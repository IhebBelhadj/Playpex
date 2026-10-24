'use strict';

// The torrent sites as plugins (plugins/torrents/*, docs/providers-plan.md
// step 4) against the core's own providers, on recorded answers of the sites
// (test/fixtures/providers, scripts/record-providers.js; no network):
//   • Play: each plugin's server.js in Node with a stub `playpex` (its
//     http.request answering the recordings, names.* the core's), run through
//     the core's play collector (lib/play/plugins.js: merged by hash, ranked
//     together) → the same torrents, in the same order, as the core's yts /
//     episodes handlers;
//   • Find releases: lib/releases.js#browse through `plugin:<id>` → the same
//     list as the core's provider of that name;
//   • all four together: no failures, movies get TheRARBG / The Pirate Bay
//     torrents the core never had, all matched to the title;
//   • loaded by a real server (QuickJS sandbox) from their folders: enabled,
//     listed as release providers, their failures only in `errors`; packed
//     into a signed repository by npm run pack:repository.

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

var axios = require('axios').default,
  recorded = require('./helpers/recorded'),
  schemas = require('../lib/plugins/schemas'),
  plugins = require('../lib/plugins'),
  names = require('../lib/media/names'),
  play = require('../lib/play'),
  playPlugins = require('../lib/play/plugins'),
  releases = require('../lib/releases'),
  signing = require('@playpex/protocol/signing');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'torrents'),
  IDS = ['eztv', 'piratebay', 'therarbg', 'yts'],
  CTX = { profile: { id: 'p1', kids: false }, device: null, locale: 'en' },
  answers = Object.assign({}, recorded.load('play'), recorded.load('releases'));

// ── the plugins in Node ─────────────────────────────────────────────────────

function out(value) {
  return JSON.parse(JSON.stringify(value));
}

function load(id) {
  var p = recorded.plugin(path.join(DIR, id), recorded.request(answers));
  p.permissions.hooks.forEach(function (h) {
    assert.equal(typeof p.hooks[h], 'function', id + ' declares ' + h + ' and handles it');
  });
  return p;
}

var loaded = {};
IDS.forEach(function (id) { loaded[id] = load(id); });

// lib/plugins as the host would answer with these plugins (only `enabled` ones),
// every answer checked against the hook's schema
var enabled = IDS.slice(),
  real = { get: plugins.get, withHook: plugins.withHook, runHook: plugins.runHook };

function hooked(name) {
  return enabled.filter(function (id) { return loaded[id].hooks[name]; }).sort();
}

plugins.get = function (id) {
  return loaded[id] || null;
};
plugins.withHook = function (name) {
  return hooked(name).map(function (id) { return { id: id, name: loaded[id].manifest.name }; });
};
plugins.runHook = function (name, input, ctx, options) {
  var problem = schemas.hookProblem(name, 'input', input);
  assert.equal(problem, null, name + ' input: ' + problem);
  var results = [], errors = [];
  return Promise.all(hooked(name).filter(function (id) { return !options || !options.only || options.only === id; }).map(function (id) {
    return Promise.resolve().then(function () {
      return loaded[id].hooks[name](out(input), ctx);
    }).then(function (output) {
      output = out(output);
      var bad = schemas.hookProblem(name, 'output', output);
      if (bad) {
        throw new Error('out of schema: ' + bad);
      }
      results.push({ plugin: id, output: output });
    }, function (err) {
      errors.push({ plugin: id, code: 'HANDLER_ERROR', message: err.message });
    });
  })).then(function () {
    results.sort(function (a, b) { return a.plugin < b.plugin ? -1 : 1; });
    return { results: results, errors: errors };
  });
};

// ── the core's providers on the same answers ─────────────────────────────────

axios.defaults.adapter = recorded.adapter(answers);

var core = {};
require('../lib/play/handlers').register({ use: function (h) { core[h.id] = h; } });

var CONTEXT = { play: play, ffmpeg: false, services: null, pluginContext: CTX };

function brief(s) {
  return { infoHash: s.infoHash, label: s.label, seeds: s.seeds, quality: s.quality, playable: s.playable, pack: s.badges.indexOf('pack') !== -1 };
}

function coreSources(title) {
  var handler = title.kind === 'movie' ? core.yts : core.episodes;
  return Promise.resolve(handler.run(title, CONTEXT)).then(function (r) {
    assert.ok(Array.isArray(r) || !r.errors.length, 'the core read every recording: ' + JSON.stringify(r.errors));
    return Array.isArray(r) ? r : r.sources;
  });
}

function pluginSources(title, only) {
  enabled = only;
  return playPlugins.collector.run(title, CONTEXT).then(function (r) {
    enabled = IDS.slice();
    assert.deepEqual(r.errors, [], 'no plugin failed');
    return r.sources;
  }, function (err) {
    enabled = IDS.slice();
    throw err;
  });
}

