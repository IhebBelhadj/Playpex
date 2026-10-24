'use strict';

// The torrent sites as plugins (plugins/torrents/*, docs/providers-plan.md
// steps 4–5) on recorded answers of the sites (test/fixtures/providers,
// scripts/record-providers.js; no network), against what the core's own
// providers answered on the same recordings before they left the core
// (test/fixtures/providers/expected.json):
//   • Play: each plugin's server.js in Node with a stub `playpex` (its
//     http.request answering the recordings, names.* the core's), run through
//     the core's play collector (lib/play/plugins.js: merged by hash, ranked
//     together) → the same torrents, in the same order, as the core's yts /
//     episodes handlers gave;
//   • Find releases: lib/releases.js#browse through `plugin:<id>` → the same
//     list as the core's provider of that name gave;
//   • all four together: no failures, movies get TheRARBG / The Pirate Bay
//     torrents the core never had, all matched to the title;
//   • loaded by a real server (QuickJS sandbox) from their folders: enabled,
//     listed as release providers, their failures only in `errors`; packed
//     into a signed repository by npm run pack:repository.
//
// After recording again (the sites changed): PLAYPEX_UPDATE_EXPECTED=1 writes
// what the plugins answer into expected.json; review that diff before keeping it.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-providers-parity-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var recorded = require('./helpers/recorded'),
  plugins = require('../lib/plugins'),
  names = require('../lib/media/names'),
  play = require('../lib/play'),
  playPlugins = require('../lib/play/plugins'),
  releases = require('../lib/releases'),
  signing = require('@playpex/protocol/signing');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'torrents'),
  IDS = ['eztv', 'piratebay', 'therarbg', 'yts'],
  CTX = { profile: { id: 'p1', kids: false }, device: null, locale: 'en' },
  answers = Object.assign({}, recorded.load('play'), recorded.load('releases')),
  EXPECTED = path.join(recorded.DIR, 'expected.json'),
  expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')),
  update = process.env.PLAYPEX_UPDATE_EXPECTED === '1';

// ── the plugins in Node ─────────────────────────────────────────────────────

function load(id) {
  var p = recorded.plugin(path.join(DIR, id), recorded.request(answers));
  p.permissions.hooks.forEach(function (h) {
    assert.equal(typeof p.hooks[h], 'function', id + ' declares ' + h + ' and handles it');
  });
  return p;
}

var loaded = {};
IDS.forEach(function (id) { loaded[id] = load(id); });

// lib/plugins as the host would answer with these plugins (only enabled ones)
var host = recorded.host(plugins, loaded);

var CONTEXT = { play: play, ffmpeg: false, services: null, pluginContext: CTX };

function pluginSources(title, only) {
  host.enable(only);
  return playPlugins.collector.run(title, CONTEXT).then(function (r) {
    host.enable();
    assert.deepEqual(r.errors, [], 'no plugin failed');
    return r.sources;
  }, function (err) {
    host.enable();
    throw err;
  });
}

// ── Play ────────────────────────────────────────────────────────────────────

function onlyFor(title) {
  return title.kind === 'movie' ? ['yts'] : ['eztv', 'therarbg'];
}

recorded.PLAY.forEach(function (c) {
  var only = onlyFor(c.title);
  test('Play, ' + c.name + ': ' + only.join(' + ') + ' as plugins give the core\'s torrents in its order', function () {
    return pluginSources(c.title, only).then(function (sources) {
      if (update) {
        expected.play[c.name] = sources.map(recorded.brief);
      }
      var core = expected.play[c.name];
      assert.ok(core && core.length > 0, 'expected.json has torrents for ' + c.name);
      assert.deepEqual(sources.map(recorded.brief), core);
      sources.forEach(function (s) {
        assert.equal(s.type, 'torrent');
        assert.ok(s.handler.indexOf('plugin:') === 0 && only.indexOf(s.plugin) !== -1, s.handler);
      });
    });
  });
});

test('Play, every plugin: matched to the title, each torrent once, at most 50 a plugin, more for movies than YTS alone', function () {
  return Promise.all(recorded.PLAY.map(function (c) {
    return pluginSources(c.title, IDS).then(function (sources) {
      var core = expected.play[c.name];
      IDS.forEach(function (id) {
        assert.ok(sources.filter(function (s) { return s.plugin === id; }).length <= 50, c.name + ': ' + id + ' keeps its best 50');
      });
      var hashes = sources.map(function (s) { return s.infoHash; }),
        ref = playPlugins.titleRef(c.title);
      assert.equal(new Set(hashes).size, hashes.length, c.name + ': one source per torrent');
      core.forEach(function (s) {
        assert.ok(hashes.indexOf(s.infoHash) !== -1, c.name + ': the core\'s ' + s.label + ' is there');
      });
      // YTS finds a movie by its IMDb id ("Dune: Part One" is TMDB's "Dune"): the others by name
      sources.filter(function (s) { return s.plugin !== 'yts'; }).forEach(function (s) {
        assert.ok(names.matches(s.label, ref), c.name + ': ' + s.label + ' is the title');
      });
      return { name: c.name, core: core.length, plugins: sources.length, from: new Set(sources.map(function (s) { return s.plugin; })) };
    });
  })).then(function (counts) {
    var dune = counts[0];
    assert.ok(dune.plugins > dune.core, 'Dune: ' + dune.plugins + ' torrents from the plugins, ' + dune.core + ' from YTS');
    assert.ok(dune.from.has('therarbg') || dune.from.has('piratebay'), 'Dune: torrents beyond YTS');
  });
});

