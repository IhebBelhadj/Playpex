'use strict';

// Express side of lib/auth (docs/server-separation-plan.md §6.3), mounted by
// lib/api.js:
//
//   betterAuth      /api/v1/auth/*: Better Auth's handler, for the endpoints in
//                   auth.EXPOSED only (device flow, the admin's sign-in / -out /
//                   get-session); others → 404. Before the body parsers.
//                   POST /device/token with `cookie: true` (browsers,
//                   docs/web-client-plan.md §5.2) answers the token as the
//                   httpOnly cookie playpex_device instead of in the body;
//                   POST /device/logout (ours) forgets the calling device.
//   requireClient   every client route: a paired device, a local client, the
//                   admin or our own ffmpeg; else 401 PAIRING_REQUIRED. A
//                   device known by its cookie must send X-Playpex-Client on
//                   state-changing requests (CSRF), else 403 CLIENT_HEADER_REQUIRED
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
  if (key === 'POST /device/logout') {
    return logout(req, res);
  }
  if (!auth.EXPOSED[key]) {
    return errors.fail(res, 'NOT_FOUND', 'No route ' + req.method + ' ' + protocol.API_PREFIX + '/auth' + req.path);
  }
  // The caller's address for Better Auth's rate limits and session records,
  // from the socket (a client-sent copy is overwritten)
  req.headers[auth.ADDRESS_HEADER] = auth.remoteAddress(req);
  auth.ready().then(function (s) {
    if (key === 'POST /device/token') {
      return deviceToken(s, req, res);
    }
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

// ── the device cookie (browsers) ───────────────────────────────────────────

function secure(req) {
  return !!(req.secure || (req.socket && req.socket.encrypted));
}

function setDeviceCookie(req, res, token, seconds) {
  res.append('Set-Cookie', auth.DEVICE_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; Max-Age=' + Math.max(0, Math.floor(seconds)) + '; HttpOnly; SameSite=Strict' + (secure(req) ? '; Secure' : ''));
}

function clearDeviceCookie(req, res) {
  res.append('Set-Cookie', auth.DEVICE_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (secure(req) ? '; Secure' : ''));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error('Request body too large'), { code: 'INVALID' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// The body's fields, JSON or form-encoded (RFC 8628 clients send either)
function parseFields(raw, type) {
  var text = raw.toString('utf8');
  if (/json/i.test(type || '')) {
    try {
      var parsed = JSON.parse(text || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }
  var fields = {};
  new URLSearchParams(text).forEach(function (v, k) { fields[k] = v; });
  return fields;
}

// POST /auth/device/token through Better Auth's fetch handler (its rate limits
// and checks), so that, with `cookie: true`, the token can be answered as the
// playpex_device cookie: the page's scripts never see it.
function deviceToken(s, req, res) {
  return readBody(req).then(function (raw) {
    var type = req.headers['content-type'] || '',
      fields = parseFields(raw, type),
      asCookie = !!fields && (fields.cookie === true || fields.cookie === 'true'),
      headers = new Headers();
    Object.keys(req.headers).forEach(function (name) {
      var v = req.headers[name];
      if (name === 'content-length' || name === 'transfer-encoding' || v === undefined) {
        return;
      }
      headers.set(name, Array.isArray(v) ? v.join(', ') : String(v));
    });
    var body = raw;
    if (fields && fields.cookie !== undefined) {
      delete fields.cookie;
      body = /json/i.test(type) ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
    }
    var url = 'http://' + (req.headers.host || 'localhost') + req.originalUrl;
    return s.auth.handler(new Request(url, { method: 'POST', headers: headers, body: body })).then(function (answer) {
      return answer.text().then(function (text) {
        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) { /* not JSON: passed through */ }
        res.status(answer.status);
        answer.headers.forEach(function (value, name) {
          if (name !== 'content-length' && name !== 'content-encoding' && name !== 'transfer-encoding' &&
            name !== 'set-cookie') {
            res.setHeader(name, value);
          }
        });
        if (asCookie && answer.status === 200 && json && typeof json.access_token === 'string') {
          setDeviceCookie(req, res, json.access_token, json.expires_in || auth.SESSION_SECONDS);
          res.set('Cache-Control', 'no-store');
          return res.json({ token_type: 'cookie', expires_in: json.expires_in, scope: json.scope || '' });
        }
        res.send(text);
      });
    });
  }, function (err) {
    errors.fail(res, 'INVALID', err.message);
  });
}

// POST /auth/device/logout: the calling device (its cookie, or a Bearer
// token) is forgotten: its session revoked, the cookie cleared. Answers
// { ok: true } whether or not there was one.
function logout(req, res) {
  auth.identify(req).then(function (who) {
    var device = who && who.kind === 'device' ? who : who && who.device;
    if (device && device.via === 'cookie' && !req.headers[protocol.CLIENT_HEADER.toLowerCase()]) {
      return csrfRefused(res);
    }
    clearDeviceCookie(req, res);
    res.set('Cache-Control', 'no-store');
    var revoke = device ? auth.revokeDevice(device.device.id) : Promise.resolve(false);
    return revoke.then(function () { res.json({ ok: true }); });
  }).catch(function (err) {
    log.error('device logout failed: ' + err.message, { err: err });
    errors.fail(res, 'INTERNAL', 'Internal error');
  });
}

function csrfRefused(res) {
  return errors.fail(res, 'CLIENT_HEADER_REQUIRED',
    'Send the ' + protocol.CLIENT_HEADER + ' header with requests a device cookie authenticates');
}

var SAFE_METHODS = { GET: true, HEAD: true, OPTIONS: true };

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
    var sentCookie = !!auth.deviceCookie(req),
      byCookie = who && (who.via === 'cookie' || (who.device && who.device.via === 'cookie'));
    if (sentCookie && !byCookie) {
      clearDeviceCookie(req, res);   // a revoked device's (or a stranger's) cookie
    }
    if (!who) {
      res.set('WWW-Authenticate', 'Bearer realm="Playpex"');
      return errors.fail(res, 'PAIRING_REQUIRED',
        'Pair this device with the server first (POST ' + protocol.API_PREFIX + '/auth/device/code)');
    }
    // CSRF: a cross-site form or fetch can't send a custom header without a
    // preflight the server doesn't grant
    if (who.via === 'cookie' && !SAFE_METHODS[req.method] && !req.headers[protocol.CLIENT_HEADER.toLowerCase()]) {
      return csrfRefused(res);
    }
    // The session's expiry slid forward: so does the cookie's
    if (who.via === 'cookie' && who.renewed) {
      setDeviceCookie(req, res, auth.deviceCookie(req), auth.SESSION_SECONDS);
    }
    next();
  });
}

function requireAdmin(req, res, next) {
  identified(req, res, next, function (who) {
    // A browser with both cookies, identified as its device: admin routes are the admin's
    if (who && who.kind === 'device' && who.admin) {
      who = req.auth = who.admin;
    }
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
