'use strict';

// Managed plugins (docs/plugin-layer-plan.md §9, step 8) on a real server with
// a fake provider: it builds a plugin around a test adapter registered as
// shipped code, from an input holding a "key" (kept as a secret).
//
//   inspect → a preview like a package's (origin managed, installable without developer mode) → installed by its token
//   trusted, its input sealed and out of the plugin's reach
//   check: up to date · a build asking for more waits for consent (refresh leaves it) · accepted, it updates
//   rollback puts the earlier build back · new shipped code rebuilds it at refresh · removal forgets it all

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-managed-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  builtin = require('../lib/plugins/builtin'),
  managed = require('../lib/plugins/managed'),
  userData = require('../lib/userData');

var base = null, cookie = null,
  ADAPTER = path.join(tmp, 'adapter-v1.js'),
  ADAPTER2 = path.join(tmp, 'adapter-v2.js'),
  ADAPTER3 = path.join(tmp, 'adapter-v3.js'),
  service = { version: '1.0.0', hooks: [] };   // what the made-up service is now

var CODE = String.raw`
playpex.data('hello', function () {
  return playpex.secrets.get('managed:input').then(function (v) { return { data: { saw: v } }; },
    function (err) { return { data: { refused: String(err && err.message) } }; });
});
`;

function call(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({}, payload ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, text: raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

var PROVIDER = {
  name: 'fake',
  label: 'Fake service',
  code: 'fake-adapter',
  secretInput: true,
  build: function (input) {
    if (!input || !/^[a-z]+$/.test(input.name || '')) {
      return Promise.reject(Object.assign(new Error('a name of letters'), { code: 'INVALID' }));
    }
    return Promise.resolve({
      manifest: {
        id: 'fake-' + input.name, name: 'Fake ' + input.name, version: service.version, publisher: { name: 'fake service' },
        api: { server: '^1.5' }, audience: 'everyone',
        permissions: service.hooks.length ? { sources: ['magnet'], hooks: service.hooks } : {}
      },
      summary: { name: input.name }
    });
  }
};

test.before(function () {
  fs.writeFileSync(ADAPTER, CODE);
  fs.writeFileSync(ADAPTER2, CODE + '\n// the next server version\n');
  fs.writeFileSync(ADAPTER3, CODE + '\n// a server version whose build asks for more\n');
  builtin.register('fake-adapter', ADAPTER);
  managed.register(PROVIDER);
  return server.start({
    port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
    plugins: { dirs: [], repositories: false, managed: { intervalMs: false } }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'managed-pass' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'managed-pass' });
  }).then(function (res) {
    cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  managed.unregister('fake');
  return (base ? server.stop() : Promise.resolve()).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function install(preview, accept) {
  return call('POST', '/admin/plugins/packages/' + preview.token + '/install', accept ? { accept: true } : {});
}

test('providers are listed; a bad input is the provider\'s refusal', function () {
  return call('GET', '/admin/plugins/managed').then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.providers.filter(function (x) { return x.name === 'fake'; }), [{ name: 'fake', label: 'Fake service' }]);
    assert.ok(r.json.providers.some(function (x) { return x.name === 'stremio'; }), 'the server ships the Stremio bridge');
    return call('POST', '/admin/plugins/managed/fake/inspect', { input: { name: 'B4d!' } });
  }).then(function (r) {
    assert.equal(r.status, 400);
    return call('POST', '/admin/plugins/managed/nobody/inspect', { input: {} });
  }).then(function (r) {
    assert.equal(r.status, 404);
  });
});

test('inspect → a preview like a package\'s → installed: trusted, its input sealed and unreachable', function () {
  var preview;
  return call('POST', '/admin/plugins/managed/fake/inspect', { input: { name: 'alpha', key: 'k-123' } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    preview = r.json;
    assert.equal(preview.origin, 'managed');
    assert.deepEqual(preview.managed, { provider: 'fake' });
    assert.deepEqual(preview.summary, { name: 'alpha' });
    assert.equal(preview.installable, true, 'no developer mode needed');
    assert.equal(preview.change, 'install');
    return install(preview);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.origin, 'managed');
    var p = plugins.get('fake-alpha');
    assert.equal(p.state, 'enabled');
    assert.equal(p.trusted, 'fake-adapter');
    var info = JSON.parse(fs.readFileSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'fake-alpha', 'managed.json'), 'utf8'));
    assert.equal(info.provider, 'fake');
    assert.equal(info.input, undefined, 'a secret input isn\'t in the file');
    return Promise.all([
      managed.inputOf('fake-alpha'),
      userData.services().then(function (s) { return s.plugins.installed.get('fake-alpha'); }),
      plugins.data('fake-alpha', 'hello', {}, { profile: null, device: null, locale: 'en' })
    ]);
  }).then(function (r) {
    assert.deepEqual(r[0], { name: 'alpha', key: 'k-123' });
    assert.equal(r[1].source, 'fake');
    assert.match(r[2].data.refused, /permissions\.secrets/, 'the plugin can\'t read its input');
  });
});

