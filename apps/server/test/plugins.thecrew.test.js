'use strict';

// The Crew plugin (plugins/thecrew, a port of the Kodi add-on). Two parts:
//   • its server.js in Node with a stub `playpex` and a made-up web (no
//     network): Torrentio and Knaben in Play (one per hash, the matcher's
//     verdict, an episode's file in a pack), the debrid check (TorBox and
//     Premiumize cached, Real-Debrid tries), resolving through Real-Debrid
//     (the file named, never the sample; one it doesn't have removed again),
//     TorBox and AllDebrid, a link on a host it may not reach, Find
//     releases and Search paged, Check the accounts; answers against the
//     hook schemas;
//   • loaded by a real server from its folder: enabled.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  vm = require('vm');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugin-thecrew-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  schemas = require('../lib/plugins/schemas');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'thecrew');

var A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), J = '1'.repeat(40), K = '2'.repeat(40),
  P = '3'.repeat(40), Q = '4'.repeat(40);

var ENDGAME = { kind: 'movie', tmdbId: 299534, imdbId: 'tt4154796', title: 'Avengers: Endgame', year: 2019 };
var EPISODE = { kind: 'episode', tmdbId: 1396, imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008, season: 1, episode: 3 };
var CTX = { profile: { id: 'ana', kids: false }, device: null, locale: 'en' };

// ── a made-up web ───────────────────────────────────────────────────────────

function hit(hash, title, seeds) {
  return { hash: hash.toUpperCase(), title: title, bytes: 2000000000, seeders: seeds, peers: 3, cachedOrigin: 'The Pirate Bay (proxy)', date: '2019-07-31T23:00:00+00:00' };
}

