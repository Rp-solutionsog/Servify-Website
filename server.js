/* ============================================================
   SERVIFY v2 — alles in einem Server (für Gratis-Hosting)
   - Express-API + Website-Auslieferung (keine Build-Tools nötig)
   - PostgreSQL (Neon, kostenlos) — Verbindungen Neon-freundlich
   - Discord-Login (OAuth2) + Bot-Anbindung über die Discord-REST-API
     (der Bot braucht KEINEN Dauerbetrieb: Prüfen/Einladung/Zahlen
      laufen über normale API-Aufrufe mit dem Bot-Token)
   Benötigte Umgebungsvariablen (Render → Environment):
     DATABASE_URL          Neon-Verbindungs-URL (postgres://...)
     DISCORD_CLIENT_ID     aus dem Discord Developer Portal
     DISCORD_CLIENT_SECRET aus dem Discord Developer Portal
     SESSION_SECRET        langer Zufallstext (Login-Sicherheit)
     ADMIN_IDS             deine Discord-ID(s), kommagetrennt
   Optional:
     DISCORD_BOT_TOKEN     Bot-Token (für Auto-Einladung, Mitgliederzahl, Bot-Check)
     PUBLIC_URL            z.B. https://servify.onrender.com (sonst automatisch)
     LEGAL_NAME / LEGAL_ADDRESS / LEGAL_EMAIL   für Impressum & Datenschutz
   ============================================================ */

"use strict";
const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");

/* ── Konfiguration ─────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const BOT_API_KEY = process.env.BOT_API_KEY || "";
const BUMP_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 Stunden (passend zum Servify-Discord-Bot)

for (const [k, v] of Object.entries({ DATABASE_URL, DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: CLIENT_SECRET, SESSION_SECRET })) {
  if (!v) console.warn(`⚠️  Umgebungsvariable ${k} fehlt — bitte in Render unter "Environment" setzen.`);
}
if (!BOT_API_KEY) console.warn(`⚠️  BOT_API_KEY fehlt — der Servify-Discord-Bot kann sich dann nicht mit der Website verbinden.`);

/* ── Datenbank (Neon-freundlich) ───────────────────────────────
   Kleiner Pool + kurze Leerlaufzeit, damit Neons Gratis-Datenbank
   zwischen Besuchen schlafen darf (spart das Gratis-Kontingent). */
const useSsl = DATABASE_URL && !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 3,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 12000,
});
pool.on("error", err => console.error("PG-Pool-Hinweis:", err.code || err.message));

async function q(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Neon beendet schlafende Verbindungen — einmal neu versuchen.
    const transient = ["57P01", "ECONNRESET", "ETIMEDOUT", "XX000"].includes(err.code) ||
      /terminat|closed|reset|timeout/i.test(err.message || "");
    if (!transient) throw err;
    await new Promise(r => setTimeout(r, 350));
    return pool.query(text, params);
  }
}

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS servers (
    guild_id     TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    icon         TEXT,
    description  TEXT NOT NULL DEFAULT '',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    language     TEXT NOT NULL DEFAULT 'de',
    nsfw         BOOLEAN NOT NULL DEFAULT false,
    is_public    BOOLEAN NOT NULL DEFAULT true,
    invite_url   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    bot_added    BOOLEAN NOT NULL DEFAULT false,
    hidden       BOOLEAN NOT NULL DEFAULT false,
    featured     BOOLEAN NOT NULL DEFAULT false,
    members      INTEGER NOT NULL DEFAULT 0,
    online       INTEGER NOT NULL DEFAULT 0,
    bump_count   INTEGER NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    last_bump_at BIGINT NOT NULL DEFAULT 0
  )`);
  await q(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bump_count INTEGER NOT NULL DEFAULT 0`);
  await q(`CREATE TABLE IF NOT EXISTS reviews (
    id         BIGSERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    user_name  TEXT NOT NULL DEFAULT '',
    user_avatar TEXT,
    rating     INTEGER NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    UNIQUE (guild_id, user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS suggestions (
    id          BIGSERIAL PRIMARY KEY,
    text        TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    votes       INTEGER NOT NULL DEFAULT 0,
    voters      TEXT[] NOT NULL DEFAULT '{}',
    created_at  BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS reports (
    id          BIGSERIAL PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    resolved    BOOLEAN NOT NULL DEFAULT false,
    created_at  BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL )`);
  console.log("✅ Datenbank bereit");
}

async function getSettings() {
  const r = await q("SELECT key, value FROM settings");
  const s = { autoApprove: "0", requireBot: "0" };
  for (const row of r.rows) s[row.key] = row.value;
  return s;
}
async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
}

/* ── Sitzung: signiertes httpOnly-Cookie (ohne Zusatzpakete) ── */
const b64u = buf => Buffer.from(buf).toString("base64url");
const sign = data => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");

