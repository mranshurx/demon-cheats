const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cors());

/* ================= STORAGE: Upstash Redis (REST) as the database ================= */
const KV_URL   = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || 'https://flying-poodle-243357.upstash.io';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY   = process.env.KV_DB_KEY || 'cyberx:db';
const USE_GITHUB = !!(KV_URL && KV_TOKEN);   // name kept — now means "remote DB enabled"

const ADMIN_SECRET_PASS = process.env.ADMIN_PASS || "ANSHU-BHAI-CYBER";

// Optional: paste your happ-proxy.com Provider ID.
const HAPP_PROVIDER_ID = "";

const FRONTEND_DIR = fs.existsSync(path.join(__dirname, '..', 'frontend'))
  ? path.join(__dirname, '..', 'frontend')
  : path.join(__dirname, 'frontend');

/* ================= DB STATE ================= */
const DEFAULT_MAINT = { enabled: false, message: 'System under maintenance.' };
let keysCache = null;
let maintCache = null;
let dbSha = null;
let saveTimer = null;
let saving = false;
let dirty = false;

function ghHeaders() {
  return {
    Authorization: `Bearer ${KV_TOKEN}`,
    'Content-Type': 'application/json'
  };
}
async function ghGetFile() {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(KV_KEY)}`, { headers: ghHeaders() });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  const j = await r.json();
  return { content: j && j.result ? j.result : null, sha: null };
}
async function ghPutFile(contentStr) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(KV_KEY)}`, {
    method: 'POST',
    headers: ghHeaders(),
    body: contentStr
  });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw new Error(`KV PUT ${r.status} ${await r.text()}`);
  return { sha: null };
}

