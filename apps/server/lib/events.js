'use strict';

// Real-time events (docs/server-separation-plan.md §6.4): one WebSocket at
// GET /api/v1/events, plain JSON text messages, so any platform can read it:
//
//   { "topic": "session.updated", "time": "<ISO date>", "data": { … } }
//
// Topics (everyone):  server.status (on connect, then every 30 s),
//                     torrent.stats (every 2 s while torrents run),
//                     session.started / session.updated / session.ended,
//                     settings.changed { scope, ownerId, keys } (lib/services/settings.js)
// Admin only:         log (info and above), device.paired / device.revoked,
//                     pairing.requested / pairing.approved / pairing.denied,
//                     host.updated (desktop app: start at login, updater state)
//
// `?topics=session,torrent.stats` keeps only topics starting with one of
// those prefixes. Auth is the same as the HTTP API (lib/auth: device token as
// `?access_token=` or Authorization header, the dashboard's cookie, loopback);
// Host and Origin are checked like every request (lib/middleware.js).
//
//   events.publish(topic, data, { admin: true })   from anywhere in the server
//   events.attach(httpServer) / events.detach()    from index.js

var url = require('url'),
  WebSocket = require('ws'),
  protocol = require('@playpex/protocol'),
  logger = require('./logger'),
  log = logger.child('http');

var PATH = protocol.API_PREFIX + '/events',
  PING_MS = 30 * 1000,
  STATUS_MS = 30 * 1000,
  STATS_MS = 2000;

var wss = null,
  clients = new Set(),   // { socket, admin, topics, alive }
  timers = [],
  statusProvider = null,
  statsProvider = null,
  localListeners = [];   // onPublish(): in-process listeners (lib/host.js → the tray)

var ONLINE_MS = 90 * 1000;

function wanted(client, topic) {
  return !client.topics || client.topics.some(function (prefix) { return topic.indexOf(prefix) === 0; });
}

function send(client, message) {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(message);
  }
}

/**
 * Sends an event to every connected client allowed to see it.
 * @param {string} topic
 * @param {*} data
 * @param {{ admin?: boolean, internal?: boolean }} [options] admin: only admin sessions get it;
 *   internal: only in-process listeners (onPublish: the plugins' event bus), never a client
 */
function publish(topic, data, options) {
  localListeners.forEach(function (fn) {
    try {
      fn(topic, data, options || {});
    } catch (e) {
      log.warn('event listener failed: ' + e.message);
    }
  });
  if (!clients.size || (options && options.internal)) {
    return;
  }
  var adminOnly = options && options.admin,
    message = JSON.stringify({ topic: topic, time: new Date().toISOString(), data: data });
  clients.forEach(function (client) {
    if ((!adminOnly || client.admin) && wanted(client, topic)) {
      send(client, message);
    }
  });
}

function refuse(socket, status, code, message) {
  var body = JSON.stringify({ error: message, code: code });
  socket.end('HTTP/1.1 ' + status + ' ' + require('http').STATUS_CODES[status] + '\r\n' +
    'Content-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
}

function onConnection(socket, req, auth) {
  var topics = req.query.topics ? String(req.query.topics).split(',').map(function (t) { return t.trim(); }).filter(Boolean) : null,
    client = { socket: socket, admin: auth.kind === 'admin', topics: topics, alive: true,
      deviceId: auth.kind === 'device' && auth.device ? auth.device.id : null };
  clients.add(client);
  socket.on('pong', function () { client.alive = true; });
  socket.on('close', function () { clients.delete(client); });
  socket.on('error', function () { clients.delete(client); });
  // Nothing to read from clients for now; ignore what they send
  socket.on('message', function () {});
  if (statusProvider && wanted(client, 'server.status')) {
    send(client, JSON.stringify({ topic: 'server.status', time: new Date().toISOString(), data: statusProvider() }));
  }
}

function onUpgrade(req, socket, head) {
  var parsed = url.parse(req.url, true);
  if (parsed.pathname !== PATH && parsed.pathname !== PATH + '/') {
    return refuse(socket, 404, 'NOT_FOUND', 'No WebSocket at ' + parsed.pathname);
  }
  var middleware = require('./middleware'),
    auth = require('./auth');
  req.query = parsed.query;
  if (!middleware.allowedHost(middleware.hostname(req.headers.host))) {
    return refuse(socket, 403, 'HOST_NOT_ALLOWED', 'Host not allowed');
  }
  // Browsers send Origin with WebSockets, and cookies: a page on another
  // site must not open the admin's event stream (cross-site WebSocket hijacking)
  if (req.headers.origin && !middleware.allowedOrigin(req.headers.origin, req)) {
    return refuse(socket, 403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
  }
  auth.identify(req).then(function (who) {
    if (!who || who.kind === 'internal') {
      return refuse(socket, 401, 'PAIRING_REQUIRED', 'Pair this device with the server first');
    }
    wss.handleUpgrade(req, socket, head, function (ws) {
      onConnection(ws, req, who);
    });
  }, function (err) {
    log.error('events: ' + err.message, { err: err });
    refuse(socket, 500, 'INTERNAL', 'Internal error');
  });
}

function onLogEntry(entry) {
  if (entry.level !== 'debug') {
    publish('log', entry, { admin: true });
  }
}

/**
 * @param {import('http').Server} server
 * @param {{ status?: function(): object, stats?: function(): Array }} [providers]
 *   what server.status and torrent.stats carry (index.js knows the store / sessions)
 */
function attach(server, providers) {
  providers = providers || {};
  statusProvider = providers.status || null;
  statsProvider = providers.stats || null;
  wss = new WebSocket.Server({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', onUpgrade);
  logger.on('entry', onLogEntry);
  timers.push(setInterval(function () {
    clients.forEach(function (client) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        return;
      }
      client.alive = false;
      client.socket.ping();
    });
  }, PING_MS));
  timers.push(setInterval(function () {
    if (statusProvider && clients.size) {
      publish('server.status', statusProvider());
    }
  }, STATUS_MS));
  timers.push(setInterval(function () {
    if (statsProvider && clients.size) {
      var stats = statsProvider();
      if (stats.length) {
        publish('torrent.stats', stats);
      }
    }
  }, STATS_MS));
  timers.forEach(function (t) { t.unref(); });
}

function detach() {
  timers.forEach(clearInterval);
  timers = [];
  logger.off('entry', onLogEntry);
  clients.forEach(function (client) { client.socket.terminate(); });
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}

module.exports = {
  PATH: PATH,
  publish: publish,
  attach: attach,
  detach: detach,
  clientCount: function () { return clients.size; },
  // fn(topic, data, options) for every published event, sockets or not
  onPublish: function (fn) { localListeners.push(fn); },
  // devices (auth.listDevices()) with `online`: an events socket open, or
  // seen within 90 s (lastSeenAt is written at most once a minute)
  markOnline: function (devices) {
    var connected = module.exports.connectedDevices(), now = Date.now();
    return devices.map(function (d) {
      return Object.assign({}, d, {
        online: !!connected[d.id] || !!(d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < ONLINE_MS)
      });
    });
  },
  // ids of the paired devices with an open events socket (the dashboard's "online now")
  connectedDevices: function () {
    var ids = {};
    clients.forEach(function (c) { if (c.deviceId) { ids[c.deviceId] = true; } });
    return ids;
  }
};
