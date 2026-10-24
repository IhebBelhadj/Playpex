'use strict';

// Torrents from plugins only (docs/providers-plan.md step 4), on a real server
// with no torrent site: the test plugin `fake-torrents` (test/fixtures/plugins)
// and a second one naming one of its torrents again.
//   Play: the torrent group, ranked together by the core (plays here → healthy
//   swarm → single episode before its pack), another episode left out, a torrent
//   named by two plugins once (the best seeded), started · Find releases: the
//   plugin as a source of both kinds, most seeded first, paged.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-sources-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var axios = require('axios').default,
  server = require('..'),
  plugins = require('../lib/plugins');

// no web: the core's own sites (until step 5 removes them) fail, the plugins need none
axios.defaults.adapter = function () {
  return Promise.reject(Object.assign(new Error('no network in this test'), { code: 'ENOTFOUND' }));
};

function pluginErrors(answer) {
  return answer.errors.filter(function (e) { return /^plugin:/.test(e.handler); });
}

var FAKE = path.join(__dirname, 'fixtures', 'plugins', 'fake-torrents'),
  base = null;

// names the fake 1080p film again (more seeds, its own name), and one of its own
function writeEcho(hash) {
  var dir = path.join(tmp, 'plugins', 'echo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'echo', name: 'Echo', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' }, audience: 'everyone',
    permissions: { sources: ['magnet'], hooks: ['play.collect'] }
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), String.raw`
playpex.hooks.on('play.collect', function (input) {
  if (input.title.kind !== 'movie') {
    return [];
  }
  return [
    { kind: 'magnet', infoHash: '${hash}', label: 'Heat.1995.1080p.WEB-DL.x264.AAC-ECHO', seeds: 999 },
    { kind: 'magnet', infoHash: '${'e'.repeat(40)}', label: 'Heat.1995.1080p.BluRay.x264.AAC-ECHO', seeds: 15 }
  ];
});
`);
  return dir;
}

function call(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// the plugin's hash for a name (its FNV-1a scheme), to know which source is which
function fakeHash(text) {
  function hex8(t) {
    var h = 0x811c9dc5;
    for (var i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  return (hex8(text) + hex8(text + '1') + hex8(text + '2') + hex8(text + '3') + hex8(text + '4')).slice(0, 40);
}

var HEAT_1080 = 'Heat.1995.1080p.WEB-DL.x264.AAC-FAKE';

test.before(function () {
  return server.start({
    port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
    plugins: { dirs: [FAKE, writeEcho(fakeHash(HEAT_1080))] }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 2 && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve();
        }
        if (Date.now() > until) {
          return reject(new Error('not loaded: ' + JSON.stringify(all)));
        }
        setTimeout(poll, 50);
      })();
    });
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('both plugins load', function () {
  plugins.list().forEach(function (p) { assert.equal(p.state, 'enabled', p.id + ': ' + p.error); });
});

test('a movie: torrents from plugins only, ranked together, one per torrent, started', function () {
  return call('POST', '/play/sources', { kind: 'movie', tmdbId: 949, imdbId: 'tt0113277', title: 'Heat', year: 1995 }).then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(pluginErrors(r.json), []);
    var s = r.json.sources;
    assert.deepEqual(r.json.groups.map(function (g) { return g.group; }), ['torrent']);
    assert.deepEqual(s.map(function (x) { return x.label; }), [
      'Heat.1995.1080p.WEB-DL.x264.AAC-ECHO',     // named by both plugins: the best seeded copy
      'Heat.1995.1080p.BluRay.x264.AAC-ECHO',     // healthy swarm
      'Heat.1995.720p.WEB.x264.AAC-FAKE',         // 2 seeds
      'Heat.1995.2160p.WEB-DL.DDP5.1.Atmos.HEVC-FAKE'
    ]);
    assert.equal(s[0].seeds, 999, 'the best seeded copy of a torrent named twice');
    assert.equal(s[0].plugin, 'echo');
    assert.equal(s.filter(function (x) { return x.infoHash === fakeHash(HEAT_1080); }).length, 1);
    assert.equal(r.json.groups[0].readiness, 'seconds');
    assert.match(s[0].magnet, /^magnet:\?xt=urn:btih:[0-9a-f]{40}&dn=[^&]+(&tr=[^&]+)+$/);
    assert.ok(s[0].magnet.indexOf(encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')) !== -1, 'with the server\'s trackers');
    return call('POST', '/play/start', { request: r.json.request, source: s[1].id });
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.json.action, 'play');
    assert.equal(r.json.source.type, 'torrent');
    assert.match(r.json.source.magnet, /^magnet:\?xt=urn:btih:e{40}&dn=.*&tr=/, 'the server\'s trackers');
  });
});

test('an episode: the episode before its pack, another episode left out', function () {
  return call('POST', '/play/sources', { kind: 'episode', tmdbId: 1, title: 'Fake Show', season: 2, episode: 3 }).then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(pluginErrors(r.json), []);
    var s = r.json.sources;
    assert.deepEqual(s.map(function (x) { return x.label; }), [
      'Fake.Show.S02E03.1080p.WEB.x264.AAC-FAKE',
      'Fake.Show.S02.1080p.WEB.x264.AAC-FAKE',
      'Fake.Show.S02E03.720p.XviD-FAKE'
    ]);
    assert.ok(s[1].badges.indexOf('pack') !== -1, 'the pack is marked');
    assert.equal(s[2].playable, 'no', 'XviD');
  });
});

test('Find releases: the plugin is a source of both kinds, most seeded first, paged', function () {
  return Promise.all([
    call('GET', '/releases/providers?kind=movie'),
    call('GET', '/releases/browse?kind=movie&provider=plugin:fake-torrents&q=Heat'),
    call('GET', '/releases/browse?kind=tv&provider=plugin:fake-torrents&q=Fake%20Show&page=2')
  ]).then(function (r) {
    assert.ok(r[0].json.some(function (p) { return p.id === 'plugin:fake-torrents' && p.name === 'Fake torrents'; }));
    // under 20 kept: the next page read too (the same releases: each once)
    assert.deepEqual(r[1].json.torrents.map(function (t) { return t.seeds; }), [900, 120, 2]);
    assert.equal(r[1].json.page, 2);
    assert.equal(r[1].json.hasMore, false);
    assert.equal(r[2].json.page, 2);
    assert.equal(r[2].json.hasMore, false);
    assert.ok(r[2].json.torrents.some(function (t) { return t.pack; }), 'a pack listed as one');
  });
});
