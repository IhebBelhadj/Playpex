'use strict';

// The 18+ plugin (plugins/adult, docs/plugins-plan.md step P5). Two parts:
//   • its server.js in Node with a stub `playpex` and canned answers of TMDB,
//     The Pirate Bay and TheRARBG (no network): every screen's answer against
//     the template schemas, the layout switch, title torrents matched and ranked,
//     plays with tracking none, the search chip;
//   • loaded by a real server from its folder (developer copy): listed for an
//     adult profile, never for a kids one, and its catalog asking for a key.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  vm = require('vm');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugin-adult-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  schemas = require('../lib/plugins/schemas');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'adult'),
  HASH_A = 'a'.repeat(40), HASH_B = 'b'.repeat(40), HASH_C = 'c'.repeat(40), HASH_D = 'd'.repeat(40);

// ── the plugin in Node ──────────────────────────────────────────────────────

var TMDB_ITEM = { id: 1, adult: true, title: 'Heatwave', release_date: '2025-03-01', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
  vote_average: 7.2, vote_count: 10, overview: 'A film.' };

function answer(url) {
  var u = new URL(url), q = u.searchParams;
  if (u.hostname === 'api.themoviedb.org') {
    if (u.pathname === '/3/discover/movie') {
      return { page: Number(q.get('page')), total_pages: 3, results: [TMDB_ITEM, { id: 2, adult: false, title: 'Not adult', poster_path: '/x.jpg' },
        { id: 3, adult: true, title: 'No poster' }] };
    }
    if (u.pathname === '/3/movie/1') {
      return Object.assign({}, TMDB_ITEM, { runtime: 95, production_companies: [{ id: 97168, name: 'Vixen' }],
        credits: { cast: [{ name: 'Jane Doe', profile_path: '/j.jpg' }], crew: [{ job: 'Director', name: 'Greg Lansky' }] } });
    }
    if (u.pathname === '/3/search/movie') {
      var adult = q.get('include_adult') === 'true';
      return adult ? { page: Number(q.get('page')), total_results: 30, results: Number(q.get('page')) === 2 ? [TMDB_ITEM] : [] } :
        { page: 1, total_results: 25, results: [] };
    }
  }
  if (u.hostname === 'apibay.org') {
    if (u.pathname === '/q.php') {
      return [
        { name: 'Heatwave [Vixen 2025] XXX 1080p MP4-P2P', info_hash: HASH_A.toUpperCase(), seeders: '50', leechers: '5', size: '2000', category: '505', added: '1760000000' },
        { name: 'Heatwave 2 [Vixen 2025] XXX 1080p', info_hash: HASH_B, seeders: '90', leechers: '1', size: '2000', category: '505' },
        { name: 'Heatwave [Vixen 2025] DVDR', info_hash: HASH_D, seeders: '9', leechers: '1', size: '9000', category: '502' }
      ];
    }
    return [{ name: 'Top film [Studio 2024] XXX 2160p x265', info_hash: HASH_D, seeders: '300', leechers: '10', size: '5000', category: '507' }];
  }
  if (/therarbg/.test(u.hostname)) {
    return { results: [{ n: 'Heatwave.2025.720p.AAC', h: HASH_C, se: '20', le: '2', s: '1000', c: 'XXX', a: 1760000000 },
      { n: 'Some.Show.S01E01', h: HASH_B, se: '99', s: '1', c: 'TV' }], links: { next: null } };
  }
  return null;
}

function load() {
  var handlers = {}, secrets = {}, settings = {}, store = {}, requests = [];
  var playpex = {
    // answers out of the vm's realm, comparable with deepEqual
    data: function (name, fn) {
      handlers[name] = function (args, ctx) {
        return fn(args, ctx).then(function (r) { return JSON.parse(JSON.stringify(r)); });
      };
    },
    http: {
      request: function (o) {
        requests.push(o);
        var body = answer(o.url);
        return Promise.resolve(body === null ? { status: 404, headers: {}, body: null } : { status: 200, headers: {}, body: body });
      }
    },
    secrets: { get: function (k) { return Promise.resolve(secrets[k] || null); } },
    settings: { get: function (k) { return Promise.resolve(k in settings ? settings[k] : k === 'metadataProvider' ? 'tmdb' : null); } },
    store: {
      get: function (k) { return Promise.resolve(k in store ? store[k] : null); },
      set: function (k, v) { store[k] = v; return Promise.resolve(true); }
    },
    log: { warn: function () {}, info: function () {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), { playpex: playpex, URL: URL });
  return { handlers: handlers, secrets: secrets, settings: settings, store: store, requests: requests };
}

var CTX = { profile: { id: 'p1', kids: false }, device: null, locale: 'en' };

function valid(def, value) {
  var problem = schemas.apiProblem(def, value);
  assert.equal(problem, null, def + ': ' + problem);
}

test('without a catalog key: the catalog says where to enter one', function () {
  var p = load();
  return p.handlers.browse({}, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.match(r.data.empty, /TMDB API key/);
    assert.deepEqual(p.requests, [], 'nothing fetched');
  });
});

