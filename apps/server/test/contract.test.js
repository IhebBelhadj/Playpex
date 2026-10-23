'use strict';

// Contract test (docs/server-separation-plan.md §6.1): starts the real server
// on a free port with throwaway data dirs, calls the API and checks every
// answer against packages/protocol/openapi.yaml — the operation must exist,
// the status must be documented, and a JSON body must match its schema.
//
//   npm test -w apps/server                              offline routes only
//   PLAYPEX_TEST_NETWORK=1 npm test -w apps/server       + provider-backed routes (YTS, IMDb, EZTV…)

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

// Before the server is required: lib/paths reads these once
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-contract-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
// LAN discovery has its own test (discovery.test.js): no mDNS / UDP 28471 here
process.env.PLAYPEX_DISCOVERY = '0';

var YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020'),
  protocol = require('@playpex/protocol'),
  server = require('..');

// The library's TMDB (lib/library/match.js's catalog), offline
var CATALOG = {
  search: function (kind, q) {
    return Promise.resolve(kind === 'movie' && /inception/i.test(q) ?
      [{ id: 27205, title: 'Inception', release_date: '2010-07-15', overview: 'Dreams.', poster_path: '/p.jpg' }] : []);
  },
  movie: function (id) {
    return id === 27205 ? Promise.resolve({ id: 27205, title: 'Inception', release_date: '2010-07-15', imdb_id: 'tt1375666' }) :
      Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
  },
  tv: function () { return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } })); },
  season: function () { return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } })); },
  find: function () { return Promise.resolve({ movie_results: [], tv_results: [] }); }
};

var SPEC_FILE = require.resolve('@playpex/protocol/openapi.yaml'),
  spec = YAML.parse(fs.readFileSync(SPEC_FILE, 'utf8')),
  ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }),
  NETWORK = process.env.PLAYPEX_TEST_NETWORK === '1',
  base = null,
  adminCookie = null,   // set by the auth test, for the admin-only routes
  covered = {};

ajv.addSchema(spec, 'spec');

