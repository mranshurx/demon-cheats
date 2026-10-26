const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const KEYS_FILE = path.join(__dirname, 'keys.json');
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance.json');
const ADMIN_SECRET_PASS = "ANSHU-BHAI-CYBER"; 

// YOUR EXACT HYSTERIA & GAME ROUTING CONFIGURATION
const BASE_CONFIG = {
  "remarks": "CYBER X SILENT [Auto-Update: 1h]",
  "profile-update-interval": 3600,
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
  "profile-update-interval": 3600,
  "inbounds": [],
  "outbounds": [{ "tag": "blocked", "protocol": "blackhole" }],
  "routing": { "rules": [] }
};

function readKeys() {
  if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '[]');
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

function readMaintenance() {
  if (!fs.existsSync(MAINTENANCE_FILE)) {
    return { enabled: false, message: "System under maintenance." };
  }
  try {
    return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
  } catch (e) {
    return { enabled: false, message: "System under maintenance." };
  }
}

function writeMaintenance(data) {
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(data, null, 2));
}

// -------------------------------------------------------------
// MAINTENANCE STATUS API
// -------------------------------------------------------------
app.get('/api/maintenance-status', (req, res) => {
  res.json(readMaintenance());
});

// -------------------------------------------------------------
// PUBLIC SUBSCRIPTION ENDPOINT (Happ App)
// -------------------------------------------------------------
app.get('/sub', (req, res) => {
  const m = readMaintenance();
  res.setHeader('profile-update-interval', '3600');
  res.setHeader('Content-Type', 'application/json');

  if (m.enabled) {
    let maintConfig = { ...EXPIRED_CONFIG };
    maintConfig.remarks = `⚠️ MAINTENANCE: ${m.message}`;
    return res.status(200).send(JSON.stringify(maintConfig, null, 2));
  }

  const { key } = req.query;
  if (!key) return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));

  const keys = readKeys();
  const keyRecord = keys.find(k => k.key === key);

  if (!keyRecord) return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));

  const now = new Date();
  const expiresAt = new Date(keyRecord.expiresAt);

  if (now > expiresAt) {
    return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));
  }

  const expireEpochSeconds = Math.floor(expiresAt.getTime() / 1000);
  res.setHeader('subscription-userinfo', `upload=0; download=0; total=107374182400; expire=${expireEpochSeconds}`);

  return res.status(200).send(JSON.stringify(BASE_CONFIG, null, 2));
});

// -------------------------------------------------------------
// CLIENT PORTAL KEY CHECK API
// -------------------------------------------------------------
app.get('/api/check-key', (req, res) => {
  const m = readMaintenance();
  if (m.enabled) {
    return res.json({ valid: false, maintenance: true, message: m.message });
  }

  const { key } = req.query;
  if (!key) return res.json({ valid: false, message: "Please enter an access key." });

  const keys = readKeys();
  const record = keys.find(k => k.key === key);

  if (!record) {
    return res.json({ valid: false, message: "Invalid key! Key does not exist or has been revoked." });
  }

  const now = new Date();
  const expiresAt = new Date(record.expiresAt);
  if (now > expiresAt) {
    return res.json({ valid: false, message: "This key has expired." });
  }

  return res.json({
    valid: true,
    key: record.key,
    expiresAt: record.expiresAt,
    message: "Access Key Validated!"
  });
});

// -------------------------------------------------------------
// ADMIN APIs
// -------------------------------------------------------------
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
  writeKeys(keys);

  return res.json({ success: true, record: newRecord });
});

app.post('/api/admin/list-keys', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  const keys = readKeys();
  const maintenance = readMaintenance();
  return res.json({ keys, maintenance });
});

app.post('/api/admin/revoke-key', (req, res) => {
  const { adminPass, key } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  let keys = readKeys();
  const initialLength = keys.length;
  keys = keys.filter(k => k.key !== key);

  if (keys.length === initialLength) {
    return res.json({ success: false, error: "Key not found." });
  }

  writeKeys(keys);
  return res.json({ success: true, message: `Key ${key} revoked instantly.` });
});

app.post('/api/admin/maintenance', (req, res) => {
  const { adminPass, enabled, message } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  writeMaintenance({ enabled: !!enabled, message: message || "System under maintenance." });
  return res.json({ success: true, maintenance: readMaintenance() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