function makeSession(payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}
function readSessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const a = Buffer.from(sig || ""), b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge) bits.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.secure) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}
const isHttps = req => (req.headers["x-forwarded-proto"] || req.protocol) === "https";
const baseUrl = req => PUBLIC_URL || `${isHttps(req) ? "https" : "http"}://${req.get("host")}`;

function getSession(req) {
  return readSessionToken(parseCookies(req).sid);
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_logged_in" });
  req.user = s; next();
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_logged_in" });
  if (!ADMIN_IDS.includes(String(s.uid))) return res.status(403).json({ error: "not_admin" });
  req.user = s; next();
}

/* ── kleine Anfrage-Bremse für POSTs (gegen Spam) ─────────────── */
const rlStore = new Map();
function limit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.headers["x-forwarded-for"] || req.ip}`;
    const now = Date.now();
    let e = rlStore.get(key);
    if (!e || now > e.reset) e = { n: 0, reset: now + windowMs };
    e.n++; rlStore.set(key, e);
    if (rlStore.size > 5000) rlStore.clear();
    if (e.n > max) return res.status(429).json({ error: "too_many_requests" });
    next();
  };
}

/* ── Discord-REST-Helfer ───────────────────────────────────── */
const DISCORD = "https://discord.com/api/v10";

async function dFetch(url, options = {}, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

function oauthUrl(req, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code",
    redirect_uri: `${baseUrl(req)}/auth/discord/callback`,
    scope: "identify guilds", state, prompt: "none",
  });
  return `${DISCORD}/oauth2/authorize?${p}`;
}
async function exchangeCode(req, code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code",
    code, redirect_uri: `${baseUrl(req)}/auth/discord/callback`,
  });
  const r = await dFetch(`${DISCORD}/oauth2/token`, {
    method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!r.ok) throw new Error(`token_exchange_${r.status}`);
  return r.json();
}
async function fetchDiscordUser(accessToken) {
  const r = await dFetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`me_${r.status}`);
  return r.json();
}
async function fetchManageableGuilds(accessToken) {
  const r = await dFetch(`${DISCORD}/users/@me/guilds`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (r.status === 401) return { relogin: true, guilds: [] };
  if (!r.ok) throw new Error(`guilds_${r.status}`);
  const all = await r.json();
  const guilds = all.filter(g => {
    try { return g.owner || (BigInt(g.permissions) & (8n | 32n)) !== 0n; } // ADMINISTRATOR | MANAGE_GUILD
    catch { return !!g.owner; }
  });
  return { relogin: false, guilds };
}
const iconUrl = (id, icon) => icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}?size=128` : null;
const avatarUrl = (id, av) => av ? `https://cdn.discordapp.com/avatars/${id}/${av}.png?size=64` : null;

/* Bot-Aufrufe (funktionieren rein über das Token — kein Dauerprozess nötig) */
async function botGetGuild(guildId) {
  if (!BOT_TOKEN) return { known: false };
  try {
    const r = await dFetch(`${DISCORD}/guilds/${guildId}?with_counts=true`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }, 4000);
    if (r.ok) { const g = await r.json(); return { known: true, inGuild: true, members: g.approximate_member_count || 0, online: g.approximate_presence_count || 0 }; }
    if (r.status === 403 || r.status === 404) return { known: true, inGuild: false };
    return { known: false };
  } catch { return { known: false }; }
}
async function botCreateInvite(guildId) {
  if (!BOT_TOKEN) return null;
  try {
    const cr = await dFetch(`${DISCORD}/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }, 5000);
    if (!cr.ok) return null;
    const channels = await cr.json();
    const text = channels.filter(c => c.type === 0).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const ch of text.slice(0, 4)) {
      const ir = await dFetch(`${DISCORD}/channels/${ch.id}/invites`, {
        method: "POST",
        headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ max_age: 0, max_uses: 0, unique: false }),
      }, 5000);
      if (ir.ok) { const inv = await ir.json(); if (inv.code) return `https://discord.gg/${inv.code}`; }
    }
    return null;
  } catch { return null; }
}

/* Besitzer-Server aktualisieren: Bot da? Mitgliederzahl? Einladung fehlt? */
async function refreshOwnedServer(row) {
  if (!BOT_TOKEN) return row;
  const info = await botGetGuild(row.guild_id);
  if (!info.known) return row;
  const updates = [], params = [];
  let i = 1;
  if (info.inGuild !== row.bot_added) { updates.push(`bot_added=$${i++}`); params.push(info.inGuild); }
  if (info.inGuild) {
    if (info.members && info.members !== row.members) { updates.push(`members=$${i++}`); params.push(info.members); }
    if (typeof info.online === "number" && info.online !== row.online) { updates.push(`online=$${i++}`); params.push(info.online); }
  }
  let invite = row.invite_url;
  if (info.inGuild && !invite) {
    invite = await botCreateInvite(row.guild_id);
    if (invite) { updates.push(`invite_url=$${i++}`); params.push(invite); }
  }
  if (!updates.length) return row;
  params.push(row.guild_id);
  const r = await q(`UPDATE servers SET ${updates.join(", ")} WHERE guild_id=$${i} RETURNING *`, params);
  return r.rows[0] || row;
}

