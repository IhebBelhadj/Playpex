'use strict';

// Express side of lib/auth (docs/server-separation-plan.md §6.3), mounted by
// lib/api.js:
//
//   betterAuth      /api/v1/auth/*: Better Auth's handler, for the endpoints in
//                   auth.EXPOSED only (device flow, the admin's sign-in / -out /
//                   get-session); others → 404. Before the body parsers.
//   requireClient   every client route: a paired device, a local client, the
//                   admin or our own ffmpeg; else 401 PAIRING_REQUIRED
//   requireAdmin    /admin/* and the dashboard's routes: the admin's cookie
//                   session; else 401 ADMIN_REQUIRED
//   localOnly       first-run setup: loopback only, same-origin or no Origin

var auth = require('./index'),
  errors = require('../errors'),
  protocol = require('@playpex/protocol'),
  log = require('../logger').child('auth');

var nodeHandler = null;   // toNodeHandler(auth), made with the instance

function betterAuth(req, res) {
  // Mounted at <prefix>/auth: req.path is what follows
  var key = req.method + ' ' + req.path.replace(/\/+$/, '');
  if (!auth.EXPOSED[key]) {
    return errors.fail(res, 'NOT_FOUND', 'No route ' + req.method + ' ' + protocol.API_PREFIX + '/auth' + req.path);
  }
  // The caller's address for Better Auth's rate limits and session records,
  // from the socket (a client-sent copy is overwritten)
  req.headers[auth.ADDRESS_HEADER] = auth.remoteAddress(req);
  auth.ready().then(function (s) {
    if (!nodeHandler || nodeHandler.auth !== s.auth) {
      nodeHandler = require('better-auth/node').toNodeHandler(s.auth);
      nodeHandler.auth = s.auth;
    }
    return nodeHandler(req, res);   // better-call rebuilds the full path from Express's baseUrl
  }).catch(function (err) {
    log.error(req.method + ' ' + req.originalUrl.split('?')[0] + ' failed', { err: err });
    errors.fail(res, 'INTERNAL', 'Internal error');
  });
}

function identified(req, res, next, check) {
  var pending = req.auth !== undefined ? Promise.resolve(req.auth) : auth.identify(req);
  pending.then(function (who) {
    req.auth = who;
    check(who);
  }).catch(function (err) {
    log.error('identify failed: ' + err.message, { err: err });
    errors.fail(res, 'INTERNAL', 'Internal error');
  });
}

function requireClient(req, res, next) {
  identified(req, res, next, function (who) {
    if (!who) {
      res.set('WWW-Authenticate', 'Bearer realm="Playpex"');
      return errors.fail(res, 'PAIRING_REQUIRED',
        'Pair this device with the server first (POST ' + protocol.API_PREFIX + '/auth/device/code)');
    }
    next();
  });
}

function requireAdmin(req, res, next) {
  identified(req, res, next, function (who) {
    if (!who || who.kind !== 'admin') {
      return errors.fail(res, 'ADMIN_REQUIRED', 'Sign in as the server\'s admin');
    }
    next();
  });
}

// From the server machine, and not from a web page of another origin (the
// CORS allow list has `ng serve`'s origins). The dashboard is same-origin; the
// CLI, curl and the TV app send no Origin.
function localOnly(req, res, next) {
  if (!auth.isLoopback(req)) {
    return errors.fail(res, 'FORBIDDEN', 'Only allowed from the server machine');
  }
  var origin = req.headers.origin;
  if (origin && origin !== 'http://' + req.headers.host) {
    return errors.fail(res, 'ORIGIN_NOT_ALLOWED', 'Only allowed from the dashboard');
  }
  next();
}

module.exports = {
  betterAuth: betterAuth,
  requireClient: requireClient,
  requireAdmin: requireAdmin,
  localOnly: localOnly
};
