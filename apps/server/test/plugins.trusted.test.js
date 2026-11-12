'use strict';

// Trusted code and core-only host calls (docs/plugin-layer-plan.md §8, step
// 7) on a real server: a test adapter registered as shipped code, a core
// call `test.echo`, and three plugins running that code: loaded as managed
// (trusted), as a developer copy (not trusted), and a managed copy with one
// byte changed (refused).
//
//   trusted code calls the core call and is counted · the same code from a developer folder is refused it
//   a managed plugin whose code isn't shipped code doesn't load · trust keeps the sandbox: its permissions still hold

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-trusted-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  builtin = require('../lib/plugins/builtin'),
  corecalls = require('../lib/plugins/corecalls');

var ADAPTER = String.raw`
playpex.data('echo', function (args) {
  return playpex.core.call('test.echo', { said: args.said }).then(function (v) { return { data: v }; });
});
playpex.data('fetch', function () {
  return playpex.http.request({ url: 'https://example.com/' }).then(function () { return { data: 'fetched' }; });
});
`;

var started = false;

function writePlugin(id, code) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: id, name: id, version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1.5' }, audience: 'everyone', permissions: {}
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  return dir;
}

function data(id, name, args) {
  return plugins.data(id, name, args || {}, { profile: null, device: null, locale: 'en' });
}

test.before(function () {
  var file = path.join(tmp, 'adapter.js');
  fs.writeFileSync(file, ADAPTER);
  builtin.register('test-adapter', file);
  corecalls.register('test.echo', function (plugin, args) {
    return { echoed: args.said, by: plugin.id, code: plugin.trusted };
  });
  return server.start({ port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false, plugins: { dirs: [] } })
    .then(function () { started = true; });
});

test.after(function () {
  corecalls.unregister('test.echo');
  return (started ? server.stop() : Promise.resolve()).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('shipped code loaded as managed is trusted and calls the core', function () {
  return plugins.load(writePlugin('made', ADAPTER), 'managed').then(function (p) {
    assert.equal(p.trusted, 'test-adapter');
    return data('made', 'echo', { said: 'hi' });
  }).then(function (a) {
    assert.deepEqual(a.data, { echoed: 'hi', by: 'made', code: 'test-adapter' });
    assert.equal(plugins.get('made').stats.host['core test.echo'], 1, 'counted in its Activity');
  });
});

test('the same code from a developer folder is refused the core call', function () {
  return plugins.load(writePlugin('copied', ADAPTER), 'dev').then(function (p) {
    assert.equal(p.trusted, null);
    return data('copied', 'echo', { said: 'hi' });
  }).then(function () {
    assert.fail('a developer copy called the core');
  }, function (err) {
    assert.equal(err.code, 'PLUGIN_FAILED');
    assert.match(err.message, /core\.call is the core's own/);
  });
});

test('a managed plugin whose code was changed doesn\'t load', function () {
  return plugins.load(writePlugin('changed', ADAPTER + '\n// one more line\n'), 'managed').then(function () {
    assert.fail('changed code loaded as managed');
  }, function (err) {
    assert.equal(err.code, 'INVALID');
    assert.match(err.message, /must be code this server ships/);
  });
});

test('trust keeps the sandbox: its permissions still hold', function () {
  return data('made', 'fetch').then(function () {
    assert.fail('a trusted plugin fetched without permissions.network');
  }, function (err) {
    assert.equal(err.code, 'PLUGIN_FAILED');
    assert.match(err.message, /permissions\.network/);
  });
});