/* ── Ausgabeformat ─────────────────────────────────────────── */
function toApi(row, extra = {}) {
  return {
    guildId: row.guild_id, ownerId: row.owner_id, name: row.name,
    icon: row.icon || null, description: row.description, tags: row.tags || [],
    language: row.language, nsfw: row.nsfw, isPublic: row.is_public,
    inviteUrl: row.invite_url || null, status: row.status, botAdded: row.bot_added,
    hidden: row.hidden, featured: row.featured, members: row.members, online: row.online,
    createdAt: Number(row.created_at), lastBumpAt: Number(row.last_bump_at),
    bumpCount: row.bump_count || 0,
    rating: row.avg_rating != null ? Math.round(Number(row.avg_rating) * 10) / 10 : 0,
    reviewCount: row.review_count != null ? Number(row.review_count) : 0,
    ...extra,
  };
}
const REVIEW_JOIN = `LEFT JOIN (
    SELECT guild_id, AVG(rating)::float AS avg_rating, COUNT(*)::int AS review_count
    FROM reviews GROUP BY guild_id
  ) rv ON rv.guild_id = s.guild_id`;

/* Rang unter allen öffentlich gelisteten Servern (gleiche Reihenfolge wie "Trending"). */
async function computeRank(guildId) {
  const r = await q(`
    SELECT rank FROM (
      SELECT guild_id, ROW_NUMBER() OVER (
        ORDER BY featured DESC, GREATEST(last_bump_at, created_at) DESC
      ) AS rank
      FROM servers
      WHERE status='approved' AND hidden=false AND is_public=true
    ) ranked WHERE guild_id = $1`, [guildId]);
  return r.rows[0] ? Number(r.rows[0].rank) : null;
}

/* Gemeinsame Bump-Logik – wird sowohl vom Website-Button als auch von der
   Bot-API benutzt, damit Cooldown & Zähler an EINER Stelle korrekt bleiben. */
async function performBump(guildId) {
  const row = (await q(`SELECT * FROM servers WHERE guild_id=$1`, [guildId])).rows[0];
  if (!row) return { error: "not_registered" };
  const now = Date.now();
  const next = Number(row.last_bump_at) + BUMP_COOLDOWN_MS;
  if (now < next) return { error: "cooldown", nextBumpAt: next };
  const bumpCount = (row.bump_count || 0) + 1;
  await q(`UPDATE servers SET last_bump_at=$1, bump_count=$2 WHERE guild_id=$3`, [now, bumpCount, guildId]);
  const rank = await computeRank(guildId);
  return { ok: true, serverId: guildId, serverName: row.name, nextBumpAt: now + BUMP_COOLDOWN_MS, boostEndsAt: now + BUMP_COOLDOWN_MS, bumpCount, rank };
}

/* Prüft den geteilten Bot-Schlüssel (Bearer-Token) für Discord-Bot-Aufrufe. */
function requireBotKey(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!BOT_API_KEY || token !== BOT_API_KEY) {
    return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Ungültiger oder fehlender API-Schlüssel." } });
  }
  next();
}

/* ── App ───────────────────────────────────────────────────── */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "60kb" }));

/* Gesundheits-Check für den Wach-Pinger — absichtlich OHNE Datenbank,
   damit die Neon-Datenbank zwischen echten Besuchen schlafen darf. */
app.get("/health", (req, res) => res.json({ ok: true, up: process.uptime() | 0 }));

/* ── Login ─────────────────────────────────────────────────── */
app.get("/auth/discord", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send("Discord-Login ist noch nicht konfiguriert (CLIENT_ID/SECRET fehlen).");
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, "oauth_state", state, { maxAge: 10 * 60 * 1000, secure: isHttps(req) });
  res.redirect(oauthUrl(req, state));
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const saved = parseCookies(req).oauth_state;
    if (!code || !state || !saved || state !== saved) return res.redirect("/?fehler=login");
    const tok = await exchangeCode(req, String(code));
    const me = await fetchDiscordUser(tok.access_token);
    const session = {
      uid: me.id, name: me.global_name || me.username,
      avatar: avatarUrl(me.id, me.avatar),
      at: tok.access_token,
      exp: Date.now() + 30 * 24 * 3600 * 1000,
    };
    setCookie(res, "sid", makeSession(session), { maxAge: 30 * 24 * 3600 * 1000, secure: isHttps(req) });
    res.redirect("/");
  } catch (e) {
    console.error("Login-Fehler:", e.message);
    res.redirect("/?fehler=login");
  }
});

