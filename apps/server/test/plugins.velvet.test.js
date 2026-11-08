'use strict';

// The 18+ plugin Velvet (plugins/velvet, docs/plugins-plan.md step P5). Two parts:
//   • its server.js in Node with a stub `playpex` and canned answers of TMDB,
//     The Pirate Bay and TheRARBG (no network): every screen's answer against
//     the template schemas, the layout switch, title torrents matched and ranked,
//     plays with tracking none, the search chip;
//   • Sex-Empire (a streaming site, setting sexEmpire) with canned pages: its
//     rows, a film's page, its players read (VidHide's packed script, DoodStream's
//     pass_md5) as hls / http sources on declared hosts only, and its streams
//     with a catalog film's torrents;
//   • loaded by a real server from its folder (developer copy): listed for an
//     adult profile, never for a kids one, and its section showing the site's
//     films without a catalog key.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  vm = require('vm');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugin-velvet-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  schemas = require('../lib/plugins/schemas');

var DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'velvet'),
  HASH_A = 'a'.repeat(40), HASH_B = 'b'.repeat(40), HASH_C = 'c'.repeat(40), HASH_D = 'd'.repeat(40);

// ── the plugin in Node ──────────────────────────────────────────────────────

var TMDB_ITEM = { id: 1, adult: true, title: 'Heatwave', release_date: '2025-03-01', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
  vote_average: 7.2, vote_count: 10, overview: 'A film.' };

var SCENE = { id: 'uuid-1', _id: 501, title: 'Marie in the Garden', date: '2024-03-15', description: 'A scene.',
  image: 'https://img.example/s1.jpg', background: { large: 'https://img.example/b1.jpg' },
  site: { id: 9001, name: 'Ersties', short_name: 'ersties' }, performers: [{ name: 'Marie H' }], duration: 1800 };

function answer(url, o) {
  var u = new URL(url), q = u.searchParams;
  if (u.hostname === 'api.theporndb.net') {
    if (u.pathname === '/sites') {
      return { data: /ersties/i.test(q.get('q')) ? [{ id: 9002, name: 'Ersties Archive', short_name: 'erstiesarchive' }, { id: 9001, name: 'Ersties', short_name: 'ersties' }] : [] };
    }
    if (u.pathname === '/scenes') {
      return { data: [SCENE, Object.assign({}, SCENE, { id: 'uuid-2', image: null, background: null, posters: null })], meta: { current_page: 1, last_page: 2 } };
    }
    if (u.pathname === '/movies') {
      return { data: [{ id: 7, title: 'Marie the Film', date: '2020-01-01', image: 'https://img.example/m.jpg', site: { id: 92, name: 'Brazzers' } }], meta: { current_page: 1, last_page: 1 } };
    }
    if (u.pathname === '/scenes/uuid-1') {
      return { data: SCENE };
    }
  }
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
    if (u.pathname === '/q.php' && /ersties/i.test(q.get('q'))) {
      return [
        { name: 'Ersties.24.03.15.Marie.H.XXX.1080p.MP4', info_hash: HASH_A, seeders: '40', leechers: '2', size: '900', category: '505' },
        { name: 'Ersties.23.01.01.Other.Girl.XXX.720p.MP4', info_hash: HASH_B, seeders: '80', leechers: '2', size: '700', category: '505' },
        { name: 'OtherSite.24.03.15.Marie.H.XXX.1080p', info_hash: HASH_D, seeders: '90', leechers: '2', size: '800', category: '505' }
      ];
    }
    if (u.pathname === '/q.php') {
      return [
        { name: 'Heatwave [Vixen 2025] XXX 1080p MP4-P2P', info_hash: HASH_A.toUpperCase(), seeders: '50', leechers: '5', size: '2000', category: '505', added: '1760000000' },
        { name: 'Heatwave 2 [Vixen 2025] XXX 1080p', info_hash: HASH_B, seeders: '90', leechers: '1', size: '2000', category: '505' },
        { name: 'Heatwave [Vixen 2025] DVDR', info_hash: HASH_D, seeders: '9', leechers: '1', size: '9000', category: '502' }
      ];
    }
    return [{ name: 'Top film [Studio 2024] XXX 2160p x265', info_hash: HASH_D, seeders: '300', leechers: '10', size: '5000', category: '507' }];
  }
  if (/therarbg/.test(u.hostname) && /ersties/i.test(u.pathname)) {
    return { results: [{ n: 'Ersties - Marie H - Marie in the Garden 1080p', h: HASH_C, se: '10', le: '1', s: '600', c: 'XXX' }], links: { next: null } };
  }
  if (/therarbg/.test(u.hostname)) {
    return { results: [{ n: 'Heatwave.2025.720p.AAC', h: HASH_C, se: '20', le: '2', s: '1000', c: 'XXX', a: 1760000000 },
      { n: 'Some.Show.S01E01', h: HASH_B, se: '99', s: '1', c: 'TV' }], links: { next: null } };
  }
  if (/^(sex-empere\.org|morencius\.com|playmogo\.com|hgcloud\.to)$/.test(u.hostname)) {
    return site(u, o || {});
  }
  if (/^(thesextube\.net|luluvido\.com|luluvdoo\.com)$/.test(u.hostname)) {
    return tube(u);
  }
  return null;
}

