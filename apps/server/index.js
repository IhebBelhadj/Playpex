'use strict';

// Playpex Media Server core (docs/server-separation-plan.md §5.1). Nothing
// listens on require: a host calls start() / stop().
//   headless (systemd, Docker, `npm run server`): bin/playpex-server.js
//   embedded in the TV app until it's separated:   apps/tv/electron/main.js
//
//   start(options) → Promise<{ port, host, urls, id, name }>
//     rejects with err.code 'PORT_IN_USE' / 'PORT_NOT_ALLOWED' (+ err.port)
//   stop() → Promise   destroys the torrent engines (data stays), closes HTTP and the DB

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
  store = require('./lib/store'),
  userData = require('./lib/userData'),
  api = require('./lib/api');

var log = logger.child('server');

var running = null;   // { server, sockets, info }

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
 * @param {{ port?: number, host?: string, console?: boolean, ffmpegDir?: string }} [options]
 *   port / host: override the settings for this run (the embedded TV server
 *   uses port 0 on 127.0.0.1 when the fixed port belongs to something else);
 *   console: also log to stdout/stderr (default true); ffmpegDir: bundled ffmpeg
 */
function start(options) {
  options = options || {};
  if (running) {
    return Promise.resolve(running.info);
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
  store.init({ downloads: settings.get('storage.downloadDir') || paths.downloads });

  var lan = settings.get('network.lanSharing'),
    host = options.host || (lan ? '0.0.0.0' : '127.0.0.1'),
    port = options.port !== undefined ? options.port : settings.get('general.port'),
    server = http.createServer(api),
    sockets = new Set();

  server.on('connection', function (socket) {
    sockets.add(socket);
    socket.on('close', function () { sockets.delete(socket); });
  });

  return listen(server, port, host).then(function (bound) {
    var info = Object.assign(identity.info(), {
      port: bound,
      host: host,
      urls: ['http://localhost:' + bound].concat(lan && !options.host ? lanUrls(bound) : [])
    });
    running = { server: server, sockets: sockets, info: info };
    log.info('listening on ' + info.urls.join(', ') + (lan ? '' : ' (LAN sharing off)'),
      { port: bound, host: host, lanSharing: lan });
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
  return new Promise(function (resolve) {
    store.destroyAll(resolve);
  }).then(function () {
    return new Promise(function (resolve) {
      current.server.close(function () { resolve(); });
      // Streams and keep-alive connections would hold close() open
      current.sockets.forEach(function (socket) { socket.destroy(); });
    });
  }).then(function () {
    return userData.close();
  }).then(function () {
    log.info('stopped');
  });
}

module.exports = {
  start: start,
  stop: stop,
  info: function () { return running ? running.info : null; },
  settings: settings,
  logger: logger
};
