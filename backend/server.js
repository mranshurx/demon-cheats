const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const KEYS_FILE = path.join(__dirname, 'keys.json');

// Secret password for your Admin Panel API actions
const ADMIN_SECRET_PASS = "CYBER_ADMIN_PASSWORD_999"; 

// YOUR EXACT WORKING HYSTERIA & GAME ROUTING CONFIGURATION
const BASE_CONFIG = {
  "remarks": "CYBER X SILENT",
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

// DEAD CONFIG TO WIPE CACHE UPON EXPIRY
const EXPIRED_CONFIG = {
  "remarks": "❌ SUBSCRIPTION EXPIRED - ACCESS TERMINATED",
  "inbounds": [],
  "outbounds": [{ "tag": "blocked", "protocol": "blackhole" }],
  "routing": { "rules": [] }
};

function readKeys() {
  if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '[]');
  return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}

function writeKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

// -------------------------------------------------------------
// 1. PUBLIC SUBSCRIPTION ENDPOINT (Hit by Happ App)
// -------------------------------------------------------------
app.get('/sub', (req, res) => {
  const { key } = req.query;

  // Instruct client apps to auto-update every 30 minutes (0.5 hours)
  res.setHeader('profile-update-interval', '0.5');
  res.setHeader('Content-Type', 'application/json');

  if (!key) {
    return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));
  }

  const keys = readKeys();
  const keyRecord = keys.find(k => k.key === key);

  if (!keyRecord) {
    return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));
  }

  const now = new Date();
  const expiresAt = new Date(keyRecord.expiresAt);

  if (now > expiresAt) {
    // KEY EXPIRED: Send blackhole config so Happ overwrites cache & disconnects immediately
    return res.status(200).send(JSON.stringify(EXPIRED_CONFIG, null, 2));
  }

  // KEY ACTIVE: Send your real working Hysteria JSON config
  return res.status(200).send(JSON.stringify(BASE_CONFIG, null, 2));
});

// -------------------------------------------------------------
// 2. CLIENT CHECK API
// -------------------------------------------------------------
app.get('/api/check-key', (req, res) => {
  const { key } = req.query;
  const keys = readKeys();
  const record = keys.find(k => k.key === key);

  if (!record) {
    return res.json({ valid: false, message: "Key not found." });
  }

  const now = new Date();
  const expiresAt = new Date(record.expiresAt);
  const isExpired = now > expiresAt;

  return res.json({
    valid: !isExpired,
    key: record.key,
    expiresAt: record.expiresAt,
    status: isExpired ? "EXPIRED" : "ACTIVE"
  });
});

// -------------------------------------------------------------
// 3. ADMIN APIS
// -------------------------------------------------------------
app.post('/api/admin/create-key', (req, res) => {
  const { adminPass, durationHours } = req.body;

  if (adminPass !== ADMIN_SECRET_PASS) {
    return res.status(401).json({ error: "Unauthorized: Invalid Admin Password." });
  }

  const keys = readKeys();
  const randomKey = "CYBER-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + parseInt(durationHours || 24));

  const newRecord = {
    key: randomKey,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString()
  };

  keys.push(newRecord);
  writeKeys(keys);

  return res.json({ success: true, record: newRecord });
});

app.post('/api/admin/list-keys', (req, res) => {
  const { adminPass } = req.body;
  if (adminPass !== ADMIN_SECRET_PASS) return res.status(401).json({ error: "Unauthorized" });

  const keys = readKeys();
  return res.json({ keys });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
