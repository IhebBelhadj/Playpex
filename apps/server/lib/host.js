'use strict';

// The program this server runs in (docs/server-separation-plan.md §8.1):
//   'headless'  bin/playpex-server.js on its own (systemd, Docker, `npm run server`)
//   'desktop'   the same entry, run by the desktop supervisor (apps/server-desktop)
//               in an Electron utilityProcess: messages over process.parentPort
//
// Messages with the desktop supervisor (plain objects, both ways):
//   supervisor → server
//     { type: 'stop' }                          graceful stop, then exit 0
//     { type: 'desktop', state }                its settings and updater state
//                                               (start at login, updates), on change
//     { type: 'request', id, action, args }     an action of ACTIONS below
//     { type: 'reply', id, ok, result | error, code }
//   server → supervisor
//     { type: 'status', status }                every STATUS_MS and on events (see status())
//     { type: 'event', topic, data }            pairing.* / device.* / session.* events
//     { type: 'fatal', code, port, playpex, message }   couldn't start (then exits 1)
//     { type: 'request', id, action, args }     desktop.set / update.check / update.install
//     { type: 'reply', … }
//
//   host.kind()                       'headless' | 'desktop'
//   host.desktop()                    the supervisor's last state, or null
//   host.request(action, args)        → Promise (rejects with code NOT_SUPPORTED when not desktop)

var logger = require('./logger'),
  log = logger.child('server');

var STATUS_MS = 5000,
  REQUEST_MS = 15000,
  FORWARDED = /^(pairing|device|session)\./;

var kind = 'headless',
  port = null,           // process.parentPort
  desktopState = null,
  pending = {},          // id → { resolve, reject, timer }
  nextId = 1,
  statusTimer = null,
  statusQueued = null,
  onStop = null;

function send(message) {
  if (port) {
    try {
      port.postMessage(message);
    } catch (e) {
      // the supervisor is gone: nothing to tell
    }
  }
}