test('check: up to date; a build asking for more waits for consent, refresh leaves it; accepted, it updates', function () {
  return call('POST', '/admin/plugins/fake-alpha/managed/check').then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.json.upToDate, true);
    service = { version: '1.1.0', hooks: ['play.collect'] };
    return managed.refresh();
  }).then(function () {
    assert.equal(plugins.get('fake-alpha').manifest.version, '1.0.0', 'more permissions: not installed by refresh');
    return call('POST', '/admin/plugins/fake-alpha/managed/check');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.change, 'update');
    assert.ok(r.json.added.length, 'what it adds is shown');
    return install(r.json).then(function (refused) {
      assert.equal(refused.status, 409, 'not without accepting');
      return call('POST', '/admin/plugins/fake-alpha/managed/check');
    });
  }).then(function (r) {
    return install(r.json, true);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(plugins.get('fake-alpha').manifest.version, '1.1.0');
    return managed.inputOf('fake-alpha');
  }).then(function (input) {
    assert.deepEqual(input, { name: 'alpha', key: 'k-123' }, 'its input kept');
  });
});

test('a new input rebuilds the same plugin; another name is refused', function () {
  return call('PUT', '/admin/plugins/fake-alpha/managed', { input: { name: 'alpha', key: 'k-456' } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.change, 'reinstall');
    return install(r.json);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return managed.inputOf('fake-alpha');
  }).then(function (input) {
    assert.equal(input.key, 'k-456');
    return call('PUT', '/admin/plugins/fake-alpha/managed', { input: { name: 'beta' } });
  }).then(function (r) {
    assert.equal(r.status, 400);
    assert.match(r.json.error, /add it as another plugin/);
  });
});

test('rollback puts the earlier build back, as a managed plugin', function () {
  return call('POST', '/admin/plugins/fake-alpha/rollback').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.origin, 'managed');
    assert.equal(r.json.rollback, true);
    return install(r.json, true);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var p = plugins.get('fake-alpha');
    assert.equal(p.trusted, 'fake-adapter');
    return managed.inputOf('fake-alpha');
  }).then(function (input) {
    assert.equal(input.key, 'k-456', 'a rollback leaves the input where it is');
  });
});

test('new shipped code: refresh rebuilds it (asking for nothing more) and it loads trusted', function () {
  builtin.register('fake-adapter', ADAPTER2);
  return managed.refresh().then(function () {
    var p = plugins.get('fake-alpha');
    assert.equal(p.state, 'enabled');
    assert.equal(p.trusted, 'fake-adapter');
    var code = fs.readFileSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'fake-alpha', 'server.js'), 'utf8');
    assert.match(code, /the next server version/);
  });
});

test('new shipped code whose build asks for more: it keeps running on the new code, the bigger build waits', function () {
  var before = plugins.get('fake-alpha').manifest;
  builtin.register('fake-adapter', ADAPTER3);
  service = { version: '1.4.0', hooks: ['play.collect', 'play.before'] };
  return managed.refresh().then(function () {
    var p = plugins.get('fake-alpha');
    assert.equal(p.state, 'enabled', 'it didn\'t stop: its old code wouldn\'t load any more');
    assert.equal(p.trusted, 'fake-adapter');
    assert.deepEqual(p.manifest.permissions, before.permissions, 'what it may do: as it was');
    assert.equal(p.manifest.version, before.version);
    assert.match(fs.readFileSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'fake-alpha', 'server.js'), 'utf8'), /asks for more/);
    return call('POST', '/admin/plugins/fake-alpha/managed/check');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, '1.4.0', 'the bigger build: Check for updates');
    assert.ok(r.json.added.length);
  });
});

test('removal forgets its files, row and input', function () {
  return call('DELETE', '/admin/plugins/fake-alpha').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.ok(!plugins.get('fake-alpha'));
    assert.equal(fs.existsSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'fake-alpha')), false);
    return userData.services().then(function (s) {
      return Promise.all([s.plugins.installed.get('fake-alpha'), s.plugins.secrets.get('fake-alpha', 'managed:input')]);
    });
  }).then(function (r) {
    assert.equal(r[0], null);
    assert.equal(r[1], null);
  });
});