// ── Sex-Empire's pages, canned ──────────────────────────────────────────────

// Dean Edwards' packer, as the video host's page has it (radix 36)
function pack(code) {
  var words = [], index = {};
  var payload = code.replace(/\b\w+\b/g, function (w) {
    if (!(w in index)) { index[w] = words.length; words.push(w); }
    return index[w].toString(36);
  });
  return 'eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp(\'\\\\b\'+c.toString(a)+\'\\\\b\',\'g\'),k[c]);return p}(\'' +
    payload.replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\',36,' + words.length + ',\'' + words.join('|') + '\'.split(\'|\')))';
}

var SE_FILMS = {
  '11855': { title: 'Harem', year: 1999, embeds: ['https://morencius.com/embed/vzyu721zfuyc?adfree=1', 'https://hgcloud.to/e/66c5370ypi83',
    'https://morencius.com/embed/', 'https://playmogo.com/e/ujgsm0bntcey'] },
  '20001': { title: 'Heatwave', year: 2025, embeds: ['https://morencius.com/embed/heatwave0001', 'https://playmogo.com/e/captcha00001'] },
  '20002': { title: 'Heatwave 2', year: 2025, embeds: ['https://playmogo.com/e/ujgsm0bntcey'] }
};
// a search with 30 results (two pages of the site's)
for (var n = 0; n < 30; n++) {
  SE_FILMS[String(30000 + n)] = { title: 'Many ' + n, year: 2020, embeds: [] };
}

// a listing's film: English titles on /en/ pages
function card(id) {
  var f = SE_FILMS[id];
  return '<a class="item item-poster grid-item" href="https://sex-empere.org/en/movies/hd-porno-movies/' + id + '-x.html">' +
    '<div class="item-poster__img"><img src="https://sex-empire.org/uploads/' + id + '.webp" loading="lazy" alt=""></div>' +
    '<div class="item-poster__title ws-nowrap">' + f.title + '</div><div class="item-poster__meta ws-nowrap">' + f.year + ' &nbsp;&bull;&nbsp; HD 720p</div></a>';
}

function filmPage(id) {
  var f = SE_FILMS[id];
  return '<meta property="og:image" content="https://sex-empire.org/uploads/' + id + '.webp"><h1 class="flex-grow-1">' + f.title + '</h1>' +
    '<div class="item__rating">\n720P\n</div><a onclick="doRate(\'plus\', \'' + id + '\'); return false;"></a><ul class="pmovie__list">' +
    '<li><span>Genre:</span> <a href="#">All Sex</a>, <a href="#">Feature</a></li><li><span>Country:</span>\n\nItaly\n</li>' +
    '<li><span>Release year:</span> <a href="#">' + f.year + '</a></a></li><li><span>Duration:</span> 01:20:11</li>' +
    '<li><span>Directed by:</span> <a href="#">Luca Damiano</a></li><li><span>Casting:</span> <a href="#">Jeanette la Douce</a>, <a href="#">Lady Rox</a></li>' +
    '<li><span>Language:</span>\n\nRussian\n\n, Original\n</li></ul>' +
    f.embeds.map(function (e) { return '<script>var s2 = document.createElement("iframe");s2.src  = "' + e + '";</script>'; }).join('');
}

var VIDHIDE = {
  vzyu721zfuyc: { hls2: 'https://VyY3AyGtEHNQnhdR.acek-cdn.com/hls2/01/08780/vzyu721zfuyc_,l,n,.urlset/master.m3u8?t=tok&s=1',
    hls3: 'https://pfabi.starlakecreativeworks.sbs/x/hls3/01/master.txt', hls4: '/stream/abc/master.m3u8' },
  // its hls2 on a CDN the plugin doesn't know: the relative hls4 (the embed's own host)
  heatwave0001: { hls2: 'https://x.unknown-cdn.example/hls2/master.m3u8', hls4: '/stream/heat/master.m3u8' }
};

