'use strict';

// Playpex Media Server core (docs/server-separation-plan.md §5.1). Nothing
// listens on require: a host calls start() / stop().
//   headless (systemd, Docker, `npm run server`): bin/playpex-server.js
//   desktop app (tray icon): apps/server-desktop, the same entry in a utilityProcess
//
//   start(options) → Promise<{ port, host, urls, id, name }>
//     rejects with err.code 'PORT_IN_USE' / 'PORT_NOT_ALLOWED' (+ err.port)
//   stop() → Promise   stops the torrent engine (data stays), closes HTTP and the DB
//   startOrRecover(options) → like start(), but when the port belongs to another
//     program, starts in recovery mode instead (plan §5.9): dashboard only, on
//     a free loopback port, so the admin can choose another port
//   restart() → Promise<info>   stop() + startOrRecover() with the same options
//     (the dashboard's "Restart server": a new port, LAN sharing, download dir)

// Since Node 17 dns.lookup() returns addresses in resolver order. On IPv6 /
// NAT64 networks that's an IPv6 address first, which the (IPv4-only) DHT and
// UDP tracker sockets can't send to: the DHT never bootstraps and torrents only
// get the few peers one tracker hands out. Must run before any lookup.
require('dns').setDefaultResultOrder('ipv4first');

var fs = require('fs'),
  path = require('path');

// Dev convenience: API keys etc. from the repo root's .env. Real environment
// variables win; installs have no .env, they use settings.json.
var DOTENV = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(DOTENV)) {
  require('dotenv').config({ path: DOTENV });
}

var http = require('http'),
  os = require('os'),
  paths = require('./lib/paths'),
  settings = require('./lib/settings'),
  logger = require('./lib/logger'),
  identity = require('./lib/identity'),
  ffmpeg = require('./lib/ffmpeg'),
  health = require('./lib/health'),
  system = require('./lib/system'),
  portOwner = require('./lib/portOwner'),
  torrents = require('./lib/torrents/client'),
  sessions = require('./lib/sessions'),
  userData = require('./lib/userData'),
  auth = require('./lib/auth'),
  events = require('./lib/events'),
  discovery = require('./lib/discovery'),
  library = require('./lib/library'),
  dlna = require('./lib/dlna'),
  plugins = require('./lib/plugins'),
  api = require('./lib/api');

var log = logger.child('server');

var running = null,   // { server, sockets, info }
  lastOptions = {};   // start()'s options, for restart()

function lanUrls(port) {
  var nets = os.networkInterfaces();
  return Object.keys(nets).reduce(function (all, name) {
    return all.concat(nets[name].filter(function (a) {
      return a.family === 'IPv4' && !a.internal;
    }).map(function (a) {
      return 'http://' + a.address + ':' + port;
    }));
  }, []);
}