function web() {
  var w = {
    calls: [],
    // what Real-Debrid has: a hash → downloaded at once
    rdHas: [B],
    deleted: [],
    answer: function (o) {
      var u = new URL(o.url), p = u.pathname, method = o.method || 'GET', body = o.body;
      w.calls.push({ method: method, host: u.host, path: p, query: u.search, body: body, auth: (o.headers || {}).Authorization || null });
      var form = typeof body === 'string' ? new URLSearchParams(body) : null;
      if (u.host === 'torrentio.strem.fun') {
        if (p === '/stream/movie/tt4154796.json') {
          return { status: 200, body: { streams: [
            { title: 'Avengers.Endgame.2019.1080p.BluRay.x264\n👤 120 💾 2.1 GB ⚙️ YTS', infoHash: A, fileIdx: 0, behaviorHints: { filename: 'Avengers.Endgame.2019.1080p.mkv' } },
            { title: 'Avengers Endgame 2019 720p WEB x264\n👤 40 💾 925 MB ⚙️ ThePirateBay', infoHash: B, behaviorHints: { filename: 'Avengers.Endgame.720p.mkv' } },
            { title: 'no hash here', url: 'https://example.com/x.mp4' }
          ] } };
        }
        if (p === '/stream/series/tt0903747:1:3.json') {
          return { status: 200, body: { streams: [
            { title: 'Breaking Bad S01 1080p BluRay x264\nBreaking.Bad.S01E03.1080p.mkv\n👤 30 💾 1.5 GB ⚙️ EZTV', infoHash: P, fileIdx: 2, behaviorHints: { filename: 'Breaking.Bad.S01E03.1080p.mkv' } },
            { title: 'Breaking Bad S01E03 720p WEB x264\n👤 12 💾 400 MB ⚙️ 1337x', infoHash: Q, fileIdx: 0, behaviorHints: { filename: 'Breaking.Bad.S01E03.720p.mkv' } }
          ] } };
        }
        return { status: 200, body: { streams: [] } };
      }
      if (u.host === 'api.knaben.org') {
        var q = body.query || '';
        if (q === 'Avengers Endgame 2019') {
          return { status: 200, body: { hits: [hit(B, 'Avengers Endgame 2019 720p WEB x264', 300), hit(K, 'Avengers.Endgame.2019.2160p.WEB', 90), hit(J, 'The Avengers 2012 1080p', 500)] } };
        }
        if (q === 'Breaking Bad S01E03') {
          return { status: 200, body: { hits: [hit(Q, 'Breaking Bad S01E03 720p WEB x264', 50), hit(C, 'The Bad Guys Breaking In S01E03 1080p', 6)] } };
        }
        if (q === 'Breaking Bad S01') {
          return { status: 200, body: { hits: [] } };
        }
        // a page of 50 for the release list, then 3 on page 2
        var n = body.from === 0 ? 50 : 3, hits = [];
        for (var i = 0; i < n; i++) {
          hits.push(hit((body.from + i).toString(16).padStart(40, '0'), 'Release ' + (body.from + i) + ' 1080p', 100 - i));
        }
        return { status: 200, body: { hits: hits } };
      }
      if (u.host === 'api.torbox.app') {
        assert.equal(o.headers.Authorization, 'Bearer tb-key');
        if (p === '/v1/api/torrents/checkcached') {
          return { status: 200, body: { success: true, data: u.searchParams.get('hash').split(',').indexOf(A) !== -1 ? { [A]: { name: 'Endgame', size: 1 } } : {} } };
        }
        if (p === '/v1/api/torrents/createtorrent') {
          return { status: 200, body: { success: true, data: { torrent_id: 7, hash: /btih:([0-9a-f]+)/.exec(form.get('magnet'))[1] } } };
        }
        if (p === '/v1/api/torrents/mylist') {
          return { status: 200, body: { success: true, data: { id: 7, download_present: true, files: [
            { id: 0, name: 'Endgame/Sample/sample.mkv', size: 10 }, { id: 1, name: 'Endgame/Avengers.Endgame.2019.1080p.mkv', size: 5000 }] } } };
        }
        if (p === '/v1/api/torrents/requestdl') {
          assert.equal(u.searchParams.get('file_id'), '1');
          return { status: 200, body: { success: true, data: 'https://store-031.weur.tb-cdn.st/dl/abc/Avengers.Endgame.2019.1080p.mkv' } };
        }
        if (p === '/v1/api/user/me') {
          return { status: 200, body: { success: true, data: { plan: 2, premium_expires_at: '2027-01-01T00:00:00Z' } } };
        }
      }
      if (u.host === 'www.premiumize.me') {
        if (u.searchParams.get('apikey') !== 'pm-key') {
          return { status: 200, body: { status: 'error', message: 'Not logged in' } };
        }
        if (p === '/api/cache/check') {
          return { status: 200, body: { status: 'success', response: u.searchParams.getAll('items[]').map(function (h) { return h === K; }) } };
        }
        if (p === '/api/account/info') {
          return { status: 200, body: { status: 'success', premium_until: 1798761600 } };
        }
      }
      if (u.host === 'api.real-debrid.com') {
        if (o.headers.Authorization !== 'Bearer rd-token') {
          return { status: 401, body: { error: 'bad_token', error_code: 8 } };
        }
        var m = /^\/rest\/1\.0\/torrents\/(addMagnet|info|selectFiles|delete)\/?(.*)$/.exec(p);
        if (m && m[1] === 'addMagnet') {
          var h = /btih:([0-9a-f]+)/.exec(form.get('magnet'))[1];
          w.rd = w.rd || {};
          w.rd['rd-' + h] = { hash: h, selected: null };
          return { status: 201, body: { id: 'rd-' + h, uri: 'x' } };
        }
        if (m && m[1] === 'info') {
          var t = w.rd[m[2]], files = [{ id: 1, path: '/Endgame/Sample/sample.mkv', bytes: 10 }, { id: 2, path: '/Endgame/Avengers.Endgame.720p.mkv', bytes: 9000 }];
          if (!t.selected) {
            return { status: 200, body: { id: m[2], status: 'waiting_files_selection', files: files, links: [] } };
          }
          var has = w.rdHas.indexOf(t.hash) !== -1;
          return { status: 200, body: { id: m[2], status: has ? 'downloaded' : 'downloading', files: files, links: has ? ['https://real-debrid.com/d/XYZ'] : [] } };
        }
        if (m && m[1] === 'selectFiles') {
          w.rd[m[2]].selected = form.get('files');
          return { status: 204, body: '' };
        }
        if (m && m[1] === 'delete') {
          w.deleted.push('rd:' + w.rd[m[2]].hash);
          return { status: 204, body: '' };
        }
        if (p === '/rest/1.0/unrestrict/link') {
          return { status: 200, body: { download: w.rdLink || 'https://42.download.real-debrid.com/d/XYZ/Avengers.Endgame.720p.mkv', filename: 'Avengers.Endgame.720p.mkv', filesize: 9000 } };
        }
        if (p === '/rest/1.0/user') {
          return { status: 200, body: { username: 'ana', type: 'premium', expiration: '2027-03-01T00:00:00.000Z' } };
        }
      }
      if (u.host === 'api.alldebrid.com') {
        assert.equal(u.searchParams.get('agent'), 'playpex');
        if (p === '/v4/magnet/upload') {
          return { status: 200, body: { status: 'success', data: { magnets: [{ id: 99, ready: false }] } } };
        }
        if (p === '/v4/magnet/delete') {
          w.deleted.push('ad:' + form.get('id'));
          return { status: 200, body: { status: 'success', data: {} } };
        }
        if (p === '/v4/user') {
          return { status: 200, body: { status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' } } };
        }
      }
      return { status: 404, body: { error: 'not found' } };
    }
  };
  return w;
}

// ── the plugin in Node ──────────────────────────────────────────────────────

function words(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// the core's matcher, roughly: the title first, then the year / the episode
function matches(name, t) {
  var n = words(name), title = words(t.title);
  if (n.indexOf(title) !== 0) {
    return null;
  }
  if (t.kind === 'movie') {
    return n.indexOf(String(t.year)) !== -1 ? 'movie' : null;
  }
  var code = 's' + String(t.season).padStart(2, '0');
  if (n.indexOf(code + 'e' + String(t.episode).padStart(2, '0')) !== -1) {
    return 'episode';
  }
  return new RegExp(code + '( |$)').test(n) ? 'pack' : null;
}

function load(secrets, settings) {
  var p = { hooks: {}, handlers: {}, web: web(), logs: [] };
  var plain = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  var playpex = {
    hooks: { on: function (name, fn) { p.hooks[name] = function (input, ctx) { return Promise.resolve(fn(plain(input), ctx)).then(plain); }; } },
    data: function (name, fn) { p.handlers[name] = function (args, ctx) { return Promise.resolve(fn(args, ctx)).then(plain); }; },
    http: {
      request: function (o) {
        var r = p.web.answer(plain(o));
        return Promise.resolve({ status: r.status, headers: {}, body: r.body });
      }
    },
    secrets: { get: function (k) { return Promise.resolve((secrets || {})[k] || null); } },
    settings: { get: function (k) { return Promise.resolve(settings && k in settings ? settings[k] : true); } },
    names: {
      matches: function (list, t) { return Promise.resolve([].concat(list).map(function (n) { return matches(n, t); })); },
      rank: function (items) { return Promise.resolve(items.slice().sort(function (a, b) { return b.seeds - a.seeds; })); }
    },
    log: { warn: function (m) { p.logs.push(m); }, info: function () {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'server.js'), 'utf8'), { playpex: playpex, URL: URL, Date: Date, encodeURIComponent: encodeURIComponent });
  return p;
}

var KEYS = { torboxKey: 'tb-key', premiumizeKey: 'pm-key', realdebridToken: 'rd-token' };

function valid(name, kind, value) {
  assert.equal(schemas.hookProblem(name, kind, value), null);
}

function byHash(sources) {
  var out = {};
  sources.forEach(function (s) { out[s.infoHash] = s; });
  return out;
}

// ── Play ────────────────────────────────────────────────────────────────────

test('play.collect, a movie: Torrentio and Knaben, one per hash (Torrentio\'s, which names the file), other titles left out', function () {
  var p = load();
  return p.hooks['play.collect']({ title: ENDGAME }, CTX).then(function (sources) {
    valid('play.collect', 'output', sources);
    var s = byHash(sources);
    assert.deepEqual(Object.keys(s).sort(), [A, B, K].sort(), 'J (The Avengers 2012) isn\'t this title');
    assert.equal(s[A].seeds, 120);
    assert.equal(s[A].size, Math.round(2.1 * Math.pow(1024, 3)));
    assert.equal(s[A].fileIndex, 0);
    assert.equal(s[A].fileName, 'Avengers.Endgame.2019.1080p.mkv');
    assert.deepEqual(s[A].notes, ['From Torrentio (YTS)']);
    assert.equal(s[B].fileName, 'Avengers.Endgame.720p.mkv', 'Torrentio\'s copy kept, though Knaben counts more seeds');
    assert.deepEqual(s[K].notes, ['From Knaben (The Pirate Bay)']);
    assert.equal(s[K].peers, 3);
    var knaben = p.web.calls.filter(function (c) { return c.host === 'api.knaben.org'; });
    assert.deepEqual(knaben.map(function (c) { return [c.body.query, c.body.categories[0]]; }), [['Avengers Endgame 2019', 3000000]]);
  });
});

test('play.collect, an episode: Torrentio by the show\'s IMDb id (a pack\'s own file), Knaben by SxxEyy and Sxx; switched off: nothing asked', function () {
  var p = load();
  return p.hooks['play.collect']({ title: EPISODE }, CTX).then(function (sources) {
    valid('play.collect', 'output', sources);
    var s = byHash(sources);
    assert.deepEqual(Object.keys(s).sort(), [P, Q].sort(), 'not "The Bad Guys Breaking In"');
    assert.equal(s[P].fileIndex, 2);
    assert.equal(s[P].fileName, 'Breaking.Bad.S01E03.1080p.mkv');
    assert.ok(p.web.calls.some(function (c) { return c.path === '/stream/series/tt0903747:1:3.json'; }));
    assert.deepEqual(p.web.calls.filter(function (c) { return c.host === 'api.knaben.org'; }).map(function (c) { return c.body.query; }).sort(),
      ['Breaking Bad S01', 'Breaking Bad S01E03']);
    var off = load({}, { torrentio: false, knaben: false });
    return off.hooks['play.collect']({ title: EPISODE }, CTX).then(function (none) {
      assert.deepEqual(none, []);
      assert.equal(off.web.calls.length, 0);
    });
  });
});

test('play.resolve check: TorBox and Premiumize say what they have, Real-Debrid only tries; no account: nothing', function () {
  var p = load(KEYS), input = { mode: 'check', hashes: [A, B, K] };
  valid('play.resolve', 'input', input);
  return p.hooks['play.resolve'](input, CTX).then(function (out) {
    valid('play.resolve', 'output', out);
    assert.deepEqual(out.hashes[A], { cached: true, label: 'TorBox' });
    assert.deepEqual(out.hashes[K], { cached: true, label: 'Premiumize' });
    assert.deepEqual(out.hashes[B], { cached: false, tries: true, label: 'Real-Debrid' });
    return load({}).hooks['play.resolve'](input, CTX);
  }).then(function (out) {
    assert.deepEqual(out, { hashes: {} });
    return load({ realdebridToken: 'rd-token', alldebridKey: 'ad-key' }).hooks['play.resolve'](input, CTX);
  }).then(function (out) {
    assert.deepEqual(out.hashes[A], { cached: false, tries: true, label: 'Real-Debrid or AllDebrid' });
  });
});

test('play.resolve: Real-Debrid plays the file the source named (never the sample); one it doesn\'t have is removed again', function () {
  var p = load({ realdebridToken: 'rd-token' });
  var source = { kind: 'magnet', infoHash: B, label: 'Avengers Endgame 2019 720p WEB x264', fileName: 'Avengers.Endgame.720p.mkv' };
  var input = { mode: 'resolve', title: ENDGAME, source: source };
  valid('play.resolve', 'input', input);
  return p.hooks['play.resolve'](input, CTX).then(function (out) {
    valid('play.resolve', 'output', out);
    assert.deepEqual(out.source, {
      kind: 'http', url: 'https://42.download.real-debrid.com/d/XYZ/Avengers.Endgame.720p.mkv', label: 'Avengers.Endgame.720p.mkv',
      size: 9000, container: 'mkv', notes: ['From Real-Debrid']
    });
    assert.equal(p.web.rd['rd-' + B].selected, '2', 'the film, not Sample/sample.mkv');
    assert.deepEqual(p.web.deleted, [], 'kept in the account: it plays from there');
    return p.hooks['play.resolve']({ mode: 'resolve', title: ENDGAME, source: { kind: 'magnet', infoHash: C, label: 'Avengers Endgame 2019 CAM' } }, CTX);
  }).then(function (out) {
    assert.deepEqual(out, { source: null });
    assert.deepEqual(p.web.deleted, ['rd:' + C], 'Real-Debrid doesn\'t start downloading it');
  });
});

test('play.resolve: TorBox for what its check said it has (the film, not the sample); AllDebrid not ready → removed, null', function () {
  var p = load(Object.assign({ alldebridKey: 'ad-key' }, KEYS));
  return p.hooks['play.resolve']({ mode: 'check', hashes: [A] }, CTX).then(function () {
    return p.hooks['play.resolve']({ mode: 'resolve', title: ENDGAME, source: { kind: 'magnet', infoHash: A, label: 'Avengers.Endgame.2019.1080p.BluRay.x264' } }, CTX);
  }).then(function (out) {
    valid('play.resolve', 'output', out);
    assert.equal(out.source.url, 'https://store-031.weur.tb-cdn.st/dl/abc/Avengers.Endgame.2019.1080p.mkv');
    assert.deepEqual(out.source.notes, ['From TorBox']);
    assert.ok(!p.web.calls.some(function (c) { return c.host === 'api.real-debrid.com'; }), 'TorBox served it: nobody else asked');
    var ad = load({ alldebridKey: 'ad-key' });
    return ad.hooks['play.resolve']({ mode: 'resolve', title: ENDGAME, source: { kind: 'magnet', infoHash: C, label: 'x' } }, CTX).then(function (out) {
      assert.deepEqual(out, { source: null });
      assert.deepEqual(ad.web.deleted, ['ad:99']);
    });
  });
});

test('play.resolve: a link on a host the plugin may not reach gives nothing, with a warning', function () {
  var p = load({ realdebridToken: 'rd-token' });
  p.web.rdLink = 'https://files.elsewhere.example/Avengers.mkv';
  return p.hooks['play.resolve']({ mode: 'resolve', title: ENDGAME, source: { kind: 'magnet', infoHash: B, label: 'x' } }, CTX).then(function (out) {
    assert.deepEqual(out, { source: null });
    assert.ok(p.logs.some(function (l) { return /files\.elsewhere\.example/.test(l); }), p.logs.join('\n'));
  });
});

// ── Find releases, Search, the accounts ─────────────────────────────────────

test('releases.providers and sources.search: Knaben, 50 a page, the last page said; a show\'s own list without keywords: nothing', function () {
  var p = load();
  return p.hooks['releases.providers']({ kind: 'movie', query: 'Release', page: 1 }, CTX).then(function (out) {
    valid('releases.providers', 'output', out);
    assert.equal(out.releases.length, 50);
    assert.equal(out.last, false);
    assert.equal(out.releases[0].uploadedAt, '2019-07-31T23:00:00.000Z');
    return p.hooks['releases.providers']({ kind: 'movie', query: 'Release', page: 2 }, CTX);
  }).then(function (out) {
    assert.equal(out.releases.length, 3);
    assert.equal(out.last, true);
    assert.equal(p.web.calls[p.web.calls.length - 1].body.from, 50);
    return p.hooks['releases.providers']({ kind: 'show', title: { kind: 'show', imdbId: 'tt0903747' }, page: 1 }, CTX);
  }).then(function (out) {
    assert.deepEqual(out, { releases: [], last: true });
    return p.hooks['sources.search']({ query: 'Release', kind: 'any', page: 1 }, CTX);
  }).then(function (out) {
    valid('sources.search', 'output', out);
    assert.equal(out.results.length, 50);
    assert.equal(out.results[0].source.kind, 'magnet');
    assert.equal(p.web.calls[p.web.calls.length - 1].body.categories, undefined, 'any kind: every category');
  });
});

test('Check the accounts: each service\'s state, a refused key named', function () {
  return load({}).handlers.checkAccounts({}, CTX).then(function (out) {
    assert.equal(out.effects[0].tone, 'info');
    return load(Object.assign({ alldebridKey: 'bad' }, KEYS)).handlers.checkAccounts({}, CTX);
  }).then(function (out) {
    assert.equal(out.effects[0].tone, 'error');
    assert.equal(out.effects[0].text, 'AllDebrid: the key was refused. TorBox, Premiumize, Real-Debrid: fine');
    return load(KEYS).handlers.checkAccounts({}, CTX);
  }).then(function (out) {
    assert.equal(out.effects[0].tone, 'success');
    assert.equal(out.effects[0].text, 'TorBox: plan 2 until 2027-01-01; Premiumize: premium until 2027-01-01; Real-Debrid: premium until 2027-03-01');
  });
});

// ── a real server ───────────────────────────────────────────────────────────

test('loaded by a real server from its folder: enabled, its hooks and its action', function () {
  var plugins = require('../lib/plugins');
  return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [DIR], installed: false, repositories: false } }).then(function () {
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
    var registered = plugins.get('thecrew').registered;
    assert.deepEqual(registered.hook.slice().sort(), ['play.collect', 'play.resolve', 'releases.providers', 'sources.search']);
    assert.deepEqual(registered.data, ['checkAccounts']);
  }).finally(function () {
    return server.stop();
  });
});