function site(u, o) {
  var q = u.searchParams, id;
  if (u.hostname === 'sex-empere.org') {
    // the search: the form's POST to /en/
    var form = o.method === 'POST' ? new URLSearchParams(String(o.body || '')) : null;
    if (u.pathname === '/en/' && form && form.get('do') === 'search') {
      assert.equal(o.headers['Content-Type'], 'application/x-www-form-urlencoded');
      var story = form.get('story'), start = Number(form.get('search_start') || 1);
      if (/many/i.test(story)) {
        // 30 results: 24 on the first page, 6 on the second
        var ids = Object.keys(SE_FILMS).filter(function (k) { return /^3/.test(k); });
        return 'Found 30 responses (Query results) ' + ids.slice((start - 1) * 24, start * 24).map(card).join('');
      }
      return /heatwave/i.test(story) ? 'Found 2 responses ' + card('20002') + card('20001') : /harem/i.test(story) ? 'Found 1 responses ' + card('11855') : '<p>nothing</p>';
    }
    if (u.pathname === '/en/' || u.pathname === '/en/page/2/') {
      return u.pathname === '/en/' ? card('11855') + card('20001') + card('11855') : '';
    }
    if ((id = (/^\/en\/(\d+)-x\.html$/.exec(u.pathname) || [])[1]) && SE_FILMS[id]) {
      return filmPage(id);
    }
    return null;
  }
  if (u.hostname === 'morencius.com' && (id = (/^\/embed\/(\w+)$/.exec(u.pathname) || [])[1]) && VIDHIDE[id]) {
    return '<html><script>' + pack('var links=' + JSON.stringify(VIDHIDE[id]) + ';jwplayer("vplayer").setup({sources:[{file:links.hls4||links.hls3||links.hls2,type:"hls"}]});') + '</script></html>';
  }
  if (u.hostname === 'playmogo.com') {
    if (u.pathname === '/e/ujgsm0bntcey') {
      return '<script>$.get(\'/pass_md5/288165842-102-173/8c42v06geavw2ilz77tkanuj\', function (data) {});' +
        'function makePlay() { return a + "?token=8c42v06geavw2ilz77tkanuj&expiry=" + Date.now(); }</script>';
    }
    if (u.pathname === '/e/captcha00001') {
      return '<div class="captcha-player"></div>';
    }
    if (u.pathname === '/pass_md5/288165842-102-173/8c42v06geavw2ilz77tkanuj') {
      return 'https://tr232gd.cloudatacdn.com/u5kj7l3bexp3/tyd949144t~\n';
    }
  }
  return null;
}

// ── TheSexTube's API and LuluStream, canned ─────────────────────────────────

var STUDIO_TAGS = [4599, 15789, 4175], PERSONAL_TAGS = [5777, 23028, 16894, 17619, 17798, 3045, 17039, 18377, 3787, 25310, 5761, 3409, 30034, 18337, 3668, 29748, 5008];

function post(id, title, tags, link, date) {
  return { id: id, date: date || '2026-11-0' + (id % 9 + 1) + 'T04:51:51', title: { rendered: title }, tags: tags,
    content: { rendered: '<p>A scene.</p>' + (link ? '<a id="music" href="' + link + '" target="_blank">Streaming Video From LuLustream</a>' : '') } };
}

var TUBE_POSTS = [
  post(101, 'Ersties &#8211; Hood Up, Panties Down', [4599], 'https://luluvido.com/bot2836bqoj0'),
  post(102, 'Easy Like Sunday Morning &#8211; Ceci &#038; Hans &#8211; Lustery', [15789], 'https://luluvdoo.com/abcdefgh12'),
  // a photo set: no video
  post(103, 'Franziska Distler in Playboy set', [4175], null),
  // the API should never answer these two (their tags are excluded, the title names a leak): dropped anyway
  post(104, 'Someone at home', [4599, 5777], 'https://luluvido.com/leak0000001'),
  post(105, 'Playboy Plus &#8211; Ally PPV video leaked', [4175], 'https://luluvido.com/leak0000002'),
  post(106, 'Ersties &#8211; Marie in the Garden', [4599], 'https://luluvido.com/marie0000001')
];
// personal: tagged onlyfans, never a studio
var PERSONAL_POST = post(720618, 'Someone fucks husband video leaked', [5777, 30480], 'https://luluvido.com/leak0000003');

