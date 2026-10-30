const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(cors());

/* ================= STORAGE: your GitHub repo ================= */
const LOCAL_CFG = path.join(__dirname, 'github.json');

function envCfg() {
  return {
    owner:  process.env.GITHUB_OWNER || '',
    repo:   process.env.GITHUB_REPO || '',
    branch: process.env.GITHUB_BRANCH || 'main',
    file:   process.env.GITHUB_KEYS_PATH || 'data/keys.json',
    token:  process.env.GITHUB_TOKEN || ''
  };
}

let cfg = envCfg();

function loadCfg() {
  try {
    if (fs.existsSync(LOCAL_CFG)) Object.assign(cfg, JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8')));
  } catch (e) { console.warn('[cfg] could not read github.json:', e.message); }
}
function saveCfg() {
  try { fs.writeFileSync(LOCAL_CFG, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.warn('[cfg] could not persist github.json:', e.message); }
}

/* Panel values win over env values for this request */
function credsFrom(req) {
  const out = { ...cfg };
  const gh = (req.body && req.body.gh) || req.query || {};
  for (const k of ['owner', 'repo', 'branch', 'file', 'token']) {
    if (gh[k]) out[k] = String(gh[k]).trim();
  }
  if (!out.branch) out.branch = 'main';
  if (!out.file) out.file = 'data/keys.json';
  return out;
}
function sigOf(c) { return `${c.owner}/${c.repo}@${c.branch}:${c.file}:${c.token ? 't' : 'a'}`; }
function ready(c) { return !!(c.owner && c.repo); }

const ADMIN_SECRET_PASS = process.env.ADMIN_PASS || "ANSHU-BHAI-CYBER";
const HAPP_PROVIDER_ID = "";

const FRONTEND_DIR = fs.existsSync(path.join(__dirname, '..', 'frontend'))
  ? path.join(__dirname, '..', 'frontend')
  : path.join(__dirname, 'frontend');

const DEFAULT_MAINT = { enabled: false, message: 'System under maintenance.' };
const EMPTY_DB = () => ({ keys: [], maintenance: { ...DEFAULT_MAINT } });

/* ================= GITHUB API ================= */
function apiHeaders(c, json) {
  const h = { 'User-Agent': 'cyber-x-silent', Accept: 'application/vnd.github+json' };
  if (c.token) h.Authorization = `Bearer ${c.token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/* Read the keys file. Falls back to the public raw URL when no token is set. */
async function ghRead(c) {
  if (!ready(c)) return null;
  const encoded = c.file.split('/').map(encodeURIComponent).join('/');

  if (!c.token) {
    const raw = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${encodeURIComponent(c.branch)}/${encoded}?t=${Date.now()}`;
    const r = await fetch(raw, { headers: { 'User-Agent': 'cyber-x-silent' } });
    if (r.status === 404) return { text: null, sha: null };
    if (!r.ok) throw new Error(`raw GET ${r.status}`);
    return { text: await r.text(), sha: null };
  }

  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${encoded}?ref=${encodeURIComponent(c.branch)}`;
  const r = await fetch(url, { headers: apiHeaders(c, false) });
  if (r.status === 404) return { text: null, sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { text: Buffer.from(j.content || '', 'base64').toString('utf8'), sha: j.sha || null };
}

/* Write the keys file. Returns { ok, sha } or { conflict: true }. */
async function ghWrite(c, text, sha) {
  if (!ready(c)) throw new Error('GitHub storage not configured');
  if (!c.token) throw new Error('A GitHub token is required to write keys');

  const encoded = c.file.split('/').map(encodeURIComponent).join('/');
  const body = {
    message: 'chore(keys): update license database',
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: c.branch
  };
  if (sha) body.sha = sha;

  const r = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${encoded}`, {
    method: 'PUT',
    headers: apiHeaders(c, true),
    body: JSON.stringify(body)
  });
  if (r.status === 409 || r.status === 422) return { conflict: true };
  if (!r.ok) throw new Error(`GitHub PUT ${r.status} ${await r.text()}`);
  const j = await r.json().catch(() => ({}));
  return { ok: true, sha: (j.content && j.content.sha) || null };
}

/* ================= CACHE + SERIALIZED WRITES ================= */
let cache = { data: null, sha: null, at: 0, sig: '' };
const TTL = 5000;
let queue = Promise.resolve();
function enqueue(fn) { queue = queue.then(fn, fn); return queue; }

