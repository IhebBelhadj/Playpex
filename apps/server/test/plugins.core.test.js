'use strict';

// Core data for plugins (docs/plugins-plan.md §4.2, lib/plugins/core.js) on a
// real server: `playpex.tmdb.*` through the server's TMDB client (stubbed
// here: no key, no network), `playpex.imdb.*`, and `playpex.library.find`
// against library rows made through the services.
//
//   the wrappers build catalog paths, the key stays the server's   include_adult only for adults plugins
//   account / rating paths, our own params, odd values → INVALID   404 → NOT_FOUND, others → UPSTREAM, no key → PROVIDER_NOT_CONFIGURED
//   library.find needs permissions.library; a kids profile (or none) never counts adults-only folders

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-core-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  userData = require('../lib/userData'),
  tmdb = require('../lib/tmdb'),
  imdb = require('../lib/imdb');

var base = null,
  kidsProfile = null,
  grownProfile = null,
  tmdbCalls = [],
  noKey = false;

// ── a stubbed TMDB and IMDb ─────────────────────────────────────────────────

function status(code) {
  return Promise.reject(Object.assign(new Error('Request failed with status code ' + code), { response: { status: code } }));
}

tmdb.get = function (apiPath, params) {
  tmdbCalls.push({ path: apiPath, params: params });
  if (noKey) {
    return Promise.reject(Object.assign(new Error('TMDB_API_KEY is not set'), { code: 'PROVIDER_NOT_CONFIGURED' }));
  }
  if (apiPath === '/movie/404') {
    return status(404);
  }
  if (apiPath === '/movie/500') {
    return status(500);
  }
  return Promise.resolve({ path: apiPath, title: apiPath === '/movie/550' ? 'Fight Club' : null });
};

imdb.title = function (id) {
  return Promise.resolve({ id: id, rating: 8.8, votes: 2400000 });
};

// ── fixtures ────────────────────────────────────────────────────────────────

// One handler calling any playpex function by name: { fn: 'tmdb.movie', args: [550] }
var CALLER = String.raw`
playpex.data('call', function (input, ctx) {
  var fn = input.fn.split('.').reduce(function (o, k) { return o[k]; }, playpex);
  var args = (input.args || []).concat(input.fn === 'library.find' ? [ctx] : []);
  return Promise.resolve().then(function () { return fn.apply(null, args); }).then(function (value) {
    return { data: { value: value } };
  }, function (err) {
    return { data: { code: err.code || null, message: err.message } };
  });
});
`;

function writePlugin(id, extra) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(Object.assign({
    id: id, name: id, version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: {}
  }, extra)));
  fs.writeFileSync(path.join(dir, 'server.js'), CALLER);
  return dir;
}

function call(id, fn, args, profile) {
  var body = Buffer.from(JSON.stringify({ args: { fn: fn, args: args || [] } }));
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1/plugins/' + id + '/data/call' + (profile ? '?profile=' + profile : ''), base), {
      method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': 'test-device-1' }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode !== 200) {
          return reject(new Error(fn + ' → ' + res.statusCode + ' ' + JSON.stringify(json)));
        }
        resolve(json.data);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function last() {
  return tmdbCalls[tmdbCalls.length - 1];
}