var LULU = {
  bot2836bqoj0: 'https://vbrsoy9wvjcw.tnmr.org/hls2/01/04657/bot2836bqoj0_h/master.m3u8?t=tok&s=1',
  marie0000001: 'https://x1.cdn-tnmr.org/hls2/02/1/marie0000001_h/master.m3u8?t=tok',
  // a CDN the plugin doesn't know: not taken
  abcdefgh12: 'https://x.unknown-cdn.example/master.m3u8',
  leak0000001: 'https://x.tnmr.org/leak1.m3u8', leak0000002: 'https://x.tnmr.org/leak2.m3u8', leak0000003: 'https://x.tnmr.org/leak3.m3u8'
};

function tube(u) {
  var q = u.searchParams, m;
  if (u.hostname === 'thesextube.net') {
    if (u.pathname === '/wp-json/wp/v2/posts') {
      assert.equal(q.get('tags'), q.get('tags').split(',').filter(function (t) { return STUDIO_TAGS.indexOf(Number(t)) !== -1; }).join(','), 'studio tags only');
      assert.equal(q.get('tags_exclude'), PERSONAL_TAGS.join(','), 'every personal tag excluded');
      var tags = q.get('tags').split(',').map(Number), words = (q.get('search') || '').toLowerCase();
      var list = TUBE_POSTS.filter(function (x) {
        return x.tags.some(function (t) { return tags.indexOf(t) !== -1; }) && (!words || x.title.rendered.toLowerCase().indexOf(words) !== -1);
      });
      // past the last page WordPress answers 400 (rest_post_invalid_page_number)
      return Number(q.get('page')) > 1 ? { httpStatus: 400, body: '{"code":"rest_post_invalid_page_number"}' } : JSON.stringify(list);
    }
    if ((m = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(u.pathname))) {
      var one = TUBE_POSTS.concat([PERSONAL_POST]).filter(function (x) { return String(x.id) === m[1]; })[0];
      return one ? JSON.stringify(one) : null;
    }
    return null;
  }
  m = /^\/(\w+)$/.exec(u.pathname);
  return m && LULU[m[1]] ? '<html><script>' + pack('jwplayer("vplayer").setup({sources:[{file:"' + LULU[m[1]] + '"}],duration:"410.16"});') + '</script></html>' : null;
}

function load() {
  // the site off unless a test switches it on: the tests above it are about the catalog and the torrents
  var handlers = {}, secrets = {}, settings = { sexEmpire: false, theSexTube: false }, store = {}, requests = [];
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
        var body = answer(o.url, o);
        // { httpStatus, body }: an answer other than 200
        if (body && typeof body === 'object' && body.httpStatus) return Promise.resolve({ status: body.httpStatus, headers: {}, body: body.body });
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

// the plugin's User-Agent: video hosts' tokens hold for the one that read the page
var BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

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
    assert.deepEqual(r.data.items[0].intent, { screen: 'plugin.velvet.title', params: { provider: 'tmdb', id: '1' } });
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
    assert.deepEqual(r.data.rows[0].items[0].intent, { screen: 'plugin.velvet.find', params: { q: 'Jane Doe' } });
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
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.velvet.releases', replace: true });
    assert.equal(p.store['layout:p1'], 'list');
    return Promise.all([p.handlers.browse({}, CTX), p.handlers.releases({ params: {}, filters: {}, page: 1 }, CTX)]);
  }).then(function (r) {
    assert.equal(r[0].effects[0].intent.screen, 'plugin.velvet.releases', 'the section opens the list now');
    valid('templates/properties/releases', r[1].data);
    assert.equal(r[1].effects, undefined);
    assert.deepEqual(r[1].data.releases.map(function (x) { return x.title; }), ['Top film'], 'The Pirate Bay\'s top 100 by default');
    assert.equal(r[1].data.filters[0].key, 'view');
    return p.handlers.releases({ params: {}, filters: { view: ['posters'] } }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.velvet.browse', replace: true });
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
    // then its torrents for the words: the find screen
    assert.deepEqual(r[0].data.rows[1].items[0].intent, { screen: 'plugin.velvet.find', params: { q: 'heat' } });
    assert.deepEqual(r[1].data.rows, [], 'not under 3 characters');
  });
});

