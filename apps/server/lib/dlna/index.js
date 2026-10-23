'use strict';

// The DLNA / UPnP AV media server (docs/media-server-plan.md §7, step 8):
// TVs, consoles and players on the LAN browse and play the library without
// Playpex TV. SSDP (./ssdp.js), a device + service descriptions
// (./descriptions.js), ContentDirectory over the library's rows (./tree.js)
// and a DLNA-only HTTP listener (./http.js) on `dlna.port`.
//
//   dlna.start(info, { lan, port?, ssdpPort? })   from index.js once listening
//   dlna.stop() → Promise                         ssdp:byebye, closes the listener
//   dlna.refresh() → Promise                      after `dlna.*` or the server name changed
//   dlna.status()                                 for the dashboard (GET /admin/dlna)
//
// DLNA has no authentication, so it is off by default (`dlna.enabled`), runs
// only with LAN sharing and outside recovery mode, serves only folders marked
// "include in DLNA" whose audience is `everyone`, answers only private /
// loopback / link-local addresses, and changes nothing (no write action).

var http = require('http'),
  os = require('os'),
  crypto = require('crypto'),
  axios = require('axios'),
  settings = require('../settings'),
  events = require('../events'),
  userData = require('../userData'),
  discovery = require('../discovery'),
  ssdp = require('./ssdp'),
  tree = require('./tree'),
  dlnaHttp = require('./http'),
  log = require('../logger').child('dlna');

var SEEN_MS = 24 * 3600 * 1000,
  MAX_SEEN = 100;

var current = null,     // start()'s arguments, for refresh()
  running = null,       // { server, sockets, app, ssdp, port }
  state = initialState(),
  snapshot = null,      // Promise of the tree's snapshot, until the library changes
  updateId = (Math.floor(Date.now() / 1000) >>> 0),
  seen = {},            // address → { address, userAgent, lastSeenAt, lastPlayedAt, name }
  renderers = {},       // address → { location, name, fetched }
  listening = false,
  starting = Promise.resolve();   // start()'s promise (ready())

function initialState() {
  return {
    enabled: false,
    reason: null,       // why it is off: 'disabled' | 'lanSharing' | 'recovery'
    http: { state: 'off', port: null, error: null },
    ssdp: { state: 'off', port: null, error: null }
  };
}