// ── Find releases ───────────────────────────────────────────────────────────

recorded.RELEASES.forEach(function (c, i) {
  test('Find releases, ' + JSON.stringify(c) + ': the plugin lists what the core did', function () {
    return releases.browse(Object.assign({}, c, { provider: 'plugin:' + c.provider })).then(function (r) {
      if (update) {
        expected.releases[i] = { case: c, page: r.page, hasMore: r.hasMore, torrents: recorded.listed(r) };
      }
      var core = expected.releases[i];
      assert.deepEqual(core.case, c, 'expected.json is for these cases');
      assert.equal(r.provider, 'plugin:' + c.provider);
      assert.ok(core.torrents.length > 0, 'the recording has releases');
      assert.deepEqual(recorded.listed(r), core.torrents);
      assert.equal(r.page, core.page);
      assert.equal(r.hasMore, core.hasMore);
    });
  });
});

test('Find releases: only plugins are sources, for the kinds they list (contributes.releases.kinds)', function () {
  function ids(kind) {
    return releases.providers(kind).map(function (p) { return p.id; });
  }
  // the core's defaults again: The Pirate Bay first
  assert.deepEqual(ids('movie'), ['plugin:piratebay', 'plugin:therarbg', 'plugin:yts'], 'EZTV has no movies');
  assert.deepEqual(ids('tv'), ['plugin:eztv', 'plugin:piratebay', 'plugin:therarbg'], 'YTS has no shows');
  assert.equal(releases.providers('movie')[0].default, true);
  // the hooks still answer nothing for a kind they don't list
  return Promise.all([
    loaded.eztv.hooks['releases.providers']({ kind: 'movie', page: 1 }),
    loaded.yts.hooks['releases.providers']({ kind: 'show', page: 1 })
  ]).then(function (r) {
    // (arrays of the plugins' vm realm)
    assert.equal(r[0].releases.length, 0);
    assert.equal(r[1].releases.length, 0);
  });
});

test('Find releases with no source plugin: no provider, an empty list', function () {
  host.enable([]);
  var none = releases.providers('tv');
  return releases.browse({ kind: 'movie' }).then(function (r) {
    host.enable();
    assert.deepEqual(none, []);
    assert.deepEqual(r, { provider: null, page: 1, hasMore: false, torrents: [] });
  }, function (err) {
    host.enable();
    throw err;
  });
});

if (update) {
  test.after(function () {
    fs.writeFileSync(EXPECTED, JSON.stringify(expected, null, 1) + '\n');
  });
}

// ── a real server: the sandbox, packaging ───────────────────────────────────

test('loaded by a real server: enabled, listed, failures only in errors; packed into a signed repository', function () {
  var server = require('..'),
    base = null;
  function call(method, apiPath, body) {
    return new Promise(function (resolve, reject) {
      var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      var req = http.request(new URL('/api/v1' + apiPath, base), {
        method: method, agent: false,
        headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {})
      }, function (res) {
        var chunks = [];
        res.on('data', function (ch) { chunks.push(ch); });
        res.on('end', function () { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  // the real host this time, with no web: every name fails to resolve
  host.restore();
  return server.start({
    port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
    plugins: {
      dirs: IDS.map(function (id) { return path.join(DIR, id); }),
      http: { lookup: function (host, o, cb) { cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); } }
    }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === IDS.length && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve(all);
        }
        if (Date.now() > until) {
          return reject(new Error('not loaded: ' + JSON.stringify(all)));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function (all) {
    all.forEach(function (p) { assert.equal(p.state, 'enabled', p.id + ': ' + p.error); });
    return call('GET', '/releases/providers?kind=tv');
  }).then(function (r) {
    assert.deepEqual(r.json.map(function (p) { return p.id; }), ['plugin:eztv', 'plugin:piratebay', 'plugin:therarbg']);
    return call('POST', '/play/sources', { kind: 'episode', tmdbId: 95396, imdbId: 'tt11280740', title: 'Severance', season: 1, episode: 1 });
  }).then(function (r) {
    assert.equal(r.status, 200);
    var failed = r.json.errors.map(function (e) { return e.handler; });
    ['eztv', 'piratebay', 'therarbg'].forEach(function (id) {
      assert.ok(failed.indexOf('plugin:' + id) !== -1, id + ' failed without a web: ' + JSON.stringify(r.json.errors));
    });
    assert.equal(failed.indexOf('plugin:yts'), -1, 'YTS has no episodes: nothing asked');
  }).then(function () {
    var pair = signing.generate(), keyFile = path.join(tmp, 'key.json'), outDir = path.join(tmp, 'repository');
    fs.writeFileSync(keyFile, JSON.stringify(pair));
    var r = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pack-repository.js')]
      .concat(IDS.map(function (id) { return path.join(DIR, id); }))
      .concat(['--out', outDir, '--key', keyFile, '--id', 'torrents', '--name', 'Torrent sites', '--base-url', 'https://example.org/torrents/']),
    { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    var index = fs.readFileSync(path.join(outDir, 'index.json'));
    assert.ok(signing.verify(index, fs.readFileSync(path.join(outDir, 'index.json.sig'), 'utf8').trim(), pair.publicKey), 'signed');
    assert.deepEqual(JSON.parse(index).plugins.map(function (p) { return p.id; }).sort(), IDS);
  }).then(function () {
    return server.stop();
  }, function (err) {
    return server.stop().then(function () { throw err; });
  });
});

test.after(function () {
  fs.rmSync(tmp, { recursive: true, force: true });
});
