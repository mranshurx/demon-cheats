const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cors());

const KEYS_FILE = path.join(__dirname, 'keys.json');
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance.json');
const ADMIN_SECRET_PASS = "ANSHU-BHAI-CYBER";

// Optional but recommended: paste your happ-proxy.com Provider ID.
const HAPP_PROVIDER_ID = ""; // e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

// YOUR HYSTERIA & GAME ROUTING CONFIGURATION
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

function readKeys() {
  if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '[]');
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (e) { return []; }
}

function readMaintenance() {
  if (!fs.existsSync(MAINTENANCE_FILE)) return { enabled: false, message: "System under maintenance." };
  try { return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')); } catch (e) { return { enabled: false, message: "System under maintenance." }; }
}

/* ============================================================
   HAPP ENCRYPTED LINK  (hides the URL + the JSON config in-app)
   ============================================================ */
const happLinkCache = new Map(); // key -> happ://crypt5/... link

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

function encryptHappLink(subUrl) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ url: subUrl });
    const req = https.request({
      hostname: 'crypto.happ.su',
      path: '/api-v2.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j && j.encrypted_link ? j.encrypted_link : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(9000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

app.get('/api/maintenance-status', (req, res) => {
  res.json(readMaintenance());
});

// Returns the encrypted happ:// link for a valid key (cached).
app.get('/api/happ-link', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({ ok: false, reason: 'no-key' });

  const record = readKeys().find(k => k.key === key);
  if (!record || new Date() > new Date(record.expiresAt)) return res.json({ ok: false, reason: 'invalid' });

  const subUrl = `${baseUrl(req)}/sub?key=${encodeURIComponent(key)}`;

  if (happLinkCache.has(key)) return res.json({ ok: true, link: happLinkCache.get(key), raw: subUrl });

  const link = await encryptHappLink(subUrl);
  if (link) happLinkCache.set(key, link);
  // If Happ's service is down, fall back to the raw URL (frontend still works).
  return res.json({ ok: !!link, link: link || subUrl, raw: subUrl, encrypted: !!link });
});

// -------------------------------------------------------------
// PUBLIC SUBSCRIPTION ENDPOINT
// -------------------------------------------------------------
app.get('/sub', (req, res) => {
  const m = readMaintenance();

  // ---- Happ client-management headers ----
  res.setHeader('profile-update-interval', '1');                 // auto-update every 1 hour
  res.setHeader('subscription-auto-update-enable', '1');
  res.setHeader('subscription-auto-update-open-enable', '1');    // refresh on every app launch
  res.setHeader('hide-settings', '1');                           // hide config (needs provider id)
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
      const keys = readKeys();
      const keyRecord = keys.find(k => k.key === key);
      if (!keyRecord || new Date() > new Date(keyRecord.expiresAt)) {
        targetConfig = EXPIRED_CONFIG;
      } else {
        const expiresAt = new Date(keyRecord.expiresAt);
        res.setHeader('subscription-userinfo', `upload=0; download=0; total=107374182400; expire=${Math.floor(expiresAt.getTime() / 1000)}`);
      }
    }
  }

  return res.status(200).send(JSON.stringify(targetConfig));
});

// CLIENT PORTAL KEY CHECK API
app.get('/api/check-key', (req, res) => {
  const m = readMaintenance();
  if (m.enabled) return res.json({ valid: false, maintenance: true, message: m.message });

  const { key } = req.query;
  if (!key) return res.json({ valid: false, message: "Please enter an access key." });

  const keys = readKeys();
  const record = keys.find(k => k.key === key);
  if (!record || new Date() > new Date(record.expiresAt)) {
    return res.json({ valid: false, message: "Invalid key or key has expired/been revoked." });
  }

  return res.json({ valid: true, key: record.key, expiresAt: record.expiresAt, message: "Access Key Validated!" });
});

// ADMIN APIs
app.post('/api/admin/login', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ success: false, error: "Invalid Admin Password." });
  return res.json({ success: true });
});

app.post('/api/admin/create-key', (req, res) => {
  const { adminPass, durationHours } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized." });

  const keys = readKeys();
  const randomKey = "CYBER-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + parseInt(durationHours || 24));

  const newRecord = { key: randomKey, expiresAt: expiresAt.toISOString(), createdAt: new Date().toISOString() };
  keys.push(newRecord);
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  return res.json({ success: true, record: newRecord });
});

app.post('/api/admin/list-keys', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });
  const keys = readKeys().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ keys, maintenance: readMaintenance() });
});

app.post('/api/admin/revoke-key', (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  let keys = readKeys();
  keys = keys.filter(k => k.key !== key);
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  happLinkCache.delete(key);
  return res.json({ success: true, message: `Key ${key} revoked instantly.` });
});

app.post('/api/admin/maintenance', (req, res) => {
  const { adminPass, enabled, message } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  const updateData = { enabled: !!enabled, message: message || "System under maintenance." };
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(updateData, null, 2));
  return res.json({ success: true, maintenance: updateData });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
