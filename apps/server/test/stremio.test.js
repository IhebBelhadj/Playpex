'use strict';

// The Stremio add-on bridge (docs/stremio-bridge-plan.md) on a real server
// against a made-up add-on (test/helpers/stremio-addon.js):
//
//   the protocol's cleaners · inspect: a preview of what it offers, ids by configuration, a bad address
//   install: trusted adapter, the URL a secret out of every file and answer
//   Play: torrents ranked by seeders (one per hash), a debrid link redirected to a CDN no answer named and
//     played with ranges, HLS whose parts are on another host, plain http / externalUrl / YouTube dropped,
//     a redirect to a private address refused, an oversized answer refused (Play still answers)
//   subtitles: its list with languages mapped, a file fetched from a host its answer named
//   catalogs: rows where the admin placed them (paged, TMDB's titles opening core pages), the section with
//     genre and search, the search chip, pictures through the image proxy; title pages of its own ids and
//     their videos played by a play effect
//   placements changed, a new configuration (same plugin), the add-on's update, removal

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-stremio-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var stremio = require('@playpex/protocol/stremio'),
  server = require('..'),
  plugins = require('../lib/plugins'),
  managed = require('../lib/plugins/managed'),
  bridge = require('../lib/plugins/stremio'),
  manifests = require('../lib/plugins/stremio/manifest'),
  account = require('../lib/plugins/stremio/account'),
  web = require('./helpers/stremio-addon');

var addon = null, base = null, cookie = null, id = null, skip = false;

function call(method, apiPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL(apiPath.indexOf('/api/') === 0 ? apiPath : '/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}, headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks), json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, raw: raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function data(name, args) {
  return call('POST', '/plugins/' + id + '/data/' + name, { args: args || {} });
}

test.before(function () {
  return web.start().then(function (w) {
    if (!w) {
      skip = true;
      return null;
    }
    addon = w;
    // TMDB is never asked in tests: the ids metas don't carry are known already
    bridge.testing.tmdbIds.set('tt1000900', null);
    bridge.testing.tmdbIds.set('tt1000901', null);
    account.configure({ base: addon.apiBase });
    return server.start({
      port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
      plugins: { dirs: [], repositories: false, managed: { intervalMs: false }, http: addon.http() }
    }).then(function (info) {
      base = 'http://127.0.0.1:' + info.port;
      return call('POST', '/admin/setup', { username: 'admin', password: 'stremio-pass' });
    }).then(function () {
      return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'stremio-pass' });
    }).then(function (res) {
      cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
    });
  });
});

