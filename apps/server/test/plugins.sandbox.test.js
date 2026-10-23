'use strict';

// The plugin sandbox (docs/plugins-plan.md step P2) on a real server: hostile
// plugins are stopped or throttled every time and the server keeps serving.
// A local HTTPS server (a throwaway certificate made with openssl, on
// 127.0.0.2) plays the outside world; a fake resolver maps test host names to
// it, to 127.0.0.1 or to a LAN address.
//
//   reads files / process / fetch → nothing there      loops forever → CPU_LIMIT, the server answers meanwhile
//   allocates 1 GB → OUT_OF_MEMORY                     three of those → the plugin is stopped (failed)
//   an IP / undeclared host / a name resolving to loopback or the LAN / a redirect there → refused
//   too many requests → waits, then RATE_LIMITED       play without permission → the effect is dropped
//   4 calls at once all answer                         kids profiles never reach an adults plugin

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  userData = require('../lib/userData');

var TEST_HOST = '127.0.0.2',
  base = null,
  remote = null,       // the HTTPS "internet"
  remotePort = 0,
  remoteHits = 0,
  hasTls = true;

// ── fixtures ────────────────────────────────────────────────────────────────

function manifest(id, extra) {
  return Object.assign({
    id: id, name: id, version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: {}
  }, extra);
}

function writePlugin(id, extra, code, files) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(manifest(id, extra)));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  Object.keys(files || {}).forEach(function (f) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), files[f]);
  });
  return dir;
}

var HOSTILE = String.raw`
playpex.data('probe', function () {
  return { data: {
    require: typeof require, process: typeof process, fetch: typeof fetch, timers: typeof setTimeout,
    wasm: typeof WebAssembly, std: typeof std, os: typeof os, globals: Object.getOwnPropertyNames(globalThis).filter(function (k) {
      // the language's own lowercase globals; anything else would be ours or the engine's
      return ['playpex', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI',
        'encodeURIComponent', 'escape', 'unescape', 'undefined', 'eval', 'globalThis'].indexOf(k) === -1 && /^[a-z]/.test(k);
    })
  } };
});
playpex.data('spin', function () { while (true) {} });
playpex.data('spinLater', async function () { await null; for (;;) { try { Math.random(); } catch (e) {} } });
playpex.data('hog', function () { var a = []; for (;;) { a.push(new Array(1 << 20).fill(1)); } });
playpex.data('fetch', async function (args) {
  try {
    var r = await playpex.http.request({ url: args.url, responseType: args.type || 'json' });
    return { data: { status: r.status, body: r.body } };
  } catch (e) {
    return { data: { error: e.code, message: e.message } };
  }
});
playpex.data('burst', async function (args) {
  var started = Date.now();
  var all = await Promise.all(Array.from({ length: args.n }, function () {
    return playpex.http.request({ url: args.url, responseType: 'json' }).then(function () { return 'ok'; }, function (e) { return e.code; });
  }));
  return { data: { results: all, ms: Date.now() - started } };
});
playpex.data('denied', async function () {
  var out = {};
  async function attempt(name, fn) { try { await fn(); out[name] = 'allowed'; } catch (e) { out[name] = e.code; } }
  await attempt('store', function () { return playpex.store.set('a', 1); });
  await attempt('secret', function () { return playpex.secrets.get('stolen'); });
  await attempt('hook', function () { playpex.hooks.on('play.collect', function () {}); });
  await attempt('event', function () { playpex.events.on('playback.started', function () {}); });
  await attempt('later', function () { return playpex.watchlist.list('p'); });
  return { data: out };
});
playpex.data('playIt', function () {
  return { data: null, effects: [
    { type: 'play', request: { title: 'X', sources: [{ kind: 'magnet', label: 'x', infoHash: '${'a'.repeat(40)}' }] } },
    { type: 'toast', text: 'hello' },
    { type: 'open', intent: { screen: 'plugin.other.title' } }
  ] };
});
playpex.data('badAnswer', function () { return { data: 1, effects: [{ type: 'eval', code: 'x' }] }; });
`;

