'use strict';

// This install's own state (docs/server-separation-plan.md §10.1): client.json
// in Electron's userData (~/.config/Playpex TV), never in the server's dirs.
//
//   { deviceId, deviceName, lastServerId,
//     servers: { <server id>: { name, url, token: { storage: 'safe' | 'plain', value } | null } } }
//
// Device tokens are encrypted with Electron's safeStorage (Keychain, DPAPI,
// libsecret / KWallet). Linux without a keyring: stored as plain text in this
// 0600 file, and the UI says so (tokenStorage() === 'plain').
//
//   const config = require('./clientConfig')    after app 'ready' (safeStorage)
//   config.deviceId() / config.deviceName()
//   config.server(id) → { id, name, url, token } (token decrypted) | null
//   config.saveServer(id, { name, url }) / config.setToken(id, token) / config.forgetToken(id) / config.forget(id)
//   config.lastServerId() / config.setLastServerId(id)

const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = 'client.json';

let data = null;

function file() {
  return path.join(app.getPath('userData'), FILE);
}

function load() {
  if (data) {
    return data;
  }
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (e) {
    data = {};
  }
  data.servers = data.servers && typeof data.servers === 'object' ? data.servers : {};
  return data;
}

function save() {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// 'encrypted' when safeStorage really encrypts; Chromium's basic_text backend
// (Linux without gnome-keyring / KWallet) only obfuscates with a fixed key
function tokenStorage() {
  if (!safeStorage.isEncryptionAvailable()) {
    return 'plain';
  }
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return 'plain';
  }
  return 'encrypted';
}

function seal(token) {
  if (tokenStorage() === 'encrypted') {
    return { storage: 'safe', value: safeStorage.encryptString(token).toString('base64') };
  }
  return { storage: 'plain', value: token };
}

function unseal(sealed) {
  if (!sealed || typeof sealed.value !== 'string') {
    return null;
  }
  if (sealed.storage === 'plain') {
    return sealed.value;
  }
  try {
    return safeStorage.decryptString(Buffer.from(sealed.value, 'base64'));
  } catch (e) {
    return null;   // keyring changed or gone: pair again
  }
}

function deviceId() {
  load();
  if (!data.deviceId) {
    data.deviceId = 'tv-' + crypto.randomBytes(16).toString('hex');
    data.deviceIdIsNew = true;
    save();
  }
  return data.deviceId;
}

// Once, on the first run: adopts the id the renderer kept in localStorage
// before step 9 (null when it had none), so the server's leases and device
// names don't change
function adoptDeviceId(id) {
  deviceId();
  if (!data.deviceIdIsNew) {
    return data.deviceId;
  }
  if (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
    data.deviceId = id;
  }
  delete data.deviceIdIsNew;
  save();
  return data.deviceId;
}

function deviceName() {
  load();
  return data.deviceName || 'Playpex TV (' + os.hostname().replace(/\.local$/, '') + ')';
}

function server(id) {
  const s = id && load().servers[id];
  if (!s) {
    return null;
  }
  return { id, name: s.name, url: s.url, token: unseal(s.token) };
}

function saveServer(id, info) {
  load();
  const s = data.servers[id] || { token: null };
  s.name = info.name || s.name || id;
  s.url = info.url || s.url;
  data.servers[id] = s;
  save();
}

function setToken(id, token) {
  load();
  if (!data.servers[id]) {
    data.servers[id] = { name: id, url: null };
  }
  data.servers[id].token = token ? seal(token) : null;
  save();
}

function forgetToken(id) {
  if (load().servers[id]) {
    data.servers[id].token = null;
    save();
  }
}

function forget(id) {
  load();
  delete data.servers[id];
  if (data.lastServerId === id) {
    data.lastServerId = null;
  }
  save();
}

function lastServerId() {
  return load().lastServerId || null;
}

function setLastServerId(id) {
  load();
  data.lastServerId = id || null;
  save();
}

// ids of the servers this device holds a token for
function pairedIds() {
  load();
  return Object.keys(data.servers).filter(id => data.servers[id].token);
}

module.exports = {
  tokenStorage,
  deviceId,
  adoptDeviceId,
  deviceIdIsNew: () => !!load().deviceIdIsNew,
  deviceName,
  server,
  saveServer,
  setToken,
  forgetToken,
  forget,
  lastServerId,
  setLastServerId,
  pairedIds
};