/* ================= DURATION PARSING (strict) ================= */
/*
  Rules:
  - `days` wins if present (multiples of 24)
  - then `durationHours` / `duration` / `hours` read as HOURS
  - 24h is used only when the body carries nothing usable, and it is logged loudly
*/
function parseDuration(body) {
  body = body || {};

  if (body.days != null) {
    const d = Number(body.days);
    if (Number.isFinite(d) && d > 0) return Math.round(d * 24);
  }

  for (const field of ['durationHours', 'duration', 'hours']) {
    if (body[field] != null) {
      const n = Number(body[field]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  }

  console.warn('[duration] no valid duration in body — falling back to 24h:', JSON.stringify(body));
  return 24;
}

/* Last-resort guard used at activation time (record already exists) */
function normalizeHours(h) {
  const n = Number(h);
  return (Number.isFinite(n) && n > 0) ? Math.round(n) : 24;
}

/* Never clobber a real duration on boot — only fill in what is genuinely missing */
function migrateRecord(r) {
  if (r.durationHours == null) {
    const c = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    const e = r.expiresAt ? new Date(r.expiresAt).getTime() : 0;
    const d = (e - c) / 3600000;
    r.durationHours = (d > 0 && Math.round(d) !== 24) ? Math.round(d) : 24;
    console.log(`[migrate] ${r.key} -> ${r.durationHours}h (derived)`);
  } else {
    const fixed = normalizeHours(r.durationHours);
    if (fixed !== r.durationHours) {
      console.warn(`[migrate] ${r.key} repaired ${r.durationHours} -> ${fixed}`);
      r.durationHours = fixed;
    }
  }
  if (r.expiresAt && !r.activatedAt) r.activatedAt = r.createdAt || new Date().toISOString();
}

function readKeys() { return keysCache || []; }
function readMaintenance() { return maintCache || DEFAULT_MAINT; }

function saveLocal() {
  fs.writeFileSync(path.join(__dirname, 'keys.json'), JSON.stringify(keysCache, null, 2));
  fs.writeFileSync(path.join(__dirname, 'maintenance.json'), JSON.stringify(maintCache, null, 2));
}
function scheduleSave() {
  if (!USE_GITHUB) { saveLocal(); return; }
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 4000);
}
async function flush() {
  if (!USE_GITHUB || saving || !dirty) return;
  saving = true; dirty = false;
  const data = JSON.stringify({ keys: keysCache, maintenance: maintCache }, null, 2);
  try {
    let res = await ghPutFile(data);
    if (res && res.conflict) {
      dbSha = (await ghGetFile()).sha;
      res = await ghPutFile(data);
    }
    if (res && res.sha) dbSha = res.sha;
    console.log('[db] synced to remote DB');
  } catch (e) {
    dirty = true;
    console.error('[db] sync failed:', e.message);
  } finally {
    saving = false;
    if (dirty && !saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 5000);
  }
}

async function preload() {
  if (USE_GITHUB) {
    const f = await ghGetFile();
    dbSha = f.sha;
    let db = {};
    try { db = f.content ? JSON.parse(f.content) : {}; } catch (e) { db = {}; }
    keysCache = Array.isArray(db.keys) ? db.keys : [];
    maintCache = db.maintenance || { ...DEFAULT_MAINT };
    console.log(`[db] REMOTE MODE — loaded ${keysCache.length} keys from ${KV_KEY}`);
  } else {
    try { keysCache = fs.existsSync(path.join(__dirname, 'keys.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8')) : []; }
    catch (e) { keysCache = []; }
    maintCache = { ...DEFAULT_MAINT };
    console.warn('[db] LOCAL FILE MODE (no KV env vars) — keys are wiped on every restart!');
  }
  if (!Array.isArray(keysCache)) keysCache = [];
  keysCache.forEach(migrateRecord);
}

/* ================= YOUR HYSTERIA & GAME ROUTING CONFIGURATION ================= */
const BASE_CONFIG = {
  "remarks": "CYBER X SILENT [Secured]",
  "profile-update-interval": 1,
  "inbounds": [
    { "tag": "socks", "listen": "127.0.0.1", "port": 10808, "protocol": "socks", "settings": { "auth": "noauth", "udp": true }, "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"], "routeOnly": false } },
    { "tag": "http", "listen": "127.0.0.1", "port": 10809, "protocol": "http", "sniffing": { "enabled": true, "destOverride": ["http", "tls", "quic"], "routeOnly": false } }
  ],
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "hysteria",
      "settings": { "address": "wraith-bom.xreg.site", "port": 443, "version": 2 },
      "streamSettings": {
        "network": "hysteria",
        "security": "tls",
        "tlsSettings": { "serverName": "wraith-bom.xreg.site", "alpn": ["h3"] },
        "hysteriaSettings": { "version": 2, "auth": "XREG-E472-1EF2-8D79.1793018457.4f51e32b10e2a44595314baee488cb83" }
      }
    },
    { "tag": "direct", "protocol": "freedom" }
  ],
  "routing": {
    "domainStrategy": "AsIs",
    "rules": [
      {
        "type": "field",
        "domain": [
          "full:clientbp.ggpolarbear.com", "full:loginbp.ggpolarbear.com", "full:core-bs.ggpolarbear.com",
          "full:core-bs.freefiremobile.com", "full:core-tata.freefireind.in", "full:core-gmc.freefiremobile.com",
          "full:client.ind.freefiremobile.com", "full:client.us.freefiremobile.com", "full:sgnetwork.ggblueshark.com",
          "full:menetwork.ggblueshark.com", "full:bdnetwork.ggpolarbear.com", "full:100067.connect.garena.com",
          "full:100067.msdk.garena.com", "full:clientbp.ppmainecoonghj.com", "full:loginbp.ppmainecoonghj.com",
          "full:ffmconnect.ppmainecoonghj.com", "full:ffmmsdk.ppmainecoonghj.com",
          "regexp:^(clientbp|loginbp|core-[a-z0-9]+|[a-z]+network|ffmconnect|ffmmsdk)\\."
        ],
        "outboundTag": "proxy"
      },
      {
        "type": "field",
        "ip": [
          "0.0.0.0/24","101.32.114.0/23","101.33.44.0/22","102.204.191.0/24","102.217.238.0/24",
          "103.103.244.0/24","103.108.100.0/22","103.117.4.0/22","103.123.54.0/23","103.127.228.0/22",
          "103.16.32.0/22","103.215.127.0/24","103.219.200.0/22","103.237.102.0/23","103.247.204.0/22"
        ],
        "outboundTag": "proxy"
      },
      { "type": "field", "network": "tcp", "port": "39000-39999", "outboundTag": "proxy" },
      { "type": "field", "network": "udp", "port": "10000-10999", "outboundTag": "proxy" },
      {
        "type": "field",
        "domain": [
          "full:event-vodka.freefireind.in","full:indevent.ggblueshark.com","full:sgevent.ggblueshark.com",
          "full:meevent.ggblueshark.com","full:thevent.ggblueshark.com","full:sacevent.ggblueshark.com",
          "full:idevent.ggblueshark.com","full:bdevent.ggpolarbear.com","regexp:event\\.gg(blueshark|polarbear)\\.com$",
          "full:gin.freefireind.in","full:gin.freefiremobile.com","full:vodka.freefireind.in",
          "full:dl.castle.freefiremobile.com","full:dl.cdn.freefiremobile.com","full:dl-core.cdn.freefiremobile.com",
          "domain:freefiremobile-a.akamaihd.net","full:client.nulldash.store","full:client.xreg.site","full:client.silentx.store"
        ],
        "outboundTag": "direct"
      },
      { "type": "field", "network": "tcp,udp", "outboundTag": "direct" }
    ]
  }
};

