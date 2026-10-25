'use strict';

// The Trakt plugin (plugins/trakt, docs/plugins-plan.md step P6; a metadata
// provider of docs/providers-plan.md step 7). Two parts:
//   • its server.js in Node with a stub `playpex` and a fake Trakt API (no
//     network): Trakt's rating as metadata.details, scrobbling (start, pause,
//     resume, one stop), the profile's changes sent to Trakt (never a scrobbled
//     title twice), the sync both ways (first sync merges, later ones follow
//     additions and removals), only granted profiles, the rows, Sync now;
//     answers against the hook and slot schemas;
//   • loaded by a real server from its folder: enabled, and without a client
//     id it adds nothing to a title page.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  vm = require('vm');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugin-trakt-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  schemas = require('../lib/plugins/schemas'),
  tmdb = require('../lib/tmdb');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'trakt');

// ── a fake Trakt ────────────────────────────────────────────────────────────

function movie(tmdbId, title, year) {
  return { title: title, year: year, ids: { trakt: tmdbId + 1000, imdb: 'tt' + String(tmdbId).padStart(7, '0'), tmdb: tmdbId } };
}
function show(tmdbId, title) {
  return { title: title, year: 2008, ids: { trakt: tmdbId + 2000, tmdb: tmdbId } };
}

function fakeTrakt() {
  var t = {
    calls: [],
    watchlist: { movies: [], shows: [] },
    history: { movies: [], episodes: [] },
    ratings: { movies: [], shows: [] },
    answer: function (method, url, body) {
      var u = new URL(url), p = u.pathname;
      t.calls.push({ method: method, path: p + u.search, body: body ? JSON.parse(body) : null });
      if (method === 'GET' && /^\/(movies|shows)\/tt\d+\/ratings$/.test(p)) {
        return { status: 200, body: { rating: 7.946, votes: 21000, distribution: {} } };
      }
      if (method === 'GET' && p === '/movies/trending') {
        return { status: 200, body: [{ watchers: 9, movie: movie(949, 'Heat', 1995) }, { watchers: 3, movie: movie(1, 'No poster', 2000) }] };
      }
      if (method === 'GET' && p === '/recommendations/movies') {
        return { status: 200, body: [movie(603, 'The Matrix', 1999)] };
      }
      if (method === 'GET' && p.indexOf('/sync/watchlist/') === 0) {
        var kind = p.split('/')[3];
        return { status: 200, headers: { 'x-pagination-page-count': '1' }, body: t.watchlist[kind].map(function (x) {
          return kind === 'movies' ? { type: 'movie', listed_at: '2026-10-01T00:00:00.000Z', movie: x } : { type: 'show', show: x };
        }) };
      }
      if (method === 'GET' && p.indexOf('/sync/history/') === 0) {
        var since = u.searchParams.get('start_at');
        return { status: 200, body: t.history[p.split('/')[3]].filter(function (h) { return !since || h.watched_at >= since; }) };
      }
      if (method === 'GET' && p.indexOf('/sync/ratings/') === 0) {
        return { status: 200, body: t.ratings[p.split('/')[3]] };
      }
      if (method === 'POST') {
        return { status: 201, body: {} };
      }
      return { status: 404, body: { error: 'not found' } };
    }
  };
  return t;
}

// ── the plugin in Node ──────────────────────────────────────────────────────

