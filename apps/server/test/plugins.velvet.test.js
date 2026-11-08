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
  if (u.hostname === 'xhamster.com') {
    return xhamster(u);
  }
  return null;
}

// ── xHamster's pages, canned ────────────────────────────────────────────────

// its ciphered source URLs: one per generator (made with a separate Python
// transcription of yt-dlp's generators), all decoding to XH_PLAYLIST
var XH_PLAYLIST = 'https://video-nss-h.xhcdn.com/abc==,1794186000/media=hls4/031/265/823/_TPL_.h264.mp4.m3u8';
var XH_CIPHERED = ["0115cd5b07187b5669d78959726efe6e84a396b0d6b3329a878cab25890689b91e71e4cf577312ff1575e42f49898f9c315ceb51a8055bfba8a98b8a7e3ce84aa28dc47c6385605a6bd7dce9c9089b150f64c928d12e3242dd1a6eb55890", "024f9721c5a327c4ee5c71f290276ac696ac558e9333eb6e5f7c74dd783aa48c6209e0f85adf02625cd389ff4927457cd2e693e8ddfc60226f58e86c71ddb3984f55c3297fe1aee7a88a00b956476651974a5f47b32b6b13f9bc7e002e7d", "032a00000078514da0a79d17c4e9074cad6bd272ebea2df9a81d3725a448c34d7177ce6bde48e803472c7f6affd255bdf30cdfd7b25afa2ec6f012402b82fea00b5f54e0f47b12ef44445ee83996b7b5f7a6e15913aebe22c74a40d184b4", "04ffffffff651b89a369b5d61b1f63fa73f7fdad3d8c44dc378f3d1071598b2d4d819b1d08d1be855cc4f980e305abc7b2fd587fb22b32cdd541963e7e8f52ffde823e86afde2d9faa437d454261803665ce15a3e79bf789bf3272ad4335", "05ffffff7f4c50d229561ba37bc26cba7fdb47db0ad64f79b4915af72db9c71afe7ac5d12ab203caa0d245779be433089a7a8c52f8a78793b50ff309f5db5df5e4605d9cf73aefda5993f34d9b6a223fb30bd14fe5fd2deb2c48d1ae1286", "060000008068b369a17031473543026798171209830ae6cbd41c8487d042352c9b6a03cea11eb4d6465c363a2f3fde9b7403fd2ea976e0582440bd74041d175b32851a31feb4770d7d96e75ea1b3425e7ca5616253a65771e04ab665f05e", "07f1ad7600170902cee773acbd6c8f6394a18e9eb9236039d5d2814715836ec3799b08df38af94b0f1378bc07ab1f51436fbbdea91d0c15e04b2671ae4d894ec9389c7816c8f9bd0640bea3160b9e2eafc60343c782ae26327e8e93b7498"];

function xhPageOf(initials) {
  return '<html><head></head><body><script>window.initials=' + JSON.stringify(initials) + ';</script></body></html>';
}

