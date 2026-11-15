'use strict';

// Playpex TV on the web (docs/web-client-plan.md §5.1–5.2): the TV's web
// build served at /tv/ (hashed files cached, the app's routes → index.html,
// 404 when not built), and browsers paired with the httpOnly device cookie
// (POST /auth/device/token with cookie: true): the cookie authenticates
// client routes and WebSockets, state-changing requests need X-Playpex-Client
// (CSRF), Bearer tokens unchanged, the admin's cookie and a device cookie in
// one browser, logout, revoke. The real server with temp dirs; loopback made
// to count as the LAN (security.requirePairingOnLoopback).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  WebSocket = require('ws'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-web-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
process.env.PLAYPEX_TV_WEB_DIR = path.join(tmp, 'public-tv');

var protocol = require('@playpex/protocol'),
  server = require('..'),
  auth = require('../lib/auth'),
  logger = require('../lib/logger');

var OPTIONS = { port: 0, console: false, library: false, plugins: false, torrents: { engine: 'fake', discovery: false } },
  UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  CLIENT = { 'X-Playpex-Client': 'playpex-web/1.0.0; api=1' },
  base = null,
  adminCookie = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

// { status, headers, body (JSON or null), text }; path is absolute ('/tv/…') or under /api/v1
function call(method, urlPath, body, headers) {
  var payload = body === undefined ? null : Buffer.from(JSON.stringify(body)),
    full = urlPath.indexOf('/tv') === 0 || urlPath.indexOf('/link') === 0 ? urlPath : protocol.API_PREFIX + urlPath;
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL(full, base), {
      method: method,
      agent: false,
      headers: Object.assign(payload ? { 'Content-Type': 'application/json' } : {}, headers || {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text: text,
          body: /json/.test(res.headers['content-type'] || '') && text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function cookieOf(res, name) {
  var found = [].concat(res.headers['set-cookie'] || []).filter(function (c) { return c.indexOf(name + '=') === 0; });
  return found.length ? found[found.length - 1] : null;
}

// Pairs a client (approved before it polls): the token answer
function pair(clientId, tokenBody, headers) {
  return call('POST', '/auth/device/code', { client_id: clientId }, headers).then(function (res) {
    assert.equal(res.status, 200);
    var code = res.body;
    return auth.approve(code.user_code).then(function () {
      return call('POST', '/auth/device/token', Object.assign({ grant_type: protocol.AUTH.DEVICE_GRANT_TYPE,
        device_code: code.device_code, client_id: clientId }, tokenBody), headers);
    });
  });
}

function pairBrowser() {
  return pair('playpex-web', { cookie: true }, { 'User-Agent': UA }).then(function (res) {
    assert.equal(res.status, 200, res.text);
    var set = cookieOf(res, 'playpex_device');
    assert.ok(set, 'a Set-Cookie for playpex_device');
    return { res: res, setCookie: set, cookie: set.split(';')[0] };
  });
}

function socketStatus(headers) {
  return new Promise(function (resolve) {
    var ws = new WebSocket(base.replace('http', 'ws') + protocol.API_PREFIX + '/events', { headers: headers || {} });
    ws.on('unexpected-response', function (req, res) { resolve(res.statusCode); });
    ws.on('open', function () { ws.terminate(); resolve(101); });
    ws.on('error', function () { /* answered by unexpected-response */ });
  });
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'web-pass-1' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'web-pass-1' });
  }).then(function (res) {
    adminCookie = cookieOf(res, 'playpex.session_token').split(';')[0];
    // From here on the test's loopback calls count as the LAN's
    server.settings.update({ security: { requirePairingOnLoopback: true } });
  });
});