// A stable UDN from the server id (DLNA devices remember servers by it)
function udnOf(id) {
  var h = crypto.createHash('sha1').update('playpex-dlna:' + id).digest('hex');
  return 'uuid:' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' +
    ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function serverHeader(info) {
  return os.type() + '/' + os.release().split('-')[0] + ' UPnP/1.0 DLNADOC/1.50 Playpex/' + info.version;
}

function ctxInfo() {
  var info = current.info;
  return {
    id: info.id,
    udn: udnOf(info.id),
    name: settings.get('general.serverName'),
    version: info.version,
    apiPort: info.port,
    server: serverHeader(info)
  };
}

function getSnapshot() {
  if (!snapshot) {
    snapshot = userData.services().then(function (s) {
      return Promise.all([s.library.shown({ kid: true }), s.library.folders()]);
    }).then(function (r) {
      return tree.build(r[0], r[1]);
    });
    snapshot.catch(function (err) {
      log.warn('DLNA library unavailable: ' + err.message);
      snapshot = null;
    });
  }
  return snapshot;
}

function onEvent(topic) {
  if (topic !== 'library.changed') {
    return;
  }
  snapshot = null;
  updateId = (updateId + 1) >>> 0;
  if (running) {
    running.app.notifyChange();
  }
}

// ── "seen by": renderers that browsed or played in the last day ────────────

function prune() {
  var now = Date.now();
  Object.keys(seen).forEach(function (address) {
    if (now - seen[address].lastSeenAt > SEEN_MS) {
      delete seen[address];
    }
  });
  var all = Object.keys(seen);
  if (all.length > MAX_SEEN) {
    all.sort(function (a, b) { return seen[a].lastSeenAt - seen[b].lastSeenAt; })
      .slice(0, all.length - MAX_SEEN).forEach(function (a) { delete seen[a]; });
  }
}

// The renderer's own name, from the description it announced (only from its
// own address: nothing else is ever fetched)
function lookUpName(address) {
  var r = renderers[address];
  if (!r || r.fetched) {
    return;
  }
  r.fetched = true;
  var url;
  try {
    url = new URL(r.location);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'http:' || url.hostname !== address) {
    return;
  }
  axios.get(url.href, { timeout: 3000, maxContentLength: 256 * 1024, responseType: 'text' }).then(function (res) {
    var body = String(res.data),
      pick = function (tag) {
        var m = new RegExp('<' + tag + '>([^<]{1,120})</' + tag + '>').exec(body);
        return m ? require('./xml').unescape(m[1]).trim() : null;
      },
      name = pick('friendlyName') || [pick('manufacturer'), pick('modelName')].filter(Boolean).join(' ') || null;
    r.name = name;
    if (seen[address]) {
      seen[address].name = name;
    }
  }, function (err) {
    log.debug('renderer description unreadable: ' + err.message, { from: address });
  });
}

function noteSeen(address, userAgent, action) {
  var entry = seen[address] || (seen[address] = { address: address, userAgent: null, lastSeenAt: 0, lastPlayedAt: null, name: null });
  entry.lastSeenAt = Date.now();
  if (action === 'played') {
    entry.lastPlayedAt = entry.lastSeenAt;
  }
  if (userAgent) {
    entry.userAgent = String(userAgent).slice(0, 200);
  }
  if (renderers[address]) {
    entry.name = renderers[address].name || entry.name;
    lookUpName(address);
  }
  prune();
}

function noteRenderer(address, location) {
  var r = renderers[address];
  if (!r || r.location !== location) {
    renderers[address] = { location: location, name: r ? r.name : null, fetched: false };
    if (Object.keys(renderers).length > MAX_SEEN * 2) {
      delete renderers[Object.keys(renderers)[0]];
    }
  }
  if (seen[address]) {
    lookUpName(address);
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function listen(server, port) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', function () {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function start(info, options) {
  starting = begin(info, options || {});
  return starting;
}

function begin(info, options) {
  current = { info: info, options: options };
  state = initialState();
  if (!listening) {
    events.onPublish(onEvent);
    listening = true;
  }
  if (info.recovery) {
    state.reason = 'recovery';
  } else if (!settings.get('dlna.enabled')) {
    state.reason = 'disabled';
  } else if (!options.lan) {
    state.reason = 'lanSharing';
  }
  if (state.reason) {
    log.debug('DLNA off (' + state.reason + ')');
    return Promise.resolve();
  }
  state.enabled = true;
  var port = options.port !== undefined ? options.port : settings.get('dlna.port'),
    me = current;
  if (port === info.port) {
    state.http = { state: 'error', port: port, error: 'the DLNA port can\'t be the HTTP port (' + port + ')' };
    log.warn('DLNA not started: ' + state.http.error);
    return Promise.resolve();
  }
  var app = dlnaHttp.create({
      info: ctxInfo,
      snapshot: getSnapshot,
      updateId: function () { return updateId; },
      seen: noteSeen
    }),
    server = http.createServer(app),
    sockets = new Set();
  server.on('connection', function (socket) {
    sockets.add(socket);
    socket.on('close', function () { sockets.delete(socket); });
  });
  state.http = { state: 'starting', port: port, error: null };
  return listen(server, port).then(function (bound) {
    if (current !== me) {
      server.close();
      return;
    }
    state.http = { state: 'listening', port: bound, error: null };
    running = { server: server, sockets: sockets, app: app, port: bound, ssdp: null };
    running.ssdp = ssdp.start({
      udn: udnOf(info.id),
      port: bound,
      server: serverHeader(info),
      ssdpPort: options.ssdpPort,
      onRenderer: noteRenderer
    });
    log.info('DLNA media server "' + settings.get('general.serverName') + '" on port ' + bound);
  }, function (err) {
    state.http = {
      state: 'error',
      port: port,
      error: err.code === 'EADDRINUSE' ? 'port ' + port + ' is in use by another program' :
        err.code === 'EACCES' ? 'not allowed to listen on port ' + port : err.message
    };
    log.warn('DLNA not started: ' + state.http.error, { code: err.code });
  });
}

function stop() {
  var r = running;
  running = null;
  current = null;
  state = initialState();
  if (!r) {
    return Promise.resolve();
  }
  r.app.closeSubscriptions();
  return r.ssdp.stop().then(function () {
    return new Promise(function (resolve) {
      r.server.close(function () { resolve(); });
      r.sockets.forEach(function (socket) { socket.destroy(); });
    });
  });
}

function refresh() {
  if (!current) {
    return Promise.resolve();
  }
  var again = current;
  return stop().then(function () {
    return start(again.info, again.options);
  });
}

// The description's URL on each LAN address
function urls(port) {
  return ssdp.interfaces().filter(function (iface) {
    return discovery.isLocalAddress(iface.address);
  }).map(function (iface) {
    return 'http://' + iface.address + ':' + port + '/dlna/description.xml';
  });
}

function status() {
  prune();
  var info = current && current.info;
  return {
    enabled: state.enabled,
    reason: state.reason,
    name: settings.get('general.serverName'),
    udn: info ? udnOf(info.id) : null,
    http: Object.assign({}, state.http),
    ssdp: running ? running.ssdp.status() : Object.assign({}, state.ssdp),
    urls: running ? urls(running.port) : [],
    renderers: Object.keys(seen).map(function (address) {
      var e = seen[address];
      return {
        address: e.address,
        name: e.name || null,
        userAgent: e.userAgent,
        lastSeenAt: new Date(e.lastSeenAt).toISOString(),
        lastPlayedAt: e.lastPlayedAt ? new Date(e.lastPlayedAt).toISOString() : null
      };
    }).sort(function (a, b) { return a.lastSeenAt < b.lastSeenAt ? 1 : -1; })
  };
}

module.exports = {
  start: start,
  // resolves once the last start() has its listener (or failed)
  ready: function () { return starting; },
  stop: stop,
  refresh: refresh,
  status: status,
  snapshot: getSnapshot,
  // tests
  udnOf: udnOf
};