test.before(function () {
  var dirs = [
    writePlugin('reader', { permissions: { library: true } }),
    writePlugin('plain', {}),
    writePlugin('night', { audience: 'adults' })
  ];
  return server.start({
    port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false }, plugins: { dirs: dirs }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 3 && all.every(function (p) { return p.state !== 'loading'; })) {
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
    // Fight Club in a folder for everyone and in an adults-only one; a show's episode only in the adults-only one
    var everyoneDir = path.join(tmp, 'media', 'Everyone'), adultsDir = path.join(tmp, 'media', 'Grown-ups');
    fs.mkdirSync(everyoneDir, { recursive: true });
    fs.mkdirSync(adultsDir, { recursive: true });
    return Promise.all([
      s.profiles.create({ name: 'Kid', isKid: true }),
      s.profiles.create({ name: 'Grown' }),
      s.library.addFolder({ path: everyoneDir, kind: 'mixed' }),
      s.library.addFolder({ path: adultsDir, kind: 'mixed', audience: 'adults' })
    ]).then(function (r) {
      kidsProfile = r[0].id;
      grownProfile = r[1].id;
      return Promise.all([
        s.library.addFile(r[2].id, { relPath: 'Fight Club (1999).mkv', size: 1000 }),
        s.library.addFile(r[3].id, { relPath: 'Fight Club (1999) 2160p.mkv', size: 2000 }),
        s.library.addFile(r[3].id, { relPath: 'Breaking Bad S01E02.mkv', size: 500 })
      ]);
    }).then(function (files) {
      return Promise.all([
        s.library.match(files[0].id, { kind: 'movie', tmdbId: 550 }, { title: 'Fight Club' }, 'admin'),
        s.library.match(files[1].id, { kind: 'movie', tmdbId: 550 }, { title: 'Fight Club' }, 'admin'),
        s.library.match(files[2].id, { kind: 'episode', showTmdbId: 1396, season: 1, episode: 2 }, null, 'admin')
      ]);
    });
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── tests ───────────────────────────────────────────────────────────────────

test('tmdb: the wrappers build catalog paths, without a key of the plugin\'s own', function () {
  return call('plain', 'tmdb.movie', [550, { append_to_response: 'credits' }]).then(function (r) {
    assert.equal(r.value.title, 'Fight Club');
    assert.deepEqual(last(), { path: '/movie/550', params: { append_to_response: 'credits', include_adult: false } });
    return call('plain', 'tmdb.search', ['movie', 'fight club', { year: 1999 }]);
  }).then(function () {
    assert.deepEqual(last(), { path: '/search/movie', params: { query: 'fight club', year: 1999, include_adult: false } });
    return Promise.all([
      call('plain', 'tmdb.episode', [1396, 1, 2]),
      call('plain', 'tmdb.find', ['tt0137523']),
      call('plain', 'tmdb.trending', ['tv', 'day']),
      call('plain', 'tmdb.discover', ['movie', { with_companies: '1|2', 'primary_release_date.gte': '2020-01-01' }])
    ]);
  }).then(function () {
    var paths = tmdbCalls.slice(-4).map(function (c) { return c.path; }).sort();
    assert.deepEqual(paths, ['/discover/movie', '/find/tt0137523', '/trending/tv/day', '/tv/1396/season/1/episode/2']);
    var find = tmdbCalls.filter(function (c) { return c.path === '/find/tt0137523'; })[0];
    assert.equal(find.params.external_source, 'imdb_id');
    var before = tmdbCalls.length;
    return call('plain', 'tmdb.image', ['/abc.jpg', 'w185']).then(function (r) {
      assert.equal(r.value, 'https://image.tmdb.org/t/p/w185/abc.jpg');
      assert.equal(tmdbCalls.length, before, 'image() is a URL, not a call');
    });
  });
});

test('tmdb: include_adult only for adults plugins', function () {
  return call('plain', 'tmdb.discover', ['movie', { include_adult: true }]).then(function () {
    assert.equal(last().params.include_adult, false);
    return call('night', 'tmdb.discover', ['movie', { include_adult: true }], grownProfile);
  }).then(function () {
    assert.equal(last().params.include_adult, true);
  });
});

test('tmdb: only catalog reads, with plain parameters of the plugin\'s', function () {
  var before = tmdbCalls.length;
  return Promise.all([
    call('plain', 'tmdb.get', ['/account/1']),
    call('plain', 'tmdb.get', ['/movie/550/account_states']),
    call('plain', 'tmdb.get', ['/movie/550/rating']),
    call('plain', 'tmdb.get', ['/movie/../account']),
    call('plain', 'tmdb.get', ['https://evil.example/movie/1']),
    call('plain', 'tmdb.get', ['/movie/550?api_key=x']),
    call('plain', 'tmdb.get', ['/movie/550', { api_key: 'mine' }]),
    call('plain', 'tmdb.get', ['/movie/550', { session_id: 's' }]),
    call('plain', 'tmdb.get', ['/movie/550', { nested: { a: 1 } }]),
    call('plain', 'tmdb.get', ['/movie/550', ['a']])
  ]).then(function (all) {
    all.forEach(function (r, i) {
      assert.equal(r.code, 'INVALID', i + ': ' + JSON.stringify(r));
    });
    assert.equal(tmdbCalls.length, before, 'nothing reached TMDB');
  });
});

test('tmdb: failures in the plugin\'s words, never with the key', function () {
  return Promise.all([
    call('plain', 'tmdb.movie', [404]),
    call('plain', 'tmdb.movie', [500])
  ]).then(function (r) {
    assert.equal(r[0].code, 'NOT_FOUND');
    assert.equal(r[1].code, 'UPSTREAM');
    assert.equal(r[1].message, 'TMDB: HTTP 500');
    noKey = true;
    return call('plain', 'tmdb.movie', [550]);
  }).then(function (r) {
    noKey = false;
    assert.equal(r.code, 'PROVIDER_NOT_CONFIGURED');
    assert.doesNotMatch(r.message, /api_key|TMDB_API_KEY/);
  });
});

test('imdb: ratings by IMDb id', function () {
  return call('plain', 'imdb.title', ['tt0137523']).then(function (r) {
    assert.deepEqual(r.value, { id: 'tt0137523', rating: 8.8, votes: 2400000 });
    return call('plain', 'imdb.episodes', ['nope']);
  }).then(function (r) {
    assert.equal(r.code, 'INVALID');
  });
});

test('library.find: needs permissions.library', function () {
  return call('plain', 'library.find', [{ kind: 'movie', tmdbId: 550 }], grownProfile).then(function (r) {
    assert.equal(r.code, 'PERMISSION_DENIED');
  });
});

test('library.find: what the profile may see, never paths', function () {
  var movie = { kind: 'movie', tmdbId: 550 };
  return Promise.all([
    call('reader', 'library.find', [movie], grownProfile),
    call('reader', 'library.find', [movie], kidsProfile),
    call('reader', 'library.find', [movie]),
    call('reader', 'library.find', [{ kind: 'show', tmdbId: 1396 }], grownProfile),
    call('reader', 'library.find', [{ kind: 'episode', tmdbId: 1396, season: 1, episode: 2 }], grownProfile),
    call('reader', 'library.find', [{ kind: 'episode', tmdbId: 1396, season: 1, episode: 3 }], grownProfile),
    call('reader', 'library.find', [{ kind: 'show', tmdbId: 1396 }], kidsProfile)
  ]).then(function (r) {
    assert.deepEqual(r[0].value, { mediaType: 'movie', tmdbId: 550, fileCount: 2, episodes: [] });
    assert.equal(r[1].value.fileCount, 1, 'a kids profile: not the adults-only folder');
    assert.equal(r[2].value.fileCount, 1, 'no profile: as a kids profile');
    assert.deepEqual(r[3].value.episodes, [{ season: 1, episode: 2, fileCount: 1 }]);
    assert.equal(r[4].value.fileCount, 1);
    assert.deepEqual([r[5].value.fileCount, r[5].value.episodes], [0, []]);
    assert.equal(r[6].value.fileCount, 0);
    assert.doesNotMatch(JSON.stringify(r), /\.mkv|Everyone|Grown-ups|"f_/);
  });
});

test('library.find: bad titles', function () {
  return Promise.all([
    call('reader', 'library.find', [{ kind: 'video' }], grownProfile),
    call('reader', 'library.find', [{ kind: 'movie' }], grownProfile),
    call('reader', 'library.find', [{ kind: 'episode', tmdbId: 1396 }], grownProfile),
    call('reader', 'library.find', [{ kind: 'film', tmdbId: 1 }], grownProfile)
  ]).then(function (r) {
    r.forEach(function (x, i) {
      assert.equal(x.code, 'INVALID', i + ': ' + JSON.stringify(x));
    });
  });
});