test.after(function () {
  server.settings.update({ security: { requirePairingOnLoopback: false } });
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('/tv/: not built → 404 with the command', function () {
  return call('GET', '/tv/').then(function (res) {
    assert.equal(res.status, 404);
    assert.match(res.text, /npm run build:web -w apps\/tv/);
  });
});

test('/tv/: the web build, cached by name, the app\'s routes answer index.html', function () {
  var dir = process.env.PLAYPEX_TV_WEB_DIR,
    INDEX = '<!doctype html><title>Playpex TV</title><base href="/tv/">';
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  fs.writeFileSync(path.join(dir, 'main.0123456789abcdef.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'favicon.ico'), 'ico');
  fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), '<svg/>');
  return Promise.all([
    call('GET', '/tv'),
    call('GET', '/tv?x=1'),
    call('GET', '/tv/'),
    call('GET', '/tv/movies/list'),
    call('GET', '/tv/main.0123456789abcdef.js'),
    call('GET', '/tv/favicon.ico'),
    call('GET', '/tv/assets/logo.svg'),
    call('GET', '/tv/nope.js'),
    call('GET', '/link')
  ]).then(function (r) {
    assert.equal(r[0].status, 301);
    assert.equal(r[0].headers.location, '/tv/');
    assert.equal(r[1].headers.location, '/tv/?x=1');
    assert.equal(r[2].status, 200);
    assert.equal(r[2].text, INDEX);
    assert.equal(r[2].headers['cache-control'], 'no-cache');
    assert.equal(r[3].status, 200);
    assert.equal(r[3].text, INDEX);
    assert.equal(r[4].status, 200);
    assert.match(r[4].headers['cache-control'], /immutable/);
    assert.match(r[4].headers['cache-control'], /max-age=31536000/);
    assert.equal(r[5].status, 200);
    assert.equal(r[5].headers['cache-control'], 'public, max-age=3600');
    assert.equal(r[6].status, 200);
    assert.equal(r[7].status, 404);
    // the dashboard's fallback is untouched (built or not, never the TV's page)
    assert.notEqual(r[8].text, INDEX);
  });
});

test('browser pairing: the token as an httpOnly cookie, never in the body', function () {
  return pairBrowser().then(function (paired) {
    var res = paired.res, set = paired.setCookie;
    conforms('DeviceCookie', res.body);
    assert.equal(res.body.token_type, 'cookie');
    assert.equal(res.body.access_token, undefined);
    assert.ok(res.body.expires_in > 360 * 24 * 3600);
    assert.doesNotMatch(res.text, new RegExp(paired.cookie.split('=')[1]));
    assert.match(set, /; HttpOnly/);
    assert.match(set, /; SameSite=Strict/);
    assert.match(set, /; Path=\//);
    assert.match(set, /; Max-Age=3\d{7}/);
    assert.doesNotMatch(set, /Secure/);   // plain http
    assert.equal(res.headers['cache-control'], 'no-store');
    // Better Auth's own session cookie isn't set
    assert.equal(cookieOf(res, 'playpex.session_token'), null);
    return Promise.all([
      call('GET', '/profiles', undefined, { Cookie: paired.cookie }),
      call('GET', '/devices/me', undefined, { Cookie: paired.cookie }),
      call('GET', '/profiles'),
      socketStatus({ Cookie: paired.cookie }),
      socketStatus(),
      call('GET', '/admin/devices', undefined, { Cookie: paired.cookie })
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 200);
    assert.equal(r[1].status, 200);
    assert.equal(r[1].body.clientId, 'playpex-web');
    assert.equal(r[1].body.name, 'Chrome on Windows');
    assert.equal(r[2].status, 401);
    assert.equal(r[2].body.code, 'PAIRING_REQUIRED');
    assert.equal(r[3], 101);
    assert.equal(r[4], 401);
    assert.equal(r[5].status, 401);   // a device cookie is never the admin
    assert.equal(r[5].body.code, 'ADMIN_REQUIRED');
  });
});

test('CSRF: cookie-authenticated writes need X-Playpex-Client; Bearer tokens don\'t', function () {
  var cookie;
  return pairBrowser().then(function (paired) {
    cookie = paired.cookie;
    return call('POST', '/profiles', { name: 'Forged' }, { Cookie: cookie });
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CLIENT_HEADER_REQUIRED');
    conforms('Error', res.body);
    return call('PATCH', '/settings/device', { 'player.volume': 40 }, { Cookie: cookie });
  }).then(function (res) {
    assert.equal(res.status, 403);
    return call('POST', '/profiles', { name: 'Web' }, Object.assign({ Cookie: cookie }, CLIENT));
  }).then(function (res) {
    assert.equal(res.status, 201, res.text);
    // a cross-site page is refused by its Origin anyway
    return call('POST', '/profiles', { name: 'Evil' }, Object.assign({ Cookie: cookie, Origin: 'https://evil.example' }, CLIENT));
  }).then(function (res) {
    assert.equal(res.body.code, 'ORIGIN_NOT_ALLOWED');
    // Bearer: the token in the body, no cookie, no CSRF rule
    return pair('playpex-tv', {});
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.token_type, 'Bearer');
    assert.equal(res.headers['set-cookie'], undefined);
    conforms('DeviceToken', res.body);
    return call('POST', '/profiles', { name: 'Tv' }, { Authorization: 'Bearer ' + res.body.access_token });
  }).then(function (res) {
    assert.equal(res.status, 201, res.text);
  });
});

test('the admin\'s cookie and a device cookie in one browser', function () {
  var both;
  return pairBrowser().then(function (paired) {
    both = adminCookie + '; ' + paired.cookie;
    return Promise.all([
      call('GET', '/devices/me', undefined, Object.assign({ Cookie: both }, CLIENT)),   // the TV web app
      call('GET', '/devices/me', undefined, { Cookie: both }),                          // the dashboard
      call('GET', '/admin/devices', undefined, Object.assign({ Cookie: both }, CLIENT)),
      call('GET', '/admin/devices', undefined, { Cookie: both }),
      call('GET', '/sessions', undefined, { Cookie: both }),
      // the dashboard's writes (no X-Playpex-Client) are the admin's, not refused as CSRF
      call('PATCH', '/settings/device', { 'player.volume': 30 }, { Cookie: both, 'X-Playpex-Device': 'dash-1' }),
      socketStatus({ Cookie: both })
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 200);
    assert.equal(r[0].body.clientId, 'playpex-web');
    assert.equal(r[1].status, 404);   // the admin isn't a device
    assert.equal(r[2].status, 200);
    assert.equal(r[3].status, 200);
    assert.equal(r[4].status, 200);
    assert.equal(r[5].status, 200, r[5].text);
    assert.equal(r[6], 101);
  });
});

test('logout: the device forgotten, the cookie cleared', function () {
  var cookie;
  return pairBrowser().then(function (paired) {
    cookie = paired.cookie;
    return call('POST', '/auth/device/logout', undefined, { Cookie: cookie });
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CLIENT_HEADER_REQUIRED');
    return call('POST', '/auth/device/logout', undefined, Object.assign({ Cookie: cookie }, CLIENT));
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.match(cookieOf(res, 'playpex_device'), /^playpex_device=; .*Max-Age=0/);
    return call('GET', '/profiles', undefined, { Cookie: cookie });
  }).then(function (res) {
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'PAIRING_REQUIRED');
    // a dead cookie is cleared
    assert.match(cookieOf(res, 'playpex_device'), /Max-Age=0/);
    // nobody to forget: still ok
    return call('POST', '/auth/device/logout', undefined, CLIENT);
  }).then(function (res) {
    assert.equal(res.status, 200);
  });
});

test('revoked on the dashboard → 401 PAIRING_REQUIRED, socket refused', function () {
  var cookie;
  return pairBrowser().then(function (paired) {
    cookie = paired.cookie;
    return call('GET', '/devices/me', undefined, { Cookie: cookie });
  }).then(function (res) {
    return call('DELETE', '/admin/devices/' + res.body.id, undefined, { Cookie: adminCookie, Origin: base });
  }).then(function (res) {
    assert.equal(res.status, 200, res.text);
    return Promise.all([call('GET', '/profiles', undefined, { Cookie: cookie }), socketStatus({ Cookie: cookie })]);
  }).then(function (r) {
    assert.equal(r[0].status, 401);
    assert.equal(r[0].body.code, 'PAIRING_REQUIRED');
    assert.equal(r[1], 401);
  });
});

test('loopback: no pairing needed, and a paired browser keeps its identity', function () {
  var cookie;
  return pairBrowser().then(function (paired) {
    cookie = paired.cookie;
    server.settings.update({ security: { requirePairingOnLoopback: false } });
    return Promise.all([
      call('GET', '/profiles'),
      call('POST', '/profiles', { name: 'Local' }),   // a local client: no CSRF rule
      call('GET', '/devices/me', undefined, { Cookie: cookie }),
      call('GET', '/devices/me')
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 200);
    assert.equal(r[1].status, 201, r[1].text);
    assert.equal(r[2].status, 200);
    assert.equal(r[2].body.clientId, 'playpex-web');
    assert.equal(r[3].status, 404);
  }).finally(function () {
    server.settings.update({ security: { requirePairingOnLoopback: true } });
  });
});

test('device names from the User-Agent', function () {
  var cases = [
    [UA, 'Chrome on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['curl/8.0', null]
  ];
  cases.forEach(function (c) { assert.equal(auth.browserName(c[0]), c[1], c[0]); });
});