var GOOD = String.raw`
playpex.data('slow', async function () {
  var r = await playpex.http.request({ url: 'https://api.playpex-test.dev:PORT/slow', responseType: 'json' });
  return { data: r.body };
});
playpex.data('echo', async function (args, ctx) {
  var bytes = new Uint8Array([1, 2, 3, 250]);
  var r = await playpex.http.request({ url: 'https://api.playpex-test.dev:PORT/echo', method: 'POST', body: bytes, responseType: 'bytes' });
  return { data: { len: r.body.length, last: r.body[3], isBytes: r.body instanceof Uint8Array, profile: ctx.profile, locale: ctx.locale } };
});
playpex.data('keep', async function (args) {
  await playpex.store.set('k:' + args.n, { n: args.n });
  var tooBig = 'x'.repeat(5000);
  var quota = null;
  try { await playpex.store.set('big', tooBig); } catch (e) { quota = e.code; }
  return { data: { value: await playpex.store.get('k:' + args.n), keys: await playpex.store.list('k:'), quota: quota,
    secret: await playpex.secrets.get('apiKey'), mode: await playpex.settings.get('mode', null),
    hello: await playpex.i18n.t('hello', { name: 'Ann' }, { locale: 'fr' }) } };
});
playpex.hooks.on('play.collect', function (input) {
  return [{ kind: 'magnet', label: input.title.title + ' 1080p', infoHash: '${'b'.repeat(40)}', quality: '1080p' }];
});
`;

function certificate() {
  var dir = path.join(tmp, 'tls');
  fs.mkdirSync(dir);
  var result = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=playpex-test',
    '-addext', 'subjectAltName=DNS:*.playpex-test.dev'], { stdio: 'ignore' });
  if (result.status !== 0) {
    return null;
  }
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

// Test names → addresses: api (the test server), loop (loopback), lan (a LAN address)
function lookup(host, options, callback) {
  var map = { 'api.playpex-test.dev': TEST_HOST, 'loop.playpex-test.dev': '127.0.0.1', 'lan.playpex-test.dev': '192.168.1.20',
    'mixed.playpex-test.dev': [TEST_HOST, '10.0.0.5'] };
  var a = map[host];
  if (!a) {
    var err = new Error('ENOTFOUND');
    err.code = 'ENOTFOUND';
    return callback(err);
  }
  callback(null, [].concat(a).map(function (address) { return { address: address, family: 4 }; }));
}

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + urlPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Playpex-Device': 'test-device-1' }, headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function data(id, name, args, profile) {
  return request('POST', '/plugins/' + id + '/data/' + name + (profile ? '?profile=' + profile : ''), { args: args || {} });
}

var kidsProfile = null, adultProfile = null;