app.post("/auth/logout", (req, res) => {
  setCookie(res, "sid", "", { maxAge: 1000, secure: isHttps(req) });
  res.json({ ok: true });
});

/* ── Basis-Infos ───────────────────────────────────────────── */
app.get("/api/config", (req, res) => {
  res.json({ clientId: CLIENT_ID, botConfigured: !!BOT_TOKEN, bumpCooldownMs: BUMP_COOLDOWN_MS });
});

app.get("/api/me", (req, res) => {
  const s = getSession(req);
  if (!s) return res.json({ user: null, isAdmin: false });
  res.json({ user: { id: s.uid, name: s.name, avatar: s.avatar }, isAdmin: ADMIN_IDS.includes(String(s.uid)) });
});

app.get("/api/me/guilds", requireAuth, async (req, res) => {
  try {
    const { relogin, guilds } = await fetchManageableGuilds(req.user.at);
    if (relogin) return res.status(401).json({ error: "relogin" });
    const ids = guilds.map(g => g.id);
    const existing = ids.length
      ? (await q(`SELECT guild_id FROM servers WHERE guild_id = ANY($1)`, [ids])).rows.map(r => r.guild_id)
      : [];
    res.json({
      guilds: guilds.map(g => ({
        id: g.id, name: g.name, icon: iconUrl(g.id, g.icon), listed: existing.includes(g.id),
      })),
    });
  } catch (e) {
    console.error("guilds:", e.message);
    res.status(502).json({ error: "discord_unavailable" });
  }
});

app.get("/api/me/servers", requireAuth, async (req, res) => {
  const r = await q(`SELECT s.*, rv.avg_rating, rv.review_count FROM servers s ${REVIEW_JOIN}
                     WHERE s.owner_id=$1 ORDER BY s.created_at DESC`, [req.user.uid]);
  const rows = await Promise.all(r.rows.slice(0, 8).map(row => refreshOwnedServer(row).catch(() => row)));
  const rest = r.rows.slice(8);
  res.json({ servers: [...rows, ...rest].map(row => toApi(row, { canBumpAt: Number(row.last_bump_at) + BUMP_COOLDOWN_MS })) });
});