const EXPIRED_CONFIG = {
  "remarks": "❌ SUBSCRIPTION EXPIRED OR TERMINATED",
  "profile-update-interval": 1,
  "inbounds": [],
  "outbounds": [{ "tag": "blocked", "protocol": "blackhole" }],
  "routing": { "rules": [] }
};

/* KEY RESOLUTION — clock starts on first activation, exact ms math */
function findActiveKey(key) {
  const r = readKeys().find(k => k.key === key);
  if (!r) return null;
  if (!r.activatedAt) {
    const now = Date.now();
    r.activatedAt = new Date(now).toISOString();
    r.durationHours = normalizeHours(r.durationHours);
    r.expiresAt = new Date(now + r.durationHours * 3600000).toISOString();
    scheduleSave();
    console.log(`[key] activated ${r.key} -> ${r.durationHours}h, expires ${r.expiresAt}`);
  }
  if (!r.expiresAt || Date.now() > new Date(r.expiresAt).getTime()) return null;
  return r;
}

/* ================= HAPP ENCRYPTED LINK ================= */
const happLinkCache = new Map();
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}
function encryptHappLink(subUrl) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ url: subUrl });
    const req = https.request({
      hostname: 'crypto.happ.su', path: '/api-v2.php', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); resolve(j && j.encrypted_link ? j.encrypted_link : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(9000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

/* ================= API ROUTES ================= */
app.get('/api/maintenance-status', (req, res) => {
  res.json(readMaintenance());
});

app.get('/api/happ-link', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({ ok: false, reason: 'no-key' });
  const record = findActiveKey(key);
  if (!record) return res.json({ ok: false, reason: 'invalid' });
  const subUrl = `${baseUrl(req)}/sub?key=${encodeURIComponent(key)}`;
  if (happLinkCache.has(key)) return res.json({ ok: true, link: happLinkCache.get(key), raw: subUrl });
  const link = await encryptHappLink(subUrl);
  if (link) happLinkCache.set(key, link);
  return res.json({ ok: !!link, link: link || subUrl, raw: subUrl, encrypted: !!link });
});

app.get('/sub', (req, res) => {
  const m = readMaintenance();

  res.setHeader('profile-update-interval', '1');
  res.setHeader('subscription-auto-update-enable', '1');
  res.setHeader('subscription-auto-update-open-enable', '1');
  res.setHeader('hide-settings', '1');
  if (HAPP_PROVIDER_ID) res.setHeader('providerid', HAPP_PROVIDER_ID);
  res.setHeader('content-disposition', 'attachment; filename="cyber-x-silent"');
  res.setHeader('Content-Type', 'application/json');

  let targetConfig = BASE_CONFIG;

  if (m.enabled) {
    targetConfig = { ...EXPIRED_CONFIG };
    targetConfig.remarks = `⚠️ MAINTENANCE: ${m.message}`;
  } else {
    const { key } = req.query;
    if (!key) targetConfig = EXPIRED_CONFIG;
    else {
      const record = findActiveKey(key);
      if (!record) targetConfig = EXPIRED_CONFIG;
      else {
        const expiresAt = new Date(record.expiresAt);
        res.setHeader('subscription-userinfo', `upload=0; download=0; total=107374182400; expire=${Math.floor(expiresAt.getTime() / 1000)}`);
      }
    }
  }

  return res.status(200).send(JSON.stringify(targetConfig));
});

app.get('/api/check-key', (req, res) => {
  const m = readMaintenance();
  if (m.enabled) return res.json({ valid: false, maintenance: true, message: m.message });

  const { key } = req.query;
  if (!key) return res.json({ valid: false, message: "Please enter an access key." });

  const all = readKeys();
  if (!all.find(k => k.key === key)) return res.json({ valid: false, message: "Invalid key." });

  const record = findActiveKey(key);
  if (!record) return res.json({ valid: false, message: "Key has expired." });

  const remainingMs = new Date(record.expiresAt).getTime() - Date.now();
  return res.json({
    valid: true,
    key: record.key,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    durationHours: record.durationHours,
    remainingMs,
    message: "Access Key Validated!"
  });
});

/* ================= ADMIN API ================= */
app.post('/api/admin/login', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ success: false, error: "Invalid Admin Password." });
  return res.json({ success: true });
});