async function getDb(force, c) {
  c = c || cfg;
  if (!ready(c)) return EMPTY_DB();
  const sig = sigOf(c);

  if (!force && cache.data && cache.sig === sig && Date.now() - cache.at < TTL) return cache.data;

  const f = await ghRead(c);
  let db;
  try { db = f && f.text ? JSON.parse(f.text) : null; } catch (e) { db = null; }
  if (!db || typeof db !== 'object') db = EMPTY_DB();
  if (!Array.isArray(db.keys)) db.keys = [];
  if (!db.maintenance) db.maintenance = { ...DEFAULT_MAINT };
  db.keys.forEach(migrateRecord);

  cache = { data: db, sha: f ? f.sha : null, at: Date.now(), sig };
  return db;
}

async function putDb(db, c) {
  c = c || cfg;
  const text = JSON.stringify(db, null, 2);
  const sig = sigOf(c);
  return enqueue(async () => {
    let sha = (cache.sig === sig) ? cache.sha : null;
    if (!sha) {
      const f = await ghRead(c);
      sha = f ? f.sha : null;
    }
    let r = await ghWrite(c, text, sha);
    if (r && r.conflict) {
      const f = await ghRead(c);
      r = await ghWrite(c, text, f ? f.sha : null);
    }
    if (!r || !r.ok) throw new Error('GitHub write failed');
    cache = { data: db, sha: r.sha, at: Date.now(), sig };
    return r;
  });
}

/* Read fresh, mutate, write back */
async function mutate(c, fn) {
  const db = await getDb(true, c);
  const out = await fn(db);
  await putDb(db, c);
  return out;
}

/* ================= DURATION ================= */
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
  console.warn('[duration] nothing usable in body — defaulting to 24h:', JSON.stringify(body));
  return 24;
}
function normalizeHours(h) {
  const n = Number(h);
  return (Number.isFinite(n) && n > 0) ? Math.round(n) : 24;
}
function migrateRecord(r) {
  if (r.durationHours == null) {
    const c = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    const e = r.expiresAt ? new Date(r.expiresAt).getTime() : 0;
    const d = (e - c) / 3600000;
    r.durationHours = (d > 0 && Math.round(d) !== 24) ? Math.round(d) : 24;
  } else {
    r.durationHours = normalizeHours(r.durationHours);
  }
  if (r.startedAt == null) r.startedAt = r.activatedAt || null;
  if (r.expiresAt && !r.activatedAt) r.activatedAt = r.createdAt || new Date().toISOString();
}

/* ================= KEY RESOLUTION ================= */
async function findActiveKey(key, c) {
  let db = await getDb(false, c);
  let r = db.keys.find(k => k.key === key);
  if (!r) return null;

  if (!r.activatedAt) {
    r = await mutate(c, fresh => {
      const rec = fresh.keys.find(k => k.key === key);
      if (!rec || rec.activatedAt) return rec || null;
      const now = Date.now();
      rec.activatedAt = new Date(now).toISOString();
      rec.startedAt = rec.activatedAt;
      rec.durationHours = normalizeHours(rec.durationHours);
      rec.expiresAt = new Date(now + rec.durationHours * 3600000).toISOString();
      console.log(`[key] activated ${rec.key} -> ${rec.durationHours}h, expires ${rec.expiresAt}`);
      return rec;
    });
    if (!r) return null;
  }

  if (!r.expiresAt || Date.now() > new Date(r.expiresAt).getTime()) return null;
  return r;
}

/* ================= ROUTING CONFIG ================= */
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

/* ================= HAPP LINK ================= */
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

/* ================= PUBLIC API ================= */
app.get('/api/maintenance-status', async (req, res) => {
  try {
    const db = await getDb(false, credsFrom(req));
    res.json(db.maintenance || DEFAULT_MAINT);
  } catch (e) {
    res.json(DEFAULT_MAINT);
  }
});

app.get('/api/happ-link', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({ ok: false, reason: 'no-key' });
  try {
    const c = credsFrom(req);
    const record = await findActiveKey(key, c);
    if (!record) return res.json({ ok: false, reason: 'invalid' });
    const subUrl = `${baseUrl(req)}/sub?key=${encodeURIComponent(key)}`;
    if (happLinkCache.has(key)) return res.json({ ok: true, link: happLinkCache.get(key), raw: subUrl });
    const link = await encryptHappLink(subUrl);
    if (link) happLinkCache.set(key, link);
    return res.json({ ok: !!link, link: link || subUrl, raw: subUrl, encrypted: !!link });
  } catch (e) {
    return res.json({ ok: false, reason: 'storage-error', detail: e.message });
  }
});