test.after(function () {
  return (base ? server.stop() : Promise.resolve()).then(function () {
    return addon ? addon.stop() : null;
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('the protocol: addresses, paths, cleaners, free-text conventions', function () {
  var a = stremio.addonUrl('stremio://addon.example.org/cfg=K3Y');
  assert.equal(a.manifest, 'https://addon.example.org/cfg=K3Y/manifest.json');
  assert.equal(a.base, 'https://addon.example.org/cfg=K3Y');
  assert.equal(a.configured, true);
  assert.equal(stremio.addonUrl('https://addon.example.org/manifest.json').configured, false);
  assert.throws(function () { stremio.addonUrl('ftp://x/manifest.json'); }, /https/);
  assert.throws(function () { stremio.addonUrl('https://u:p@x.org/manifest.json'); }, /password/);
  assert.equal(stremio.requestPath('stream', 'series', 'tt1:1:2'), '/stream/series/tt1%3A1%3A2.json');
  assert.equal(stremio.requestPath('catalog', 'movie', 'top', { genre: 'Sci-Fi & Fantasy', skip: 100 }), '/catalog/movie/top/genre=Sci-Fi%20%26%20Fantasy&skip=100.json');
  var m = stremio.cleanManifest({ id: 'x', name: 'X', resources: ['stream', { name: 'meta', types: ['channel'], idPrefixes: ['yt:'] }, 'addon_catalog'], types: ['movie'] });
  assert.deepEqual(m.unused, [], 'addon_catalog is read');
  assert.deepEqual(m.manifest.addonCatalogs, [], 'none listed');
  assert.deepEqual(m.manifest.resources[1], { name: 'meta', types: ['channel'], idPrefixes: ['yt:'] });
  assert.ok(stremio.offers(m.manifest, 'meta', 'channel', 'yt:abc'));
  assert.ok(!stremio.offers(m.manifest, 'meta', 'channel', 'tt1'));
  assert.throws(function () { stremio.cleanManifest({ name: 'no id' }); }, /no id/);
  var s = stremio.clean('stream', { streams: [{ infoHash: 'A'.repeat(40), sources: ['tracker:udp://t:1', 'dht:x'] }, { url: 'javascript:x' }, 7], cacheMaxAge: 99999999 });
  assert.equal(s.streams.length, 2);
  assert.equal(s.streams[0].infoHash, 'a'.repeat(40));
  assert.deepEqual(s.streams[0].trackers, ['udp://t:1']);
  assert.equal(s.streams[1].kind, 'other', 'not a URL Playpex plays');
  assert.equal(s.cache.maxAge, null, 'past the cap: ours');
  assert.throws(function () { stremio.clean('stream', { streams: 'x' }); }, /list/);
  assert.equal(stremio.seedersOf('👤 57 💾 4.35 GB ⚙️ X'), 57);
  assert.equal(stremio.sizeOf('👤 57 💾 4.35 GB'), Math.round(4.35 * 1073741824));
  assert.equal(stremio.language('pob'), 'pt-BR');
  assert.equal(stremio.language('eng'), 'en');
  assert.equal(manifests.versionOf('v3'), '3.0.0');
  assert.equal(manifests.versionOf('1.2'), '1.2.0');
});

test('inspect: what it offers, its id by configuration; a bad address and a wrong answer refused', { skip: skip }, function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: addon.url() } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var p = r.json;
    id = p.id;
    assert.match(id, /^st-test-fakeaddon-[0-9a-f]{4}$/);
    assert.equal(p.origin, 'managed');
    assert.equal(p.installable, true);
    var sum = p.summary;
    assert.equal(sum.host, 'addon.playpex-test.dev');
    assert.equal(sum.configured, false);
    assert.equal(sum.configureUrl, 'https://addon.playpex-test.dev:' + addon.port + '/configure');
    assert.equal(sum.offers.play, true);
    assert.equal(sum.offers.subtitles, true);
    assert.deepEqual(sum.offers.catalogs.map(function (c) { return c.name + ':' + c.show; }), ['Top films:movies', 'Channels:section']);
    assert.ok(sum.unused.indexOf('addon_catalog') === -1, 'it lists add-ons');
    assert.equal(sum.offers.addons, true);
    assert.ok(sum.unused.some(function (u) { return /Needs a thing/.test(u); }), 'a catalog needing what the bridge can\'t give');
    assert.ok(sum.unused.some(function (u) { return /music/.test(u); }));
    return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: addon.url('/cfg=SECRET42/manifest.json') } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.json.id, id, 'another configuration is another plugin');
    assert.equal(r.json.summary.configureUrl, null, 'configured: its configure page would show the key');
    assert.ok(r.text.indexOf('SECRET42') === -1, 'the key is never in the preview');
    return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: 'https://loop.playpex-test.dev:' + addon.port + '/manifest.json' } });
  }).then(function (r) {
    assert.equal(r.status >= 400, true, 'a private address');
    return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: addon.url('/stream/movie/tt0000001.json') } });
  }).then(function (r) {
    assert.equal(r.status >= 400, true, 'not a manifest');
  });
});

test('install: the adapter trusted, the URL a secret out of files and answers', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var url = addon.url('/cfg=SECRET42/manifest.json');
  return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: url } }).then(function (r) {
    id = r.json.id;
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install', {});
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var p = plugins.get(id);
    assert.equal(p.state, 'enabled', p.error);
    assert.equal(p.trusted, 'stremio');
    assert.equal(p.openStreams, true);
    assert.equal(p.manifest.icon, 'assets/icon.png', 'its logo as its icon');
    var dir = path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', id);
    fs.readdirSync(dir).forEach(function (f) {
      var file = path.join(dir, f);
      if (fs.statSync(file).isFile()) {
        assert.ok(fs.readFileSync(file, 'utf8').indexOf('SECRET42') === -1, f + ' holds no key');
      }
    });
    return Promise.all([managed.inputOf(id), call('GET', '/admin/plugins/' + id), call('GET', '/plugins')]);
  }).then(function (r) {
    assert.deepEqual(r[0], { url: url });
    assert.equal(r[1].status, 200);
    assert.ok(r[1].text.indexOf('SECRET42') === -1, 'not in the admin\'s view');
    assert.ok(r[2].text.indexOf('SECRET42') === -1, 'not in clients\' view');
    assert.ok(r[2].json.plugins.some(function (p) { return p.id === id; }));
  });
});