/* ── Öffentliche Listen ────────────────────────────────────── */
app.get("/api/servers", async (req, res) => {
  const settings = await getSettings();
  const cond = [`s.status='approved'`, `s.hidden=false`, `s.is_public=true`];
  const params = [];
  if (settings.requireBot === "1") cond.push(`s.bot_added=true`);
  const { q: search, tag, lang, sort } = req.query;
  if (search) { params.push(`%${String(search).slice(0, 60)}%`); cond.push(`(s.name ILIKE $${params.length} OR s.description ILIKE $${params.length})`); }
  if (tag) { params.push(String(tag).toLowerCase().slice(0, 30)); cond.push(`$${params.length} = ANY(s.tags)`); }
  if (lang) { params.push(String(lang).slice(0, 5)); cond.push(`s.language = $${params.length}`); }
  const order = {
    rating: `rv.avg_rating DESC NULLS LAST, rv.review_count DESC NULLS LAST, s.members DESC`,
    members: `s.members DESC, rv.avg_rating DESC NULLS LAST`,
    newest: `s.created_at DESC`,
    trending: `GREATEST(s.last_bump_at, s.created_at) DESC, rv.avg_rating DESC NULLS LAST`,
  }[String(req.query.sort || "trending")] || `GREATEST(s.last_bump_at, s.created_at) DESC`;
  const limitN = Math.min(parseInt(req.query.limit) || 24, 60);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  params.push(limitN, offset);
  const r = await q(
    `SELECT s.*, rv.avg_rating, rv.review_count, COUNT(*) OVER() AS total
     FROM servers s ${REVIEW_JOIN}
     WHERE ${cond.join(" AND ")}
     ORDER BY s.featured DESC, ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ total: r.rows[0] ? Number(r.rows[0].total) : 0, servers: r.rows.map(x => toApi(x)) });
});

app.get("/api/tags", async (req, res) => {
  const r = await q(`SELECT tag, COUNT(*)::int AS n FROM (
      SELECT unnest(tags) AS tag FROM servers WHERE status='approved' AND hidden=false AND is_public=true
    ) t GROUP BY tag ORDER BY n DESC, tag ASC LIMIT 24`);
  res.json({ tags: r.rows });
});

app.get("/api/servers/:id", async (req, res) => {
  const r = await q(`SELECT s.*, rv.avg_rating, rv.review_count FROM servers s ${REVIEW_JOIN} WHERE s.guild_id=$1`, [req.params.id]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  const s = getSession(req);
  const isOwner = s && s.uid === row.owner_id;
  const isAdmin = s && ADMIN_IDS.includes(String(s.uid));
  if (!isOwner && !isAdmin && (row.status !== "approved" || row.hidden || !row.is_public)) {
    return res.status(404).json({ error: "not_found" });
  }
  const rev = await q(`SELECT * FROM reviews WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
  res.json({
    server: toApi(row, { canBumpAt: Number(row.last_bump_at) + BUMP_COOLDOWN_MS }),
    reviews: rev.rows.map(v => ({
      userId: v.user_id, userName: v.user_name, userAvatar: v.user_avatar,
      rating: v.rating, text: v.text, createdAt: Number(v.created_at),
    })),
  });
});

/* ── Server eintragen / bearbeiten ─────────────────────────── */
app.post("/api/servers", requireAuth, limit("add", 10, 10 * 60 * 1000), async (req, res) => {
  try {
    const guildId = String(req.body.guildId || "").trim();
    if (!/^\d{5,25}$/.test(guildId)) return res.status(400).json({ error: "bad_guild_id" });
    const { relogin, guilds } = await fetchManageableGuilds(req.user.at);
    if (relogin) return res.status(401).json({ error: "relogin" });
    const g = guilds.find(x => x.id === guildId);
    if (!g) return res.status(403).json({ error: "not_your_guild" });
    const settings = await getSettings();
    const status = settings.autoApprove === "1" ? "approved" : "pending";
    const now = Date.now();
    const r = await q(
      `INSERT INTO servers (guild_id, owner_id, name, icon, created_at, status, last_bump_at)
       VALUES ($1,$2,$3,$4,$5,$6,$5)
       ON CONFLICT (guild_id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon
       RETURNING *`,
      [guildId, req.user.uid, g.name.slice(0, 100), iconUrl(guildId, g.icon), now, status]);
    const row = r.rows[0];
    refreshOwnedServer(row).catch(() => {});
    res.json({ server: toApi(row) });
  } catch (e) {
    console.error("add:", e.message);
    res.status(502).json({ error: "discord_unavailable" });
  }
});

app.patch("/api/servers/:id", requireAuth, async (req, res) => {
  const row = (await q(`SELECT * FROM servers WHERE guild_id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  const isAdmin = ADMIN_IDS.includes(String(req.user.uid));
  if (row.owner_id !== req.user.uid && !isAdmin) return res.status(403).json({ error: "not_owner" });

  const b = req.body || {};
  const updates = [], params = [];
  let i = 1;
  if (typeof b.description === "string") { updates.push(`description=$${i++}`); params.push(b.description.slice(0, 1200)); }
  if (Array.isArray(b.tags)) {
    const tags = [...new Set(b.tags.map(t => String(t).toLowerCase().replace(/[^a-z0-9äöüß\-]/g, "").slice(0, 24)).filter(Boolean))].slice(0, 8);
    updates.push(`tags=$${i++}`); params.push(tags);
  }
  if (typeof b.language === "string") { updates.push(`language=$${i++}`); params.push(b.language.slice(0, 5)); }
  if (typeof b.nsfw === "boolean") { updates.push(`nsfw=$${i++}`); params.push(b.nsfw); }
  if (typeof b.isPublic === "boolean") { updates.push(`is_public=$${i++}`); params.push(b.isPublic); }
  if (typeof b.inviteUrl === "string") {
    const u = b.inviteUrl.trim();
    if (u && !/^https:\/\/(discord\.gg|discord\.com\/invite)\//.test(u)) return res.status(400).json({ error: "bad_invite" });
    updates.push(`invite_url=$${i++}`); params.push(u || null);
  }
  /* Wichtig: status / bot_added werden hier NIEMALS angefasst —
     eine Freigabe kann durch Bearbeiten nicht verloren gehen. */
  if (!updates.length) return res.json({ server: toApi(row) });
  params.push(req.params.id);
  const r = await q(`UPDATE servers SET ${updates.join(", ")} WHERE guild_id=$${i} RETURNING *`, params);
  res.json({ server: toApi(r.rows[0]) });
});

app.delete("/api/servers/:id", requireAuth, async (req, res) => {
  const row = (await q(`SELECT owner_id FROM servers WHERE guild_id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  const isAdmin = ADMIN_IDS.includes(String(req.user.uid));
  if (row.owner_id !== req.user.uid && !isAdmin) return res.status(403).json({ error: "not_owner" });
  await q(`DELETE FROM reviews WHERE guild_id=$1`, [req.params.id]);
  await q(`DELETE FROM servers WHERE guild_id=$1`, [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/servers/:id/bump", requireAuth, limit("bump", 30, 60 * 60 * 1000), async (req, res) => {
  const row = (await q(`SELECT owner_id FROM servers WHERE guild_id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.owner_id !== req.user.uid) return res.status(403).json({ error: "not_owner" });
  const result = await performBump(req.params.id);
  if (result.error === "cooldown") return res.status(429).json({ error: "cooldown", canBumpAt: result.nextBumpAt });
  res.json({ ok: true, canBumpAt: result.nextBumpAt, bumpCount: result.bumpCount });
});

/* ── Bot-API (für den separaten Servify-Discord-Bot) ──────────
   Authentifizierung über Bearer-Token (BOT_API_KEY), nicht über Cookies —
   der Bot ist kein eingeloggter Website-Nutzer. */
app.post("/api/bump", requireBotKey, limit("botbump", 60, 60 * 60 * 1000), async (req, res) => {
  const guildId = String((req.body || {}).guildId || "").trim();
  if (!guildId) return res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: "guildId fehlt." } });
  const result = await performBump(guildId);
  if (result.error === "not_registered") {
    return res.status(404).json({ success: false, error: { code: "SERVER_NOT_REGISTERED", message: "Dieser Server ist nicht auf Servify registriert." } });
  }
  if (result.error === "cooldown") {
    return res.status(429).json({ success: false, error: { code: "COOLDOWN_ACTIVE", data: {
      nextBumpAt: new Date(result.nextBumpAt).toISOString(), remainingMs: result.nextBumpAt - Date.now(),
    } } });
  }
  res.json({ success: true, data: {
    serverId: result.serverId, serverName: result.serverName,
    nextBumpAt: new Date(result.nextBumpAt).toISOString(),
    boostEndsAt: new Date(result.boostEndsAt).toISOString(),
    bumpCount: result.bumpCount, rank: result.rank,
  } });
});

app.get("/api/servers/:guildId/status", requireBotKey, async (req, res) => {
  const row = (await q(`SELECT * FROM servers WHERE guild_id=$1`, [req.params.guildId])).rows[0];
  if (!row) return res.status(404).json({ success: false, error: { code: "SERVER_NOT_REGISTERED" } });
  const rank = await computeRank(req.params.guildId);
  res.json({ success: true, data: {
    registered: true, bumpCount: row.bump_count || 0, rank,
    lastBumpAt: row.last_bump_at ? new Date(Number(row.last_bump_at)).toISOString() : null,
    nextBumpAt: row.last_bump_at ? new Date(Number(row.last_bump_at) + BUMP_COOLDOWN_MS).toISOString() : null,
  } });
});

app.post("/api/bot/guild-join", requireBotKey, async (req, res) => {
  const { guildId, name, memberCount, iconURL } = req.body || {};
  if (guildId) {
    await q(`UPDATE servers SET name=COALESCE($2,name), members=COALESCE($3,members), icon=COALESCE($4,icon), bot_added=true WHERE guild_id=$1`,
      [guildId, name || null, Number.isFinite(memberCount) ? memberCount : null, iconURL || null]).catch(() => {});
  }
  res.json({ success: true });
});
app.post("/api/bot/guild-leave", requireBotKey, async (req, res) => {
  const { guildId } = req.body || {};
  if (guildId) await q(`UPDATE servers SET bot_added=false WHERE guild_id=$1`, [guildId]).catch(() => {});
  res.json({ success: true });
});

app.post("/api/servers/:id/bot-added", requireAuth, async (req, res) => {
  const row = (await q(`SELECT * FROM servers WHERE guild_id=$1`, [req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.owner_id !== req.user.uid && !ADMIN_IDS.includes(String(req.user.uid))) return res.status(403).json({ error: "not_owner" });
  if (!BOT_TOKEN) return res.json({ server: toApi(row), botConfigured: false });
  const updated = await refreshOwnedServer(row);
  res.json({ server: toApi(updated), botConfigured: true });
});

/* ── Rezensionen ───────────────────────────────────────────── */
app.post("/api/servers/:id/reviews", requireAuth, limit("review", 20, 10 * 60 * 1000), async (req, res) => {
  const row = (await q(`SELECT * FROM servers WHERE guild_id=$1`, [req.params.id])).rows[0];
  if (!row || row.status !== "approved") return res.status(404).json({ error: "not_found" });
  if (row.owner_id === req.user.uid) return res.status(400).json({ error: "own_server" });
  const rating = Math.min(5, Math.max(1, parseInt(req.body.rating) || 0));
  if (!rating) return res.status(400).json({ error: "bad_rating" });
  const text = String(req.body.text || "").slice(0, 800);
  await q(`INSERT INTO reviews (guild_id, user_id, user_name, user_avatar, rating, text, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (guild_id, user_id)
           DO UPDATE SET rating=EXCLUDED.rating, text=EXCLUDED.text, created_at=EXCLUDED.created_at, user_name=EXCLUDED.user_name, user_avatar=EXCLUDED.user_avatar`,
    [req.params.id, req.user.uid, req.user.name, req.user.avatar, rating, text, Date.now()]);
  res.json({ ok: true });
});

app.delete("/api/servers/:id/reviews", requireAuth, async (req, res) => {
  await q(`DELETE FROM reviews WHERE guild_id=$1 AND user_id=$2`, [req.params.id, req.user.uid]);
  res.json({ ok: true });
});

/* ── Meldungen ─────────────────────────────────────────────── */
app.post("/api/servers/:id/report", requireAuth, limit("report", 10, 10 * 60 * 1000), async (req, res) => {
  const reason = String(req.body.reason || "").slice(0, 500).trim();
  if (!reason) return res.status(400).json({ error: "bad_reason" });
  await q(`INSERT INTO reports (guild_id, reporter_id, reason, created_at) VALUES ($1,$2,$3,$4)`,
    [req.params.id, req.user.uid, reason, Date.now()]);
  res.json({ ok: true });
});

/* ── Vorschläge ────────────────────────────────────────────── */
app.get("/api/suggestions", async (req, res) => {
  const r = await q(`SELECT * FROM suggestions ORDER BY votes DESC, created_at DESC LIMIT 200`);
  const s = getSession(req);
  res.json({
    suggestions: r.rows.map(x => ({
      id: x.id, text: x.text, authorId: x.author_id, authorName: x.author_name,
      votes: x.votes, createdAt: Number(x.created_at),
      voted: s ? x.voters.includes(s.uid) : false,
    })),
  });
});
app.post("/api/suggestions", requireAuth, limit("suggest", 8, 10 * 60 * 1000), async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (text.length < 4) return res.status(400).json({ error: "too_short" });
  const r = await q(`INSERT INTO suggestions (text, author_id, author_name, created_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [text, req.user.uid, req.user.name, Date.now()]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.post("/api/suggestions/:id/vote", requireAuth, async (req, res) => {
  await q(`UPDATE suggestions SET votes = votes + 1, voters = array_append(voters, $2)
           WHERE id=$1 AND NOT ($2 = ANY(voters))`, [req.params.id, req.user.uid]);
  res.json({ ok: true });
});
app.delete("/api/suggestions/:id", requireAdmin, async (req, res) => {
  await q(`DELETE FROM suggestions WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

/* ── Admin ─────────────────────────────────────────────────── */
app.get("/api/admin/servers", requireAdmin, async (req, res) => {
  const r = await q(`SELECT s.*, rv.avg_rating, rv.review_count FROM servers s ${REVIEW_JOIN} ORDER BY s.created_at DESC LIMIT 500`);
  res.json({ servers: r.rows.map(x => toApi(x)) });
});
async function adminSet(res, guildId, sql, params) {
  const r = await q(`UPDATE servers SET ${sql} WHERE guild_id=$${params.length + 1} RETURNING *`, [...params, guildId]);
  if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
  res.json({ server: toApi(r.rows[0]) });
}
app.post("/api/admin/servers/:id/approve", requireAdmin, (req, res) => adminSet(res, req.params.id, `status='approved'`, []));
app.post("/api/admin/servers/:id/reject", requireAdmin, (req, res) => adminSet(res, req.params.id, `status='rejected'`, []));
app.post("/api/admin/servers/:id/pending", requireAdmin, (req, res) => adminSet(res, req.params.id, `status='pending'`, []));
app.post("/api/admin/servers/:id/hide", requireAdmin, (req, res) => adminSet(res, req.params.id, `hidden = NOT hidden`, []));
app.post("/api/admin/servers/:id/feature", requireAdmin, (req, res) => adminSet(res, req.params.id, `featured = NOT featured`, []));

app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  const r = await q(`SELECT r.*, s.name AS server_name FROM reports r LEFT JOIN servers s ON s.guild_id=r.guild_id
                     ORDER BY r.resolved ASC, r.created_at DESC LIMIT 300`);
  res.json({
    reports: r.rows.map(x => ({
      id: x.id, guildId: x.guild_id, serverName: x.server_name || "(gelöscht)",
      reason: x.reason, resolved: x.resolved, createdAt: Number(x.created_at),
    })),
  });
});
app.post("/api/admin/reports/:id/resolve", requireAdmin, async (req, res) => {
  await q(`UPDATE reports SET resolved = NOT resolved WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => res.json({ settings: await getSettings() }));
app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const allowed = ["autoApprove", "requireBot"];
  for (const k of allowed) {
    if (k in (req.body || {})) await setSetting(k, req.body[k] ? "1" : "0");
  }
  res.json({ settings: await getSettings() });
});

/* ── Rechtsseiten (echte URLs, unabhängig von der App) ─────── */
const L_NAME = process.env.LEGAL_NAME || "[Name — in Render unter Environment als LEGAL_NAME eintragen]";
const L_ADDR = process.env.LEGAL_ADDRESS || "[Adresse — als LEGAL_ADDRESS eintragen]";
const L_MAIL = process.env.LEGAL_EMAIL || "[E-Mail — als LEGAL_EMAIL eintragen]";

function legalPage(title, inner) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – Servify</title>
<style>body{margin:0;background:#0a0e1f;color:#e7e9f5;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;line-height:1.7}
.w{max-width:760px;margin:0 auto;padding:48px 22px}h1{color:#fff;font-size:30px;margin:0 0 18px}
h2{color:#b9b3ff;font-size:18px;margin:28px 0 6px}a{color:#8f8bff}p{margin:8px 0}</style></head>
<body><div class="w"><h1>${title}</h1>${inner}
<p style="margin-top:44px"><a href="/">← Zurück zu Servify</a></p></div></body></html>`;
}
app.get("/impressum", (req, res) => res.type("html").send(legalPage("Impressum", `
<h2>Angaben gemäß § 5 DDG</h2><p>${L_NAME}<br>${L_ADDR}<br>Deutschland</p>
<p>Kontakt: ${L_MAIL}</p>
<p>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: ${L_NAME}, Anschrift wie oben.</p>
<h2>Haftung für Inhalte</h2><p>Die Inhalte dieser Seiten wurden mit größter Sorgfalt erstellt. Für Richtigkeit, Vollständigkeit und Aktualität kann keine Gewähr übernommen werden. Nach §§ 8 bis 10 DDG besteht keine Pflicht, übermittelte oder gespeicherte fremde Informationen zu überwachen.</p>
<h2>Haftung für Links</h2><p>Für Inhalte verlinkter externer Seiten (z. B. Discord-Server) ist stets der jeweilige Anbieter verantwortlich.</p>
<h2>Urheberrecht</h2><p>Die vom Betreiber erstellten Inhalte unterliegen dem deutschen Urheberrecht.</p>`)));
app.get("/datenschutz", (req, res) => res.type("html").send(legalPage("Datenschutzerklärung", `
<h2>1. Verantwortlicher</h2><p>${L_NAME}, ${L_ADDR}, E-Mail: ${L_MAIL}</p>
<h2>2. Verarbeitete Daten</h2><p>Discord-Login (Discord-ID, Benutzername, Avatar); eingegebene Inhalte (Server, Beschreibungen, Tags, Rezensionen, Vorschläge, Meldungen); technische Daten (IP-Adresse, Zeitpunkt, aufgerufene Seiten in Server-Protokollen); ein technisch notwendiges Cookie für die Login-Sitzung.</p>
<h2>3. Zwecke und Rechtsgrundlage</h2><p>Bereitstellung, Betrieb und Sicherheit des Dienstes; Art. 6 Abs. 1 lit. b und f DSGVO.</p>
<h2>4. Discord</h2><p>Die Anmeldung erfolgt über Discord (Discord Inc., USA); dabei können Daten in die USA übertragen werden. Es gelten zusätzlich die Datenschutzbestimmungen von Discord.</p>
<h2>5. Hosting</h2><p>Diese Website wird bei externen Hosting-Anbietern (Render, Neon) betrieben; dabei werden technische Daten verarbeitet.</p>
<h2>6. Speicherdauer</h2><p>Daten werden gespeichert, solange Konto bzw. Einträge bestehen; Löschung jederzeit auf Anfrage.</p>
<h2>7. Deine Rechte</h2><p>Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch sowie Beschwerderecht bei einer Aufsichtsbehörde. Kontakt siehe oben.</p>`)));
app.get("/nutzungsbedingungen", (req, res) => res.type("html").send(legalPage("Nutzungsbedingungen", `
<h2>1. Geltungsbereich</h2><p>Nutzung dieser Website zum Entdecken und Eintragen von Discord-Servern.</p>
<h2>2. Nutzung</h2><p>Angemeldete Nutzer dürfen Server eintragen, bewerten und Vorschläge machen; für eigene Inhalte sind sie selbst verantwortlich.</p>
<h2>3. Verbotene Inhalte</h2><p>Rechtswidrige Inhalte, Hassrede, Belästigung, Spam, Betrug sowie nicht gekennzeichnete NSFW-Inhalte. NSFW ist zu kennzeichnen.</p>
<h2>4. Moderation</h2><p>Der Betreiber darf Einträge prüfen, verbergen oder entfernen und Nutzer bei Verstößen ausschließen.</p>
<h2>5. Haftung</h2><p>Bereitstellung ohne Gewähr; für verlinkte Server sind deren Betreiber verantwortlich.</p>
<h2>6. Änderungen</h2><p>Es gilt die jeweils veröffentlichte Fassung.</p>`)));

/* ── Website ausliefern ────────────────────────────────────── */
app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "logo.png")));
app.get(/^\/(?!api|auth|health).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* API-Fallback + Fehlerbehandlung */
app.use("/api", (req, res) => res.status(404).json({ error: "unknown_route" }));
app.use((err, req, res, next) => {
  console.error("Fehler:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "server_error" });
});

/* ── Start ─────────────────────────────────────────────────── */
initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Servify läuft auf Port ${PORT}`)))
  .catch(err => { console.error("Datenbank-Start fehlgeschlagen:", err.message); process.exit(1); });
