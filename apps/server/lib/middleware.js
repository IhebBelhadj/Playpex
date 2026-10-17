'use strict';

// Express middleware every request goes through (lib/api.js), before any route.
// Network hardening from docs/server-separation-plan.md §5.8. Access control
// (pairing, tokens, the admin) is lib/auth/http.js, mounted by lib/api.js.

var net = require('net'),
  os = require('os'),
  settings = require('./settings'),
  log = require('./logger').child('http');

// Origins always allowed: the TV UI under `ng serve` during development. The
// TV app itself (file://) sends no Origin: its Electron shell removes it and
// answers CORS itself (apps/tv/electron/auth.js), so `null`, which any
// sandboxed iframe on the web sends too, isn't trusted.
var BUILTIN_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

function hostname(hostHeader) {
  if (!hostHeader) {
    return '';
  }
  var m = /^\[([^\]]+)\]/.exec(hostHeader);   // [::1]:28470
  return (m ? m[1] : hostHeader.replace(/:\d+$/, '')).toLowerCase();
}

function allowedHost(host) {
  if (net.isIP(host) || host === 'localhost' || /\.localhost$/.test(host)) {
    return true;
  }
  var me = os.hostname().toLowerCase();
  return host === me || host === me + '.local' || host === me.replace(/\.local$/, '') ||
    settings.get('network.allowedHosts').some(function (h) { return h.toLowerCase() === host; });
}

// DNS rebinding: a web page on evil.example that re-points its name at
// 127.0.0.1 or a LAN address still sends "Host: evil.example". IP literals,
// localhost, this machine's name (+ .local) and network.allowedHosts pass.
function hostCheck(req, res, next) {
  var host = hostname(req.headers.host);
  if (!host || allowedHost(host)) {
    return next();
  }
  log.warn('host not allowed: ' + host);
  res.status(403).json({ error: 'Host not allowed: ' + host, code: 'HOST_NOT_ALLOWED' });
}

function allowedOrigin(origin, req) {
  return BUILTIN_ORIGINS.indexOf(origin) !== -1 ||
    origin === 'http://' + req.headers.host ||                // same origin (the dashboard)
    settings.get('network.corsOrigins').indexOf(origin) !== -1;
}

// CORS for the allowed origins. Other web pages may still load media
// (<video> needs no CORS) and get GET answers they can't read, but can't
// change anything: a state-changing request from another origin is refused.
// CORS is not authorization; it only keeps random web pages out.
function cors(req, res, next) {
  var origin = req.headers.origin;
  if (!origin) {
    return next();
  }
  if (allowedOrigin(origin, req)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'OPTIONS, HEAD, GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return next();
  }
  log.warn('origin not allowed: ' + origin);
  res.status(403).json({ error: 'Origin not allowed: ' + origin, code: 'ORIGIN_NOT_ALLOWED' });
}

// One log entry per request, without the query string (it may carry tokens
// later). Successful reads are debug: the player polls every few seconds.
function requestLog(req, res, next) {
  var start = process.hrtime.bigint();
  res.on('close', function () {
    var status = res.statusCode,
      aborted = !res.writableFinished,
      urlPath = req.originalUrl.split('?')[0],
      fields = { ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6) },
      level = aborted ? 'debug' : status >= 500 ? 'error' : status >= 400 ? 'warn' :
        (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') ? 'debug' : 'info';
    if (aborted) {
      fields.aborted = true;
    }
    log[level](req.method + ' ' + urlPath + ' ' + status, fields);
  });
  next();
}

module.exports = {
  hostname: hostname,
  allowedHost: allowedHost,
  allowedOrigin: allowedOrigin,
  hostCheck: hostCheck,
  cors: cors,
  requestLog: requestLog
};