function listen(server, port, host) {
  return new Promise(function (resolve, reject) {
    function onError(err) {
      server.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve(server.address().port);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * @param {{ port?: number, host?: string, console?: boolean, ffmpegDir?: string, discoveryPort?: number,
 *   recovery?: object, torrents?: object, library?: object|false, dlna?: object, plugins?: object|false }} [options]
 *   port / host: override the settings for this run (tests);
 *   console: also log to stdout/stderr (default true); ffmpegDir: bundled ffmpeg;
 *   discoveryPort: UDP port of the discovery responder (tests; default 28471);
 *   recovery: { reason, port, owner } (startOrRecover): dashboard only, loopback;
 *   torrents: torrent client options for this run (tests: { engine: 'fake', engineOptions, discovery: false });
 *   dlna: { port, ssdpPort } of the DLNA server for this run (tests; it runs only with dlna.enabled);
 *   plugins: false = no plugins (tests), else lib/plugins start options for this run
 *     ({ dirs, http }; developerMode comes from the settings unless given)
 */
function start(options) {
  options = options || {};
  if (running) {
    return Promise.resolve(running.info);
  }
  if (!options.recovery) {
    lastOptions = Object.assign({}, options);
  }
  settings.load();
  logger.configure({
    level: settings.get('general.logLevel'),
    dir: paths.logs,
    console: options.console !== false
  });
  if (options.ffmpegDir) {
    ffmpeg.setBundledDir(options.ffmpegDir);
  }
  identity.load();

  health.install();

  var recovery = options.recovery || null,
    lan = settings.get('network.lanSharing') && !recovery,
    host = recovery ? '127.0.0.1' : options.host || (lan ? '0.0.0.0' : '127.0.0.1'),
    port = recovery ? 0 : options.port !== undefined ? options.port : settings.get('general.port'),
    server = http.createServer(api),
    sockets = new Set();

  server.on('connection', function (socket) {
    sockets.add(socket);
    socket.on('close', function () { sockets.delete(socket); });
  });

  // The downloads and the torrent engine (not in recovery mode: nothing runs then)
  var torrentsReady = recovery ? Promise.resolve() : torrents.init(Object.assign({
    dataDir: settings.get('storage.downloadDir') || paths.downloads,
    stateDir: paths.cache,
    configDir: paths.config
  }, options.torrents));

  return torrentsReady.then(function () {
    return listen(server, port, host);
  }).then(function (bound) {
    var info = Object.assign(identity.info(), {
      startedAt: Date.now(),
      port: bound,
      host: host,
      urls: ['http://localhost:' + bound].concat(lan && !options.host ? lanUrls(bound) : []),
      recovery: recovery
    });
    running = { server: server, sockets: sockets, info: info };
    system.start(info);
    sessions.start();
    // the library's scanner (option library: false = off, tests; else its start options)
    if (!recovery && options.library !== false) {
      library.start(Object.assign({ torrents: torrents }, options.library));
    }
    // files fetched over HTTP (docs/search-plan.md decision C); none in recovery mode
    if (!recovery) {
      require('./lib/downloads/direct').start();
    }
    // only when listening on the LAN: not the TV app's loopback fallback
    discovery.start(info, { lan: host !== '127.0.0.1', udpPort: options.discoveryPort });
    // the DLNA server (off by default; its own port; option dlna: { port, ssdpPort } for tests)
    dlna.start(info, Object.assign({ lan: host !== '127.0.0.1' }, options.dlna));
    // plugins (docs/plugins-plan.md): each in its own sandbox; none in recovery mode
    if (!recovery && options.plugins !== false) {
      plugins.start(Object.assign({ developerMode: settings.get('plugins.developerMode') }, options.plugins));
    }
    events.attach(server, {
      status: function () {
        return {
          uptimeS: Math.round((Date.now() - info.startedAt) / 1000),
          torrents: torrents.info().active,
          sessions: sessions.count(),
          eventClients: events.clientCount()
        };
      },
      stats: sessions.activeStats
    });
    // Loads Better Auth and the database now rather than on the first request
    auth.setupNeeded().then(function (needed) {
      if (needed) {
        log.warn('no admin account yet: set one up from this machine (dashboard, or ' +
          '`playpex-server admin set <username>`); until then pairing requests can be approved with ' +
          '`playpex-server devices approve <code>`');
      }
    }, function () {});
    if (recovery) {
      log.warn('RECOVERY MODE: port ' + recovery.port + ' is in use' +
        (recovery.owner ? ' by ' + (recovery.owner.name || 'a process') + ' (pid ' + recovery.owner.pid + ')' : '') +
        '. Clients are not served. Open http://localhost:' + bound + '/ on this machine to choose another port, ' +
        'or run `playpex-server set-port <port>`');
    } else {
      log.info('listening on ' + info.urls.join(', ') + (lan ? '' : ' (LAN sharing off)'),
        { port: bound, host: host, lanSharing: lan });
    }
    log.info('logs in ' + paths.logs + ', settings in ' + settings.FILE);
    ffmpeg.info().then(function (ff) {
      if (ff.available) {
        log.info('ffmpeg ' + ff.version + ' (' + ff.source + ')', { path: ff.ffmpeg });
      } else {
        log.warn('ffmpeg/ffprobe not found: Dolby/DTS audio will play silently', { path: ff.ffmpeg });
      }
    });
    return info;
  }, function (err) {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      throw err;
    }
    var e = new Error(err.code === 'EADDRINUSE' ? 'Port ' + port + ' is already in use' :
      'Not allowed to listen on port ' + port);
    e.code = err.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'PORT_NOT_ALLOWED';
    e.port = port;
    throw e;   // the host decides (bin: log + exit; TV app: reuse a running server)
  });
}

function stop() {
  if (!running) {
    return Promise.resolve();
  }
  var current = running;
  running = null;
  log.info('stopping');
  system.stop();
  sessions.stop();
  require('./lib/media/playback').stopAll();
  events.detach();
  return require('./lib/downloads/direct').stop().then(function () {
    return plugins.stop();
  }).then(function () {
    return library.stop();
  }).then(function () {
    return dlna.stop();
  }).then(function () {
    return discovery.stop();
  }).then(function () {
    return torrents.close();
  }).then(function () {
    return new Promise(function (resolve) {
      current.server.close(function () { resolve(); });
      // Streams and keep-alive connections would hold close() open
      current.sockets.forEach(function (socket) { socket.destroy(); });
    });
  }).then(function () {
    auth.close();
    return userData.close();
  }).then(function () {
    log.info('stopped');
  });
}

// start(), or recovery mode when another program holds the port. Rejects
// when another Playpex server holds it (use that one) or for other errors.
function startOrRecover(options) {
  options = options || {};
  return start(options).catch(function (err) {
    if (err.code !== 'PORT_IN_USE' && err.code !== 'PORT_NOT_ALLOWED') {
      throw err;
    }
    return portOwner.isPlaypex(err.port).then(function (playpex) {
      if (playpex) {
        err.playpex = true;   // another Playpex server: the caller decides
        throw err;
      }
      return portOwner(err.port).then(function (owner) {
        log.error(err.message + (owner ? ' by ' + (owner.name || 'a process') + ' (pid ' + owner.pid + ')' : ''),
          { code: err.code, port: err.port });
        return start(Object.assign({}, options, {
          recovery: { reason: err.code, port: err.port, owner: owner, message: err.message }
        }));
      });
    });
  });
}

// The dashboard's "Restart server": settings that apply on start (port, LAN
// sharing, download dir) take effect. Answers the new info (another port,
// maybe recovery mode).
var restarting = null;
function restart() {
  if (!restarting) {
    log.info('restarting');
    restarting = stop().then(function () {
      return startOrRecover(lastOptions);
    }).then(function (info) {
      restarting = null;
      return info;
    }, function (err) {
      restarting = null;
      log.error('restart failed: ' + err.message, { err: err });
      throw err;
    });
  }
  return restarting;
}

module.exports = {
  start: start,
  stop: stop,
  startOrRecover: startOrRecover,
  restart: restart,
  info: function () { return running ? running.info : null; },
  settings: settings,
  logger: logger
};