test.before(function () {
  var tls = certificate();
  hasTls = !!tls;
  var ready = tls ? new Promise(function (resolve) {
    remote = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
      remoteHits++;
      var url = new URL(req.url, 'https://x');
      if (url.pathname === '/json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ hello: 'world' }));
      }
      if (url.pathname === '/slow') {
        return setTimeout(function () { res.end(JSON.stringify({ slow: true })); }, 400);
      }
      if (url.pathname === '/echo') {
        var chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        return req.on('end', function () { res.end(Buffer.concat(chunks)); });
      }
      if (url.pathname === '/to-loop' || url.pathname === '/to-undeclared' || url.pathname === '/to-api') {
        var target = { '/to-loop': 'https://loop.playpex-test.dev:' + remotePort + '/json',
          '/to-undeclared': 'https://elsewhere.example.org/json', '/to-api': '/json' }[url.pathname];
        res.writeHead(302, { Location: target });
        return res.end();
      }
      res.statusCode = 404;
      res.end('{}');
    });
    remote.listen(0, TEST_HOST, function () {
      remotePort = remote.address().port;
      resolve();
    });
  }) : Promise.resolve();

  return ready.then(function () {
    var network = ['api.playpex-test.dev', 'loop.playpex-test.dev', 'lan.playpex-test.dev', 'mixed.playpex-test.dev'];
    var dirs = [
      writePlugin('hostile', { permissions: { network: network, play: false } }, HOSTILE),
      writePlugin('good', {
        permissions: { network: ['api.playpex-test.dev'], storage: '4KB', secrets: ['apiKey'], hooks: ['play.collect'], sources: ['magnet'] },
        contributes: {
          screens: [{ name: 'home', template: 'catalog', data: 'slow' }],
          settings: [{ key: 'mode', scope: 'server', type: 'choice', label: 'Mode', options: [['a', 'A'], ['b', 'B']], default: 'b' }]
        },
        icon: 'assets/icon.svg'
      }, GOOD.replace(/PORT/g, String(remotePort)), {
        'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'i18n/en.json': '{"hello":"Hello {name}"}', 'i18n/fr.json': '{"hello":"Bonjour {name}"}'
      }),
      writePlugin('slowpoke', { permissions: { network: ['api.playpex-test.dev'], rateLimit: { perSecond: 1, burst: 2 } } }, HOSTILE),
      writePlugin('looper', {}, 'for (;;) {}'),
      writePlugin('strikes', {}, HOSTILE),
      writePlugin('spinner', {}, HOSTILE),
      writePlugin('hogger', {}, HOSTILE),
      writePlugin('grown', {}, 'playpex.hooks.on("play.collect", function () { return []; });'),
      writePlugin('nsfw', { audience: 'adults', permissions: { play: true, sources: ['magnet'], hooks: ['play.collect'] } }, HOSTILE),
      writePlugin('badhook', { permissions: { hooks: ['play.collect'], sources: ['magnet'] } },
        'playpex.hooks.on("play.collect", function () { return [{ kind: "file", path: "/etc/passwd" }]; });')
    ];
    return server.start({
      port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
      plugins: { dirs: dirs, http: { lookup: lookup, ports: [remotePort], ca: tls ? tls.cert : null, allowAddresses: [TEST_HOST], maxWaitMs: 1500 } }
    });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    // plugins load in the background: wait for every sandbox to settle
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 10 && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve();
        }
        if (Date.now() > until) {
          return reject(new Error('plugins not loaded: ' + JSON.stringify(all.map(function (p) { return [p.id, p.state, p.error]; }))));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function () {
    return userData.services();
  }).then(function (s) {
    return Promise.all([s.profiles.create({ name: 'Kid', isKid: true }), s.profiles.create({ name: 'Grown' }),
      s.plugins.secrets.set('good', 'apiKey', 'k-123')]);
  }).then(function (r) {
    kidsProfile = r[0].id;
    adultProfile = r[1].id;
  });
});