/* Diagnostic — tells you where keys are actually being stored */
app.post('/api/admin/diag', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });
  return res.json({
    storageMode: USE_GITHUB ? 'remote-db' : 'LOCAL-FILE (volatile!)',
    dbUrlSet: !!KV_URL,
    dbKey: KV_KEY,
    keysInMemory: readKeys().length,
    maintenance: readMaintenance(),
    hasDbSha: !!dbSha,
    hint: USE_GITHUB
      ? 'Good — keys persist in the remote DB.'
      : 'Set KV_REST_API_URL + KV_REST_API_TOKEN, otherwise keys vanish on every restart.'
  });
});

app.post('/api/admin/create-key', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const durationHours = parseDuration(req.body);
  console.log('[create-key] body =', JSON.stringify(req.body), '=> durationHours =', durationHours);

  const keys = readKeys();
  let randomKey;
  do { randomKey = "CYBER-" + Math.random().toString(36).substring(2, 8).toUpperCase(); }
  while (keys.find(k => k.key === randomKey));

  const newRecord = {
    key: randomKey,
    durationHours,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    expiresAt: null
  };
  keys.push(newRecord);
  scheduleSave();
  return res.json({ success: true, record: newRecord, durationHours });
});

app.post('/api/admin/list-keys', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });
  const keys = [...readKeys()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ keys, maintenance: readMaintenance() });
});

app.post('/api/admin/revoke-key', (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  const keys = readKeys();
  const idx = keys.findIndex(k => k.key === key);
  if (idx >= 0) keys.splice(idx, 1);
  scheduleSave();
  happLinkCache.delete(key);
  return res.json({ success: true, message: `Key ${key} revoked instantly.` });
});

/* Repair a key: set a new duration and re-arm the clock */
app.post('/api/admin/repair-key', (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const r = readKeys().find(k => k.key === key);
  if (!r) return res.status(404).json({ error: "Key not found." });

  const durationHours = parseDuration(req.body);
  r.durationHours = durationHours;
  r.activatedAt = null;
  r.expiresAt = null;
  scheduleSave();
  happLinkCache.delete(key);
  console.log(`[repair-key] ${key} -> ${durationHours}h, clock re-armed`);
  return res.json({ success: true, record: r, durationHours });
});

app.post('/api/admin/maintenance', (req, res) => {
  const { adminPass, enabled, message } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  maintCache = { enabled: !!enabled, message: message || "System under maintenance." };
  scheduleSave();
  return res.json({ success: true, maintenance: readMaintenance() });
});

/* ================= FRONTEND ROUTES ================= */
app.get('/admin', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

app.use(express.static(FRONTEND_DIR));

/* ================= BOOT ================= */
const PORT = process.env.PORT || 3000;
(async () => {
  await preload();
  app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
})();

process.on('SIGTERM', async () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await flush();
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