test('scenes: rows of the followed studios, a scene page, its torrents by studio and date', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  p.secrets.theporndbApiKey = 't';
  p.settings.sceneStudios = 'Ersties, Nobody Here';
  return p.handlers.browse({}, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    var titles = r.data.rows.map(function (row) { return row.title; });
    assert.deepEqual(titles.slice(-2), ['New scenes', 'Ersties'], 'after the films: new scenes, then the followed studio (found by its exact name)');
    assert.equal(r.data.rows[r.data.rows.length - 1].page.args.row, 'studio:9001');
    var latest = r.data.rows[r.data.rows.length - 2].page.args;
    assert.deepEqual([latest.row, latest.studios], ['latest', '9001'], 'new scenes: from the followed studios');
    return p.handlers.rowPage(Object.assign({ page: 1 }, latest), CTX).then(function (page) {
      valid('rowPage', page.data);
      assert.equal(page.data.items.length, 1, 'merged by date, once each');
      assert.ok(p.requests.some(function (q) { return /\/scenes\?.*site_id=9001/.test(q.url); }), 'asked per studio, never across all of them');
      return p.handlers.browse({}, CTX);
    });
  }).then(function (r) {
    assert.deepEqual(r.data.filters.map(function (f) { return f.key; }), ['view', 'kind', 'studio', 'period']);
    return p.handlers.browse({ filters: { kind: ['scenes'] } }, CTX);
  }).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.equal(r.data.rows[0].title, 'New scenes', 'only scenes');
    assert.ok(r.data.rows.every(function (row) { return row.page.args.provider === 'scenes' && row.variant === 'still'; }));
    assert.equal(r.data.filters[2].options[0].label, 'Ersties', 'the followed studio first');
    return p.handlers.rowPage({ provider: 'scenes', row: 'studio:9001', page: 1 }, CTX);
  }).then(function (r) {
    valid('rowPage', r.data);
    assert.equal(r.data.items.length, 1, 'scenes without a picture are left out');
    assert.equal(r.data.items[0].variant, 'still');
    assert.equal(r.data.items[0].image, 'https://img.example/b1.jpg');
    assert.equal(r.data.items[0].subtitle, 'Ersties, 2024-03-15');
    return p.handlers.title({ params: { provider: 'scenes', id: 'uuid-1' } }, CTX);
  }).then(function (r) {
    valid('templates/properties/title', r.data);
    assert.equal(r.data.info.eyebrow, 'Ersties');
    assert.equal(r.data.info.meta[0].text, '2024-03-15');
    assert.deepEqual(r.data.actions[1].intent.params, { q: 'Ersties 24 03 15' }, 'releases are named by studio and date');
    assert.equal(r.data.rows[1].page.args.row, 'studio:9001', 'more from its studio');
    return p.handlers.play({ provider: 'scenes', id: 'uuid-1' }, CTX);
  }).then(function (r) {
    var sources = r.effects[0].request.sources.map(function (x) { return x.label; });
    assert.deepEqual(sources, ['Ersties.24.03.15.Marie.H.XXX.1080p.MP4', 'Ersties - Marie H - Marie in the Garden 1080p'],
      'its date first, then its performer; another scene of the studio and another studio are not it');
    assert.equal(r.effects[0].request.tracking, 'none');
  });
});

test('with only the ThePornDB key: films and scenes both from it, and the search chip finds both', function () {
  var p = load();
  p.secrets.theporndbApiKey = 't';
  p.settings.metadataProvider = 'theporndb';
  return Promise.all([p.handlers.browse({}, CTX), p.handlers.searchFilter({ slot: 'core.search.filters', context: { query: 'marie' } }, CTX)]).then(function (r) {
    valid('templates/properties/catalog', r[0].data);
    valid('slots/searchFilter', r[1].data);
    assert.ok(r[0].data.rows.some(function (row) { return row.page.args.provider === 'scenes'; }));
    assert.deepEqual(r[1].data.rows.map(function (row) { return row.title; }), ['Films', 'Scenes', 'Releases']);
  });
});

// ── Sex-Empire ──────────────────────────────────────────────────────────────

function hosts(p) {
  return p.requests.map(function (o) { return new URL(o.url).hostname; });
}