test('Play: torrents by seeders, a debrid link, HLS; what it can\'t play dropped', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var sources;
  return call('POST', '/play/sources', { kind: 'movie', tmdbId: 1, imdbId: 'tt0000001', title: 'Film', year: 2020 }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    sources = r.json.sources.filter(function (s) { return s.plugin === id; });
    var torrents = sources.filter(function (s) { return s.type === 'torrent'; }),
      links = sources.filter(function (s) { return s.type === 'plugin'; });
    assert.deepEqual(torrents.map(function (s) { return s.infoHash; }).sort(), ['a'.repeat(40), 'b'.repeat(40)], 'one per hash');
    var b = torrents.filter(function (s) { return s.infoHash === 'b'.repeat(40); })[0];
    assert.equal(b.seeds, 300, 'the add-on\'s count, the first copy');
    assert.equal(b.size, 700 * 1048576);
    assert.ok(b.notes.some(function (n) { return /as the add-on says/.test(n); }));
    var a = torrents.filter(function (s) { return s.infoHash === 'a'.repeat(40); })[0];
    assert.equal(a.label, 'Film.2020.1080p.WEB.x264.AAC-FAKE.mkv', 'its file name');
    assert.deepEqual(a.file, { name: 'Film.2020.1080p.WEB.x264.AAC-FAKE.mkv', index: 0 });
    assert.ok(a.magnet.indexOf('tracker.example') === -1, 'the server\'s own trackers, never the add-on\'s');
    var labels = links.map(function (s) { return s.label; });
    assert.ok(labels.indexOf('Film.2020.1080p.BluRay.x264.AAC-FAKE.mp4') !== -1, 'the debrid link');
    assert.ok(labels.some(function (l) { return /HLS/.test(l); }), 'the HLS stream');
    assert.ok(!labels.some(function (l) { return /plain http/.test(l); }), 'plain http: dropped');
    assert.ok(!sources.some(function (s) { return /Web page|Trailer/.test(s.label); }), 'externalUrl and YouTube: not in Play');
    var debrid = links.filter(function (s) { return /BluRay/.test(s.label); })[0];
    return call('GET', '/media/' + debrid.ref, undefined, { Range: 'bytes=1000-1999' });
  }).then(function (r) {
    assert.equal(r.status, 206, r.text.slice(0, 200));
    assert.deepEqual(r.raw, addon.film.subarray(1000, 2000), 'the CDN\'s bytes, through a redirect no answer named');
    assert.ok(addon.counts['cdn/film.mp4'] >= 1);
    var hls = sources.filter(function (s) { return /HLS/.test(s.label); })[0];
    assert.equal(hls.format, 'hls');
    return call('GET', '/media/' + hls.ref + '/index.m3u8');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var part = r.text.split('\n').filter(function (l) { return l && l[0] !== '#'; })[0];
    assert.ok(part.indexOf('parts.playpex-test.dev') === -1, 'rewritten to the server');
    var hls = sources.filter(function (s) { return /HLS/.test(s.label); })[0];
    return call('GET', '/media/' + hls.ref + '/' + part);
  }).then(function (r) {
    assert.equal(r.status, 200, 'its part from another host');
    assert.equal(r.raw.length, 1880);
    var evil = sources.filter(function (s) { return /evil/.test(s.label); })[0];
    return call('GET', '/media/' + evil.ref, undefined, { Range: 'bytes=0-9' });
  }).then(function (r) {
    assert.ok(r.status >= 400, 'a redirect to a private address: refused (' + r.status + ')');
    assert.ok(!addon.asked.some(function (a) { return a.indexOf('loop/') === 0; }));
    return call('POST', '/play/sources', { kind: 'movie', tmdbId: 9, imdbId: 'tt0000009', title: 'Big', year: 2020 });
  }).then(function (r) {
    assert.equal(r.status, 200, 'Play still answers');
    assert.ok(!r.json.sources.some(function (s) { return s.plugin === id; }));
    assert.ok((r.json.errors || []).some(function (e) { return /2 MB|larger/.test(e.message); }), JSON.stringify(r.json.errors));
  });
});

