'use strict';

// Provider health (lib/health.js): the core's services, and plugins' hosts
// from their requests (docs/providers-plan.md §4.1: no torrent site of its own).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  health = require('../lib/health');

test('the core lists its services, no torrent site', function () {
  var ids = health.list().map(function (p) { return p.id; });
  assert.ok(ids.indexOf('tmdb') !== -1 && ids.indexOf('imdb') !== -1);
  assert.deepEqual(ids.filter(function (id) { return /yts|eztv|rarbg|pirate/.test(id); }), []);
});

test('a plugin\'s host: one entry once it asked, its last failure by code, a 5xx is a failure, a 404 an answer', function () {
  var p = { id: 'sites', manifest: { name: 'Sites' } };
  function row() {
    return health.list().filter(function (r) { return r.id === 'plugin:sites:example.org'; })[0];
  }
  assert.equal(row(), undefined);
  health.plugin(p, 'example.org', null, 200);
  assert.equal(row().ok, true);
  assert.equal(row().name, 'Sites (example.org)');
  assert.equal(row().plugin, 'sites');
  assert.equal(row().host, 'example.org');
  health.plugin(p, 'example.org', Object.assign(new Error('https://example.org/?key=secret'), { code: 'DNS_FAILED' }));
  assert.equal(row().lastError, 'DNS_FAILED', 'the code, never the message');
  assert.equal(row().failures, 1);
  health.plugin(p, 'example.org', null, 503);
  assert.equal(row().lastError, 'HTTP 503');
  assert.equal(row().failures, 2);
  health.plugin(p, 'example.org', null, 404);
  assert.equal(row().failures, 0);
});