app.get('/sub', async (req, res) => {
  res.setHeader('profile-update-interval', '1');
  res.setHeader('subscription-auto-update-enable', '1');
  res.setHeader('subscription-auto-update-open-enable', '1');
  res.setHeader('hide-settings', '1');
  if (HAPP_PROVIDER_ID) res.setHeader('providerid', HAPP_PROVIDER_ID);
  res.setHeader('content-disposition', 'attachment; filename="cyber-x-silent"');
  res.setHeader('Content-Type', 'application/json');

  let targetConfig = BASE_CONFIG;
  try {
    const c = credsFrom(req);
    const db = await getDb(false, c);
    const m = db.maintenance || DEFAULT_MAINT;

    if (m.enabled) {
      targetConfig = { ...EXPIRED_CONFIG, remarks: `⚠️ MAINTENANCE: ${m.message}` };
    } else {
      const { key } = req.query;
      const record = key ? await findActiveKey(key, c) : null;
      if (!record) targetConfig = EXPIRED_CONFIG;
      else {
        const expiresAt = new Date(record.expiresAt);
        res.setHeader('subscription-userinfo', `upload=0; download=0; total=107374182400; expire=${Math.floor(expiresAt.getTime() / 1000)}`);
      }
    }
  } catch (e) {
    targetConfig = EXPIRED_CONFIG;
  }

  return res.status(200).send(JSON.stringify(targetConfig));
});

app.get('/api/check-key', async (req, res) => {
  try {
    const c = credsFrom(req);
    const db = await getDb(false, c);
    const m = db.maintenance || DEFAULT_MAINT;
    if (m.enabled) return res.json({ valid: false, maintenance: true, message: m.message });

    const { key } = req.query;
    if (!key) return res.json({ valid: false, message: "Please enter an access key." });
    if (!db.keys.find(k => k.key === key)) return res.json({ valid: false, message: "Invalid key." });

    const record = await findActiveKey(key, c);
    if (!record) return res.json({ valid: false, message: "Key has expired." });

    return res.json({
      valid: true,
      key: record.key,
      startedAt: record.startedAt || record.activatedAt,
      activatedAt: record.activatedAt,
      expiresAt: record.expiresAt,
      durationHours: record.durationHours,
      remainingMs: new Date(record.expiresAt).getTime() - Date.now(),
      message: "Access Key Validated!"
    });
  } catch (e) {
    return res.json({ valid: false, message: "Storage error: " + e.message });
  }
});

/* ================= ADMIN ================= */
app.post('/api/admin/login', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ success: false, error: "Invalid Admin Password." });
  return res.json({ success: true });
});

app.post('/api/admin/diag', async (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const c = credsFrom(req);
  const info = {
    storage: 'github',
    owner: c.owner || null,
    repo: c.repo || null,
    branch: c.branch,
    file: c.file,
    tokenSet: !!c.token,
    writable: !!(c.token && c.owner && c.repo),
    envSeed: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO)
  };

  try {
    const db = await getDb(true, c);
    info.keys = db.keys.length;
    info.ok = true;
    info.hint = info.writable
      ? 'Storage OK — keys are written straight to your repo.'
      : 'Read works, but a token is required to create or revoke keys.';
  } catch (e) {
    info.ok = false;
    info.error = e.message;
    info.hint = 'Check owner, repo, branch and path. The token needs Contents: Read and write.';
  }
  return res.json(info);
});

/* Save credentials from the panel and verify them */
app.post('/api/admin/github-config', async (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const incoming = req.body.gh || {};
  const next = { ...cfg };
  for (const k of ['owner', 'repo', 'branch', 'file', 'token']) {
    if (incoming[k] !== undefined && incoming[k] !== '') next[k] = String(incoming[k]).trim();
  }
  if (!next.branch) next.branch = 'main';
  if (!next.file) next.file = 'data/keys.json';

  if (!next.owner || !next.repo) return res.status(400).json({ success: false, error: "Owner and repo are required." });

  try {
    const f = await ghRead(next);
    if (f.text === null && next.token) {
      await ghWrite(next, JSON.stringify(EMPTY_DB(), null, 2), null);
    }
  } catch (e) {
    return res.status(400).json({ success: false, error: "Could not reach that repo: " + e.message });
  }

  cfg = next;
  saveCfg();
  cache = { data: null, sha: null, at: 0, sig: '' };
  console.log(`[cfg] storage set to ${cfg.owner}/${cfg.repo}:${cfg.file}`);
  return res.json({ success: true, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, file: cfg.file, tokenSet: !!cfg.token });
});