test('an add-on with subtitles only: its plugin has that hook alone, and starts', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var subsId;
  return call('POST', '/admin/plugins/managed/stremio/inspect', { input: { url: addon.url('/subs-only/manifest.json') } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    subsId = r.json.id;
    assert.deepEqual(r.json.hooks, ['subtitles.providers']);
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install', {});
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(plugins.get(subsId).state, 'enabled');
    return call('GET', '/subtitles/search?provider=plugin:' + subsId + '&imdb_id=tt0000001&languages=de');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal((r.json.subtitles || r.json)[0].language, 'de');
    return call('DELETE', '/admin/plugins/' + subsId);
  });
});

test('Up next: the sources of the group the last episode played from come first', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var body = { kind: 'movie', tmdbId: 1, imdbId: 'tt0000001', title: 'Film', year: 2020 };
  return call('POST', '/play/sources', body).then(function (r) {
    var a = r.json.sources.filter(function (s) { return s.infoHash === 'a'.repeat(40); })[0];
    assert.equal(a.bingeGroup, 'fake|1080p', 'the add-on\'s bingeGroup on the source');
    assert.notEqual(r.json.sources[0].id, a.id, 'not first on its own');
    return call('POST', '/play/sources', Object.assign({ bingeGroup: 'fake|1080p' }, body));
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.sources[0].infoHash, 'a'.repeat(40), 'first with its group asked');
    assert.ok(r.json.sources[0].badges.indexOf('best') !== -1);
  });
});

test('a film inside a rar of three volumes: played with ranges through the server; 7z dropped', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var src;
  return call('POST', '/play/sources', { kind: 'movie', tmdbId: 2, imdbId: 'tt0000002', title: 'Film', year: 2020 }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var mine = r.json.sources.filter(function (s) { return s.plugin === id; });
    assert.equal(mine.length, 1, '7z: dropped');
    src = mine[0];
    assert.ok(src.notes.some(function (n) { return /rar archive/.test(n); }));
    return call('GET', '/media/' + src.ref, undefined, { Range: 'bytes=100000-210000' });
  }).then(function (r) {
    assert.equal(r.status, 206, r.text.slice(0, 200));
    assert.match(r.headers['content-range'], new RegExp('/' + addon.film.length + '$'), 'the film\'s size, not a volume\'s');
    assert.ok(r.raw.equals(addon.film.subarray(100000, 210001)), 'the film\'s bytes, across two volumes');
    assert.ok(addon.counts['cdn/rar/film.part3.rar'] >= 1, 'every volume\'s headers read');
  });
});

test('Play again: its cached answer (cacheMaxAge), not asked twice', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var before = addon.counts['addon/cfg=SECRET42/stream/movie/tt0000001.json'];
  return call('POST', '/play/sources', { kind: 'movie', tmdbId: 1, imdbId: 'tt0000001', title: 'Film', year: 2020 }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(addon.counts['addon/cfg=SECRET42/stream/movie/tt0000001.json'], before);
  });
});

test('subtitles: its list, languages mapped, a file from the host its answer named', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return call('GET', '/subtitles/search?provider=plugin:' + id + '&imdb_id=tt0000001&languages=fr,en,pt').then(function (r) {
    assert.equal(r.status, 200, r.text);
    var list = r.json.subtitles || r.json;
    assert.deepEqual(list.map(function (s) { return s.lang || s.language; }).slice(0, 3).sort(), ['en', 'fr', 'pt'].sort());
    var fr = list.filter(function (s) { return (s.lang || s.language) === 'fr'; })[0];
    return call('GET', '/subtitles/file?provider=plugin:' + id + '&ref=' + encodeURIComponent(fr.ref || fr.id) + '&lang=fr');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.match(r.text, /^WEBVTT/);
    assert.match(r.text, /Hello \/3\.srt/);
  });
});