function pointer(parts) {
  return '#/' + parts.map(function (p) { return String(p).replace(/~/g, '~0').replace(/\//g, '~1'); }).join('/');
}

var operations = Object.keys(spec.paths).reduce(function (all, template) {
  var regex = new RegExp('^' + template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, function (m, name) {
    return name === 'path' ? '(.+)' : '([^/]+)';
  }) + '$');
  Object.keys(spec.paths[template]).filter(function (m) { return m !== 'parameters'; }).forEach(function (method) {
    all.push({ template: template, method: method.toUpperCase(), regex: regex, op: spec.paths[template][method] });
  });
  return all;
}, []);

function findOperation(method, urlPath) {
  var matches = operations.filter(function (o) { return o.method === method && o.regex.test(urlPath); });
  // the most specific template (fewest parameters) wins: /adult/meta/providers over /adult/meta/{provider}/…
  matches.sort(function (a, b) { return (a.template.match(/\{/g) || []).length - (b.template.match(/\{/g) || []).length; });
  return matches[0];
}

// Pointer to the JSON schema of this operation's answer, or null (no JSON body)
function responseSchemaRef(found, status) {
  var where = ['paths', found.template, found.method.toLowerCase(), 'responses', String(status)],
    response = found.op.responses[String(status)];
  assert.ok(response, found.method + ' ' + found.template + ': status ' + status + ' is not documented');
  if (response.$ref) {
    where = response.$ref.slice(2).split('/');
    response = where.reduce(function (o, k) { return o[k]; }, spec);
  }
  if (!response.content || !response.content['application/json']) {
    return null;
  }
  return 'spec' + pointer(where.concat(['content', 'application/json', 'schema']));
}

/**
 * Calls the API and checks the answer against the spec.
 * options: expect (status), headers, raw (path outside /api/v1, not checked),
 * generic (an answer of the whole API, not of this operation — 403 Host/Origin,
 * 426 version, 401 without a token: only checked against the Error schema),
 * admin (send the admin's session cookie), token (a device token: Bearer header)
 * @returns {Promise<{status, body, headers}>}
 */
function call(method, apiPath, body, options) {
  options = options || {};
  var headers = Object.assign({ Accept: 'application/json' },
      options.admin ? { Cookie: adminCookie } : {},
      options.token ? { Authorization: 'Bearer ' + options.token } : {},
      options.headers),
    payload = body === undefined ? null : JSON.stringify(body);
  if (payload) {
    headers['Content-Type'] = 'application/json';
  }
  var url = new URL((options.raw ? '' : protocol.API_PREFIX) + apiPath, base);
  return new Promise(function (resolve, reject) {
    var req = http.request(url, { method: method, headers: headers }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), parsed = null;
        if (/json/.test(res.headers['content-type'] || '')) {
          parsed = JSON.parse(text);
        }
        resolve({ status: res.statusCode, body: parsed, text: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  }).then(function (res) {
    if (options.expect !== undefined) {
      assert.equal(res.status, options.expect, method + ' ' + apiPath + ' → ' + res.status + ' ' + res.text.slice(0, 300));
    }
    if (options.raw) {
      return res;
    }
    if (options.generic) {
      var validateError = ajv.getSchema('spec#/components/schemas/Error');
      assert.ok(validateError(res.body), method + ' ' + apiPath + ': not an Error: ' + res.text.slice(0, 300));
      return res;
    }
    var found = findOperation(method, url.pathname.slice(protocol.API_PREFIX.length));
    assert.ok(found, method + ' ' + url.pathname + ' is not in openapi.yaml');
    covered[found.method + ' ' + found.template] = true;
    var ref = responseSchemaRef(found, res.status);
    if (ref) {
      var validate = ajv.getSchema(ref) || ajv.compile({ $ref: ref });
      assert.ok(validate(res.body), method + ' ' + apiPath + ' (' + res.status + ') does not match ' + ref + ':\n' +
        JSON.stringify(validate.errors, null, 2) + '\nbody: ' + res.text.slice(0, 500));
    }
    return res;
  });
}

test.before(function () {
  return server.start({ port: 0, console: false, library: { catalog: CATALOG, firstScanMs: 3600000 } }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
  });
});

test.after(function () {
  var all = operations.map(function (o) { return o.method + ' ' + o.template; }),
    missing = all.filter(function (k) { return !covered[k]; });
  process.stdout.write('\n# contract: ' + (all.length - missing.length) + '/' + all.length +
    ' operations exercised' + (NETWORK ? '' : ' (offline; PLAYPEX_TEST_NETWORK=1 for the provider routes)') + '\n' +
    missing.map(function (k) { return '#   not exercised: ' + k; }).join('\n') + '\n');
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('the spec and the protocol constants agree', function () {
  assert.equal(String(spec.info.version), String(protocol.API_VERSION));
  assert.deepEqual(spec.components.schemas.Error.properties.code.enum.slice().sort(),
    Object.keys(protocol.ERROR_CODES).sort());
  assert.equal(spec.components.parameters.MediaRef.schema.pattern, protocol.MEDIA_REF_PATTERN);
});

test('server info', function () {
  return call('GET', '/server', undefined, { expect: 200 }).then(function (res) {
    assert.equal(res.body.apiVersion, protocol.API_VERSION);
  });
});

test('the spec and the docs, without a token', function () {
  return call('GET', '/openapi.yaml', undefined, { expect: 200 }).then(function (res) {
    assert.match(res.headers['content-type'], /^application\/yaml/);
    assert.equal(YAML.parse(res.text).info.version, String(protocol.API_VERSION));
    return call('GET', '/docs', undefined, { expect: 302 });
  }).then(function (res) {
    assert.equal(res.headers.location, '/docs');
    // the guide page itself is the dashboard's (index.html when built)
    return call('GET', '/docs/auth', undefined, { raw: true });
  }).then(function (res) {
    assert.ok(res.status === 200 ? /<html/i.test(res.text) : /dashboard is not built/.test(res.text));
  });
});

test('API version negotiation', function () {
  return Promise.all([
    call('GET', '/server', undefined, { expect: 426, generic: true, headers: { 'X-Playpex-Client': 'test/1; api=99' } }),
    call('GET', '/server', undefined, { expect: 426, generic: true, headers: { 'X-Playpex-Client': 'test/1; api=0' } }),
    call('GET', '/server', undefined, { expect: 200, headers: { 'X-Playpex-Client': 'test/1; api=1' } })
  ]).then(function (r) {
    assert.equal(r[0].body.code, 'SERVER_TOO_OLD');
    assert.equal(r[1].body.code, 'CLIENT_TOO_OLD');
  });
});

test('errors: unknown routes, Host and Origin checks', function () {
  return Promise.all([
    call('GET', '/nope.json', undefined, { expect: 404, generic: true }),
    call('GET', '/nope.json', undefined, { expect: 404, raw: true }),
    call('GET', '/server', undefined, { expect: 403, generic: true, headers: { Host: 'evil.example' } }),
    call('POST', '/profiles', { name: 'x' }, { expect: 403, generic: true, headers: { Origin: 'https://evil.example' } }),
    call('GET', '/profiles', undefined, { expect: 200, headers: { Origin: 'https://evil.example' } })
  ]).then(function (r) {
    assert.equal(r[0].body.code, 'NOT_FOUND');
    assert.equal(r[2].body.code, 'HOST_NOT_ALLOWED');
    assert.equal(r[3].body.code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(r[4].headers['access-control-allow-origin'], undefined);
  });
});

test('auth: pairing (RFC 8628), device tokens, admin session, revoke', function () {
  var auth = require('../lib/auth'),
    LAN = { headers: {} },
    code, token, deviceId, cookie;
  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function poll(expect) {
    return call('POST', '/auth/device/token', { grant_type: protocol.AUTH.DEVICE_GRANT_TYPE,
      device_code: code.device_code, client_id: 'playpex-tv' }, { expect: expect });
  }
  // The test talks over loopback, which is trusted: make it count as the LAN
  server.settings.update({ security: { requirePairingOnLoopback: true } });

  return call('GET', '/profiles', undefined, Object.assign({ expect: 401, generic: true }, LAN))
    .then(function (res) {
      assert.equal(res.body.code, 'PAIRING_REQUIRED');
      assert.match(res.headers['www-authenticate'], /^Bearer/);
      return call('GET', '/server', undefined, { expect: 200 });
    })
    .then(function (res) { assert.equal(res.body.auth, 'pairing'); })
    // a client asks to pair
    .then(function () { return call('POST', '/auth/device/code', { client_id: 'BAD ID' }, { expect: 400 }); })
    .then(function (res) { assert.equal(res.body.error, 'invalid_client'); })
    .then(function () {
      return call('POST', '/auth/device/code', { client_id: 'playpex-tv' },
        { expect: 200, headers: { 'X-Playpex-Client': 'contract-test/1.0; api=1' } });
    })
    .then(function (res) {
      code = res.body;
      assert.equal(code.interval, 5);
      assert.match(code.verification_uri, /\/link$/);
      return poll(400);
    })
    .then(function (res) { assert.equal(res.body.error, 'authorization_pending'); })
    .then(function () { return poll(400); })
    .then(function (res) { assert.equal(res.body.error, 'slow_down'); })
    // admin routes need the admin; the first-run setup is open on loopback until done
    .then(function () { return call('GET', '/admin/pairing', undefined, { expect: 401 }); })
    .then(function (res) { assert.equal(res.body.code, 'ADMIN_REQUIRED'); })
    .then(function () { return call('GET', '/admin/setup', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.needed, true); })
    .then(function () { return call('POST', '/admin/setup', { username: 'admin', password: 'short' }, { expect: 400 }); })
    // a sandboxed iframe on any site sends Origin: null
    .then(function () {
      return call('POST', '/admin/setup', { username: 'evil', password: 'evil-password' },
        { expect: 403, headers: { Origin: 'null' } });
    })
    .then(function () { return call('POST', '/admin/setup', { username: 'Admin', password: 'contract-pass' }, { expect: 200 }); })
    .then(function () { return call('POST', '/admin/setup', { username: 'other', password: 'contract-pass' }, { expect: 409 }); })
    .then(function () {
      return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'wrong-password' }, { expect: 401 });
    })
    .then(function () {
      return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'contract-pass' }, { expect: 200 });
    })
    .then(function (res) {
      cookie = res.headers['set-cookie'].map(function (c) { return c.split(';')[0]; }).join('; ');
      adminCookie = cookie;
      return call('GET', '/auth/get-session', undefined, { expect: 200, admin: true });
    })
    .then(function (res) { assert.equal(res.body.user.username, 'admin'); })
    .then(function () { return call('GET', '/admin/pairing', undefined, { expect: 200, admin: true }); })
    .then(function (res) {
      assert.equal(res.body.requests.length, 1);
      assert.equal(res.body.requests[0].client, 'contract-test/1.0');
      return call('POST', '/admin/pairing/nope/approve', undefined, { expect: 404, admin: true });
    })
    // typed by a person: lowercase, with a dash
    .then(function () {
      var typed = code.user_code.slice(0, 4).toLowerCase() + '-' + code.user_code.slice(4).toLowerCase();
      return call('POST', '/admin/pairing/' + typed + '/approve', undefined, { expect: 200, admin: true });
    })
    .then(function () { return call('POST', '/admin/pairing/' + code.user_code + '/deny', undefined, { expect: 409, admin: true }); })
    .then(function () { return wait(5100); })
    .then(function () { return poll(200); })
    .then(function (res) {
      token = res.body.access_token;
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.headers['set-cookie'], undefined);
    })
    .then(function () { return wait(5100); })
    .then(function () { return poll(400); })
    .then(function (res) { assert.equal(res.body.error, 'invalid_grant'); })   // a code gives one token
    // the token works, in the header and as ?access_token=
    .then(function () { return call('GET', '/profiles', undefined, { expect: 200, token: token }); })
    .then(function () { return call('GET', '/torrents?access_token=' + token, undefined, { expect: 200 }); })
    .then(function () { return call('GET', '/profiles', undefined, { expect: 401, generic: true, token: 'nope' }); })
    .then(function () {
      return call('PUT', '/devices/me', { name: 'Living room TV', platform: 'linux', deviceId: 'tv-1',
        capabilities: { audio: ['aac', 'opus'] } }, { expect: 200, token: token });
    })
    .then(function (res) {
      deviceId = res.body.id;
      assert.equal(res.body.name, 'Living room TV');
      return call('PUT', '/devices/me', { name: 42 }, { expect: 400, token: token });
    })
    .then(function () { return call('GET', '/devices/me', undefined, { expect: 200, token: token }); })
    .then(function () { return call('GET', '/devices/me', undefined, { expect: 404, admin: true }); })
    // a device token is never the admin, not even on Better Auth's own routes
    .then(function () { return call('GET', '/admin/devices', undefined, { expect: 401, token: token }); })
    .then(function () { return call('GET', '/sessions', undefined, { expect: 401, token: token }); })
    .then(function () { return call('GET', '/auth/get-session', undefined, { expect: 200, token: token }); })
    .then(function (res) { assert.equal(res.body, null); })
    .then(function () { return call('POST', '/auth/sign-up/email', {}, { expect: 404, generic: true }); })
    // the admin manages devices
    .then(function () { return call('GET', '/admin/devices', undefined, { expect: 200, admin: true }); })
    .then(function (res) { assert.deepEqual(res.body.devices.map(function (d) { return d.id; }), [deviceId]); })
    .then(function () { return call('PUT', '/admin/devices/' + deviceId, { name: 'Bedroom TV' }, { expect: 200, admin: true }); })
    .then(function () { return call('PUT', '/admin/devices/' + deviceId, { name: '' }, { expect: 400, admin: true }); })
    .then(function () { return call('PUT', '/admin/devices/nope', { name: 'x' }, { expect: 404, admin: true }); })
    // a paired device's leases are its own
    .then(function () { return call('POST', '/torrents', { link: 'a'.repeat(40) }, { expect: 200, token: token }); })
    .then(function () { return call('GET', '/sessions', undefined, { expect: 200, admin: true }); })
    .then(function (res) {
      var mine = res.body.filter(function (s) { return s.deviceId === deviceId; });
      assert.equal(mine.length, 1);
      assert.equal(mine[0].paired, true);
      assert.equal(mine[0].deviceName, 'Bedroom TV');
    })
    // a paired device's settings are keyed by the id it sent (tv-1), whatever header it adds
    .then(function () {
      return call('PATCH', '/settings/device', { 'player.volume': 35 },
        { expect: 200, token: token, headers: { 'X-Playpex-Device': 'someone-else' } });
    })
    .then(function () { return call('GET', '/settings', undefined, { expect: 200, admin: true, headers: { 'X-Playpex-Device': 'tv-1' } }); })
    .then(function (res) { assert.equal(res.body.device['player.volume'], 35); })
    .then(function () { return call('GET', '/settings', undefined, { expect: 400, admin: true }); })   // the admin isn't a device
    // denied requests
    .then(function () { return call('POST', '/auth/device/code', { client_id: 'playpex-tv' }, { expect: 200 }); })
    .then(function (res) {
      code = res.body;
      return call('POST', '/admin/pairing/' + code.user_code + '/deny', undefined, { expect: 200, admin: true });
    })
    .then(function () { return poll(400); })
    .then(function (res) { assert.equal(res.body.error, 'access_denied'); })
    // revoking: the token stops working, its lease goes
    .then(function () { return call('DELETE', '/admin/devices/' + deviceId, undefined, { expect: 200, admin: true }); })
    .then(function () { return call('GET', '/profiles', undefined, { expect: 401, generic: true, token: token }); })
    .then(function () { return call('DELETE', '/admin/devices/' + deviceId, undefined, { expect: 404, admin: true }); })
    // … and its settings
    .then(function () { return call('GET', '/settings', undefined, { expect: 200, admin: true, headers: { 'X-Playpex-Device': 'tv-1' } }); })
    .then(function (res) { assert.equal(res.body.device['player.volume'], 100); })
    .then(function () { return call('GET', '/sessions', undefined, { expect: 200, admin: true }); })
    .then(function (res) { assert.equal(res.body.filter(function (s) { return s.deviceId === deviceId; }).length, 0); })
    // password change signs the admin out, then sign in again for the tests below
    .then(function () {
      return call('PUT', '/admin/password', { currentPassword: 'nope-nope', newPassword: 'contract-pass-2' }, { expect: 403, admin: true });
    })
    .then(function () {
      return call('PUT', '/admin/password', { currentPassword: 'contract-pass', newPassword: 'contract-pass-2' }, { expect: 200, admin: true });
    })
    .then(function () { return call('GET', '/admin/devices', undefined, { expect: 401, admin: true }); })
    .then(function () {
      return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'contract-pass-2' }, { expect: 200 });
    })
    .then(function (res) {
      adminCookie = res.headers['set-cookie'].map(function (c) { return c.split(';')[0]; }).join('; ');
      return call('POST', '/auth/sign-out', {}, { expect: 403, admin: true });   // no Origin: refused (CSRF)
    })
    .then(function () { return call('GET', '/admin/setup', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.needed, false); })
    .finally(function () {
      server.settings.update({ security: { requirePairingOnLoopback: false } });
      return auth.ready();
    });
});

test('events WebSocket', function () {
  var WebSocket = require('ws'),
    validateEvent = ajv.getSchema('spec#/components/schemas/Event'),
    wsBase = base.replace(/^http/, 'ws') + protocol.API_PREFIX + '/events';
  covered['GET /events'] = true;
  function open(url, headers) {
    return new Promise(function (resolve) {
      var ws = new WebSocket(url, { headers: headers || {} }), messages = [];
      ws.on('message', function (m) { messages.push(JSON.parse(m)); });
      ws.on('unexpected-response', function (req, res) { resolve({ status: res.statusCode }); });
      ws.on('open', function () {
        setTimeout(function () { ws.close(); resolve({ status: 101, messages: messages }); }, 300);
      });
    });
  }
  return Promise.all([
    open(wsBase),                                        // loopback: a local client
    open(wsBase, { Origin: 'https://evil.example' }),
    open(wsBase.replace('/events', '/nope.json'))
  ]).then(function (r) {
    assert.equal(r[0].status, 101);
    assert.ok(r[0].messages.length >= 1);
    r[0].messages.forEach(function (m) { assert.ok(validateEvent(m), JSON.stringify(validateEvent.errors)); });
    assert.equal(r[0].messages[0].topic, 'server.status');
    assert.equal(r[1].status, 403);
    assert.equal(r[2].status, 404);
  });
});

test('dashboard routes: overview, settings, logs, storage, restart, static pages', function () {
  var fs2 = require('fs'), downloads = path.join(process.env.PLAYPEX_CACHE_DIR, 'torrent_data');
  return call('GET', '/admin/overview', undefined, { expect: 401 }).then(function () {
    return call('GET', '/admin/overview', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.server.recovery, null);
    assert.ok(res.body.providers.length > 0);
    return call('GET', '/admin/setup', undefined, { expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.local, true);
    return call('GET', '/admin/devices', undefined, { admin: true, expect: 200 });
  }).then(function () {
    return call('GET', '/admin/settings', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.settings.general.port, 28470);
    return call('PUT', '/admin/settings', { general: { port: 80, logLevel: 'nope' } }, { admin: true, expect: 400 });
  }).then(function (res) {
    assert.equal(res.body.errors.length, 2);
    return call('PUT', '/admin/settings', { streaming: { maxTorrents: 6 }, general: { port: 28499 } }, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.deepEqual(res.body.changed.sort(), ['general.port', 'streaming.maxTorrents']);
    assert.deepEqual(res.body.restartRequired, ['general.port']);
    return call('PUT', '/admin/settings', { general: { port: 28470 }, streaming: { maxTorrents: 4 } }, { admin: true, expect: 200 });
  }).then(function () {
    return call('POST', '/admin/settings/check-port', { port: 1 }, { admin: true, expect: 400 });
  }).then(function () {
    return call('POST', '/admin/settings/check-port', { port: Number(new URL(base).port) }, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.current, true);
    return call('GET', '/admin/logs?level=info&limit=5', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.ok(res.body.entries.length <= 5);
    return call('GET', '/admin/logs?level=loud', undefined, { admin: true, expect: 400 });
  }).then(function () {
    return call('GET', '/admin/logs/download', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.equal(res.text.slice(0, 2), 'PK');
    fs2.mkdirSync(path.join(downloads, 'Some.Movie.2020'), { recursive: true });
    fs2.writeFileSync(path.join(downloads, 'Some.Movie.2020', 'movie.mkv'), Buffer.alloc(64 * 1024, 1));
    fs2.writeFileSync(path.join(downloads, 'single.mp4'), Buffer.alloc(8 * 1024, 1));
    return call('GET', '/admin/storage', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.deepEqual(res.body.items.map(function (i) { return i.name; }), ['Some.Movie.2020', 'single.mp4']);
    assert.ok(res.body.totalBytes >= 72 * 1024);
    return call('DELETE', '/admin/storage/items/a%2Fb', undefined, { admin: true, expect: 400 });
  }).then(function () {
    return call('DELETE', '/admin/storage/items/missing', undefined, { admin: true, expect: 404 });
  }).then(function () {
    return call('DELETE', '/admin/storage/items/single.mp4', undefined, { admin: true, expect: 200 });
  }).then(function () {
    return call('POST', '/admin/storage/clear', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.removed, 1);
    return call('POST', '/admin/storage/check', { dir: 'relative/dir' }, { admin: true, expect: 400 });
  }).then(function () {
    return call('POST', '/admin/storage/check', { dir: path.join(downloads, 'new', 'dir') }, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.exists, false);
    assert.equal(res.body.writable, true);
    // SPA pages: index.html when built, else a hint (404); API paths keep JSON 404s
    return call('GET', '/link?user_code=ABCD-EFGH', undefined, { raw: true });
  }).then(function (res) {
    assert.ok(res.status === 200 ? /<html/i.test(res.text) : /dashboard is not built/.test(res.text));
    return call('GET', '/api/v2/nothing', undefined, { raw: true, expect: 404 });
  }).then(function (res) {
    assert.equal(res.body.code, 'NOT_FOUND');
    var before = server.info();
    return call('POST', '/admin/restart', undefined, { admin: true, expect: 200 }).then(function () {
      return new Promise(function (resolve, reject) {
        var tries = 0, timer = setInterval(function () {
          var now = server.info();
          if (now && now !== before) {
            clearInterval(timer);
            resolve(now);
          } else if (++tries > 100) {
            clearInterval(timer);
            reject(new Error('the server did not restart'));
          }
        }, 50);
      });
    });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('GET', '/server', undefined, { expect: 200 });
  }).then(function () {
    // the admin's session survives a restart (it's in the database)
    return call('GET', '/admin/overview', undefined, { admin: true, expect: 200 });
  });
});

test('host: headless, then a (fake) desktop supervisor over parentPort', function () {
  var host = require('../lib/host'),
    sent = [],
    listener = null,
    desktop = { appVersion: '0.9.0', platform: process.platform, openAtLogin: true, checkForUpdates: true,
      update: { state: 'downloaded', version: '0.9.1', percent: 100, checkedAt: new Date().toISOString(), error: null } },
    fakePort = {
      on: function (event, fn) { listener = fn; },
      postMessage: function (message) {
        sent.push(message);
        if (message.type !== 'request') {
          return;
        }
        // what apps/server-desktop answers
        setImmediate(function () {
          if (message.action === 'desktop.set') {
            desktop = Object.assign({}, desktop, message.args);
            listener({ data: { type: 'desktop', state: desktop } });
          }
          listener({ data: { type: 'reply', id: message.id, ok: true, result: message.action === 'desktop.set' ? desktop : null } });
        });
      }
    };
  // Supervisor → server request, answered with a reply message
  function ask(action, args) {
    var id = 'test' + sent.length;
    listener({ data: { type: 'request', id: id, action: action, args: args } });
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        var reply = sent.filter(function (m) { return m.type === 'reply' && m.id === id; })[0];
        if (reply) {
          clearInterval(timer);
          resolve(reply);
        }
      }, 10);
    });
  }
  return call('GET', '/admin/host', undefined, { admin: true, expect: 200 }).then(function (res) {
    assert.deepEqual(res.body, { kind: 'headless', desktop: null });
    return call('PUT', '/admin/host', { openAtLogin: false }, { admin: true, expect: 501 });
  }).then(function (res) {
    assert.equal(res.body.code, 'NOT_SUPPORTED');
    host.attachSupervisor(fakePort, { stop: function () { throw new Error('not in this test'); } });
    listener({ data: { type: 'desktop', state: desktop } });
    return call('GET', '/admin/host', undefined, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.kind, 'desktop');
    assert.equal(res.body.desktop.update.version, '0.9.1');
    return call('PUT', '/admin/host', { openAtLogin: 'yes' }, { admin: true, expect: 400 });
  }).then(function () {
    return call('PUT', '/admin/host', { openAtLogin: false }, { admin: true, expect: 200 });
  }).then(function (res) {
    assert.equal(res.body.desktop.openAtLogin, false);
    return call('POST', '/admin/host/update/check', undefined, { admin: true, expect: 200 });
  }).then(function () {
    return call('POST', '/admin/host/update/install', {}, { admin: true, expect: 200 });
  }).then(function () {
    assert.ok(sent.some(function (m) { return m.type === 'request' && m.action === 'update.install'; }));
    return ask('status');
  }).then(function (reply) {
    assert.equal(reply.ok, true);
    assert.equal(reply.result.state, 'running');
    assert.equal(typeof reply.result.streams, 'number');
    assert.ok(Array.isArray(reply.result.pairing));
    return ask('torrents.pauseAll');
  }).then(function (reply) {
    assert.equal(reply.ok, true);
    // kept as a setting (survives restarts)
    assert.equal(server.settings.get('downloads.paused'), true);
    return ask('status');
  }).then(function (reply) {
    assert.equal(reply.result.downloadsPaused, true);
    return ask('torrents.resumeAll');
  }).then(function (reply) {
    assert.equal(reply.ok, true);
    assert.equal(server.settings.get('downloads.paused'), false);
    return ask('pairing.approve', { code: 'NOPE-NOPE' });
  }).then(function (reply) {
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'NOT_FOUND');
    return ask('no.such.action');
  }).then(function (reply) {
    assert.equal(reply.code, 'NOT_FOUND');
    host.setKind('headless');
  });
});

test('no unversioned routes, no Origin: null (plan step 9)', function () {
  return Promise.all([
    call('GET', '/api/profiles', undefined, { expect: 404, raw: true }),
    call('GET', '/elsewhere.json', undefined, { expect: 404, raw: true }),   // paths without a dot are dashboard pages
    // the TV app sends no Origin (its shell removes it); a sandboxed iframe sends `null`
    call('POST', '/api/v1/profiles', { name: 'Iframe' }, { expect: 403, raw: true, headers: { Origin: 'null' } }),
    call('POST', '/api/v1/profiles', { name: 'File page' }, { expect: 403, raw: true, headers: { Origin: 'file://' } })
  ]).then(function (r) {
    assert.equal(r[0].body.code, 'NOT_FOUND');
    assert.equal(r[1].body.code, 'NOT_FOUND');
    assert.equal(r[2].body.code, 'ORIGIN_NOT_ALLOWED');
  });
});

test('profiles', function () {
  var id;
  return call('POST', '/profiles', { name: 'Ann', avatar: 'avatar-01' }, { expect: 201 })
    .then(function (res) {
      id = res.body.id;
      return call('POST', '/profiles', { name: 'ann' }, { expect: 409 });
    })
    .then(function () { return call('POST', '/profiles', {}, { expect: 400 }); })
    .then(function () { return call('GET', '/profiles', undefined, { expect: 200 }); })
    .then(function () { return call('GET', '/profiles/' + id, undefined, { expect: 200 }); })
    .then(function () { return call('GET', '/profiles/nope', undefined, { expect: 404 }); })
    .then(function () { return call('PUT', '/profiles/' + id, { preferences: { adult: { layout: 'posters' } } }, { expect: 200 }); })
    .then(function () { return call('PUT', '/profiles/' + id + '/pin', { pin: '1234' }, { expect: 200 }); })
    .then(function () { return call('PUT', '/profiles/' + id + '/pin', { pin: '12' }, { expect: 400 }); })
    .then(function () { return call('POST', '/profiles/' + id + '/unlock', { pin: '0000' }, { expect: 403 }); })
    .then(function () { return call('POST', '/profiles/' + id + '/unlock', { pin: '1234' }, { expect: 200 }); })
    .then(function (res) { assert.ok(res.body.lastUsedAt); })
    .then(function () { return call('DELETE', '/profiles/' + id, undefined, { expect: 200 }); });
});

test('library of a profile', function () {
  var p;
  return call('POST', '/profiles', { name: 'Bob' }, { expect: 201 })
    .then(function (res) {
      p = '/profiles/' + res.body.id;
      return call('PUT', p + '/watchlist/movie/603', { title: 'The Matrix', posterPath: '/p.jpg' }, { expect: 200 });
    })
    .then(function () { return call('GET', p + '/watchlist/movie/603', undefined, { expect: 200 }); })
    .then(function () { return call('GET', p + '/watchlist/movie/abc', undefined, { expect: 400 }); })
    .then(function () { return call('GET', p + '/watchlist', undefined, { expect: 200 }); })
    .then(function () {
      return call('PUT', p + '/progress/tv/1396', { season: 1, episode: 2, positionS: 600, durationS: 3000,
        title: 'Breaking Bad', infoHash: 'abc', filePath: 'x.mkv' }, { expect: 200 });
    })
    .then(function () { return call('PUT', p + '/progress/tv/1396', { season: 1, episode: 3, positionS: 2900, durationS: 3000 }, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.justFinished, true); })
    .then(function () { return call('GET', p + '/progress/tv/1396?season=1&episode=2', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.resume.positionS, 600); })
    .then(function () { return call('GET', p + '/progress/movie/550', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.resume, null); })
    .then(function () { return call('GET', p + '/progress/tv/1396/episodes', undefined, { expect: 200 }); })
    .then(function () { return call('PUT', p + '/watched/movie/550', { title: 'Fight Club' }, { expect: 200 }); })
    .then(function () { return call('GET', p + '/library', undefined, { expect: 200 }); })
    .then(function (res) { assert.ok(res.body.continueWatching.length >= 1); })
    .then(function () { return call('GET', p + '/history', undefined, { expect: 200 }); })
    .then(function () { return call('DELETE', p + '/watched/movie/550', undefined, { expect: 200 }); })
    .then(function () { return call('DELETE', p + '/watchlist/movie/603', undefined, { expect: 200 }); })
    .then(function () { return call('GET', '/profiles/nope/library', undefined, { expect: 404 }); });
});

test('settings: device and profile, defaults, reset, rules', function () {
  var protocolSettings = require('@playpex/protocol/settings'),
    DEV = { headers: { 'X-Playpex-Device': 'settings-test' } },
    kid, adult;
  function opts(expect, extra) {
    return Object.assign({ expect: expect }, DEV, extra);
  }
  return call('GET', '/settings', undefined, { expect: 400 })
    .then(function (res) { assert.equal(res.body.code, 'DEVICE_REQUIRED'); })
    .then(function () { return call('GET', '/settings?device=bad%20id', undefined, { expect: 400 }); })
    // effective values: every registered key with its default
    .then(function () { return call('GET', '/settings?definitions=1', undefined, opts(200)); })
    .then(function (res) {
      assert.deepEqual(res.body.device, protocolSettings.defaults('device'));
      assert.equal(res.body.profile, null);
      assert.deepEqual(Object.keys(res.body.definitions).sort(), Object.keys(protocolSettings.SETTINGS).sort());
      return call('GET', '/settings?device=settings-test', undefined, { expect: 200 });
    })
    .then(function (res) { assert.equal(res.body.definitions, undefined); })
    .then(function () {
      return call('PATCH', '/settings/device', { 'player.volume': 40, 'subtitles.size': 'large',
        'client.playpex-tv.lastTab': { tab: 'audio' } }, opts(200));
    })
    .then(function (res) {
      assert.equal(res.body['player.volume'], 40);
      assert.equal(res.body['subtitles.size'], 'large');
      assert.deepEqual(res.body['client.playpex-tv.lastTab'], { tab: 'audio' });
      assert.equal(res.body['display.uiScale'], 0.8);
    })
    // all or nothing: one bad key refuses the patch
    .then(function () { return call('PATCH', '/settings/device', { 'player.volume': 50, 'player.nope': 1 }, opts(400)); })
    .then(function (res) { assert.equal(res.body.errors.length, 1); })
    .then(function () { return call('PATCH', '/settings/device', { 'player.volume': 101 }, opts(400)); })
    .then(function () { return call('PATCH', '/settings/device', { 'player.volume': 42 }, opts(400)); })      // step 5
    .then(function () { return call('PATCH', '/settings/device', { 'display.uiScale': 0.75 }, opts(400)); })  // not a size
    .then(function () { return call('PATCH', '/settings/device', { 'adult.layout': 'compact' }, opts(400)); }) // a profile key
    .then(function () { return call('PATCH', '/settings/device', { 'client.playpex-tv.big': 'x'.repeat(5000) }, opts(400)); })
    .then(function () { return call('PATCH', '/settings/device', {}, opts(400)); })
    .then(function () { return call('GET', '/settings', undefined, opts(200)); })
    .then(function (res) { assert.equal(res.body.device['player.volume'], 40); })
    // another device doesn't see them
    .then(function () { return call('GET', '/settings?device=other-device', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.device['player.volume'], 100); })
    // null resets one key; DELETE resets them all
    .then(function () { return call('PATCH', '/settings/device', { 'subtitles.size': null }, opts(200)); })
    .then(function (res) {
      assert.equal(res.body['subtitles.size'], 'medium');
      assert.equal(res.body['player.volume'], 40);
      return call('DELETE', '/settings/device', undefined, opts(200));
    })
    .then(function (res) { assert.deepEqual(res.body, protocolSettings.defaults('device')); })
    // profiles: adult keys refused for kids (and not shown), the deprecated preferences answered from the settings
    .then(function () { return call('POST', '/profiles', { name: 'Settings adult' }, { expect: 201 }); })
    .then(function (res) {
      adult = res.body.id;
      assert.deepEqual(res.body.preferences, { adult: { layout: 'posters', metadataProvider: null } });
      return call('POST', '/profiles', { name: 'Settings kid', isKid: true }, { expect: 201 });
    })
    .then(function (res) { kid = res.body.id; })
    .then(function () { return call('GET', '/settings?profile=' + adult, undefined, opts(200)); })
    .then(function (res) { assert.deepEqual(res.body.profile, protocolSettings.defaults('profile')); })
    .then(function () { return call('GET', '/settings?profile=nope', undefined, opts(404)); })
    .then(function () {
      return call('PATCH', '/profiles/' + adult + '/settings', { 'adult.layout': 'compact', 'subtitles.provider': 'yify',
        'player.autoplayNext': false }, { expect: 200 });
    })
    .then(function (res) {
      assert.equal(res.body['adult.layout'], 'compact');
      assert.equal(res.body['player.autoplayNext'], false);
      return call('GET', '/profiles/' + adult, undefined, { expect: 200 });
    })
    .then(function (res) { assert.equal(res.body.preferences.adult.layout, 'compact'); })
    .then(function () { return call('PUT', '/profiles/' + adult, { preferences: { adult: { metadataProvider: 'tmdb' } } }, { expect: 200 }); })
    .then(function (res) { assert.deepEqual(res.body.preferences.adult, { layout: 'compact', metadataProvider: 'tmdb' }); })
    .then(function () { return call('PUT', '/profiles/' + adult, { preferences: { adult: { layout: 'grid' } } }, { expect: 400 }); })
    .then(function () { return call('PATCH', '/profiles/' + adult + '/settings', { 'player.volume': 10 }, { expect: 400 }); })
    .then(function () { return call('PATCH', '/profiles/nope/settings', { 'player.autoplayNext': true }, { expect: 404 }); })
    .then(function () { return call('PATCH', '/profiles/' + kid + '/settings', { 'adult.layout': 'compact' }, { expect: 403 }); })
    .then(function () { return call('PATCH', '/profiles/' + kid + '/settings', { 'player.autoplayNext': false }, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body['adult.layout'], undefined); })
    .then(function () { return call('PUT', '/profiles/' + kid, { preferences: { adult: { layout: 'compact' } } }, { expect: 403 }); })
    // deleting a profile deletes its settings
    .then(function () { return call('DELETE', '/profiles/' + adult, undefined, { expect: 200 }); })
    .then(function () {
      return require('../lib/userData').database().then(function (db) {
        var schema = require('../lib/db/schema'), orm = require('drizzle-orm');
        return db.select().from(schema.profileSettings).where(orm.eq(schema.profileSettings.profileId, adult));
      });
    })
    .then(function (rows) { assert.equal(rows.length, 0); })
    .then(function () { return call('DELETE', '/profiles/' + kid, undefined, { expect: 200 }); });
});

test('media library (admin): folders, scan, files, matches, subtitles, folder browser', function () {
  var dir = path.join(tmp, 'media', 'Movies'), folder, file;
  fs.mkdirSync(path.join(dir, 'Inception (2010)'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Inception (2010)', 'Inception (2010).mkv'), Buffer.alloc(2000, 1));
  fs.writeFileSync(path.join(dir, 'Inception (2010)', 'Inception (2010).en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  fs.writeFileSync(path.join(dir, 'Unknown.Thing.2001.mkv'), Buffer.alloc(2000, 1));
  return call('GET', '/admin/library', undefined, { expect: 401 })
    .then(function () { return call('POST', '/admin/library/folders', { path: dir, kind: 'movies' }, { expect: 201, admin: true }); })
    .then(function (res) {
      folder = res.body;
      return call('POST', '/admin/library/folders', { path: dir, kind: 'movies' }, { expect: 409, admin: true });
    })
    .then(function () { return call('POST', '/admin/library/folders', { path: 'x', kind: 'movies' }, { expect: 400, admin: true }); })
    .then(function () { return call('POST', '/admin/library/scan', { folderId: folder.id }, { expect: 200, admin: true }); })
    .then(function () { return call('POST', '/admin/library/scan', { folderId: 'nope' }, { expect: 404, admin: true }); })
    .then(function () { return require('../lib/library').idle(); })
    .then(function () { return call('GET', '/admin/library', undefined, { expect: 200, admin: true }); })
    .then(function (res) {
      assert.ok(res.body.folders.some(function (f) { return f.id === folder.id && f.counts.ok === 1 && f.counts.unmatched === 1; }));
      return call('GET', '/admin/library/files?folder=' + folder.id + '&state=unmatched', undefined, { expect: 200, admin: true });
    })
    .then(function (res) {
      file = res.body.files[0];
      return call('GET', '/admin/library/files?state=bogus', undefined, { expect: 400, admin: true });
    })
    .then(function () { return call('GET', '/admin/library/files/' + file.id, undefined, { expect: 200, admin: true }); })
    .then(function () { return call('GET', '/admin/library/files/nope', undefined, { expect: 404, admin: true }); })
    .then(function () { return call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'movie', tmdbId: 27205 }, { expect: 200, admin: true }); })
    .then(function (res) {
      assert.equal(res.body.matchedBy, 'admin');
      return call('PUT', '/admin/library/files/' + file.id + '/match', { kind: 'movie' }, { expect: 400, admin: true });
    })
    .then(function () { return call('DELETE', '/admin/library/files/' + file.id + '/match', undefined, { expect: 200, admin: true }); })
    .then(function () { return call('PUT', '/admin/library/files/' + file.id + '/ignored', { ignored: true }, { expect: 200, admin: true }); })
    .then(function () { return call('PUT', '/admin/library/files/' + file.id + '/ignored', {}, { expect: 400, admin: true }); })
    .then(function () { return call('GET', '/admin/library/search?kind=movie&q=inception', undefined, { expect: 200, admin: true }); })
    .then(function () { return call('GET', '/admin/library/search?kind=movie', undefined, { expect: 400, admin: true }); })
    .then(function () { return call('GET', '/admin/fs?path=' + encodeURIComponent(path.join(tmp, 'media')), undefined, { expect: 200, admin: true }); })
    .then(function () { return call('GET', '/admin/fs', undefined, { expect: 200, admin: true }); })
    .then(function () { return call('GET', '/admin/fs?path=' + encodeURIComponent(path.join(tmp, 'nope')), undefined, { expect: 404, admin: true }); })
    .then(function () { return call('GET', '/admin/library/files?state=ok', undefined, { expect: 200, admin: true }); })
    .then(function (res) {
      var ref = res.body.files[0].ref;
      return call('GET', '/media/' + ref + '/subtitles', undefined, { expect: 200 }).then(function (subs) {
        assert.equal(subs.body.subtitles[0].language, 'en');
        return call('GET', '/media/' + ref + '/subtitles/0', undefined, { expect: 200 });
      }).then(function (vtt) {
        assert.match(vtt.text, /^WEBVTT/);
        return call('GET', '/media/' + ref + '/subtitles/3', undefined, { expect: 404 });
      });
    })
    // the play pipeline: the library's file of the movie, alone, plays at once (no imdbId: no YTS call)
    .then(function () { return call('POST', '/play/sources', { kind: 'movie', title: 'Inception' }, { expect: 400 }); })
    .then(function () { return call('POST', '/play/sources', { kind: 'movie', tmdbId: 27205, title: 'Inception', profileId: 'nope' }, { expect: 404 }); })
    .then(function () { return call('POST', '/play/sources', { kind: 'movie', tmdbId: 27205, title: 'Inception', year: 2010 }, { expect: 200 }); })
    .then(function (res) {
      var first = res.body.sources[0];
      assert.equal(first.type, 'file');
      assert.match(first.ref, /^f_/);
      assert.equal(res.body.policy.autoplay, first.id);
    })
    .then(function () { return call('PATCH', '/admin/library/folders/' + folder.id, { audience: 'adults' }, { expect: 200, admin: true }); })
    // a kids profile gets no file of an adults-only folder
    .then(function () { return call('POST', '/profiles', { name: 'Little one', isKid: true }, { expect: 201 }); })
    .then(function (res) {
      return call('POST', '/play/sources', { kind: 'movie', tmdbId: 27205, title: 'Inception', profileId: res.body.id }, { expect: 200 });
    })
    .then(function (res) {
      assert.equal(res.body.sources.length, 0);
      assert.equal(res.body.policy.autoplay, null);
    })
    .then(function () { return call('PATCH', '/admin/library/folders/' + folder.id, { kind: 'films' }, { expect: 400, admin: true }); })
    .then(function () { return call('PATCH', '/admin/library/folders/nope', { dlna: true }, { expect: 404, admin: true }); })
    .then(function () { return call('DELETE', '/admin/library/folders/' + folder.id, undefined, { expect: 200, admin: true }); })
    .then(function () { return call('DELETE', '/admin/library/folders/' + folder.id, undefined, { expect: 404, admin: true }); });
});

test('torrents without network', function () {
  var hash = '0000000000000000000000000000000000000000';
  return Promise.all([
    call('GET', '/torrents', undefined, { expect: 200 }),
    call('GET', '/torrents/' + hash, undefined, { expect: 404 }),
    call('GET', '/torrents/' + hash + '/stats', undefined, { expect: 404 }),
    call('POST', '/torrents/' + hash + '/deselect', undefined, { expect: 404 }),
    call('DELETE', '/torrents/' + hash, undefined, { expect: 404 }),
    call('GET', '/torrents/' + hash + '/files/a%2Fb.mkv', undefined, { expect: 404 }),
    call('GET', '/media/t_' + hash + '_0123456789abcdef', undefined, { expect: 404 }),
    call('GET', '/media/t_' + hash + '_0123456789abcdef/probe', undefined, { expect: 404 }),
    call('GET', '/media/f_00000000-0000-0000-0000-000000000000/keyframe?t=1', undefined, { expect: 404 }),
    call('GET', '/media/f_00000000-0000-0000-0000-000000000000/transcode', undefined, { expect: 404 }),
    call('POST', '/media/f_00000000-0000-0000-0000-000000000000/keepalive', {}, { expect: 404 }),
    call('DELETE', '/media/f_00000000-0000-0000-0000-000000000000', undefined, { expect: 404 }),
    call('POST', '/torrents', { link: 'not a torrent' }, { expect: 400 })
  ]);
});

test('leases: shared torrents, grace period, limits, keepalive, sessions', function () {
  var sessions = require('../lib/sessions'),
    H = ['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222',
      '3333333333333333333333333333333333333333', '4444444444444444444444444444444444444444'],
    A = { 'X-Playpex-Device': 'device-a' },
    B = { 'X-Playpex-Device': 'device-b' };
  function as(headers, expect) {
    return { headers: headers, expect: expect };
  }
  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function stateOf(hash) {
    return call('GET', '/downloads/' + hash, undefined, { expect: 200 }).then(function (res) { return res.body.state; });
  }
  function leasesOf(hash) {
    return call('GET', '/sessions', undefined, { expect: 200, admin: true }).then(function (res) {
      return res.body.filter(function (s) { return s.infoHash === hash; });
    });
  }
  sessions.configure({ graceMs: 200 });
  server.settings.update({ streaming: { maxTorrents: 2 } });

  return call('POST', '/torrents', { link: H[0] }, as(A, 200))
    .then(function () { return call('POST', '/torrents', { link: H[0] }, as(B, 200)); })
    .then(function () { return leasesOf(H[0]); })
    .then(function (leases) {
      assert.deepEqual(leases.map(function (l) { return l.deviceId; }), ['device-a', 'device-b']);
    })
    // the player's keepalive reports what it plays; ?device= works like the header
    .then(function () {
      return call('POST', '/torrents/' + H[0] + '/keepalive?device=device-a',
        { positionS: 61.5, durationS: 3600, paused: true, title: 'Test · S01E01', bogus: 1 }, { expect: 200 });
    })
    .then(function () { return leasesOf(H[0]); })
    .then(function (leases) {
      assert.equal(leases[0].playback.title, 'Test · S01E01');
      assert.equal(leases[0].playback.positionS, 61.5);
      assert.equal(leases[0].playback.bogus, undefined);
    })
    // one device letting go doesn't stop a torrent another one holds
    .then(function () { return call('DELETE', '/torrents/' + H[0], undefined, as(A, 200)); })
    .then(function () { return wait(400); })
    .then(function () { return call('GET', '/torrents/' + H[0], undefined, { expect: 200 }); })
    // the last one: paused after the grace period (kept, data kept)
    .then(function () { return call('DELETE', '/torrents/' + H[0], undefined, as(B, 200)); })
    .then(function () { return stateOf(H[0]); })
    .then(function (state) { assert.equal(state, 'downloading'); })
    .then(function () { return wait(400); })
    .then(function () { return stateOf(H[0]); })
    .then(function (state) { assert.equal(state, 'paused'); })
    .then(function () { return call('GET', '/torrents/' + H[0], undefined, { expect: 200 }); })
    // coming back within the grace period keeps it
    .then(function () { return call('POST', '/torrents', { link: H[1] }, as(A, 200)); })
    .then(function () { return call('DELETE', '/torrents/' + H[1], undefined, as(A, 200)); })
    .then(function () { return call('POST', '/torrents/' + H[1] + '/keepalive', {}, as(A, 200)); })
    .then(function () { return wait(400); })
    .then(function () { return stateOf(H[1]); })
    .then(function (state) { assert.equal(state, 'downloading'); })
    // maxTorrents: 2 → a third is BUSY; one waiting out its grace period makes room
    .then(function () { return call('POST', '/torrents', { link: H[2] }, as(A, 200)); })
    .then(function () { return call('POST', '/torrents', { link: H[3] }, as(A, 503)); })
    .then(function (res) { assert.equal(res.body.code, 'BUSY'); })
    .then(function () { return call('POST', '/torrents', { link: H[2] }, as(B, 200)); })   // held already: fine
    .then(function () { return call('DELETE', '/torrents/' + H[2], undefined, as(A, 200)); })
    .then(function () { return call('DELETE', '/torrents/' + H[2], undefined, as(B, 200)); })
    .then(function () { return call('POST', '/torrents', { link: H[3] }, as(A, 200)); })
    .then(function () { return stateOf(H[2]); })
    .then(function (state) { assert.equal(state, 'paused'); })
    // playing a paused one again: past the limit, BUSY (both running ones are held)
    .then(function () { return call('POST', '/torrents', { link: H[0] }, as(A, 503)); })
    // stopping a session from the dashboard
    .then(function () { return leasesOf(H[1]); })
    .then(function (leases) {
      assert.equal(leases.length, 1);
      return call('DELETE', '/sessions/' + leases[0].id, undefined, { expect: 200, admin: true });
    })
    .then(function () { return leasesOf(H[1]); })
    .then(function (leases) { assert.equal(leases.length, 0); })
    .then(function () { return call('DELETE', '/sessions/nope', undefined, { expect: 404, admin: true }); })
    .then(function () { return call('GET', '/sessions', undefined, { expect: 401 }); })   // local, not admin
    // the reaper drops idle leases
    .then(function () { sessions.configure({ idleMs: 1 }); return wait(20); })
    .then(function () { sessions.reap(); return leasesOf(H[3]); })
    .then(function (leases) { assert.equal(leases.length, 0); })
    .then(function () { return wait(400); })
    .then(function () { return call('GET', '/torrents', undefined, { expect: 200 }); })
    .then(function (res) { assert.equal(res.body.length, 0); })
    .then(function () { return Promise.all(H.map(function (h) { return call('DELETE', '/downloads/' + h + '?data=delete', undefined, { admin: true, expect: 200 }); })); })
    .finally(function () {
      sessions.configure({ graceMs: 30000, idleMs: 0 });
      server.settings.update({ streaming: { maxTorrents: 4 } });
    });
});

test('downloads: add, files, rules, pause, start, remove', function () {
  var H = '5555555555555555555555555555555555555555';
  return call('GET', '/downloads', undefined, { expect: 200 })
    .then(function () { return call('POST', '/downloads', { link: 'not a torrent' }, { expect: 400 }); })
    .then(function () { return call('POST', '/downloads', { link: H, files: 'a' }, { expect: 400 }); })
    .then(function () {
      return call('POST', '/downloads', { link: H, media: { mediaType: 'movie', tmdbId: 42 }, title: 'Some Movie (2020)' },
        { expect: 200, headers: { 'X-Playpex-Device': 'device-c' } });
    })
    .then(function (res) {
      // the title it was added for: what title pages find it by
      assert.deepEqual(res.body.title, { mediaType: 'movie', tmdbId: 42, title: 'Some Movie (2020)' });
      assert.equal(res.body.intent, 'download');
      assert.equal(res.body.addedBy, 'device-c');
      assert.ok(['queued', 'downloading'].indexOf(res.body.state) !== -1);
      return call('GET', '/downloads/' + H, undefined, { expect: 200 });
    })
    .then(function (res) {
      assert.equal(res.body.files, null);   // no metadata offline
      return call('PATCH', '/downloads/' + H, { removeWhenWatched: 'yes' }, { expect: 400 });
    })
    .then(function () { return call('PATCH', '/downloads/' + H, { removeWhenWatched: true }, { expect: 200 }); })
    .then(function (res) {
      assert.equal(res.body.removeWhenWatched, true);
      return call('PUT', '/downloads/' + H + '/files', {}, { expect: 400 });
    })
    .then(function () { return call('PUT', '/downloads/' + H + '/files', { files: null }, { expect: 200 }); })
    .then(function () { return call('POST', '/downloads/' + H + '/pause', undefined, { expect: 200 }); })
    .then(function (res) {
      assert.equal(res.body.state, 'paused');
      return call('POST', '/downloads/' + H + '/start', undefined, { expect: 200 });
    })
    .then(function (res) {
      assert.ok(['queued', 'downloading'].indexOf(res.body.state) !== -1);
      return call('GET', '/downloads/' + '6'.repeat(40), undefined, { expect: 404 });
    })
    // removing is the admin's: data keep / delete, nothing else
    .then(function () { return call('DELETE', '/downloads/' + H + '?data=keep', undefined, { expect: 401 }); })
    .then(function () { return call('DELETE', '/downloads/' + H, undefined, { admin: true, expect: 400 }); })
    .then(function () { return call('DELETE', '/downloads/' + H + '?data=keep', undefined, { admin: true, expect: 200 }); })
    .then(function () { return call('GET', '/downloads/' + H, undefined, { expect: 404 }); });
});

test('torrent engines: the choices, install / remove routes', function () {
  return call('GET', '/admin/settings', undefined, { admin: true, expect: 200 }).then(function (res) {
    var ids = res.body.engines.map(function (e) { return e.id; });
    assert.ok(ids.indexOf('torrent-stream') !== -1 && ids.indexOf('rqbit') !== -1 && ids.indexOf('torrentd') !== -1);
    assert.equal(res.body.engines.filter(function (e) { return e.id === 'torrent-stream'; })[0].installed, 'builtin');
    return call('POST', '/admin/engines/torrent-stream/install', undefined, { admin: true, expect: 400 });
  })
    .then(function () { return call('POST', '/admin/engines/nope/install', undefined, { admin: true, expect: 404 }); })
    .then(function () { return call('DELETE', '/admin/engines/nope', undefined, { admin: true, expect: 404 }); })
    .then(function () { return call('DELETE', '/admin/engines/rqbit', undefined, { expect: 401 }); })
    // the running engine can't be removed
    .then(function () { return call('DELETE', '/admin/engines/' + require('../lib/torrents/client').info().engine, undefined, { admin: true }); })
    .then(function (res) { assert.ok(res.status === 409 || res.status === 400, 'running engine: ' + res.status); });
});

test('provider lists and parameter checks', function () {
  return Promise.all([
    call('GET', '/releases/providers?kind=movie', undefined, { expect: 200 }),
    call('GET', '/releases/providers?kind=tv', undefined, { expect: 200 }),
    call('GET', '/releases/providers?kind=nope', undefined, { expect: 400 }),
    call('GET', '/releases/browse?kind=nope', undefined, { expect: 400 }),
    call('GET', '/adult/providers', undefined, { expect: 200 }),
    call('GET', '/adult/meta/providers', undefined, { expect: 200 }),
    call('GET', '/adult/meta/nope/home', undefined, { expect: 404 }),
    call('GET', '/subtitles/providers', undefined, { expect: 200 }),
    call('GET', '/subtitles/search', undefined, { expect: 400 }),
    call('GET', '/imdb/xyz', undefined, { expect: 400 }),
    call('GET', '/shows/tt0903747/torrents?title=Breaking%20Bad', undefined, { expect: 400 }),
    call('GET', '/adult/torrents', undefined, { expect: 400 })
  ]);
});

test('provider-backed routes', { skip: !NETWORK && 'set PLAYPEX_TEST_NETWORK=1' }, function () {
  // Providers can be down: a documented 502 passes the contract too
  function either(method, apiPath) {
    return call(method, apiPath).then(function (res) {
      process.stdout.write('# ' + apiPath + ' → ' + res.status + (res.status === 502 ? ' (' + res.body.error + ')' : '') + '\n');
      assert.ok(res.status === 200 || res.status === 502, apiPath + ' → ' + res.status);
      return res;
    });
  }
  return Promise.all([
    either('GET', '/movies/tt0133093'),
    either('GET', '/movies?limit=2'),
    either('GET', '/imdb/tt0903747'),
    either('GET', '/imdb/tt0903747/episodes'),
    either('GET', '/shows/tt0903747/torrents?title=Breaking%20Bad&season=1&episode=1'),
    either('GET', '/releases/browse?kind=movie&provider=yts'),
    either('GET', '/releases/browse?kind=tv&provider=eztv&imdb=tt0903747'),
    either('GET', '/releases/browse?kind=movie&provider=therarbg&quality=1080p'),
    either('GET', '/subtitles/search?imdb_id=tt0133093&languages=en'),
    call('GET', '/adult/meta/default/home').then(function (res) {
      assert.ok([200, 502, 503].indexOf(res.status) !== -1, 'adult home → ' + res.status);
    })
  ]);
});