function load() {
  var p = {
    hooks: {}, events: {}, jobs: {}, handlers: {},
    secrets: { traktClientId: 'client-1' },
    server: { interval: '1h' },
    profile: {},        // id → its profile settings
    store: {},
    links: { ana: 'token-ana' },
    granted: { 'write.watchlist': ['ana'], 'write.watched': ['ana'], 'write.ratings': ['ana'] },
    local: { ana: [], bob: [] },      // the core's watch lists
    writes: [],
    notified: [],
    trakt: fakeTrakt()
  };
  var plain = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  var playpex = {
    hooks: { on: function (name, fn) { p.hooks[name] = function (input, ctx) { return fn(input, ctx).then(plain); }; } },
    events: { on: function (name, fn) { p.events[name] = fn; } },
    schedule: { every: function (name, interval, fn, options) { p.jobs[name] = { interval: interval, fn: function () { return fn().then(plain); }, options: options }; } },
    data: function (name, fn) { p.handlers[name] = function (args, ctx) { return fn(args, ctx).then(plain); }; },
    http: {
      request: function (o) {
        assert.equal(o.headers['trakt-api-key'], 'client-1');
        assert.equal(o.headers['trakt-api-version'], '2');
        var r = p.trakt.answer(o.method || 'GET', o.url, o.body);
        r.auth = o.headers.Authorization || null;
        p.trakt.calls[p.trakt.calls.length - 1].auth = r.auth;
        return Promise.resolve({ status: r.status, headers: r.headers || {}, body: r.body });
      }
    },
    secrets: { get: function (k) { return Promise.resolve(p.secrets[k] || null); } },
    settings: {
      get: function (k, ctx) {
        var defaults = { scrobble: true, sync: 'all', notifyImports: true };
        if (k === 'interval') {
          return Promise.resolve(p.server.interval);
        }
        var mine = ctx && ctx.profile ? p.profile[ctx.profile.id] || {} : {};
        return Promise.resolve(k in mine ? mine[k] : defaults[k]);
      }
    },
    store: {
      get: function (k) { return Promise.resolve(k in p.store ? plain(p.store[k]) : null); },
      set: function (k, v) { p.store[k] = plain(v); return Promise.resolve(true); }
    },
    link: { status: function (name, id) { return Promise.resolve(p.links[id] ? { linked: true, accessToken: p.links[id] } : { linked: false }); } },
    profiles: { list: function (perm) { return Promise.resolve((p.granted[perm] || []).map(function (id) { return { id: id, kids: false }; })); } },
    watchlist: {
      list: function (id) { return Promise.resolve(p.local[id].map(function (t) { return { title: t, addedAt: '2026-10-01' }; })); },
      add: function (id, ref) { p.writes.push(['watchlist.add', id, plain(ref)]); p.local[id].push(plain(ref)); return Promise.resolve(true); },
      remove: function (id, ref) {
        p.writes.push(['watchlist.remove', id, ref.kind + ':' + ref.tmdbId]);
        p.local[id] = p.local[id].filter(function (t) { return !(t.kind === ref.kind && t.tmdbId === ref.tmdbId); });
        return Promise.resolve(true);
      }
    },
    watched: { set: function (id, ref, o) { p.writes.push(['watched.set', id, plain(ref), plain(o)]); return Promise.resolve(true); } },
    ratings: { set: function (id, ref, r) { p.writes.push(['ratings.set', id, ref.kind + ':' + ref.tmdbId, r]); return Promise.resolve(true); } },
    notify: { send: function (ids, n) { p.notified.push([plain(ids), n.text]); return Promise.resolve({ sent: ids, limited: [] }); } },
    tmdb: {
      movie: function (id) { return Promise.resolve(id === 1 ? { id: 1, title: 'No poster' } : { id: id, title: id === 949 ? 'Heat' : 'The Matrix', poster_path: '/p' + id + '.jpg' }); },
      tv: function (id) { return Promise.resolve({ id: id, name: 'Show', poster_path: '/s.jpg' }); },
      image: function (pathPart, size) { return 'https://image.tmdb.org/t/p/' + (size || 'w342') + pathPart; }
    },
    log: { warn: function () {}, info: function () {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), { playpex: playpex, URL: URL, encodeURIComponent: encodeURIComponent });
  p.emit = function (name, profile, data, extra) {
    return Promise.resolve(p.events[name](Object.assign({ name: name, time: '2026-10-25T10:00:00.000Z', context: { profile: { id: profile, kids: false } }, data: data }, extra || {})));
  };
  p.posts = function (prefix) {
    return p.trakt.calls.filter(function (c) { return c.method === 'POST' && (!prefix || c.path.indexOf(prefix) === 0); });
  };
  return p;
}

var CTX = { profile: { id: 'ana', kids: false }, device: null, locale: 'en' };
var HEAT = { kind: 'movie', tmdbId: 949, imdbId: 'tt0113277', title: 'Heat', year: 1995 };
var PILOT = { kind: 'episode', tmdbId: 1396, season: 1, episode: 1 };

function hookAnswer(name, value) {
  assert.equal(schemas.hookProblem(name, 'output', value), null);
}

// ── metadata.details ────────────────────────────────────────────────────────

test('metadata.details: Trakt\'s rating and its page, only with the app\'s client id and an IMDb id', function () {
  var p = load(), input = { title: HEAT, details: { title: 'Heat', year: 1995, imdbId: 'tt0113277', genres: ['Crime'] } };
  assert.equal(schemas.hookProblem('metadata.details', 'input', input), null);
  return p.hooks['metadata.details'](input, CTX).then(function (out) {
    hookAnswer('metadata.details', out);
    assert.deepEqual(out.ratings, [{ source: 'Trakt', value: 7.9, max: 10, votes: 21000, url: 'https://trakt.tv/search/imdb/tt0113277' }]);
    assert.equal(p.trakt.calls[0].path, '/movies/tt0113277/ratings');
    assert.equal(p.trakt.calls[0].auth, null, 'public: no account needed');
    return p.hooks['metadata.details'](input, CTX);
  }).then(function () {
    assert.equal(p.trakt.calls.length, 1, 'cached');
    return p.hooks['metadata.details']({ title: { kind: 'show', tmdbId: 1396 }, details: { title: 'Breaking Bad', genres: [] } }, CTX);
  }).then(function (out) {
    assert.deepEqual(out, {}, 'no IMDb id: nothing');
    var bare = load();
    delete bare.secrets.traktClientId;
    return bare.hooks['metadata.details'](input, CTX).then(function (o) {
      assert.deepEqual(o, {}, 'no client id: nothing, nothing asked');
      assert.equal(bare.trakt.calls.length, 0);
    });
  });
});

// ── scrobbling ──────────────────────────────────────────────────────────────

test('scrobbling: start, pause, resume on the next report, one stop; nothing for an unlinked profile or with it off', function () {
  var p = load();
  var at = function (pos) { return { title: HEAT, position: pos, duration: 1000, source: 'torrent' }; };
  return p.emit('playback.started', 'ana', at(10))
    .then(function () { return p.emit('playback.progress', 'ana', at(70)); })
    .then(function () { return p.emit('playback.paused', 'ana', at(100)); })
    .then(function () { return p.emit('playback.progress', 'ana', at(130)); })
    .then(function () { return p.emit('playback.finished', 'ana', at(950)); })
    .then(function () { return p.emit('playback.ended', 'ana', at(960)); })
    .then(function () {
      assert.deepEqual(p.posts('/scrobble').map(function (c) { return [c.path, c.body.progress]; }),
        [['/scrobble/start', 1], ['/scrobble/pause', 10], ['/scrobble/start', 13], ['/scrobble/stop', 95]]);
      assert.deepEqual(p.posts('/scrobble')[0].body.movie, { ids: { tmdb: 949 } });
      assert.equal(p.posts('/scrobble')[0].auth, 'Bearer token-ana');
      return p.emit('playback.started', 'ana', { title: PILOT, position: 0, duration: 3000, source: 'file' });
    })
    .then(function () {
      var last = p.posts('/scrobble').pop().body;
      assert.deepEqual([last.show, last.episode], [{ ids: { tmdb: 1396 } }, { season: 1, number: 1 }]);
      var before = p.trakt.calls.length;
      p.profile.ana = { scrobble: false };
      return p.emit('playback.started', 'ana', at(0)).then(function () {
        return p.emit('playback.started', 'bob', at(0));
      }).then(function () {
        assert.equal(p.trakt.calls.length, before, 'off, and an unlinked profile: nothing sent');
      });
    });
});

// ── the profile's changes → Trakt ───────────────────────────────────────────

test('the profile\'s changes reach Trakt; a scrobbled title isn\'t sent to its history again', function () {
  var p = load();
  return p.emit('watchlist.added', 'ana', { title: HEAT }, { by: 'user' })
    .then(function () { return p.emit('watchlist.added', 'ana', { title: PILOT }); })
    .then(function () { return p.emit('watchlist.removed', 'ana', { title: HEAT }); })
    .then(function () { return p.emit('playback.finished', 'ana', { title: HEAT, position: 900, duration: 1000 }); })
    .then(function () { return p.emit('watched.set', 'ana', { title: HEAT }); })
    .then(function () { return p.emit('watched.set', 'ana', { title: PILOT }); })
    .then(function () { return p.emit('rating.set', 'ana', { title: HEAT, rating: 10 }); })
    .then(function () {
      assert.deepEqual(p.posts('/sync').map(function (c) { return c.path; }),
        ['/sync/watchlist', '/sync/watchlist', '/sync/watchlist/remove', '/sync/history', '/sync/ratings']);
      var sync = p.posts('/sync');
      assert.deepEqual(sync[1].body, { shows: [{ ids: { tmdb: 1396 } }] }, 'an episode on the watch list is its show');
      assert.deepEqual(sync[3].body, { shows: [{ ids: { tmdb: 1396 }, seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-10-25T10:00:00.000Z' }] }] }] });
      assert.deepEqual(sync[4].body, { movies: [{ ids: { tmdb: 949 }, rating: 10 }] });
      // "watch list only": the history and ratings stay
      p.profile.ana = { sync: 'watchlist' };
      var before = p.trakt.calls.length;
      return p.emit('watched.set', 'ana', { title: { kind: 'movie', tmdbId: 5 } }).then(function () {
        return p.emit('watchlist.added', 'ana', { title: { kind: 'movie', tmdbId: 5 } });
      }).then(function () {
        assert.deepEqual(p.trakt.calls.slice(before).map(function (c) { return c.path; }), ['/sync/watchlist']);
      });
    });
});

// ── sync: Trakt → Playpex ───────────────────────────────────────────────────

test('sync: the first merges both watch lists and reads recent history and ratings; later ones follow Trakt\'s changes', function () {
  var p = load();
  p.trakt.watchlist.movies = [movie(949, 'Heat', 1995), movie(603, 'The Matrix', 1999)];
  p.trakt.watchlist.shows = [show(1396, 'Breaking Bad')];
  p.local.ana = [{ kind: 'movie', tmdbId: 155, title: 'The Dark Knight' }];
  var recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  p.trakt.history.movies = [{ watched_at: recent, type: 'movie', movie: movie(680, 'Pulp Fiction', 1994) },
    { watched_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(), type: 'movie', movie: movie(13, 'Too old', 1994) }];
  p.trakt.history.episodes = [{ watched_at: recent, type: 'episode', episode: { season: 1, number: 2 }, show: show(1396, 'Breaking Bad') }];
  p.trakt.ratings.movies = [{ rated_at: recent, rating: 8, type: 'movie', movie: movie(680, 'Pulp Fiction', 1994) }];
  return p.jobs.sync.fn().then(function (results) {
    assert.equal(p.jobs.sync.interval, '15m');
    assert.deepEqual(results.map(function (r) { return r.profile; }), ['ana'], 'only profiles granted a write scope');
    assert.deepEqual(p.local.ana.map(function (t) { return t.kind + ':' + t.tmdbId; }).sort(), ['movie:155', 'movie:603', 'movie:949', 'show:1396']);
    assert.deepEqual(p.posts('/sync/watchlist')[0].body, { movies: [{ ids: { tmdb: 155 } }], shows: [] }, 'Playpex\'s own sent once');
    var watched = p.writes.filter(function (w) { return w[0] === 'watched.set'; });
    assert.deepEqual(watched.map(function (w) { return w[2].kind + ':' + w[2].tmdbId + (w[2].season ? ':' + w[2].season + 'x' + w[2].episode : ''); }),
      ['movie:680', 'episode:1396:1x2'], 'the last 30 days only');
    assert.equal(watched[0][3].at, recent);
    assert.deepEqual(p.writes.filter(function (w) { return w[0] === 'ratings.set'; }), [['ratings.set', 'ana', 'movie:680', 8]]);
    assert.deepEqual(p.notified, [[['ana'], 'Trakt: 3 titles added to your watch list, 2 watched, 1 rating']]);
    return p.jobs.sync.fn();
  }).then(function (results) {
    assert.equal(results[0].skipped, 'not due');
    // on Trakt: The Matrix removed, Inception added
    p.trakt.watchlist.movies = [movie(949, 'Heat', 1995), movie(27205, 'Inception', 2010), movie(155, 'The Dark Knight', 2008)];
    p.writes = [];
    return p.handlers.syncNow({}, { profile: null, device: null, locale: 'en' });
  }).then(function (r) {
    assert.match(r.effects[0].text, /^Synced 1 profile/);
    assert.deepEqual(p.writes.filter(function (w) { return w[0].indexOf('watchlist') === 0; }).map(function (w) {
      return w[0] + ' ' + (w[2].kind ? w[2].kind + ':' + w[2].tmdbId : w[2]);
    }), ['watchlist.add movie:27205', 'watchlist.remove movie:603']);
    assert.equal(p.writes.filter(function (w) { return w[0] === 'watched.set'; }).length, 0, 'history already read');
  });
});

test('sync: a scrobbled title isn\'t brought back as watched again; an unlinked profile is skipped', function () {
  var p = load();
  p.granted['write.watched'] = ['ana', 'bob'];
  return p.emit('playback.finished', 'ana', { title: HEAT, position: 950, duration: 1000 }).then(function () {
    p.trakt.history.movies = [{ watched_at: new Date().toISOString(), type: 'movie', movie: movie(949, 'Heat', 1995) }];
    return p.jobs.sync.fn();
  }).then(function (results) {
    assert.equal(p.writes.filter(function (w) { return w[0] === 'watched.set'; }).length, 0);
    assert.deepEqual(results.filter(function (r) { return r.profile === 'bob'; })[0].skipped, 'not linked');
  });
});

// ── rows ────────────────────────────────────────────────────────────────────

test('rows: trending on Trakt, recommended when linked, none while searching', function () {
  var p = load();
  return p.handlers.movieRows({ slot: 'core.movies.rows', context: { section: 'core.movies', query: '', filters: {} } }, CTX).then(function (r) {
    assert.equal(schemas.apiProblem('slots/rows', r.data), null);
    assert.deepEqual(r.data.map(function (row) { return row.title; }), ['Trending on Trakt', 'Recommended for you on Trakt']);
    assert.deepEqual(r.data[0].items, [{ key: 'trakt:movie:949', title: 'Heat', subtitle: '1995', image: 'https://image.tmdb.org/t/p/w342/p949.jpg',
      intent: { screen: 'core.movie', params: { id: 949 } } }], 'no poster: left out');
    return p.handlers.movieRows({ slot: 'core.movies.rows', context: { section: 'core.movies', query: 'heat', filters: {} } }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.data, []);
    return p.handlers.movieRows({ slot: 'core.movies.rows', context: {} }, { profile: { id: 'bob', kids: false } });
  }).then(function (r) {
    assert.deepEqual(r.data.map(function (row) { return row.title; }), ['Trending on Trakt'], 'not linked: trending only');
  });
});

// ── on a real server ────────────────────────────────────────────────────────

var base = null;

function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(new URL('/api/v1' + url, base), { agent: false }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
    }).on('error', reject);
  });
}

test('loaded by a real server: enabled; without the app\'s client id it adds nothing to a title page', function () {
  var plugins = require('../lib/plugins');
  tmdb.get = function (apiPath) {
    return apiPath === '/movie/949' ? Promise.resolve({ id: 949, title: 'Heat', imdb_id: 'tt0113277', release_date: '1995-12-15', genres: [] }) :
      Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
  };
  return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [DIR], installed: false, repositories: false } }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var p = plugins.list()[0];
        if (p && p.state !== 'loading') {
          return resolve(p);
        }
        if (Date.now() > until) {
          return reject(new Error('not loaded'));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function (p) {
    assert.equal(p.state, 'enabled', p.error);
    return get('/catalog/titles/movie/949/extras');
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { providers: [], errors: [] });
  }).finally(function () {
    return server.stop();
  });
});