test('catalogs: Movies rows (paged, TMDB titles open core pages), pictures through the server', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return data('movieRows', { slot: 'core.movies.rows', context: {} }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var rows = r.json.data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Top films');
    assert.deepEqual(rows[0].page, { data: 'page', args: { key: manifests.catalogKey({ type: 'movie', id: 'top' }), genre: '' } });
    return data('page', { key: rows[0].page.args.key, genre: '', page: 1 });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var items = r.json.data.items;
    assert.equal(items.length, 100);
    assert.equal(r.json.data.last, false);
    assert.deepEqual(items[0].intent, { screen: 'core.movie', params: { id: 5000 } }, 'moviedb_id');
    assert.match(items[0].image, /^images\//, 'through the image proxy');
    return call('GET', '/plugins/' + id + '/' + items[0].image).then(function (img) {
      assert.equal(img.status, 200);
      assert.equal(img.headers['content-type'], 'image/png');
      return data('page', { key: rows0Key(), genre: '', page: 2 });
    });
  }).then(function (r) {
    assert.equal(r.json.data.items.length, 10);
    assert.equal(r.json.data.last, true);
  });
});

function rows0Key() {
  return manifests.catalogKey({ type: 'movie', id: 'top' });
}

test('its section: other catalogs, genre, search; the search chip', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return data('home', {}).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var d = r.json.data;
    assert.deepEqual(d.rows.map(function (x) { return x.title; }), ['Channels']);
    assert.equal(d.search, false, 'Channels can\'t be searched; Top films shows in Movies');
    var card = d.rows[0].items[0];
    assert.deepEqual(card.intent, { screen: 'plugin.' + id + '.title', params: { type: 'channel', id: 'fk:1' } });
    assert.equal(card.variant, 'still', 'landscape');
    return data('searchChip', { slot: 'core.search.filters', context: { query: 'heat' } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.chip.label, 'Fake Add-on');
    assert.equal(r.json.data.rows[0].items[0].title, 'Found heat 900');
  });
});

test('the dashboard\'s Search: its search catalog finds films, the bridged add-ons\' streams for them', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return call('GET', '/search/sources?provider=plugin:' + id + '&q=heat&kind=movie&page=1').then(function (r) {
    assert.equal(r.status, 200, r.text);
    var hit = r.json.items.filter(function (x) { return /Found\.Heat/.test(JSON.stringify(x)); })[0];
    assert.ok(hit, JSON.stringify(r.json).slice(0, 400));
    assert.equal(r.json.hasMore, false);
  });
});

test('title pages of its own ids; a video plays through a play effect', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return data('title', { params: { type: 'channel', id: 'fk:1' } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var d = r.json.data;
    assert.equal(d.info.title, 'Fake Channel');
    assert.match(d.info.backdrop, /^images\//);
    assert.deepEqual(d.rows[0].items.map(function (c) { return c.title; }), ['Second video', 'First video'], 'a channel: newest first');
    var first = d.rows[0].items[1];
    return data(first.call.data, first.call.args);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var effect = r.json.effects[0];
    assert.equal(effect.type, 'play');
    var kinds = effect.request.sources.map(function (s) { return s.kind; });
    assert.ok(kinds.indexOf('embed') !== -1 || kinds.indexOf('http') !== -1, JSON.stringify(effect));
  });
});

test('the add-ons it lists (addon_catalog): offered unticked, installed through the bridge', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return call('GET', '/admin/plugins/' + id + '/stremio/addons').then(function (r) {
    assert.equal(r.status, 200, r.text);
    var subs = r.json.addons.filter(function (a) { return a.name === 'Subs Only'; })[0];
    assert.ok(subs && subs.usable && !subs.checked, JSON.stringify(r.json.addons));
    assert.equal(r.json.addons.filter(function (a) { return a.name === 'Songs'; })[0].usable, false);
    assert.ok(r.text.indexOf('/subs-only/') === -1, 'no address answered');
    return call('POST', '/admin/plugins/managed/stremio/import/' + r.json.session, { keys: [subs.key] });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.installed.length, 1);
    return call('DELETE', '/admin/plugins/' + r.json.installed[0].id);
  });
});