test.after(function () {
  return server.stop().then(function () {
    if (remote) {
      remote.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── tests ───────────────────────────────────────────────────────────────────

test('what loaded, what didn\'t', function () {
  var states = {};
  plugins.list().forEach(function (p) { states[p.id] = p.state; });
  assert.equal(states.hostile, 'enabled');
  assert.equal(states.good, 'enabled');
  assert.equal(states.looper, 'failed', 'a top level that never ends');
  assert.match(plugins.get('looper').error, /CPU_LIMIT/);
  assert.equal(states.grown, 'failed', 'hooks.on for a hook it didn\'t declare');
  assert.match(plugins.get('grown').error, /permissions.hooks/);
});

test('no ambient authority: no require, process, fetch, timers, WebAssembly', function () {
  return data('hostile', 'probe').then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { require: 'undefined', process: 'undefined', fetch: 'undefined', timers: 'undefined',
      wasm: 'undefined', std: 'undefined', os: 'undefined', globals: [] });
  });
});

test('an endless loop is stopped, and the server answers meanwhile', function () {
  var started = Date.now();
  var spin = data('spinner', 'spin');
  return new Promise(function (r) { setTimeout(r, 300); }).then(function () {
    var asked = Date.now();
    return request('GET', '/server').then(function (r) {
      assert.equal(r.status, 200);
      assert.ok(Date.now() - asked < 500, 'the server answered in ' + (Date.now() - asked) + ' ms');
    });
  }).then(function () {
    return spin;
  }).then(function (r) {
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'PLUGIN_FAILED');
    assert.match(r.json.error, /interrupted|CPU/);
    var ms = Date.now() - started;
    assert.ok(ms >= 1900 && ms < 4000, 'stopped after ' + ms + ' ms');
    return data('spinner', 'spinLater');
  }).then(function (r) {
    assert.equal(r.status, 502, 'after an await too');
    return data('spinner', 'probe');
  }).then(function (r) {
    assert.equal(r.status, 200, 'the plugin still answers');
  });
});

test('memory is capped', function () {
  return data('hogger', 'hog').then(function (r) {
    assert.equal(r.status, 502);
    assert.match(r.json.error, /out of memory/);
    return request('GET', '/server');
  }).then(function (r) {
    assert.equal(r.status, 200);
  });
});

test('three calls stopped by the limits and the plugin is stopped for good', function () {
  return data('strikes', 'spin').then(function () {
    return data('strikes', 'hog');
  }).then(function () {
    return data('strikes', 'spin');
  }).then(function () {
    assert.equal(plugins.get('strikes').state, 'failed');
    assert.match(plugins.get('strikes').error, /3 calls/);
    return data('strikes', 'probe');
  }).then(function (r) {
    assert.equal(r.status, 404);
    return request('GET', '/plugins');
  }).then(function (r) {
    assert.ok(!r.json.plugins.some(function (p) { return p.id === 'strikes'; }));
  });
});

test('network: HTTPS to declared public hosts only', { skip: !hasTls && 'no openssl' }, function () {
  var cases = [
    ['https://api.playpex-test.dev:' + remotePort + '/json', null],
    ['https://127.0.0.1:' + remotePort + '/json', 'HOST_NOT_ALLOWED'],
    ['https://elsewhere.example.org/json', 'HOST_NOT_ALLOWED'],
    ['http://api.playpex-test.dev/json', 'HTTPS_ONLY'],
    ['https://api.playpex-test.dev:8443/json', 'PORT_NOT_ALLOWED'],
    ['https://loop.playpex-test.dev:' + remotePort + '/json', 'ADDRESS_NOT_ALLOWED'],
    ['https://lan.playpex-test.dev:' + remotePort + '/json', 'ADDRESS_NOT_ALLOWED'],
    ['https://mixed.playpex-test.dev:' + remotePort + '/json', 'ADDRESS_NOT_ALLOWED'],
    ['https://api.playpex-test.dev:' + remotePort + '/to-loop', 'ADDRESS_NOT_ALLOWED'],
    ['https://api.playpex-test.dev:' + remotePort + '/to-undeclared', 'HOST_NOT_ALLOWED'],
    ['https://api.playpex-test.dev:' + remotePort + '/to-api', null],
    ['https://user:pw@api.playpex-test.dev:' + remotePort + '/json', 'INVALID']
  ];
  return cases.reduce(function (chain, c) {
    return chain.then(function () {
      return data('hostile', 'fetch', { url: c[0] }).then(function (r) {
        assert.equal(r.status, 200, c[0]);
        if (c[1]) {
          assert.equal(r.json.data.error, c[1], c[0] + ': ' + r.json.data.message);
        } else {
          assert.deepEqual(r.json.data, { status: 200, body: { hello: 'world' } }, c[0]);
        }
      });
    });
  }, Promise.resolve());
});

test('bytes both ways, context, store quota, secrets, settings, translations', { skip: !hasTls && 'no openssl' }, function () {
  return data('good', 'echo', {}, adultProfile).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, { len: 4, last: 250, isBytes: true, profile: { id: adultProfile, kids: false }, locale: 'en' });
    return data('good', 'keep', { n: 1 });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.data, { value: { n: 1 }, keys: ['k:1'], quota: 'QUOTA_EXCEEDED', secret: 'k-123', mode: 'b', hello: 'Bonjour Ann' });
  });
});

test('permissions it didn\'t ask for are refused', function () {
  return data('hostile', 'denied').then(function (r) {
    assert.deepEqual(r.json.data, { store: 'PERMISSION_DENIED', secret: 'PERMISSION_DENIED', hook: 'PERMISSION_DENIED',
      event: 'PERMISSION_DENIED', later: 'NOT_AVAILABLE' });
  });
});