function fail(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// ── status for the tray ────────────────────────────────────────────────────

/**
 * What the tray shows: { state: 'starting' | 'running' | 'recovery', version,
 * port, dashboardUrl, urls, recovery, streams, devicesOnline, torrents,
 * pausedTorrents, setupNeeded, pairing: [{ userCode, client, address, expiresAt }],
 * downloadDir, logsDir }
 */
function status() {
  var core = require('../index'),
    info = core.info(),
    auth = require('./auth'),
    events = require('./events'),
    sessions = require('./sessions'),
    store = require('./store'),
    settings = require('./settings'),
    paths = require('./paths'),
    torrents = store.list();
  if (!info) {
    return Promise.resolve({ state: 'starting', version: require('../package.json').version });
  }
  return Promise.all([
    auth.setupNeeded().catch(function () { return false; }),
    auth.pendingRequests().catch(function () { return []; }),
    auth.listDevices().catch(function () { return []; })
  ]).then(function (r) {
    return {
      state: info.recovery ? 'recovery' : 'running',
      version: require('../package.json').version,
      name: info.name,
      port: info.port,
      // the dashboard, from this machine (the admin's cookie is per host:port)
      dashboardUrl: 'http://localhost:' + info.port + '/',
      urls: info.urls,
      recovery: info.recovery,
      streams: sessions.count(),
      devicesOnline: events.markOnline(r[2]).filter(function (d) { return d.online; }).length,
      torrents: torrents.length,
      pausedTorrents: torrents.filter(function (t) { return t.swarm && t.swarm.paused; }).length,
      setupNeeded: r[0],
      pairing: r[1].map(function (p) {
        return { userCode: p.userCode, client: p.client, clientId: p.clientId, address: p.address, expiresAt: p.expiresAt };
      }),
      downloadDir: settings.get('storage.downloadDir') || paths.downloads,
      logsDir: paths.logs
    };
  });
}

function pushStatus() {
  if (!port || statusQueued) {
    return;
  }
  // Events come in bursts (a session starts, a device pairs…): one status for all
  statusQueued = setTimeout(function () {
    statusQueued = null;
    status().then(function (s) { send({ type: 'status', status: s }); }, function (err) {
      log.warn('status for the supervisor failed: ' + err.message);
    });
  }, 100);
}

// ── actions the supervisor can ask for ─────────────────────────────────────

function eachTorrent(fn) {
  var count = 0;
  require('./store').list().forEach(function (t) {
    if (t.swarm && fn(t)) {
      count++;
    }
  });
  pushStatus();
  return { ok: true, count: count };
}

var ACTIONS = {
  status: function () {
    return status();
  },
  'pairing.approve': function (args) {
    return require('./auth').approve(args.code);
  },
  'pairing.deny': function (args) {
    return require('./auth').deny(args.code);
  },
  // Pauses every running torrent's swarm (no new peer connections or
  // requests); torrents added afterwards aren't affected
  'torrents.pauseAll': function () {
    return eachTorrent(function (t) {
      if (t.swarm.paused) {
        return false;
      }
      t.swarm.pause();
      return true;
    });
  },
  'torrents.resumeAll': function () {
    return eachTorrent(function (t) {
      if (!t.swarm.paused) {
        return false;
      }
      t.swarm.resume();
      return true;
    });
  }
};

function onMessage(event) {
  var message = event && event.data !== undefined ? event.data : event;
  if (!message || typeof message !== 'object') {
    return;
  }
  switch (message.type) {
    case 'stop':
      if (onStop) {
        onStop('supervisor');
      }
      break;
    case 'desktop':
      desktopState = message.state || null;
      require('./events').publish('host.updated', { kind: kind, desktop: desktopState }, { admin: true });
      break;
    case 'request':
      var action = ACTIONS[message.action];
      Promise.resolve().then(function () {
        if (!action) {
          throw fail('NOT_FOUND', 'Unknown action ' + message.action);
        }
        return action(message.args || {});
      }).then(function (result) {
        send({ type: 'reply', id: message.id, ok: true, result: result === undefined ? null : result });
      }, function (err) {
        send({ type: 'reply', id: message.id, ok: false, error: err.message, code: err.code || 'INTERNAL' });
      });
      break;
    case 'reply':
      var waiting = pending[message.id];
      if (waiting) {
        delete pending[message.id];
        clearTimeout(waiting.timer);
        if (message.ok) {
          waiting.resolve(message.result);
        } else {
          waiting.reject(fail(message.code || 'INTERNAL', message.error || 'The desktop app refused'));
        }
      }
      break;
  }
}

/**
 * Called by bin/playpex-server.js when it runs in the supervisor's utilityProcess.
 * @param {{ postMessage: function, on: function }} parentPort  process.parentPort
 * @param {{ stop: function(string) }} handlers  stop: graceful shutdown
 */
function attachSupervisor(parentPort, handlers) {
  kind = 'desktop';
  port = parentPort;
  onStop = handlers && handlers.stop;
  port.on('message', onMessage);
  require('./events').onPublish(function (topic, data) {
    if (FORWARDED.test(topic)) {
      send({ type: 'event', topic: topic, data: data });
      pushStatus();
    }
  });
  statusTimer = setInterval(pushStatus, STATUS_MS);
  statusTimer.unref();
}

// Tells the supervisor why the server couldn't start (it then exits 1)
function fatal(err) {
  send({ type: 'fatal', code: err.code || 'INTERNAL', port: err.port || null, playpex: !!err.playpex, message: err.message });
}

// Asks the supervisor for something (the dashboard's desktop settings, updates)
function request(action, args) {
  if (!port) {
    return Promise.reject(fail('NOT_SUPPORTED', 'Only the desktop app (Playpex Media Server with its tray icon) can do this'));
  }
  var id = 's' + nextId++;
  return new Promise(function (resolve, reject) {
    pending[id] = {
      resolve: resolve,
      reject: reject,
      timer: setTimeout(function () {
        delete pending[id];
        reject(fail('INTERNAL', 'The desktop app did not answer'));
      }, REQUEST_MS)
    };
    send({ type: 'request', id: id, action: action, args: args || {} });
  });
}

module.exports = {
  kind: function () { return kind; },
  setKind: function (k) { kind = k; },
  desktop: function () { return desktopState; },
  attachSupervisor: attachSupervisor,
  fatal: fatal,
  request: request,
  status: status,
  pushStatus: pushStatus
};