// a listing's video; its id says which page listed it
function xhThumb(page, n) {
  var id = (page.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home') + '-' + n + '-xh' + n;
  return { id: n, duration: 600 + n, created: 1790000000, title: 'Video ' + n + ' of ' + page, pageURL: 'https://xhamster.com/videos/' + id,
    thumbURL: 'https://ic-vt-nss.xhcdn.com/t/' + n + '.webp', imageURL: 'https://ic-vt-nss.xhcdn.com/i/' + n + '.webp', views: 1500000 + n };
}

var XH_TAGS = [
  { name: 'Siri Dahl', url: 'https://xhamster.com/pornstars/siri-dahl', isPornstar: true },
  { name: 'Brazzers', url: 'https://xhamster.com/channels/brazzers', isChannel: true },
  { name: 'MILF', url: 'https://xhamster.com/categories/milf', isCategory: true },
  { name: 'HD Videos', url: 'https://xhamster.com/hd', isCategory: true },
  { name: 'Oil', url: 'https://xhamster.com/tags/oil', isTag: true }
];

function xhamster(u) {
  var page = u.pathname + u.search;
  if (u.pathname === '/categories') {
    // the site has no picture for some (lesbian)
    return xhPageOf({ layoutPage: { store: { popular: { assignable: [{ name: 'Actions', items: [
      { name: 'Anal', url: 'https://xhamster.com/categories/anal', thumb: 'https://ic-tt-nss.xhcdn.com/c/anal.jpg' },
      { name: 'Lesbian', url: 'https://xhamster.com/categories/lesbian', thumb: null },
      { name: 'Elsewhere', url: 'https://xhamster.com/categories/milf', thumb: 'https://evil.example/milf.jpg' }
    ] }] } } } });
  }
  var video = /^\/videos\/([A-Za-z0-9-]+)$/.exec(u.pathname);
  if (video) {
    if (/nosource/.test(video[1])) {
      return xhPageOf({ videoModel: { title: 'No source' }, xplayerSettings: { sources: { hls: {} } } });
    }
    var algo = Number((/-a([1-7])-/.exec(video[1]) || [0, 3])[1]);
    return xhPageOf({
      videoModel: { id: 1, title: 'Oily Massage', duration: 1834, views: 8800000, created: 1758700000, rating: { value: 97 },
        thumbURL: 'https://ic-vt-nss.xhcdn.com/i/big.webp', description: 'A massage.' },
      videoTagsComponent: { tags: XH_TAGS },
      relatedVideosComponent: { videoTabInitialData: { videoListProps: { videoThumbProps: [xhThumb('related', 1), xhThumb('related', 2)] } } },
      xplayerSettings: { sources: {
        hls: { av1: { url: '01aa' }, h264: { url: XH_CIPHERED[algo - 1], fallback: XH_CIPHERED[0] } },
        standard: { h264: [{ quality: '720p', url: 'https://video-h.xhcdn.com/key=x/720p.h264.mp4' }] }
      } }
    });
  }
  // a listing: a short list of something else, then the page's own (the longest)
  var thumbs = [];
  for (var n = 1; n <= 12; n++) thumbs.push(xhThumb(page, n));
  thumbs.push({ id: 99, title: 'Elsewhere', pageURL: 'https://xhamster.com/videos/elsewhere-xh99', thumbURL: 'https://evil.example/t.webp' });
  return xhPageOf({ layoutPage: { sidebar: { videoThumbProps: [xhThumb('sidebar', 1)] }, videoListProps: { videoThumbProps: thumbs } } });
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
  var handlers = {}, secrets = {}, settings = { sexEmpire: false, theSexTube: false, xhamster: true }, store = {}, requests = [];
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

// ── the Sites view (xHamster) ───────────────────────────────────────────────

function xhPaths(p) {
  return p.requests.filter(function (o) { return /^https:\/\/xhamster\.com\//.test(o.url); }).map(function (o) { return o.url.slice('https://xhamster.com'.length); });
}

test('Sites: a third View; the section, the list and the sites switch to one another, kept per profile', function () {
  var p = load();
  p.secrets.tmdbApiKey = 'k';
  return p.handlers.browse({ filters: { view: ['sites'] } }, CTX).then(function (r) {
    valid('effect', r.effects[0]);
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.velvet.sites', replace: true });
    assert.equal(p.store['layout:p1'], 'sites');
    return Promise.all([p.handlers.browse({}, CTX), p.handlers.releases({ params: {}, filters: {}, page: 1 }, CTX), p.handlers.sites({}, CTX)]);
  }).then(function (r) {
    assert.equal(r[0].effects[0].intent.screen, 'plugin.velvet.sites', 'the section opens the sites now');
    assert.equal(r[1].effects[0].intent.screen, 'plugin.velvet.sites');
    assert.equal(r[2].effects, undefined);
    valid('templates/properties/catalog', r[2].data);
    assert.deepEqual(r[2].data.filters[0].options.map(function (o) { return o.value + (o.on ? '*' : ''); }), ['posters', 'list', 'sites*']);
    return p.handlers.sites({ filters: { view: ['posters'] } }, CTX);
  }).then(function (r) {
    assert.deepEqual(r.effects[0].intent, { screen: 'plugin.velvet.browse', replace: true });
    assert.equal(p.store['layout:p1'], 'posters');
  });
});

test('Sites: its own rows, its categories as cards (a missing picture from its first video), a row per popular category', function () {
  var p = load();
  return p.handlers.sites({}, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    var titles = r.data.rows.map(function (x) { return x.title; });
    assert.deepEqual(titles.slice(0, 6), ['Trending', 'Newest', 'Best this week', '4K', 'Categories', 'Amateur']);
    assert.equal(titles.length, 17);
    assert.deepEqual(r.data.filters.map(function (f) { return f.key; }), ['view', 'site', 'category', 'quality', 'duration']);
    var cats = r.data.rows[4].items, anal = cats.filter(function (c) { return c.title === 'Anal'; })[0],
      lesbian = cats.filter(function (c) { return c.title === 'Lesbian'; })[0], milf = cats.filter(function (c) { return c.title === 'MILF'; })[0];
    assert.equal(cats.length, 40);
    assert.equal(anal.image, 'https://ic-tt-nss.xhcdn.com/c/anal.jpg');
    assert.equal(lesbian.image, 'https://ic-vt-nss.xhcdn.com/t/1.webp', 'no picture on the site: its first video\'s');
    assert.ok(!/evil/.test(milf.image || ''), 'a picture on another host is never used');
    assert.deepEqual(anal.intent, { screen: 'plugin.velvet.siteList', params: { site: 'xhamster', list: 'categories.anal', name: 'Anal' } });
    assert.deepEqual(r.data.rows[0].page, { data: 'rowPage', args: { provider: 'site', site: 'xhamster', base: '', sort: 'trending', quality: '', duration: '' } });
    return p.handlers.rowPage(r.data.rows[0].page.args, CTX);
  }).then(function (r) {
    valid('rowPage', r.data);
    assert.equal(r.data.items.length, 12, 'the page\'s listing (the longest), its video on another host left out');
    var c = r.data.items[0];
    valid('card', c);
    assert.equal(c.title, 'Video 1 of /');
    assert.equal(c.variant, 'still');
    assert.equal(c.subtitle, '10:01 · 1.5M views');
    assert.deepEqual(c.intent, { screen: 'plugin.velvet.siteVideo', params: { site: 'xhamster', id: 'home-1-xh1' } });
    assert.equal(c.info.backdrop, 'https://ic-vt-nss.xhcdn.com/i/1.webp');
  });
});

test('Sites: listing paths for sorts, qualities, lengths, categories, performers, searches and pages', function () {
  var p = load(), rows = [
    { sort: 'newest', page: 2 }, { sort: 'weekly' }, { quality: '2160p' }, { sort: 'monthly', quality: '720p' },
    { base: '/categories/lesbian', sort: 'weekly', quality: '1080p', duration: '30', page: 3 },
    { base: '/pornstars/siri-dahl', quality: '2160p', duration: '10' },
    { q: 'oil massage', quality: '1080p' }, { q: 'oil massage', sort: 'newest', page: 2 }
  ];
  return rows.reduce(function (chain, a) {
    return chain.then(function () { return p.handlers.rowPage(Object.assign({ provider: 'site', site: 'xhamster', page: 1 }, a), CTX); });
  }, Promise.resolve()).then(function () {
    assert.deepEqual(xhPaths(p), [
      '/newest/2', '/best/weekly', '/4k', '/hd/best/monthly',
      '/categories/lesbian/hd/best/weekly/3?quality=1080p&min-duration=30',
      '/pornstars/siri-dahl?min-duration=10',
      '/search/oil%20massage?quality=1080p', '/search/oil%20massage?sort=newest&page=2'
    ]);
  });
});

test('Sites: a category, quality or length → that listing\'s sorts; a search → its two rows', function () {
  var p = load();
  return p.handlers.sites({ filters: { view: ['sites'], category: ['lesbian'], quality: ['1080p'] } }, CTX).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.deepEqual(r.data.rows.map(function (x) { return x.title; }), ['Lesbian: Trending', 'Lesbian: Newest', 'Lesbian: Best this week', 'Lesbian: Best this month']);
    assert.equal(r.data.rows[2].page.args.base, '/categories/lesbian');
    assert.equal(r.data.rows[2].page.args.quality, '1080p');
    return p.handlers.sites({ query: 'oil', filters: { duration: ['30'] } }, CTX);
  }).then(function (r) {
    valid('templates/properties/catalog', r.data);
    assert.deepEqual(r.data.rows.map(function (x) { return x.page.args.q + '/' + (x.page.args.sort || '') + '/' + x.page.args.duration; }), ['oil//30', 'oil/newest/30']);
    assert.deepEqual(xhPaths(p), [], 'rows are read when they show, not before');
  });
});

test('Sites: a category, performer or channel page; a bad list refused', function () {
  var p = load();
  return Promise.all([
    p.handlers.siteList({ params: { site: 'xhamster', list: 'categories.lesbian', name: 'Lesbian' } }, CTX),
    p.handlers.siteList({ params: { site: 'xhamster', list: 'pornstars.siri-dahl', name: 'Siri Dahl' }, filters: { duration: ['60'] } }, CTX),
    p.handlers.siteList({ params: { site: 'xhamster', list: 'users.someone', name: 'x' } }, CTX),
    p.handlers.siteList({ params: { site: 'xhamster', list: 'categories.../x' } }, CTX)
  ]).then(function (r) {
    r.forEach(function (x) { valid('templates/properties/catalog', x.data); });
    assert.equal(r[0].data.title, 'Lesbian');
    assert.deepEqual(r[0].data.filters.map(function (f) { return f.key; }), ['quality', 'duration']);
    assert.deepEqual(r[1].data.filters.map(function (f) { return f.key; }), ['duration'], 'performers have no quality pages');
    assert.equal(r[1].data.rows[1].page.args.base, '/pornstars/siri-dahl');
    assert.equal(r[1].data.rows[1].page.args.duration, '60');
    assert.deepEqual(r[2].data.rows, []);
    assert.deepEqual(r[3].data.rows, []);
  });
});

test('Sites: a video page: what it is, Play, its people and channel, related and more', function () {
  var p = load();
  return p.handlers.siteVideo({ params: { site: 'xhamster', id: 'oily-massage-xhAbc1' } }, CTX).then(function (r) {
    valid('templates/properties/title', r.data);
    var info = r.data.info;
    assert.equal(info.title, 'Oily Massage');
    assert.deepEqual(info.meta.map(function (m) { return m.text || m.label; }), ['30:34', '8.8M views', 'Liked 97%', '2025-09-24']);
    assert.deepEqual(info.genres, ['MILF'], 'categories only, not tags or quality pages');
    assert.deepEqual(info.credits, [{ label: 'With', names: ['Siri Dahl'] }, { label: 'Channel', names: ['Brazzers'] }]);
    assert.deepEqual(r.data.actions.map(function (a) { return a.label; }), ['Play', 'Siri Dahl', 'Brazzers']);
    assert.deepEqual(r.data.actions[0].call, { data: 'play', args: { provider: 'site', site: 'xhamster', id: 'oily-massage-xhAbc1' } });
    assert.deepEqual(r.data.actions[2].intent.params, { site: 'xhamster', list: 'channels.brazzers', name: 'Brazzers' });
    assert.deepEqual(r.data.rows.map(function (x) { return x.title; }), ['Related', 'More with Siri Dahl', 'More from Brazzers']);
    assert.equal(r.data.rows[0].items.length, 2);
    return p.handlers.siteVideo({ params: { site: 'xhamster', id: '../etc' } }, CTX);
  }).then(function (r) {
    valid('templates/properties/title', r.data);
    assert.match(r.data.info.title, /isn't available/);
  });
});

test('Sites Play: the H.264 HLS playlist deciphered (every generator), its headers, nothing saved; no source, switched off', function () {
  var p = load(), ids = [1, 2, 3, 4, 5, 6, 7].map(function (a) { return 'video-a' + a + '-xh' + a; });
  return Promise.all(ids.map(function (id) { return p.handlers.play({ provider: 'site', site: 'xhamster', id: id }, CTX); })).then(function (r) {
    var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'playpex-plugin.json'), 'utf8'));
    r.forEach(function (x, i) {
      valid('effect', x.effects[0]);
      var req = x.effects[0].request;
      assert.equal(req.tracking, 'none');
      assert.equal(req.sources.length, 1);
      assert.equal(req.sources[0].kind, 'hls');
      assert.equal(req.sources[0].url, XH_PLAYLIST, 'generator ' + (i + 1));
      assert.deepEqual(req.sources[0].headers, { 'User-Agent': BROWSER, Referer: 'https://xhamster.com/' });
    });
    // its playlist's host is declared
    var host = new URL(XH_PLAYLIST).hostname;
    assert.ok(manifest.permissions.network.some(function (n) { return n === host || (n.slice(0, 2) === '*.' && host.endsWith(n.slice(1))); }));
    assert.equal(xhPaths(p).length, 7, 'each video page read once, fresh');
    return p.handlers.play({ provider: 'site', site: 'xhamster', id: 'nosource-xh0' }, CTX);
  }).then(function (r) {
    assert.equal(r.effects[0].type, 'toast');
    p.settings.xhamster = false;
    p.requests.length = 0;
    return Promise.all([p.handlers.play({ provider: 'site', site: 'xhamster', id: 'video-a3-xh3' }, CTX), p.handlers.sites({}, CTX)]);
  }).then(function (r) {
    assert.equal(r[0].effects[0].type, 'toast');
    valid('templates/properties/catalog', r[1].data);
    assert.match(r[1].data.empty, /switched off/);
    assert.deepEqual(p.requests, [], 'nothing fetched while it\'s off');
  });
});

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
    assert.deepEqual(mine.screens.map(function (s) { return s.name; }), ['browse', 'title', 'releases', 'sites', 'find', 'siteList', 'siteVideo']);
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