test('the poster layout: home rows, paged; studio filters; a search row', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return p.handlers.browse({}, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.equal(r.data.rows.length, 13, 'popular, new, top rated and ten studios');
    assert.ok(r.data.rows.every(function (row) { return row.page && row.page.data === 'rowPage'; }));
    assert.deepEqual(r.data.filters.map(function (g) { return g.key; }), ['view', 'studio', 'period']);
    return p.handlers.rowPage(Object.assign({ page: 1 }, r.data.rows[0].page.args), CTX);
  }).then(function (r) {
    valid('rowPage', r.data);
    assert.deepEqual(r.data.items.map(function (c) { return c.title; }), ['Heatwave'], 'adult titles with a poster only');
    assert.equal(r.data.last, false);
    assert.deepEqual(r.data.items[0].intent, { screen: 'plugin.adult.title', params: { provider: 'tmdb', id: '1' } });
    return Promise.all([
      p.handlers.browse({ filters: { studio: ['97168'] } }, CTX),
      p.handlers.browse({ query: 'heat' }, CTX)
    ]);
  }).then(function (r) {
    assert.deepEqual(r[0].data.rows.map(function (x) { return x.title; }), ['Popular', 'Newest', 'Top rated']);
    assert.equal(r[1].data.rows.length, 1);
    return p.handlers.rowPage(Object.assign({ page: 1 }, r[1].data.rows[0].page.args), CTX);
  }).then(function (r) {
    assert.deepEqual(r.data.items.map(function (c) { return c.title; }), ['Heatwave'], 'found after the regular results');
  });
});

test('a title: its details, Play and Find releases, performers, more from its studio', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return p.handlers.title({ params: { provider: 'tmdb', id: '1' } }, CTX).then(function (r) {
    valid('templates/properties/title', r.data);
    assert.equal(r.data.info.eyebrow, 'Vixen');
    assert.deepEqual(r.data.info.credits.map(function (c) { return c.label; }), ['Starring', 'Director']);
    assert.deepEqual(r.data.actions.map(function (a) { return a.label; }), ['Play', 'Find releases']);
    assert.deepEqual(r.data.rows.map(function (row) { return row.title; }), ['Starring', 'More from Vixen']);
    assert.deepEqual(r.data.rows[0].items[0].intent, { screen: 'plugin.adult.find', params: { q: 'Jane Doe' } });
  });
});

test('Play: its torrents from both sites, matched by title and ranked; nothing saved', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return p.handlers.play({ provider: 'tmdb', id: '1' }, CTX).then(function (r) {
    assert.equal(r.effects.length, 1);
    valid('effect', r.effects[0]);
    var req = r.effects[0].request;
    assert.equal(req.tracking, 'none');
    assert.deepEqual(req.sources.map(function (s) { return s.magnet.slice(20, 60); }), [HASH_C, HASH_A],
      'the sequel and the DVD image left out; AAC (sound in the TV) before an untagged 1080p');
    assert.equal(req.sources[1].quality, '1080p');
    assert.ok(req.sources[1].notes.indexOf('Vixen') !== -1);
  });
});

test('the layout: the View filter switches screens in place and is kept per profile', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return p.handlers.browse({ filters: { view: ['list'] } }, CTX).then(function (r) {
    valid('effect', r.effects[0]);
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.adult.releases', replace: true });
    assert.equal(p.store['layout:p1'], 'list');
    return Promise.all([p.handlers.browse({}, CTX), p.handlers.releases({ params: {}, filters: {}, page: 1 }, CTX)]);
  }).then(function (r) {
    assert.equal(r[0].effects[0].intent.screen, 'plugin.adult.releases', 'the section opens the list now');
    valid('templates/properties/releases', r[1].data);
    assert.equal(r[1].effects, undefined);
    assert.deepEqual(r[1].data.releases.map(function (x) { return x.title; }), ['Top film'], 'The Pirate Bay\'s top 100 by default');
    assert.equal(r[1].data.filters[0].key, 'view');
    return p.handlers.releases({ params: {}, filters: { view: ['posters'] } }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.adult.browse', replace: true });
    assert.equal(p.store['layout:p1'], 'posters');
  });
});

