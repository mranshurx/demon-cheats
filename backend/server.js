const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cors());

/* ================= STORAGE: GitHub repo as the database ================= */
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO    = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';
const GITHUB_DB_PATH = process.env.GITHUB_DB_PATH || 'data/db.json';
const USE_GITHUB     = !!(GITHUB_TOKEN && GITHUB_REPO);

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
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cyber-x-silent'
  };
}
async function ghGetFile() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DB_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return { content: null, sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { content: Buffer.from(j.content || '', 'base64').toString('utf8'), sha: j.sha };
}
async function ghPutFile(contentStr) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DB_PATH}`;
  const body = {
    message: 'chore(db): sync keys [skip render]',
    content: Buffer.from(contentStr, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (dbSha) body.sha = dbSha;
  const r = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw new Error(`GitHub PUT ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { sha: j.content ? j.content.sha : null };
}

function normalizeHours(h) { const n = parseInt(h, 10); return (Number.isFinite(n) && n > 0) ? n : 24; }
function migrateRecord(r) {
  if (r.durationHours == null) {
    if (r.expiresAt && r.createdAt) {
      const d = (new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime()) / 3600000;
      r.durationHours = d > 0 ? Math.round(d) : 24;
    } else r.durationHours = 24;
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
    console.log('[db] synced to GitHub');
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
    console.log(`[db] loaded ${keysCache.length} keys from ${GITHUB_REPO}:${GITHUB_DB_PATH}`);
  } else {
    try { keysCache = fs.existsSync(path.join(__dirname, 'keys.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8')) : []; }
    catch (e) { keysCache = []; }
    maintCache = { ...DEFAULT_MAINT };
    console.log('[db] local file mode (no GitHub env vars)');
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

app.post('/api/admin/create-key', (req, res) => {
  const { adminPass, durationHours } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const keys = readKeys();
  let randomKey;
  do { randomKey = "CYBER-" + Math.random().toString(36).substring(2, 8).toUpperCase(); }
  while (keys.find(k => k.key === randomKey));

  const newRecord = {
    key: randomKey,
    durationHours: normalizeHours(durationHours),
    createdAt: new Date().toISOString(),
    activatedAt: null,
    expiresAt: null
  };
  keys.push(newRecord);
  scheduleSave();
  return res.json({ success: true, record: newRecord });
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

app.post('/api/admin/maintenance', (req, res) => {
  const { adminPass, enabled, message } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

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