test('effects: play without permission and foreign screens are dropped; bad answers fail', function () {
  return data('hostile', 'playIt').then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.effects, [{ type: 'toast', text: 'hello' }]);
    return data('nsfw', 'playIt', {}, adultProfile);
  }).then(function (r) {
    assert.equal(r.json.effects[0].type, 'play');
    assert.equal(r.json.effects[0].request.tracking, 'none', 'an adults plugin\'s plays are never tracked');
    return data('hostile', 'badAnswer');
  }).then(function (r) {
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'PLUGIN_FAILED');
  });
});

test('rate limits: a burst waits its turn, past the wait it fails', { skip: !hasTls && 'no openssl' }, function () {
  var url = 'https://api.playpex-test.dev:' + remotePort + '/json';
  return data('slowpoke', 'burst', { n: 3, url: url }).then(function (r) {
    // burst 2, then 1 per second
    assert.deepEqual(r.json.data.results, ['ok', 'ok', 'ok']);
    assert.ok(r.json.data.ms >= 800, 'took ' + r.json.data.ms + ' ms');
    return data('slowpoke', 'burst', { n: 6, url: url });
  }).then(function (r) {
    var limited = r.json.data.results.filter(function (x) { return x === 'RATE_LIMITED'; }).length;
    assert.ok(limited >= 2, r.json.data.results.join(','));
  });
});

test('4 calls at once all answer, side by side', { skip: !hasTls && 'no openssl' }, function () {
  var started = Date.now();
  return Promise.all([1, 2, 3, 4].map(function () { return data('good', 'slow'); })).then(function (all) {
    all.forEach(function (r) { assert.deepEqual(r.json.data, { slow: true }); });
    assert.ok(Date.now() - started < 1500, 'in ' + (Date.now() - started) + ' ms');
  });
});

test('hooks: answers that pass the schema come back, the others are skipped', function () {
  return plugins.runHook('play.collect', { title: { kind: 'movie', tmdbId: 27205, title: 'Inception' } },
    { profile: null, device: null, locale: 'en' }).then(function (r) {
    assert.deepEqual(r.results, [{ plugin: 'good', output: [{ kind: 'magnet', label: 'Inception 1080p', infoHash: 'b'.repeat(40), quality: '1080p' }] }]);
    assert.deepEqual(r.errors.map(function (e) { return e.plugin + ' ' + e.code; }), ['badhook BAD_ANSWER']);
  });
});

test('audience: kids profiles never reach an adults plugin', function () {
  return request('GET', '/plugins?profile=' + kidsProfile).then(function (r) {
    assert.equal(r.status, 200);
    var ids = r.json.plugins.map(function (p) { return p.id; });
    assert.ok(ids.indexOf('nsfw') === -1 && ids.indexOf('good') !== -1, ids.join(','));
    return request('GET', '/plugins?profile=' + adultProfile);
  }).then(function (r) {
    assert.ok(r.json.plugins.some(function (p) { return p.id === 'nsfw'; }));
    var good = r.json.plugins.filter(function (p) { return p.id === 'good'; })[0];
    assert.deepEqual(Object.keys(good).sort(), ['assets', 'audience', 'chrome', 'icon', 'id', 'name', 'screens', 'sections', 'slots', 'version']);
    return data('nsfw', 'probe', {}, kidsProfile);
  }).then(function (r) {
    assert.equal(r.status, 403);
    return request('GET', '/plugins?profile=nobody');
  }).then(function (r) {
    assert.equal(r.status, 404);
  });
});

test('assets: listed files only, no scripts', function () {
  return request('GET', '/plugins/good/assets/icon.svg').then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/svg+xml');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /default-src 'none'.*sandbox/);
    return Promise.all(['/plugins/good/assets/../server.js', '/plugins/good/assets/%2e%2e/server.js',
      '/plugins/good/assets/../playpex-plugin.json', '/plugins/good/assets/missing.png'].map(function (p) { return request('GET', p); }));
  }).then(function (all) {
    all.forEach(function (r) { assert.equal(r.status, 404); });
  });
});

test('unknown plugins and handlers', function () {
  return Promise.all([data('nothing', 'x'), data('good', 'nothing'), data('Bad Id', 'x'), data('looper', 'x')]).then(function (all) {
    all.forEach(function (r) { assert.equal(r.status, 404, r.text); });
  });
});