test('Find releases: searched for the title, another source, filters', function () {
  var p = load();
  return Promise.all([
    p.handlers.releases({ params: { q: 'Heatwave' }, filters: {}, page: 1 }, CTX),
    p.handlers.releases({ params: { q: 'Heatwave' }, filters: { source: ['therarbg'], plays: ['yes'] }, page: 1 }, CTX),
    p.handlers.releases({ params: { q: 'Heatwave' }, filters: { quality: ['2160p'] }, page: 2 }, CTX)
  ]).then(function (r) {
    valid('templates/properties/releases', r[0].data);
    assert.equal(r[0].data.title, 'Releases of “Heatwave”');
    assert.ok(!r[0].data.filters.some(function (g) { return g.key === 'view'; }), 'no layout switch on a search');
    assert.deepEqual(r[0].data.releases.map(function (x) { return x.seeds; }), [90, 50], 'most seeded first, films only');
    assert.deepEqual(r[1].data.releases.map(function (x) { return x.title; }), ['Heatwave 2025'], 'its cleaned title');
    assert.deepEqual(r[2].data, { releases: [], last: true, filters: r[2].data.filters }, 'The Pirate Bay has one page');
  });
});

test('the search page\'s 18+ chip', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return Promise.all([
    p.handlers.searchFilter({ slot: 'core.search.filters', context: { query: 'heat' } }, CTX),
    p.handlers.searchFilter({ slot: 'core.search.filters', context: { query: 'he' } }, CTX)
  ]).then(function (r) {
    valid('slots/searchFilter', r[0].data);
    assert.equal(r[0].data.chip.label, '18+');
    assert.deepEqual(r[0].data.rows[0].items.map(function (c) { return c.title; }), ['Heatwave']);
    assert.deepEqual(r[1].data.rows, [], 'not under 3 characters');
  });
});

// ── on a real server ────────────────────────────────────────────────────────

var base = null;

function call(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false, headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('on a real server: for adult profiles only; its catalog asks for a key', function () {
  var adult, kid;
  return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [DIR], installed: false, repositories: false } }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return Promise.all([call('POST', '/profiles', { name: 'Grown up' }), call('POST', '/profiles', { name: 'Small', isKid: true })]);
  }).then(function (r) {
    // plugins load in the background
    var until = Date.now() + 15000;
    return (function poll() {
      return call('GET', '/plugins?profile=' + r[0].json.id).then(function (list) {
        return list.json.plugins.some(function (p) { return p.id === 'adult'; }) || Date.now() > until ? r :
          new Promise(function (ok) { setTimeout(ok, 100); }).then(poll);
      });
    })();
  }).then(function (r) {
    adult = r[0].json.id;
    kid = r[1].json.id;
    return Promise.all([
      call('GET', '/plugins?profile=' + adult),
      call('GET', '/plugins?profile=' + kid),
      call('POST', '/plugins/adult/data/browse?profile=' + adult, { args: {} }),
      call('POST', '/plugins/adult/data/browse?profile=' + kid, { args: {} })
    ]);
  }).then(function (r) {
    var mine = r[0].json.plugins.filter(function (p) { return p.id === 'adult'; })[0];
    assert.ok(mine, 'listed for an adult profile');
    assert.equal(mine.audience, 'adults');
    assert.deepEqual(mine.screens.map(function (s) { return s.name; }), ['browse', 'title', 'releases', 'find']);
    assert.equal(mine.sections[0].menu.label, '18+');
    assert.ok(!r[1].json.plugins.some(function (p) { return p.id === 'adult'; }), 'never for a kids profile');
    assert.equal(r[2].status, 200, r[2].text);
    assert.match(r[2].json.data.empty, /API key/);
    assert.equal(r[3].status, 403);
  }).finally(function () {
    return server.stop().then(function () { fs.rmSync(tmp, { recursive: true, force: true }); });
  });
});
