'use strict';

// Which server the TV app uses (docs/server-separation-plan.md §10). Resolved
// in the main process before the UI loads, again when the user picks another
// server, and on "Retry" after the connection was lost.
//
//   connection.resolve() → Promise<state>
//   connection.state()   { server: { id, name, url, local, paired } | null,
//                          reason: null | 'none' | 'unreachable' | 'pairing' | 'revoked' | 'incompatible',
//                          detail, candidate: { id, name, url, local } | null }
//   connection.auth()    { origin, token, deviceId } for the header injection (auth.js)
//   connection.choose({ id, name, url }) / connection.drop(reason, detail)
//
// Resolution: the last server used, at its saved URL; when that fails, found
// again by its id (a new port or address: discovery.find); with none chosen
// yet, a server on this machine (loopback needs no pairing). A server on
// another machine is used once this device holds a token for it.

const protocol = require('@playpex/protocol');
const local = require('@playpex/protocol/local');
const config = require('./clientConfig');
const { createDiscovery, serverInfo } = require('./discovery');

const CHECK_TIMEOUT_MS = 2500;
const FIND_TIMEOUT_MS = 6000;

let current = { server: null, reason: 'none', detail: null, candidate: null };
let token = null;

function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch (e) {
    return false;
  }
}

function incompatibility(info) {
  if (protocol.API_VERSION < (info.minApiVersion || info.apiVersion)) {
    return 'CLIENT_TOO_OLD';
  }
  if (protocol.API_VERSION > info.apiVersion) {
    return 'SERVER_TOO_OLD';
  }
  return null;
}

function set(next) {
  current = Object.assign({ server: null, reason: null, detail: null, candidate: null }, next);
  token = current.server ? (config.server(current.server.id) || {}).token || null : null;
  return current;
}

// The server answered at `url` with `info`: use it, unless this device can't
function use(info, url) {
  const candidate = { id: info.id, name: info.name, url, local: isLoopback(url) };
  config.saveServer(info.id, { name: info.name, url });
  config.setLastServerId(info.id);
  const tooOld = incompatibility(info);
  if (tooOld) {
    return set({ reason: 'incompatible', detail: tooOld, candidate });
  }
  const saved = config.server(info.id);
  if (!candidate.local && !(saved && saved.token)) {
    return set({ reason: 'pairing', candidate });
  }
  return set({ server: Object.assign({ paired: !!(saved && saved.token) }, candidate) });
}

function check(url, id) {
  return serverInfo(url, CHECK_TIMEOUT_MS).then(info => (!id || info.id === id ? info : null), () => null);
}

function resolve() {
  const id = config.lastServerId();
  if (id) {
    const saved = config.server(id);
    const name = saved && saved.name || id;
    return (saved && saved.url ? check(saved.url, id) : Promise.resolve(null)).then(info => {
      if (info) {
        return use(info, saved.url);
      }
      // moved (new port, new address): look for it by id
      const discovery = createDiscovery({ localPort: local.configuredPort() });
      return discovery.find(id, FIND_TIMEOUT_MS).then(found => {
        if (!found) {
          return set({ reason: 'unreachable', detail: name, candidate: saved && saved.url ? { id, name, url: saved.url, local: isLoopback(saved.url) } : null });
        }
        return check(found.url, id).then(info => info ? use(info, found.url) : set({ reason: 'unreachable', detail: name }));
      });
    });
  }
  // Nothing chosen yet: a server on this machine needs no pairing
  const url = 'http://127.0.0.1:' + local.configuredPort();
  return check(url).then(info => info ? use(info, url) : set({ reason: 'none' }));
}

// The user picked a server (/connect), or pairing with it just worked
function choose(server) {
  config.saveServer(server.id, { name: server.name, url: server.url });
  config.setLastServerId(server.id);
  return resolve();
}

// The renderer saw the server refuse this device: 401 PAIRING_REQUIRED
// (revoked, or loopback pairing turned on) or 426 (API versions)
function drop(reason, detail) {
  const server = current.server;
  if (!server) {
    return current;
  }
  const candidate = { id: server.id, name: server.name, url: server.url, local: server.local };
  if (reason === 'revoked') {
    const hadToken = !!token;
    config.forgetToken(server.id);
    return set({ reason: hadToken ? 'revoked' : 'pairing', detail: server.name, candidate });
  }
  return set({ reason: 'incompatible', detail: detail === 'SERVER_TOO_OLD' ? 'SERVER_TOO_OLD' : 'CLIENT_TOO_OLD', candidate });
}

// For the server list: what this device knows about each discovered server
function annotate(server) {
  const saved = config.server(server.id);
  return Object.assign({}, server, {
    paired: !!(saved && saved.token),
    current: !!(current.server && current.server.id === server.id),
    // by URL, as the server sees it: this machine at its LAN address pairs too
    needsPairing: !isLoopback(server.url) && !(saved && saved.token)
  });
}

module.exports = {
  resolve,
  choose,
  drop,
  annotate,
  isLoopback,
  state: () => current,
  auth: () => ({ origin: current.server ? current.server.url : null, token, deviceId: config.deviceId() })
};