test('Sex-Empire without a catalog key: its newest films, its search with English titles, a film page', function () {
  var p = load();
  p.settings.sexEmpire = true;
  return p.handlers.browse({}, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.deepEqual(r.data.rows.map(function (row) { return row.title; }), ['New on Sex-Empire']);
    assert.equal(r.data.search, true);
    return Promise.all([
      p.handlers.rowPage(Object.assign({ page: 1 }, r.data.rows[0].page.args), CTX),
      p.handlers.rowPage({ provider: 'sexempire', q: 'harem', page: 1 }, CTX),
      p.handlers.browse({ query: 'harem' }, CTX)
    ]);
  }).then(function (r) {
    valid('rowPage', r[0].data);
    assert.deepEqual(r[0].data.items.map(function (c) { return c.title; }), ['Harem', 'Heatwave'], 'the listing\'s films, once each');
    assert.equal(r[0].data.items[0].image, 'https://sex-empire.org/uploads/11855.webp');
    assert.deepEqual(r[0].data.items[0].intent, { screen: 'plugin.velvet.title', params: { provider: 'sexempire', id: '11855' } });
    valid('rowPage', r[1].data);
    assert.deepEqual(r[1].data.items.map(function (c) { return c.title; }), ['Harem']);
    assert.ok(!p.requests.some(function (o) { return /\/en\/\d+-x\.html$/.test(o.url); }), 'a list reads no film\'s page');
    assert.equal(r[1].data.last, true);
    assert.deepEqual(r[2].data.rows.map(function (row) { return row.title; }), ['Sex-Empire for “harem”']);
    return p.handlers.title({ params: { provider: 'sexempire', id: '11855' } }, CTX);
  }).then(function (r) {
    valid('templates/properties/title', r.data);
    assert.equal(r.data.info.title, 'Harem');
    assert.equal(r.data.info.eyebrow, 'Sex-Empire');
    assert.ok(r.data.info.meta.some(function (m) { return m.text === '80 min'; }));
    assert.deepEqual(r.data.info.credits, [{ label: 'Starring', names: ['Jeanette la Douce', 'Lady Rox'] }, { label: 'Director', names: ['Luca Damiano'] }]);
    assert.deepEqual(r.data.actions[0].call, { data: 'play', args: { provider: 'sexempire', id: '11855' } });
  });
});

test('Sex-Empire Play: VidHide\'s HLS and DoodStream\'s MP4 on declared hosts, players it can\'t read never asked', function () {
  var p = load();
  p.settings.sexEmpire = true;
  return p.handlers.play({ provider: 'sexempire', id: '11855' }, CTX).then(function (r) {
    valid('effect', r.effects[0]);
    var req = r.effects[0].request, s = req.sources;
    assert.equal(req.tracking, 'none');
    assert.deepEqual(s.map(function (x) { return x.kind; }), ['hls', 'http']);
    assert.equal(s[0].url, VIDHIDE.vzyu721zfuyc.hls2, 'hls2 (a known CDN), not hls3\'s throwaway domain');
    assert.deepEqual(s[0].headers, { 'User-Agent': BROWSER, Referer: 'https://morencius.com/' }, 'the User-Agent the page was read with');
    assert.equal(s[0].label, 'Harem (1999) · VidHide');
    assert.equal(s[0].quality, '720p');
    assert.deepEqual(s[0].notes, ['Sex-Empire', 'Audio: Russian, Original']);
    assert.match(s[1].url, /^https:\/\/tr232gd\.cloudatacdn\.com\/u5kj7l3bexp3\/tyd949144t~[A-Za-z0-9]{10}\?token=8c42v06geavw2ilz77tkanuj&expiry=\d+$/);
    assert.deepEqual(s[1].headers, { 'User-Agent': BROWSER, Referer: 'https://playmogo.com/' });
    var asked = hosts(p);
    assert.ok(asked.indexOf('hgcloud.to') === -1, 'a host it can\'t read is skipped');
    assert.equal(p.requests.filter(function (o) { return o.url === 'https://morencius.com/embed/'; }).length, 0, 'an empty player slot is skipped');
    var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'playpex-plugin.json'), 'utf8'));
    s.concat(p.requests).forEach(function (x) {
      var host = new URL(x.url).hostname.toLowerCase();
      assert.ok(manifest.permissions.network.some(function (n) { return n === host || (n.slice(0, 2) === '*.' && host.endsWith(n.slice(1))); }), host + ' declared');
    });
  });
});

test('Play of a catalog film: the same film on Sex-Empire (not its sequel) first, then the torrents; a captcha skipped', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  p.settings.sexEmpire = true;
  return p.handlers.play({ provider: 'tmdb', id: '1' }, CTX).then(function (r) {
    valid('effect', r.effects[0]);
    var s = r.effects[0].request.sources;
    assert.deepEqual(s.map(function (x) { return x.kind; }), ['hls', 'magnet', 'magnet'], 'DoodStream asked for a captcha');
    assert.equal(s[0].url, 'https://morencius.com/stream/heat/master.m3u8', 'hls2 on an unknown CDN: the relative hls4');
    assert.equal(s[0].label, 'Heatwave (2025) · VidHide');
    p.settings.sexEmpire = false;
    p.requests.length = 0;
    return p.handlers.play({ provider: 'tmdb', id: '1' }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.effects[0].request.sources.map(function (x) { return x.kind; }), ['magnet', 'magnet']);
    assert.ok(hosts(p).indexOf('sex-empere.org') === -1, 'switched off: never asked');
  });
});