test('placements: the admin hides a catalog, it leaves Movies', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var key = rows0Key();
  return call('GET', '/admin/plugins/' + id + '/settings').then(function (r) {
    assert.equal(r.status, 200, r.text);
    var values = {};
    values[key] = 'hidden';
    return call('PUT', '/admin/plugins/' + id + '/settings', { values: values });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return data('movieRows', { slot: 'core.movies.rows', context: {} });
  }).then(function (r) {
    assert.deepEqual(r.json.data, []);
    var values = {};
    values[key] = 'section';
    return call('PUT', '/admin/plugins/' + id + '/settings', { values: values });
  }).then(function () {
    return data('home', { filters: { genre: ['Comedy'] } });
  }).then(function (r) {
    var d = r.json.data;
    assert.ok(d.filters[0].options.some(function (o) { return o.value === 'Comedy' && o.on; }));
    assert.equal(d.search, true, 'Top films answers searches');
    assert.ok(d.rows.some(function (x) { return x.title === 'Top films' && x.page.args.genre === 'Comedy'; }));
  });
});

test('a new configuration: the same plugin; another add-on refused', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  return call('PUT', '/admin/plugins/' + id + '/managed', { input: { url: addon.url('/cfg=OTHER7/manifest.json') } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.id, id);
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install', {});
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return managed.inputOf(id);
  }).then(function (input) {
    assert.equal(input.url, addon.url('/cfg=OTHER7/manifest.json'));
    return call('POST', '/play/sources', { kind: 'movie', tmdbId: 1, imdbId: 'tt0000001', title: 'Film', year: 2020 });
  }).then(function (r) {
    assert.ok(addon.counts['addon/cfg=OTHER7/stream/movie/tt0000001.json'] >= 1, 'asked at its new address');
    assert.ok(r.json.sources.some(function (s) { return s.plugin === id; }));
  });
});

test('the add-on\'s update: Check for updates shows it; removal forgets it', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  addon.version.value = '1.3.0';
  return call('POST', '/admin/plugins/' + id + '/managed/check').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.change, 'update');
    assert.equal(r.json.version, '1.3.0');
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install', {});
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(plugins.get(id).manifest.version, '1.3.0');
    return call('DELETE', '/admin/plugins/' + id);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.ok(!plugins.get(id));
  });
});

test('Import from Stremio: the account\'s add-ons (no address answered), the chosen ones installed, signed out', function (t) {
  if (skip) {
    return t.skip('no openssl');
  }
  var session;
  return call('POST', '/admin/plugins/managed/stremio/import', { email: 'stremio@example.test', password: 'wrong' }).then(function (r) {
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /password is wrong/);
    return call('POST', '/admin/plugins/managed/stremio/import', { email: 'stremio@example.test', password: 'right-pass' });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.indexOf('IMPORTED9') === -1 && r.text.indexOf('right-pass') === -1, 'no address, no password in the answer');
    assert.ok(r.text.indexOf('auth-123') === -1, 'no Stremio session');
    session = r.json.session;
    var by = {};
    r.json.addons.forEach(function (a) { by[a.name] = a; });
    assert.equal(by['Fake Add-on'].checked, true);
    assert.equal(by['Fake Add-on'].configured, true);
    assert.equal(by['Fake Add-on'].offers.play, true);
    assert.equal(by['Subs Only'].checked, true);
    assert.equal(by.Cinemeta.checked, false, 'Stremio\'s own: unticked');
    assert.equal(by.Cinemeta.usable, true);
    assert.equal(by['Local Files'].usable, false, 'on that computer');
    assert.equal(by.Songs.usable, false, 'nothing Playpex uses');
    assert.equal(addon.account.loggedOut >= 1, true, 'signed out at once');
    return call('POST', '/admin/plugins/managed/stremio/import/' + session, { keys: [by['Fake Add-on'].key, by['Subs Only'].key] });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.failed, []);
    assert.equal(r.json.installed.length, 2);
    r.json.installed.forEach(function (x) { assert.equal(plugins.get(x.id).state, 'enabled'); });
    return Promise.all([managed.inputOf(r.json.installed[0].id), call('POST', '/admin/plugins/managed/stremio/import/' + session, { keys: ['a0'] })]);
  }).then(function (r) {
    assert.equal(r[0].url, addon.url('/cfg=IMPORTED9/manifest.json'), 'its configured address kept as its secret');
    assert.equal(r[1].status, 404, 'an import session is used once');
  });
});