app.post('/api/admin/github-test', async (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });
  const c = credsFrom(req);
  try {
    const db = await getDb(true, c);
    return res.json({ success: true, keys: db.keys.length, writable: !!c.token });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

app.post('/api/admin/create-key', async (req, res) => {
  const { adminPass, startNow } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const c = credsFrom(req);
  if (!c.token) return res.status(400).json({ error: "No GitHub token configured — cannot write." });

  const durationHours = parseDuration(req.body);
  console.log('[create-key] body =', JSON.stringify(req.body), '=> durationHours =', durationHours);

  try {
    const record = await mutate(c, db => {
      let key;
      do { key = "CYBER-" + Math.random().toString(36).substring(2, 8).toUpperCase(); }
      while (db.keys.find(k => k.key === key));

      const now = Date.now();
      const started = !!startNow;
      const rec = {
        key,
        durationHours,
        createdAt: new Date(now).toISOString(),
        startedAt: started ? new Date(now).toISOString() : null,
        activatedAt: started ? new Date(now).toISOString() : null,
        expiresAt: started ? new Date(now + durationHours * 3600000).toISOString() : null
      };
      db.keys.push(rec);
      return rec;
    });
    return res.json({ success: true, record, durationHours });
  } catch (e) {
    return res.status(500).json({ error: "Write failed: " + e.message });
  }
});

app.post('/api/admin/list-keys', async (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });
  try {
    const db = await getDb(true, credsFrom(req));
    const keys = [...db.keys].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ keys, maintenance: db.maintenance });
  } catch (e) {
    return res.status(500).json({ error: "Read failed: " + e.message, keys: [] });
  }
});

app.post('/api/admin/revoke-key', async (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });
  const c = credsFrom(req);
  if (!c.token) return res.status(400).json({ error: "No GitHub token configured." });

  try {
    await mutate(c, db => {
      const idx = db.keys.findIndex(k => k.key === key);
      if (idx >= 0) db.keys.splice(idx, 1);
    });
    happLinkCache.delete(key);
    return res.json({ success: true, message: `Key ${key} revoked.` });
  } catch (e) {
    return res.status(500).json({ error: "Write failed: " + e.message });
  }
});

app.post('/api/admin/repair-key', async (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });
  const c = credsFrom(req);
  if (!c.token) return res.status(400).json({ error: "No GitHub token configured." });

  const durationHours = parseDuration(req.body);

  try {
    const rec = await mutate(c, db => {
      const r = db.keys.find(k => k.key === key);
      if (!r) return null;
      r.durationHours = durationHours;
      r.activatedAt = null;
      r.startedAt = null;
      r.expiresAt = null;
      return r;
    });
    if (!rec) return res.status(404).json({ error: "Key not found." });
    happLinkCache.delete(key);
    return res.json({ success: true, record: rec, durationHours });
  } catch (e) {
    return res.status(500).json({ error: "Write failed: " + e.message });
  }
});

app.post('/api/admin/maintenance', async (req, res) => {
  const { adminPass, enabled, message } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });
  const c = credsFrom(req);
  if (!c.token) return res.status(400).json({ error: "No GitHub token configured." });

  try {
    const m = await mutate(c, db => {
      db.maintenance = { enabled: !!enabled, message: message || "System under maintenance." };
      return db.maintenance;
    });
    return res.json({ success: true, maintenance: m });
  } catch (e) {
    return res.status(500).json({ error: "Write failed: " + e.message });
  }
});

/* ================= FRONTEND ================= */
app.get('/admin', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'admin.html')));
app.use(express.static(FRONTEND_DIR));

/* ================= BOOT ================= */
const PORT = process.env.PORT || 3000;
loadCfg();
app.listen(PORT, () => {
  console.log(`Server active on port ${PORT}`);
  console.log(ready(cfg)
    ? `[cfg] storage -> ${cfg.owner}/${cfg.repo}:${cfg.file} (${cfg.token ? 'token' : 'no token'})`
    : '[cfg] no GitHub storage configured yet — set it in the admin panel');
});