test('Find releases: Sex-Empire as a source of direct links, paged; a link played through the plugin', function () {
  var p = load();
  p.settings.sexEmpire = true;
  return p.handlers.releases({ params: { q: 'harem' }, filters: { source: ['sexempire'] }, page: 1 }, CTX).then(function (r) {
    valid('templates/properties/releases', r.data);
    var source = r.data.filters.filter(function (g) { return g.key === 'source'; })[0];
    assert.deepEqual(source.options.map(function (o) { return o.label; }), ['The Pirate Bay', 'TheRARBG', 'Sex-Empire (direct links)']);
    assert.equal(source.options[2].on, true);
    assert.equal(r.data.title, 'Direct links for “harem”');
    assert.deepEqual(r.data.releases, [{ title: 'Harem (1999)', call: { data: 'play', args: { provider: 'sexempire', id: '11855' } }, via: 'Sex-Empire',
      notes: [], quality: '720p' }]);
    assert.equal(r.data.last, true);
    // the link's call is the play handler: its players resolved now
    return p.handlers[r.data.releases[0].call.data](r.data.releases[0].call.args, CTX);
  }).then(function (r) {
    valid('effect', r.effects[0]);
    assert.deepEqual(r.effects[0].request.sources.map(function (x) { return x.kind; }), ['hls', 'http']);
    return Promise.all([1, 2].map(function (page) {
      return p.handlers.releases({ params: { q: 'many' }, filters: { source: ['sexempire'] }, page: page }, CTX);
    }));
  }).then(function (pages) {
    assert.deepEqual(pages.map(function (x) { return x.data.releases.length; }), [24, 6], 'the site\'s pages');
    assert.deepEqual(pages.map(function (x) { return x.data.last; }), [false, true]);
    var titles = [].concat.apply([], pages.map(function (x) { return x.data.releases.map(function (y) { return y.title; }); }));
    assert.equal(new Set(titles).size, 30, 'each once');
    assert.equal(titles[24], 'Many 24 (2020)', 'the second page after the first');
    return Promise.all([
      p.handlers.releases({ params: { q: 'harem' }, filters: { source: ['sexempire'], quality: ['1080p'] }, page: 1 }, CTX),
      p.handlers.releases({ params: {}, filters: { source: ['sexempire'] }, page: 1 }, CTX)
    ]);
  }).then(function (r) {
    assert.deepEqual(r[0].data.releases, [], 'the quality filter');
    assert.equal(r[1].data.title, 'New on Sex-Empire', 'no words: its newest films');
    assert.deepEqual(r[1].data.releases.map(function (x) { return x.title; }), ['Harem (1999)', 'Heatwave (2025)']);
    p.settings.sexEmpire = false;
    return p.handlers.releases({ params: { q: 'harem' }, filters: { source: ['sexempire'] }, page: 1 }, CTX);
  }).then(function (r) {
    var source = r.data.filters.filter(function (g) { return g.key === 'source'; })[0];
    assert.deepEqual(source.options.map(function (o) { return o.value; }), ['piratebay', 'therarbg'], 'switched off: not offered');
    assert.ok(r.data.releases.every(function (x) { return x.magnet; }), 'torrents from the default source');
  });
});