// ── Play ────────────────────────────────────────────────────────────────────

recorded.PLAY.forEach(function (c) {
  var only = c.title.kind === 'movie' ? ['yts'] : ['eztv', 'therarbg'];
  test('Play, ' + c.name + ': ' + only.join(' + ') + ' as plugins give the core\'s torrents in its order', function () {
    return Promise.all([coreSources(c.title), pluginSources(c.title, only)]).then(function (r) {
      assert.ok(r[0].length > 0, 'the recording has torrents');
      assert.deepEqual(r[1].map(brief), r[0].map(brief));
      r[1].forEach(function (s) {
        assert.equal(s.type, 'torrent');
        assert.ok(s.handler.indexOf('plugin:') === 0 && only.indexOf(s.plugin) !== -1, s.handler);
      });
    });
  });
});

test('Play, every plugin: matched to the title, each torrent once, at most 50 a plugin, more for movies than YTS alone', function () {
  return Promise.all(recorded.PLAY.map(function (c) {
    return Promise.all([coreSources(c.title), pluginSources(c.title, IDS)]).then(function (r) {
      IDS.forEach(function (id) {
        assert.ok(r[1].filter(function (s) { return s.plugin === id; }).length <= 50, c.name + ': ' + id + ' keeps its best 50');
      });
      var hashes = r[1].map(function (s) { return s.infoHash; }),
        ref = playPlugins.titleRef(c.title);
      assert.equal(new Set(hashes).size, hashes.length, c.name + ': one source per torrent');
      r[0].forEach(function (s) {
        assert.ok(hashes.indexOf(s.infoHash) !== -1, c.name + ': the core\'s ' + s.label + ' is there');
      });
      // YTS finds a movie by its IMDb id ("Dune: Part One" is TMDB's "Dune"): the others by name
      r[1].filter(function (s) { return s.plugin !== 'yts'; }).forEach(function (s) {
        assert.ok(names.matches(s.label, ref), c.name + ': ' + s.label + ' is the title');
      });
      return { name: c.name, core: r[0].length, plugins: r[1].length, from: new Set(r[1].map(function (s) { return s.plugin; })) };
    });
  })).then(function (counts) {
    var dune = counts[0];
    assert.ok(dune.plugins > dune.core, 'Dune: ' + dune.plugins + ' torrents from the plugins, ' + dune.core + ' from YTS');
    assert.ok(dune.from.has('therarbg') || dune.from.has('piratebay'), 'Dune: torrents beyond YTS');
  });
});

// ── Find releases ───────────────────────────────────────────────────────────

function listed(r) {
  return r.torrents.map(function (t) {
    return { hash: t.hash, name: t.name, seeds: t.seeds, peers: t.peers, size: t.size, added: t.added, quality: t.quality,
      playable: t.playable, audio: t.audio, season: t.season, episode: t.episode, pack: t.pack };
  });
}

recorded.RELEASES.forEach(function (c) {
  test('Find releases, ' + JSON.stringify(c) + ': the plugin lists what the core did', function () {
    return Promise.all([releases.browse(c), releases.browse(Object.assign({}, c, { provider: 'plugin:' + c.provider }))]).then(function (r) {
      assert.equal(r[0].provider, c.provider);
      assert.equal(r[1].provider, 'plugin:' + c.provider);
      assert.ok(r[0].torrents.length > 0, 'the recording has releases');
      assert.deepEqual(listed(r[1]), listed(r[0]));
      assert.equal(r[1].page, r[0].page);
      assert.equal(r[1].hasMore, r[0].hasMore);
    });
  });
});

test('Find releases: the plugins are sources of both kinds where their site has them', function () {
  assert.deepEqual(releases.providers('movie').map(function (p) { return p.id; }),
    ['piratebay', 'therarbg', 'yts', 'plugin:eztv', 'plugin:piratebay', 'plugin:therarbg', 'plugin:yts']);
  return Promise.all([
    releases.browse({ kind: 'movie', provider: 'plugin:eztv' }),
    releases.browse({ kind: 'tv', provider: 'plugin:yts' })
  ]).then(function (r) {
    assert.deepEqual(r[0].torrents, [], 'EZTV has no movies');
    assert.deepEqual(r[1].torrents, [], 'YTS has no shows');
  });
});

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
  Object.assign(plugins, real);
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
    assert.deepEqual(r.json.map(function (p) { return p.id; }).filter(function (id) { return /^plugin:/.test(id); }),
      ['plugin:eztv', 'plugin:piratebay', 'plugin:therarbg', 'plugin:yts']);
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