test('TheSexTube: its studios\' videos only, as direct links; a personal post never plays, even by id', function () {
  var p = load();
  p.settings.theSexTube = true;
  return p.handlers.releases({ params: {}, filters: { source: ['thesextube'] }, page: 1 }, CTX).then(function (r) {
    valid('templates/properties/releases', r.data);
    var source = r.data.filters.filter(function (g) { return g.key === 'source'; })[0];
    assert.deepEqual(source.options.map(function (o) { return o.value; }), ['piratebay', 'therarbg', 'thesextube']);
    assert.equal(r.data.title, 'New from the studios');
    assert.deepEqual(r.data.releases.map(function (x) { return x.title; }),
      ['Ersties – Hood Up, Panties Down', 'Easy Like Sunday Morning – Ceci & Hans – Lustery', 'Ersties – Marie in the Garden'],
      'no photo set, no personal post (by tag or by title) even when the site answers one');
    assert.deepEqual(r.data.releases[0], { title: 'Ersties – Hood Up, Panties Down', call: { data: 'play', args: { provider: 'thesextube', id: '101' } },
      via: 'Ersties', notes: ['TheSexTube'], uploadedAt: '2026-11-03T00:00:00Z' });
    return Promise.all(['101', '102', '104', '105', '720618', '999', '../users'].map(function (id) {
      return p.handlers.play({ provider: 'thesextube', id: id }, CTX);
    }));
  }).then(function (r) {
    valid('effect', r[0].effects[0]);
    var req = r[0].effects[0].request;
    assert.equal(req.tracking, 'none');
    assert.equal(req.subtitle, 'Ersties');
    assert.deepEqual(req.artwork, { backdrop: 'https://img.lulucdn.com/bot2836bqoj0_xt.jpg' });
    assert.deepEqual(req.sources.map(function (x) { return [x.kind, x.url, x.headers.Referer]; }), [['hls', LULU.bot2836bqoj0, 'https://luluvido.com/']]);
    assert.equal(req.sources[0].headers['User-Agent'], BROWSER, 'its CDN\'s token holds for that User-Agent only');
    assert.equal(r[1].effects[0].text, 'This video can\'t be played now', 'a CDN it doesn\'t know');
    r.slice(2).forEach(function (x) {
      assert.deepEqual(x.effects, [{ type: 'toast', tone: 'info', text: 'This video isn\'t available' }]);
    });
    assert.ok(!p.requests.some(function (o) { return /leak/.test(o.url); }), 'a personal post\'s video is never fetched');
    return p.handlers.releases({ params: { q: 'hood' }, filters: { source: ['thesextube'] }, page: 1 }, CTX);
  }).then(function (r) {
    assert.equal(r.data.title, 'Studio videos for “hood”');
    assert.deepEqual(r.data.releases.map(function (x) { return x.call.args.id; }), ['101']);
    return p.handlers.releases({ params: {}, filters: { source: ['thesextube'] }, page: 2 }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.data.releases, [], 'past the last page');
    assert.equal(r.data.last, true);
    p.settings.theSexTube = false;
    return Promise.all([
      p.handlers.releases({ params: {}, filters: { source: ['thesextube'] }, page: 1 }, CTX),
      p.handlers.play({ provider: 'thesextube', id: '101' }, CTX)
    ]);
  }).then(function (r) {
    assert.ok(!r[0].data.filters.filter(function (g) { return g.key === 'source'; })[0].options.some(function (o) { return o.value === 'thesextube'; }));
    assert.equal(r[1].effects[0].text, 'This video isn\'t available', 'switched off');
  });
});

test('a studio\'s scene (the second provider\'s): its TheSexTube video first, then the torrents', function () {
  var p = load();
  p.secrets.theporndbApiKey = 't';
  p.settings.theSexTube = true;
  return p.handlers.play({ provider: 'scenes', id: 'uuid-1' }, CTX).then(function (r) {
    valid('effect', r.effects[0]);
    var s = r.effects[0].request.sources;
    assert.equal(s[0].kind, 'hls');
    assert.equal(s[0].url, LULU.marie0000001);
    assert.deepEqual(s[0].notes, ['Ersties', 'TheSexTube', '2026-11-08']);
    assert.ok(s.slice(1).every(function (x) { return x.kind === 'magnet'; }) && s.length > 1);
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

test('on a real server: for adult profiles only; without a key, the site\'s films', function () {
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
        return list.json.plugins.some(function (p) { return p.id === 'velvet'; }) || Date.now() > until ? r :
          new Promise(function (ok) { setTimeout(ok, 100); }).then(poll);
      });
    })();
  }).then(function (r) {
    adult = r[0].json.id;
    kid = r[1].json.id;
    return Promise.all([
      call('GET', '/plugins?profile=' + adult),
      call('GET', '/plugins?profile=' + kid),
      call('POST', '/plugins/velvet/data/browse?profile=' + adult, { args: {} }),
      call('POST', '/plugins/velvet/data/browse?profile=' + kid, { args: {} })
    ]);
  }).then(function (r) {
    var mine = r[0].json.plugins.filter(function (p) { return p.id === 'velvet'; })[0];
    assert.ok(mine, 'listed for an adult profile');
    assert.equal(mine.audience, 'adults');
    assert.deepEqual(mine.screens.map(function (s) { return s.name; }), ['browse', 'title', 'releases', 'find']);
    assert.equal(mine.sections[0].menu.label, '18+');
    assert.ok(!r[1].json.plugins.some(function (p) { return p.id === 'velvet'; }), 'never for a kids profile');
    assert.equal(r[2].status, 200, r[2].text);
    // no catalog key, the site on by default: its newest films (fetched when the row pages in)
    assert.deepEqual(r[2].json.data.rows.map(function (row) { return row.title; }), ['New on Sex-Empire']);
    assert.equal(r[3].status, 403);
  }).finally(function () {
    return server.stop().then(function () { fs.rmSync(tmp, { recursive: true, force: true }); });
  });
});
