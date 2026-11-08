// Velvet: a film section as a plugin. Runs in the server's sandbox
// (docs/plugins/server.md); the TV draws it with the core's templates.
// Educational project: streaming copyrighted content via torrents may be
// illegal where you live.
//
// Data handlers and what the core sends them:
//   browse    catalog   { params, query, filters: { view, kind, studio, period } } the poster layout (films, scenes)
//   rowPage   row page  { page, provider, row?, sort?, studio?, period?, q? }  a paged row
//   title     title     { params: { provider, id } }                          one title
//   play      call      { provider, id }                                     its streams and torrents → the core's player
//   releases  releases  { params: { q? }, query, filters, page }             the list layout (screens releases, find)
//   searchFilter        { slot, context: { query } }                         the search page's chip: films, scenes, and Releases (the find screen)
//
// The layout (posters or list) is the "View" filter of both screens, kept per
// profile in the store: the section opens the profile's last one. Films from
// TMDB (through studios) or a second metadata provider, the profile's choice;
// scenes (studios' web releases, small studios included) from the second one,
// its `/scenes` and `/sites`, with the studios the profile follows (setting
// `sceneStudios`) as rows; releases from two torrent indexes' categories, most
// seeded first, a scene's matched by its studio and date, performer or title.
// Full films also stream from Sex-Empire (setting sexEmpire, on by default):
// a row of its newest films and its search (provider `sexempire`, the site's
// film number as the id), and a catalog film's Play adds its streams (VidHide
// HLS, DoodStream MP4) before the torrents when the site has the same film.
// Studios' videos (Ersties, Lustery, Playboy Plus) come from TheSexTube
// (setting theSexTube): only posts tagged with those studios, never the site's
// personal or leaked ones (see its section); in Find releases' Source and in
// those studios' scenes' Play.
// Plays never touch the profile's library (tracking 'none').

var TMDB = 'https://api.themoviedb.org/3';
var TMDB_IMG = 'https://image.tmdb.org/t/p/';
var TPDB = 'https://api.theporndb.net';
var APIBAY = 'https://apibay.org';
var THERARBG = ['https://therarbg.to', 'https://therarbg.com'];
var TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce'];
var CACHE_MS = 60 * 60 * 1000;
var PAGE_SIZE = 20;
var MAX_PAGE = 500;            // TMDB answers no page past 500

// ── small helpers ───────────────────────────────────────────────────────────

function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

var cache = {};

/** A GET answer as JSON, cached an hour (failures aren't kept) */
function getJson(url, headers) {
  var hit = cache[url];
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var value = playpex.http.request({ url: url, responseType: 'json', headers: headers || {} }).then(function (res) {
    if (res.status !== 200) {
      throw new Error(url.split('?')[0] + ' answered HTTP ' + res.status);
    }
    return res.body;
  });
  cache[url] = { value: value, expires: Date.now() + CACHE_MS };
  value.catch(function () { delete cache[url]; });
  return value;
}

/** The first mirror that answers */
function mirrored(bases, path) {
  var i = 0;
  function attempt() {
    return getJson(bases[i] + path).catch(function (err) {
      if (++i < bases.length) {
        return attempt();
      }
      throw err;
    });
  }
  return attempt();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function magnetOf(hash, name) {
  return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) +
    TRACKERS.map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('');
}

function clip(text, n) {
  text = String(text || '');
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

// ── release names ───────────────────────────────────────────────────────────

// "Some Title Vol. 2 [Studio 2026] WEB-DL 1080p MP4-P2P" →
// title "Some Title Vol. 2", studio "Studio", year 2026
var JUNK = /\b(xxx|2160p|1080p|720p|480p|4k|uhd|web.?dl|webrip|hdrip|bluray|dvdrip|split.?scenes?|mp4|mkv|wmv|x26[45]|h\.?26[45]|hevc|p2p|[-.](xc|trb|ktr|gush|wrb|nbq|xleech))\b/i;

function present(name) {
  var text = String(name).replace(/\.(mp4|mkv|avi|wmv)$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  var studio = null, year = null;
  var bracket = text.match(/\[([^\]]+?)\s+((19|20)\d\d)\]/);
  if (bracket) {
    studio = bracket[1].trim();
    year = Number(bracket[2]);
  }
  var title = text.replace(/\[[^\]]*\]/g, ' ');
  var junk = title.search(JUNK);
  if (junk > 0) {
    title = title.slice(0, junk);
  }
  title = title.replace(/[\s\-–(]+$/, '').replace(/\s+/g, ' ').trim();
  return { title: title.length < 3 ? text : title, studio: studio, year: year };
}

// What plays in the TV's Chromium (as the core's episodes.js says it)
function describe(name) {
  var resolution = (name.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];
  if (!resolution && /\b(4k|uhd)\b/i.test(name)) {
    resolution = '2160p';
  }
  resolution = resolution ? resolution.toLowerCase() : 'SD';
  var hevc = /\b(x265|h\.?265|hevc)\b/i.test(name),
    tenBit = /\b10.?bit\b/i.test(name),
    xvid = /\b(xvid|divx)\b/i.test(name),
    audio = 'unknown';
  if (/\b(ddp?\s?\d|ddp|dd\+|e-?ac-?3|ac-?3|eac3|truehd|atmos|dts(-?hd)?)\b/i.test(name)) {
    audio = 'unsupported';
  } else if (/\b(aac|opus|mp3)/i.test(name)) {
    audio = 'supported';
  }
  return {
    quality: resolution,
    codec: hevc ? 'x265' : xvid ? 'xvid' : 'x264',
    audio: audio,
    playable: !hevc && !tenBit && !xvid && resolution !== '2160p',
    scenes: /\bsplit.?scenes?\b/i.test(name)
  };
}

function normalizeTitle(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// null when the release isn't this film, else { yearMatch }: the name starts
// with the title (after a "[Studio]" tag), not followed by a sequel number; a
// release stating another year is another film
function match(name, title, year) {
  var normalized = normalizeTitle(String(name).replace(/^\s*(\[[^\]]*\]|\([^)]*\)|\s)+/, '')),
    wanted = normalizeTitle(title);
  if (!wanted) {
    return null;
  }
  var found = new RegExp('^' + escapeRegExp(wanted).replace(/ /g, ' +') + '(?= |$)(?! +([2-9]|[1-9]\\d)( |$))').test(normalized);
  if (!found) {
    return null;
  }
  var yearMatch = false,
    years = normalized.slice(wanted.length).match(/\b(19|20)\d\d\b/g) || [];
  if (year && years.length) {
    yearMatch = years.some(function (y) { return Math.abs(Number(y) - year) <= 1; });
    if (!yearMatch) {
      return null;
    }
  }
  return { yearMatch: yearMatch };
}

var AUDIO_RANK = { supported: 2, unknown: 1, unsupported: 0 },
  RESOLUTION_RANK = { '1080p': 3, '720p': 2, '480p': 1, 'SD': 1, '2160p': 0 },
  HEALTHY_SEEDS = 10;

function compare(a, b) {
  return (b.playable - a.playable) ||
    (AUDIO_RANK[b.audio] - AUDIO_RANK[a.audio]) ||
    ((b.seeds >= HEALTHY_SEEDS) - (a.seeds >= HEALTHY_SEEDS)) ||
    (a.scenes - b.scenes) ||
    (b.yearMatch - a.yearMatch) ||
    ((RESOLUTION_RANK[b.quality] || 0) - (RESOLUTION_RANK[a.quality] || 0)) ||
    (b.seeds - a.seeds);
}

// ── torrent sources (categories) ──────────────────────────────────────────────

// The index's subcategories that hold films (not DVDR images, pictures, games)
var PIRATEBAY_FILMS = ['501', '505', '506', '507'];

// Names come HTML-escaped ("Laurent Sky &amp; Julia Grandi", "that&rsquo;s")
var ENTITIES = { quot: '"', apos: '\'', lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
  ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', ntilde: 'ñ' };

function unescapeHtml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
    if (e[0] === '#') {
      var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return e.toLowerCase() === 'amp' ? '&' : ENTITIES[e.toLowerCase()] || all;
  });
}

function words(text) {
  return String(text || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fromPirateBay(r) {
  var hash = r.info_hash.toLowerCase(), name = unescapeHtml(r.name);
  return { provider: 'The Pirate Bay', name: name, hash: hash, seeds: Number(r.seeders) || 0, peers: Number(r.leechers) || 0,
    size: Number(r.size) || 0, added: Number(r.added) || 0 };
}

/** Its films: the top 100 of `category` (no keywords) or a search (≤ 100); no paging */
function pirateBay(keywords, category) {
  var q = words(keywords);
  var path = q ? '/q.php?' + qs({ q: q, cat: category }) : '/precompiled/data_top100_' + category + '.json';
  return getJson(APIBAY + path).then(function (list) {
    var seen = {};
    return {
      results: (Array.isArray(list) ? list : []).filter(function (r) {
        if (!r.info_hash || /^0+$/.test(r.info_hash) || PIRATEBAY_FILMS.indexOf(String(r.category)) === -1 || seen[r.info_hash]) {
          return false;
        }
        seen[r.info_hash] = true;
        return true;
      }).map(fromPirateBay),
      hasMore: false
    };
  });
}

/** TheRARBG's category, most seeded first, 50 a page (never the resolution in the keywords: it then ranks by name) */
function theRarbg(keywords, page) {
  var filters = 'order:-se:category:XXX', q = words(keywords);
  if (q) {
    filters = 'keywords:' + encodeURIComponent(q) + ':' + filters;
  }
  return mirrored(THERARBG, '/get-posts/' + filters + '/?' + qs({ format: 'json', page: page > 1 ? page : null })).then(function (data) {
    if (!data || !Array.isArray(data.results)) {
      throw new Error('TheRARBG: unexpected answer');
    }
    return {
      results: data.results.filter(function (r) { return r.h && r.c === 'XXX'; }).map(function (r) {
        return { provider: 'TheRARBG', name: r.n, hash: r.h.toLowerCase(), seeds: Number(r.se) || 0, peers: Number(r.le) || 0,
          size: Number(r.s) || 0, added: Number(r.a) || 0 };
      }),
      hasMore: !!(data.links && data.links.next)
    };
  });
}

var SOURCES = [
  { id: 'piratebay', name: 'The Pirate Bay', paged: false, list: function (c) {
    // its own subcategories narrow the top 100 by resolution
    var category = c.quality === '2160p' ? '507' : (c.quality === '1080p' || c.quality === '720p') ? '505' : '500';
    return pirateBay(c.q, category);
  } },
  { id: 'therarbg', name: 'TheRARBG', paged: true, list: function (c) { return theRarbg(c.q, c.page); } }
];

/** Both sources' answers for keywords: [{ provider, name, hash, seeds, size }], and the errors */
function searchSources(keywords) {
  var q = words(keywords);
  var reads = [
    getJson(APIBAY + '/q.php?' + qs({ q: q, cat: '500' })).then(function (list) {
      return (Array.isArray(list) ? list : []).filter(function (r) {
        return r.info_hash && !/^0+$/.test(r.info_hash) && PIRATEBAY_FILMS.indexOf(String(r.category)) !== -1;
      }).map(fromPirateBay);
    }),
    mirrored(THERARBG, '/get-posts/keywords:' + encodeURIComponent(q) + ':category:XXX/?format=json').then(function (data) {
      return ((data && data.results) || []).filter(function (r) { return r.h && r.c === 'XXX'; }).map(function (r) {
        return { provider: 'TheRARBG', name: r.n, hash: r.h.toLowerCase(), seeds: Number(r.se) || 0, size: Number(r.s) || 0 };
      });
    })
  ];
  return Promise.all(reads.map(function (p) {
    return p.then(function (v) { return { ok: v }; }, function (err) { return { error: err.message }; });
  }));
}

/**
 * Torrents for several searches, kept by `matcher(name)` (null: not it, else what
 * it matched, merged into the torrent), one per hash, ranked for streaming
 */
function collectTorrents(searches, matcher) {
  return Promise.all(searches.map(searchSources)).then(function (all) {
    var byHash = {}, errors = [], reads = 0;
    all.forEach(function (results) {
      results.forEach(function (r) {
        reads++;
        if (r.error) {
          errors.push(r.error);
          return;
        }
        r.ok.forEach(function (t) {
          var found = matcher(t.name);
          if (found && (!byHash[t.hash] || t.seeds > byHash[t.hash].seeds)) {
            byHash[t.hash] = Object.assign(t, describe(t.name), found);
          }
        });
      });
    });
    if (errors.length) {
      playpex.log.warn('torrent search errors: ' + errors.join('; '));
    }
    var list = Object.keys(byHash).map(function (h) { return byHash[h]; });
    list.sort(compare);
    return { torrents: list, failed: errors.length === reads };
  });
}

/** One film's torrents from both sources, matched by title (+ year) and ranked for streaming */
function findTorrents(title, year) {
  return collectTorrents([title], function (name) { return match(name, title, year); });
}

// ── scenes' releases ────────────────────────────────────────────────────────

function compact(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** "2024-03-15" → { yy: '24', mm: '03', dd: '15', yyyy: '2024' } */
function dateParts(date) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  return m ? { yyyy: m[1], yy: m[1].slice(2), mm: m[2], dd: m[3] } : null;
}

/**
 * Whether a release is this scene: scene releases are named by studio and date
 * ("Studio.24.03.15.Performer.Title.XXX.1080p"), sometimes by studio and
 * performer or title. The studio must be in the name; then its date, one of its
 * performers or most of its title's words. null when it isn't, else
 * { yearMatch: the date matched } (ranked first)
 */
function sceneMatch(name, scene) {
  var n = compact(name), studio = scene.studio || {};
  var names = [studio.name, studio.short].map(compact).filter(function (x) { return x.length >= 3; });
  if (!names.some(function (x) { return n.indexOf(x) !== -1; })) {
    return null;
  }
  var d = dateParts(scene.releaseDate),
    date = !!d && (n.indexOf(d.yy + d.mm + d.dd) !== -1 || n.indexOf(d.yyyy + d.mm + d.dd) !== -1),
    performer = (scene.performers || []).some(function (p) { var c = compact(p.name); return c.length >= 5 && n.indexOf(c) !== -1; }),
    titleWords = normalizeTitle(scene.title).split(' ').filter(function (w) { return w.length >= 4; }),
    nameWords = normalizeTitle(name).split(' '),
    title = titleWords.length > 0 && titleWords.filter(function (w) { return nameWords.indexOf(w) !== -1; }).length / titleWords.length >= 0.6;
  return date || performer || title ? { yearMatch: date } : null;
}

/** The searches that find a scene's releases: studio + date, studio + performer, studio + title */
function sceneSearches(scene) {
  var studio = scene.studio ? scene.studio.name : '', d = dateParts(scene.releaseDate), list = [];
  if (!studio) {
    return [scene.title];
  }
  if (d) list.push(studio + ' ' + d.yy + ' ' + d.mm + ' ' + d.dd);
  if (scene.performers && scene.performers[0]) list.push(studio + ' ' + scene.performers[0].name);
  list.push(studio + ' ' + scene.title);
  return list;
}

function findSceneTorrents(scene) {
  return collectTorrents(sceneSearches(scene), function (name) { return sceneMatch(name, scene); });
}

/** What Find releases searches for a title: a scene's studio and date (as its releases are named), else its title */
function releaseQuery(providerId, t) {
  var d = dateParts(t.releaseDate);
  return providerId === 'scenes' && t.studio && d ? t.studio.name + ' ' + d.yy + ' ' + d.mm + ' ' + d.dd : t.title;
}

function notesOf(t) {
  var p = present(t.name), notes = [];
  if (p.studio) notes.push(p.studio);
  if (p.year) notes.push(String(p.year));
  if (t.scenes) notes.push('Split scenes');
  if (t.audio === 'unsupported') notes.push('Probably no sound');
  else if (!t.playable) notes.push('May not play');
  notes.push(clip(t.provider, 80));
  return notes.slice(0, 6);
}

// ── catalogs ────────────────────────────────────────────────────────────────

// TMDB has no filter or genres for these titles: they're reached through
// their studios (production companies, checked Oct 2026: each lists ≥ 40
// titles with posters), and searches keep only flagged results
var TMDB_STUDIOS = [
  ['8552', 'Brazzers'], ['97168', 'Vixen'], ['63844', 'Blacked'], ['72478', 'Tushy'], ['6463', 'Evil Angel'],
  ['6112', 'Digital Playground'], ['6258', 'Dorcel'], ['6316', 'Naughty America'], ['15887', 'Reality Kings'],
  ['33400', 'Jules Jordan Video'], ['6886', 'Elegant Angel'], ['6122', 'New Sensations'], ['5788', 'Private'],
  ['5979', 'Vivid Entertainment'], ['120963', 'Deeper'], ['103790', 'Blacked Raw'], ['117838', 'Tushy Raw'],
  ['97187', 'Pure Taboo'], ['114045', 'Adult Time'], ['6978', 'Girlfriends Films'], ['10294', 'Sweetheart Video'],
  ['6115', 'Hustler Video'], ['56675', 'Bang Bros'], ['107132', 'Mofos'], ['46264', 'Team Skeet'], ['8248', 'Devil\'s Film'],
  ['8027', 'Lethal Hardcore'], ['6228', 'Zero Tolerance'], ['6121', 'Digital Sin'], ['65222', 'Mile High Xtreme'],
  ['32777', 'Erotica X'], ['99678', 'Dark X'], ['111525', 'MissaX'], ['122166', 'Bellesa Films'], ['168340', 'Slayed'], ['8679', 'Kink'],
  // added Nov 2026, fewer titles than the rest: Sinful XXX ~135, Playboy ~40, Lustery ~17, Ersties 1
  // Playboy = Playboy Entertainment Group (its erotic films); Playboy Enterprises (1431) also lists mainstream films
  ['120027', 'Sinful XXX'], ['39987', 'Playboy'], ['232257', 'Lustery'], ['279197', 'Ersties']
].map(function (s) { return { id: s[0], name: s[1] }; });

// The second provider's site ids (checked Oct 2026: exact name, each with ≥ 50 movies)
var TPDB_SITES = [
  ['92', 'Brazzers'], ['3372', 'Vixen'], ['200', 'Blacked'], ['3417', 'Tushy'], ['4611', 'Evil Angel'], ['347', 'Digital Playground'],
  ['6551', 'Marc Dorcel'], ['130', 'Naughty America'], ['20', 'Reality Kings'], ['1052', 'Elegant Angel'], ['202', 'Blacked Raw'],
  ['247', 'Tushy Raw'], ['3373', 'Deeper'], ['3374', 'New Sensations'], ['765', 'Private'], ['4633', 'Pure Taboo'], ['4432', 'Adult Time'],
  ['4628', 'Wicked'], ['36685', 'Hustler'], ['65', 'Mofos'], ['278', 'Team Skeet'], ['4404', 'Girlfriends Films'], ['263', 'Sweetheart Video'],
  ['1287', 'Zero Tolerance'], ['4635', 'Devil\'s Film'], ['3418', 'Digital Sin'], ['4376', 'Erotica X'], ['4388', 'Dark X'], ['6103', 'Slayed'],
  ['2274', 'MissaX'], ['353', 'Kink'], ['1001', 'Penthouse'], ['6497', 'Vivid'], ['1006', 'Lethal Hardcore'], ['1056', 'Adam & Eve']
].map(function (s) { return { id: s[0], name: s[1] }; });

// The studios offered for scenes (checked Nov 2026: scenes this year, read
// with their sub-sites: Brazzers' are on Brazzers Exxtra and the like, so the
// site alone holds a few strays). Not the films' list: Marc Dorcel, Vivid,
// Digital Sin, Adam & Eve have no recent scenes there
var SCENE_SITES = [
  ['92', 'Brazzers'], ['3372', 'Vixen'], ['200', 'Blacked'], ['3417', 'Tushy'], ['3005', 'Ersties'], ['6511', 'Lustery'],
  ['5004', 'Sinful XXX'], ['5312', 'Playboy Plus'], ['20', 'Reality Kings'], ['130', 'Naughty America'],
  ['4611', 'Evil Angel'], ['347', 'Digital Playground'], ['1052', 'Elegant Angel'], ['202', 'Blacked Raw'], ['247', 'Tushy Raw'],
  ['3373', 'Deeper'], ['3374', 'New Sensations'], ['765', 'Private'], ['4633', 'Pure Taboo'], ['4432', 'Adult Time'], ['4628', 'Wicked'],
  ['36685', 'Hustler'], ['65', 'Mofos'], ['278', 'Team Skeet'], ['4404', 'Girlfriends Films'], ['263', 'Sweetheart Video'],
  ['1287', 'Zero Tolerance'], ['4635', 'Devil\'s Film'], ['4376', 'Erotica X'], ['4388', 'Dark X'], ['6103', 'Slayed'],
  ['2274', 'MissaX'], ['353', 'Kink'], ['1001', 'Penthouse'], ['1006', 'Lethal Hardcore']
].map(function (s) { return { id: s[0], name: s[1] }; });

// Clip stores and fan sites the second provider also lists (anyone's uploads,
// named "<Store>: <uploader>"): left out of scene lists
var CLIP_STORES = /^(clips4sale|i want clips|iwantclips|manyvids|pornhub|fansdb|onlyfans|fansly|loyalfans|yourvids|xhamster|xvideos|modelhub|justfor\.?fans|clipvia|apclips|niteflirt|faphouse|admireme|fancentro|mym)\b/i;

function clipStore(site) {
  if (!site) return false;
  var names = [site.name, site.network && site.network.name, site.parent && site.parent.name];
  return /^[^:]{2,24}: /.test(site.name || '') || names.some(function (n) { return n && CLIP_STORES.test(String(n)); });
}

// A trailer or teaser rather than the scene (under 3 minutes, or named so)
function sceneExtra(m) {
  var d = Number(m.duration) || 0;
  return (d > 0 && d < 180) || /\b(trailer|teaser)\b/i.test(m.title || '');
}

var HOME_STUDIOS = 10;          // the first ones get a row on the home page

// A provider answers pages { items: [Item], page, totalPages };
// Item = { id, title, year, releaseDate, overview, poster, backdrop, rating, studio }
var PROVIDERS = {
  tmdb: {
    name: 'TMDB',
    secret: 'tmdbApiKey',
    sorts: ['popular', 'newest', 'rated'],
    periods: [['', 'Any time'], ['year', 'This year'], ['5y', 'Last 5 years'], ['classic', 'Before 2015']],
    studios: TMDB_STUDIOS,
    get: function (key, path, params) {
      return getJson(TMDB + path + '?' + qs(Object.assign({ api_key: key, language: 'en-US' }, params)));
    },
    item: function (r, studio) {
      var date = r.release_date || '';
      return {
        id: String(r.id), title: r.title || r.original_title || 'Untitled', year: date ? Number(date.slice(0, 4)) : null,
        releaseDate: date || null, overview: r.overview || '',
        poster: r.poster_path ? TMDB_IMG + 'w342' + r.poster_path : null,
        backdrop: r.backdrop_path ? TMDB_IMG + 'w1280' + r.backdrop_path : null,
        rating: r.vote_count >= 3 && r.vote_average ? r.vote_average : null, studio: studio || null
      };
    },
    page: function (data, studio, withPoster) {
      var self = this;
      return {
        items: (data.results || []).filter(function (r) { return r.adult && (!withPoster || r.poster_path); })
          .map(function (r) { return self.item(r, studio); }),
        page: data.page || 1,
        totalPages: Math.min(data.total_pages || 1, MAX_PAGE)
      };
    },
    period: function (period) {
      var year = new Date().getFullYear();
      return period === 'year' ? { 'primary_release_date.gte': year + '-01-01' } :
        period === '5y' ? { 'primary_release_date.gte': (year - 5) + '-01-01' } :
          period === 'classic' ? { 'primary_release_date.lte': '2014-12-31' } : {};
    },
    home: function () {
      return [['popular', 'Popular now'], ['newest', 'New releases'], ['rated', 'Top rated']].map(function (r) { return { row: r[0], title: r[1] }; })
        .concat(TMDB_STUDIOS.slice(0, HOME_STUDIOS).map(function (s) { return { row: 'studio:' + s.id, title: s.name }; }));
    },
    discover: function (key, o) {
      var self = this, studio = o.studio ? TMDB_STUDIOS.filter(function (s) { return s.id === String(o.studio); })[0] || { id: String(o.studio), name: '' } : null;
      var params = Object.assign({ include_adult: true, with_companies: studio ? studio.id : TMDB_STUDIOS.map(function (s) { return s.id; }).join('|'),
        page: Math.min(Math.max(1, o.page || 1), MAX_PAGE) }, this.period(o.period));
      if (!params['primary_release_date.lte']) {
        params['primary_release_date.lte'] = today();
      }
      if (o.sort === 'newest') {
        params.sort_by = 'primary_release_date.desc';
      } else if (o.sort === 'rated') {
        params.sort_by = 'vote_average.desc';
        params['vote_count.gte'] = 5;
      } else {
        params.sort_by = 'popularity.desc';
      }
      return this.get(key, '/discover/movie', params).then(function (data) { return self.page(data, studio, true); });
    },
    row: function (key, row, page) {
      var studio = /^studio:(\d+)$/.exec(row);
      return this.discover(key, studio ? { studio: studio[1], page: page } : { sort: row, page: page });
    },
    // TMDB ranks every regular match before the flagged ones: they start after
    // the regular count. Our page n reads the TMDB page where they start + 2(n − 1), and the next
    search: function (key, o) {
      var self = this, q = String(o.q || '').trim(), page = Math.max(1, o.page || 1);
      if (!q) {
        return Promise.resolve({ items: [], page: 1, totalPages: 1 });
      }
      return Promise.all([
        this.get(key, '/search/movie', { query: q, include_adult: false, page: 1 }),
        this.get(key, '/search/movie', { query: q, include_adult: true, page: 1 })
      ]).then(function (counts) {
        var first = Math.floor((counts[0].total_results || 0) / PAGE_SIZE) + 1,
          last = Math.min(Math.ceil((counts[1].total_results || 0) / PAGE_SIZE), MAX_PAGE),
          from = first + (page - 1) * 2;
        if (from > last) {
          return { items: [], page: page, totalPages: page };
        }
        return Promise.all([from, from + 1].filter(function (p) { return p <= last; }).map(function (p) {
          return p === 1 ? counts[1] : self.get(key, '/search/movie', { query: q, include_adult: true, page: p });
        })).then(function (pages) {
          var seen = {}, period = self.period(o.period), items = [];
          pages.forEach(function (data) {
            self.page(data).items.forEach(function (it) {
              if (seen[it.id]) return;
              seen[it.id] = true;
              if (period['primary_release_date.gte'] && (!it.releaseDate || it.releaseDate < period['primary_release_date.gte'])) return;
              if (period['primary_release_date.lte'] && (!it.releaseDate || it.releaseDate > period['primary_release_date.lte'])) return;
              items.push(it);
            });
          });
          return { items: items, page: page, totalPages: Math.max(page, Math.ceil((last - first + 1) / 2)) };
        });
      });
    },
    title: function (key, id) {
      var self = this;
      return this.get(key, '/movie/' + encodeURIComponent(id), { append_to_response: 'credits' }).then(function (m) {
        if (!m.adult) {
          throw new Error('not an 18+ title');
        }
        var companies = (m.production_companies || []).map(function (c) { return { id: String(c.id), name: c.name }; }),
          known = companies.filter(function (c) { return TMDB_STUDIOS.some(function (s) { return s.id === c.id; }); })[0],
          credits = m.credits || {},
          director = (credits.crew || []).filter(function (c) { return c.job === 'Director'; })[0];
        return Object.assign(self.item(m, known || companies[0] || null), {
          runtime: m.runtime || null,
          performers: (credits.cast || []).slice(0, 20).map(function (c) {
            return { name: c.name, photo: c.profile_path ? TMDB_IMG + 'w185' + c.profile_path : null };
          }),
          director: director ? director.name : null,
          browsableStudio: known ? known.id : null
        });
      });
    }
  },

  // Second provider: covers, performers, studios ("sites"); only newest-first sorting
  // (checked Oct 2026), future-dated scraped entries dropped, one site per request
  theporndb: {
    name: 'ThePornDB',
    secret: 'theporndbApiKey',
    sorts: ['newest'],
    periods: [['', 'Any time'], ['year', 'This year'], ['last', 'Last year']],
    studios: TPDB_SITES,
    get: function (key, path, params) {
      return getJson(TPDB + path + (params ? '?' + qs(params) : ''), { Authorization: 'Bearer ' + key, Accept: 'application/json' });
    },
    pick: function (obj, paths) {
      for (var i = 0; i < paths.length; i++) {
        var v = paths[i].split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
        if (v) return v;
      }
      return null;
    },
    item: function (m) {
      var date = m.date || '';
      return {
        id: String(m.id || m._id), title: m.title || 'Untitled', year: date ? Number(String(date).slice(0, 4)) : null,
        releaseDate: date || null, overview: m.description || '',
        poster: this.pick(m, ['image', 'posters.medium', 'posters.large', 'poster']),
        backdrop: this.pick(m, ['posters.large', 'background.large', 'image']),
        rating: Number(m.rating) > 0 ? Number(m.rating) : null,
        studio: m.site && m.site.name ? { id: String(m.site.id), name: m.site.name } : null
      };
    },
    year: function (period) {
      var year = new Date().getFullYear();
      return period === 'year' ? year : period === 'last' ? year - 1 : null;
    },
    movies: function (key, params) {
      var self = this;
      return this.get(key, '/movies', Object.assign({ per_page: 30, orderBy: 'recently_released' }, params)).then(function (data) {
        var meta = data.meta || {};
        return {
          items: (data.data || []).map(function (m) { return self.item(m); })
            .filter(function (it) { return it.poster && (!it.releaseDate || it.releaseDate <= today()); }),
          page: meta.current_page || params.page || 1,
          totalPages: meta.last_page || 1
        };
      });
    },
    // "New releases": page n of each home studio, merged newest first
    merged: function (key, page, year) {
      var self = this;
      return Promise.all(TPDB_SITES.slice(0, HOME_STUDIOS).map(function (s) {
        var params = { site_id: s.id, page: page, per_page: 6 };
        if (year) params.year = year;
        return self.movies(key, params).then(function (p) { return p; }, function () { return null; });
      })).then(function (pages) {
        pages = pages.filter(Boolean);
        if (!pages.length) {
          throw new Error('ThePornDB didn\'t answer');
        }
        var items = [].concat.apply([], pages.map(function (p) { return p.items; }));
        items.sort(function (a, b) { return (b.releaseDate || '').localeCompare(a.releaseDate || ''); });
        return { items: items, page: page, totalPages: Math.max.apply(null, pages.map(function (p) { return p.totalPages; })) };
      });
    },
    home: function () {
      return [{ row: 'latest', title: 'New releases' }].concat(TPDB_SITES.slice(0, HOME_STUDIOS).map(function (s) {
        return { row: 'studio:' + s.id, title: s.name };
      }));
    },
    discover: function (key, o) {
      var year = this.year(o.period);
      if (!o.studio) {
        return this.merged(key, o.page || 1, year);
      }
      var params = { site_id: o.studio, page: o.page || 1 };
      if (year) params.year = year;
      return this.movies(key, params);
    },
    row: function (key, row, page) {
      var studio = /^studio:(\d+)$/.exec(row);
      return studio ? this.movies(key, { site_id: studio[1], page: page }) : this.merged(key, page);
    },
    search: function (key, o) {
      var self = this, params = { q: o.q, page: o.page || 1, per_page: 30 }, year = this.year(o.period);
      if (year) params.year = year;
      return this.get(key, '/movies', params).then(function (data) {
        var meta = data.meta || {};
        return {
          items: (data.data || []).map(function (m) { return self.item(m); })
            .filter(function (it) { return it.poster && (!it.releaseDate || it.releaseDate <= today()); }),
          page: meta.current_page || params.page,
          totalPages: meta.last_page || 1
        };
      });
    },
    title: function (key, id) {
      var self = this;
      return this.get(key, '/movies/' + encodeURIComponent(id)).then(function (data) {
        var m = data.data || data, result = self.item(m), duration = Number(m.duration) || 0, director = (m.directors || [])[0];
        return Object.assign(result, {
          runtime: duration ? Math.round(duration / 60) : null,
          performers: (m.performers || []).map(function (p) {
            return { name: p.name || (p.parent && p.parent.name) || '', photo: self.pick(p, ['face', 'parent.face', 'image', 'parent.image']) };
          }).filter(function (p) { return p.name; }),
          director: director ? director.name : null,
          browsableStudio: result.studio && /^\d+$/.test(result.studio.id) ? result.studio.id : null
        });
      });
    }
  }
};

// Scenes: studios' web releases (the second provider's `/scenes`), small studios
// included; studios are its sites, the profile's followed ones (sceneStudios) first
PROVIDERS.scenes = {
  name: 'Scenes',
  secret: 'theporndbApiKey',
  scenes: true,
  sorts: ['newest', 'longest'],
  orders: { newest: 'recently_released', longest: 'duration_desc' },
  periods: PROVIDERS.theporndb.periods,
  studios: SCENE_SITES,
  get: PROVIDERS.theporndb.get,
  pick: PROVIDERS.theporndb.pick,
  year: PROVIDERS.theporndb.year,
  item: function (m) {
    var it = PROVIDERS.theporndb.item(m), site = m.site || {};
    it.scene = true;
    it.duration = Number(m.duration) || 0;
    if (it.studio) it.studio.short = site.short_name || null;
    it.performers = (m.performers || []).map(function (p) {
      return { name: p.name || (p.parent && p.parent.name) || '', photo: this.pick(p, ['face', 'parent.face', 'image', 'parent.image']) };
    }, this).filter(function (p) { return p.name; });
    return it;
  },
  // a studio's scenes are read with its sub-sites' (site_operation Site/Parent);
  // clip stores' uploads and trailers are left out
  list: function (key, params) {
    var self = this;
    params = Object.assign({ per_page: 30, orderBy: 'recently_released' }, params);
    if (params.site_id) params.site_operation = 'Site/Parent';
    return this.get(key, '/scenes', params).then(function (data) {
      var meta = data.meta || {};
      return {
        items: (data.data || []).filter(function (m) { return !clipStore(m.site) && !sceneExtra(m); })
          .map(function (m) { return self.item(m); })
          .filter(function (it) { return it.poster && (!it.releaseDate || it.releaseDate <= today()); }),
        page: meta.current_page || params.page || 1,
        totalPages: meta.last_page || 1
      };
    });
  },
  // "New scenes": page n of each studio (the followed ones, else the usual ones), merged newest
  // first; across every studio the newest entries are scheduled ones (future dates, left out)
  merged: function (key, studios, page, year, sort) {
    var self = this, longest = sort === 'longest';
    return Promise.all(studios.slice(0, 12).map(function (id) {
      var params = { site_id: id, page: page, per_page: 6, orderBy: self.orders[sort] || self.orders.newest };
      if (year) params.year = year;
      return self.list(key, params).then(function (p) { return p; }, function () { return null; });
    })).then(function (pages) {
      pages = pages.filter(Boolean);
      if (!pages.length) {
        throw new Error('ThePornDB didn\'t answer');
      }
      var seen = {}, items = [].concat.apply([], pages.map(function (p) { return p.items; })).filter(function (it) {
        return !seen[it.id] && (seen[it.id] = true);
      });
      items.sort(longest ? function (a, b) { return b.duration - a.duration; } :
        function (a, b) { return (b.releaseDate || '').localeCompare(a.releaseDate || ''); });
      return { items: items, page: page, totalPages: Math.max.apply(null, pages.map(function (p) { return p.totalPages; })) };
    });
  },
  studiosOf: function (followed) {
    return (followed && followed.length ? followed : SCENE_SITES.slice(0, HOME_STUDIOS)).map(function (s) { return s.id; });
  },
  home: function (followed) {
    return [{ row: 'latest', title: 'New scenes', studios: this.studiosOf(followed).join(',') }].concat((followed || []).map(function (s) {
      return { row: 'studio:' + s.id, title: s.name };
    }));
  },
  discover: function (key, o) {
    var year = this.year(o.period);
    if (!o.studio) {
      return this.merged(key, String(o.studios || '').split(',').filter(Boolean).length ? String(o.studios).split(',') : this.studiosOf(), o.page || 1, year, o.sort);
    }
    var params = { site_id: o.studio, page: o.page || 1, orderBy: this.orders[o.sort] || this.orders.newest };
    if (year) params.year = year;
    return this.list(key, params);
  },
  row: function (key, row, page, args) {
    var studio = /^studio:(\d+)$/.exec(row);
    if (studio) {
      return this.list(key, { site_id: studio[1], page: page });
    }
    var studios = String((args && args.studios) || '').split(',').filter(Boolean);
    return this.merged(key, studios.length ? studios : this.studiosOf(), page);
  },
  // most relevant first: newest first, a search's words mostly match clip stores' uploads
  search: function (key, o) {
    var params = { q: o.q, page: o.page || 1, orderBy: 'most_relevant' }, year = this.year(o.period);
    if (year) params.year = year;
    return this.list(key, params);
  },
  title: function (key, id) {
    var self = this;
    return this.get(key, '/scenes/' + encodeURIComponent(id)).then(function (data) {
      var m = data.data || data, result = self.item(m), duration = Number(m.duration) || 0, director = (m.directors || [])[0];
      return Object.assign(result, {
        runtime: duration ? Math.round(duration / 60) : null,
        director: director ? director.name : null,
        browsableStudio: result.studio && /^\d+$/.test(result.studio.id) ? result.studio.id : null
      });
    });
  }
};

/**
 * The catalog this profile uses: its choice when its key is set, else the
 * other one that has a key; null when neither has: { id, provider, key }
 */
function catalogFor(ctx, wanted) {
  return Promise.all([
    wanted ? Promise.resolve(wanted) : playpex.settings.get('metadataProvider', ctx),
    playpex.secrets.get('tmdbApiKey'),
    playpex.secrets.get('theporndbApiKey')
  ]).then(function (r) {
    var keys = { tmdb: r[1], theporndb: r[2], scenes: r[2] },
      order = r[0] === 'theporndb' ? ['theporndb', 'tmdb'] : ['tmdb', 'theporndb'],
      id = wanted ? (keys[wanted] ? wanted : null) : order.filter(function (k) { return keys[k]; })[0];
    return id ? { id: id, provider: PROVIDERS[id], key: keys[id] } : null;
  });
}

var NO_KEY = 'The 18+ catalog needs a TMDB API key or a ThePornDB one: enter it in the 18+ plugin\'s settings on the server\'s dashboard.';

/**
 * The studios this profile follows for scenes (setting sceneStudios: names, comma
 * separated), each found among the provider's sites: [{ id, name, short }]
 */
function followedStudios(ctx, s) {
  if (!s) {
    return Promise.resolve([]);
  }
  return playpex.settings.get('sceneStudios', ctx).then(function (text) {
    var names = String(text || '').split(/[,\n]/).map(function (n) { return n.trim(); }).filter(Boolean).slice(0, 12);
    return Promise.all(names.map(function (name) {
      return s.provider.get(s.key, '/sites', { q: name, per_page: 10 }).then(function (data) {
        var list = (data.data || []).filter(function (x) { return !clipStore(x); }), wanted = compact(name),
          site = list.filter(function (x) { return compact(x.name) === wanted || compact(x.short_name) === wanted; })[0] || list[0];
        return site ? { id: String(site.id), name: site.name, short: site.short_name || null } : null;
      }, function () { return null; });
    }));
  }).then(function (sites) {
    var seen = {};
    return sites.filter(function (x) { return x && !seen[x.id] && (seen[x.id] = true); });
  });
}

// ── Sex-Empire (streams) ────────────────────────────────────────────────────
//
// A free site of full films (sex-empere.org, checked Nov 2026: no account).
// Its film pages embed players from video hosts; the ones read here give a
// stream the server can proxy: VidHide (an HLS playlist in a packed script)
// and DoodStream (an MP4 behind /pass_md5/). Other hosts are skipped. A film's
// identity is its number on the site: /en/<id>-x.html redirects to its English
// page. Its search is the form's POST to /en/ (a GET there ignores the words):
// English titles, original ones matched too, 24 a page.

var SE = 'https://sex-empere.org';
var SE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36' };
// The hosts read (an embed elsewhere is skipped) and the CDNs their streams
// come from (checked Nov 2026; permissions.network lists them all: the server
// refuses any other). VidHide's hls3 links use throwaway domains: not taken
var SE_EMBED_HOSTS = ['morencius.com', 'playmogo.com'];
var SE_STREAM_HOSTS = ['morencius.com', 'acek-cdn.com', 'dramiyos-cdn.com', 'cloudatacdn.com'];
var SE_QUALITY = { '2160P': '2160p', '4K': '2160p', '1080P': '1080p', 'FULLHD': '1080p', '720P': '720p', 'HD': '720p', '480P': '480p' };

/** A page's text (a form's answer with `o.form`), cached an hour (embed pages aren't: their tokens expire) */
function getText(url, o) {
  o = o || {};
  var key = o.form ? url + '\n' + qs(o.form) : url;
  var hit = !o.fresh && cache[key];
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var request = { url: url, headers: Object.assign({}, SE_HEADERS, o.headers || {}), timeoutMs: o.timeoutMs || 4000 };
  if (o.form) {
    request.method = 'POST';
    request.body = qs(o.form);
    request.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  var value = playpex.http.request(request).then(function (res) {
    if (res.status !== 200) {
      throw new Error(url.split('?')[0] + ' answered HTTP ' + res.status);
    }
    return String(res.body);
  });
  if (!o.fresh) {
    cache[key] = { value: value, expires: Date.now() + (o.ttlMs || CACHE_MS) };
    value.catch(function () { delete cache[key]; });
  }
  return value;
}

function stripTags(html) {
  return unescapeHtml(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** A listing's (home, search, page N) films: [{ id, title, year, poster, quality }] */
function seList(html) {
  var out = [], seen = {}, re = /<a class="item item-poster[^"]*" href="([^"]+)">([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(String(html)))) {
    var id = (/\/(\d+)-[^/]*\.html$/.exec(m[1]) || [])[1];
    if (!id || seen[id]) continue;
    seen[id] = true;
    var body = m[2],
      title = stripTags((/item-poster__title[^>]*>([\s\S]*?)<\/div>/.exec(body) || [])[1]),
      meta = stripTags((/item-poster__meta[^>]*>([\s\S]*?)<\/div>/.exec(body) || [])[1]),
      poster = (/<img[^>]*src="(https:\/\/[^"]+)"/.exec(body) || [])[1] || null,
      year = Number((/\b(19|20)\d\d\b/.exec(meta) || [])[0]) || null,
      quality = (/\b(2160p|1080p|720p|480p)\b/i.exec(meta) || [])[1];
    out.push({ id: id, title: title, year: year, poster: poster, quality: quality ? quality.toLowerCase() : null });
  }
  return out;
}

function seField(html, label) {
  var m = new RegExp('<li><span>' + label + ':</span>([\\s\\S]*?)</li>').exec(html);
  return m ? stripTags(m[1]).replace(/\s*,\s*/g, ', ').replace(/^, |, $/g, '') : '';
}

/** A film's English page → { id, title, year, runtime, director, performers, genres, country, languages, poster, quality, embeds } */
function seFilm(html, id) {
  html = String(html);
  var duration = /(\d+):(\d\d):(\d\d)/.exec(seField(html, 'Duration')),
    rating = stripTags((/<div class="item__rating">([\s\S]*?)<\/div>/.exec(html) || [])[1]).toUpperCase(),
    embeds = [], re = /\.src\s*=\s*"(https:\/\/[^"]+)"/g, m;
  while ((m = re.exec(html))) {
    var url = m[1].replace(/\?.*$/, '');
    // an empty slot ("…/embed/") has no film id
    if (/\/(e|embed|d)\/[A-Za-z0-9]{6,}$/.test(url) && embeds.indexOf(url) === -1) embeds.push(url);
  }
  return {
    id: String(id || (/doRate\('plus', '(\d+)'\)/.exec(html) || [])[1] || ''),
    title: stripTags((/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html) || [])[1]),
    year: Number(seField(html, 'Release year')) || null,
    runtime: duration ? Number(duration[1]) * 60 + Number(duration[2]) : null,
    director: seField(html, 'Directed by') || null,
    performers: seField(html, 'Casting').split(', ').filter(Boolean).map(function (n) { return { name: n }; }),
    genres: seField(html, 'Genre'),
    country: seField(html, 'Country'),
    languages: seField(html, 'Language'),
    poster: (/<meta property="og:image" content="(https:\/\/[^"]+)"/.exec(html) || [])[1] || null,
    quality: SE_QUALITY[rating] || null,
    embeds: embeds
  };
}

function seFilmById(id) {
  return getText(SE + '/en/' + encodeURIComponent(id) + '-x.html').then(function (html) { return seFilm(html, id); });
}

var SE_SEARCH_SIZE = 24;        // results per page of the site's search

/** A page of the site's search: { list: [{ id, title, year, poster, quality }], total } */
function seSearchPage(q, page) {
  return getText(SE + '/en/', { form: { do: 'search', subaction: 'search', story: q, search_start: page > 1 ? page : null } }).then(function (html) {
    // "Found 44 responses (Query results 1 - 24)"
    var total = Number((/Found\s+(\d+)\s+respons/i.exec(html) || [])[1]);
    var list = seList(html);
    return { list: list, total: isFinite(total) && total > 0 ? total : list.length };
  });
}

/** The site's search, its first page */
function seSearch(q) {
  return seSearchPage(q, 1).then(function (p) { return p.list; });
}

/** The newest films, with English titles */
function seLatest(page) {
  return getText(SE + '/en/' + (page > 1 ? 'page/' + page + '/' : '')).then(seList);
}

/** The site's film for a catalog title (TMDB / the second provider), or null: same title, year ±1 */
function seFind(title, year) {
  var wanted = compact(title);
  if (!wanted) {
    return Promise.resolve(null);
  }
  // the results' English titles compared: only the film's own page is read
  return seSearch(title).then(function (list) {
    var f = list.filter(function (x) { return compact(x.title) === wanted && (!year || !x.year || Math.abs(x.year - year) <= 1); })[0];
    return f ? seFilmById(f.id).then(function (film) {
      return compact(film.title) === wanted ? Object.assign(film, { quality: film.quality || SE_QUALITY[String(f.quality || '').toUpperCase()] || null }) : null;
    }) : null;
  });
}

// Dean Edwards' packer undone without running it: the payload's words are
// base-N indexes into the dictionary
function unpack(html) {
  var m = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(String(html));
  if (!m) return null;
  var payload = m[1].replace(/\\'/g, '\'').replace(/\\\\/g, '\\'), radix = Number(m[2]), dict = m[4].split('|'),
    digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (radix < 2 || radix > 62) return null;
  return payload.replace(/\b\w+\b/g, function (w) {
    var n = 0;
    for (var i = 0; i < w.length; i++) {
      var d = digits.indexOf(w[i]);
      if (d < 0 || d >= radix) return w;
      n = n * radix + d;
    }
    return n < dict.length && dict[n] ? dict[n] : w;
  });
}

/**
 * A stream's headers: the player page's host as the Referer, and the User-Agent
 * the page was read with (video hosts' tokens can hold for that one only)
 */
function streamHeaders(page) {
  return { 'User-Agent': SE_HEADERS['User-Agent'], Referer: originOf(page) + '/' };
}

function originOf(url) {
  return (/^https:\/\/[^/]+/.exec(url) || [''])[0];
}

/** Whether the URL's host is one of these domains or under one */
function onHosts(url, domains) {
  var host = originOf(url).slice(8).toLowerCase();
  return !!host && domains.some(function (d) { return host === d || host.slice(-(d.length + 1)) === '.' + d; });
}

/** VidHide: the packed player's `links` (hls4 / hls3 may be relative to the embed's host) */
function vidhideStream(html, embed) {
  var code = unpack(html);
  var links = code && /links\s*=\s*(\{[^}]*\})/.exec(code);
  if (!links) return null;
  try { links = JSON.parse(links[1]); } catch (e) { return null; }
  var url = [links.hls2, links.hls4, links.hls3].map(function (u) {
    return typeof u === 'string' && u[0] === '/' ? originOf(embed) + u : u;
  }).filter(function (u) { return typeof u === 'string' && onHosts(u, SE_STREAM_HOSTS); })[0];
  return url ? { kind: 'hls', url: url, headers: streamHeaders(embed), host: 'VidHide' } : null;
}

/** DoodStream: /pass_md5/… answers the file's base; the player adds 10 random characters, its token and the time */
function doodStream(html, embed) {
  // no pass_md5: the host asks for a captcha (it does after many plays from one address)
  var pass = /\/pass_md5\/[^'"\s]+/.exec(html), token = /[?&]token=([A-Za-z0-9]+)/.exec(html);
  if (!pass || !token) return null;
  var origin = originOf(embed);
  return getText(origin + pass[0], { fresh: true, headers: { Referer: embed }, timeoutMs: 3000 }).then(function (base) {
    base = base.trim();
    // "RELOAD": an expired page; another CDN: one the server would refuse
    if (!/^https:\/\/\S+$/.test(base) || !onHosts(base, SE_STREAM_HOSTS)) return null;
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', tail = '';
    for (var i = 0; i < 10; i++) tail += chars.charAt(Math.floor(Math.random() * chars.length));
    return { kind: 'http', url: base + tail + '?token=' + token[1] + '&expiry=' + Date.now(), headers: streamHeaders(embed), host: 'DoodStream', container: 'mp4' };
  });
}

/** An embed page → a stream { kind, url, headers, host } or null (a host it can't read, or it didn't answer) */
function resolveEmbed(embed) {
  return getText(embed, { fresh: true, headers: { Referer: SE + '/' }, timeoutMs: 3000 }).then(function (html) {
    if (/\/pass_md5\//.test(html)) return doodStream(html, embed);
    if (/eval\(function\(p,a,c,k,e,d\)/.test(html)) return vidhideStream(html, embed);
    return null;
  }).catch(function (err) {
    playpex.log.info('Sex-Empire: an embed didn\'t play', { host: originOf(embed), error: err.message });
    return null;
  });
}

/** A film's streams as the core's sources (best first: HLS, then the MP4) */
function seSources(film) {
  var embeds = film.embeds.filter(function (e) { return onHosts(e, SE_EMBED_HOSTS); }).slice(0, 4);
  return Promise.all(embeds.map(resolveEmbed)).then(function (streams) {
    var notes = ['Sex-Empire'].concat(film.languages ? [clip('Audio: ' + film.languages, 80)] : []);
    return streams.filter(Boolean).sort(function (a, b) { return (a.kind === 'hls' ? 0 : 1) - (b.kind === 'hls' ? 0 : 1); }).map(function (s) {
      var source = { kind: s.kind, url: s.url, headers: s.headers, label: clip(film.title + (film.year ? ' (' + film.year + ')' : '') + ' · ' + s.host, 200), notes: notes };
      if (film.quality) source.quality = film.quality;
      if (s.container) source.container = s.container;
      return source;
    });
  });
}

/** Whether the admin left the source on (setting sexEmpire) */
function seOn(ctx) {
  return playpex.settings.get('sexEmpire', ctx).then(function (v) { return v !== false; }, function () { return true; });
}

// A site film as a catalog item (cards, the title page)
function seItem(f) {
  var lines = [f.genres, f.country, f.languages ? 'Audio: ' + f.languages : ''].filter(Boolean);
  return {
    id: f.id, title: f.title, year: f.year, poster: f.poster, backdrop: null,
    overview: lines.join(' · '), studio: { name: 'Sex-Empire' },
    runtime: f.runtime, director: f.director, performers: f.performers || []
  };
}

/**
 * Find releases' Sex-Empire: a page of its search (24, in English), else of
 * its newest films → { films, more }
 */
function seReleases(q, page) {
  if (!q) {
    return seLatest(page).then(function (list) { return { films: list, more: list.length > 0 && page < MAX_PAGE }; });
  }
  return seSearchPage(q, page).then(function (p) {
    return { films: p.list, more: p.list.length > 0 && page * SE_SEARCH_SIZE < p.total };
  });
}

/** A site film as a direct link of the releases template (played by the play handler) */
function seRelease(f) {
  var out = {
    title: clip(f.title + (f.year ? ' (' + f.year + ')' : ''), 300),
    call: { data: 'play', args: { provider: 'sexempire', id: f.id } },
    via: 'Sex-Empire',
    notes: [f.runtime ? f.runtime + ' min' : '', f.genres, f.languages ? 'Audio: ' + f.languages : '']
      .filter(Boolean).map(function (n) { return clip(n, 80); }).slice(0, 6)
  };
  if (f.quality) out.quality = f.quality;
  return out;
}

/** A row of the site: its search or its newest films, paged */
function seRowPage(args, page) {
  if (args.q) {
    return seSearchPage(args.q, page).then(function (p) {
      return { items: p.list, last: !p.list.length || page * SE_SEARCH_SIZE >= p.total };
    });
  }
  return seLatest(page).then(function (list) {
    return { items: list, last: !list.length || page >= MAX_PAGE };
  });
}

// ── TheSexTube: studios only (streams) ──────────────────────────────────────
//
// thesextube.net (WordPress, its REST API open; checked Nov 2026) also posts
// a lot of personal and leaked videos: those are never read. Only posts the
// site tags with one of the studios below are asked for, every tag of
// personal videos excluded in the query itself, and a title naming one is
// dropped too; a post given back to Play (an id from a client) is checked the
// same way before anything plays. Playboy TV's posts are left out: their
// Streamtape links were all gone (2021 posts). The videos are on LuluStream:
// a packed JW Player page → an HLS playlist (AES-128, keys on the same CDN),
// H.264 + AAC.

var TST_API = 'https://thesextube.net/wp-json/wp/v2/';
var TST_STUDIOS = [
  { id: 'ersties', name: 'Ersties', tag: 4599 },
  { id: 'lustery', name: 'Lustery', tag: 15789 },
  { id: 'playboyplus', name: 'Playboy Plus', tag: 4175 }
];
// the site's tags of personal / leaked videos (onlyfans, fansly, patreon, youtube, youtuber, instagram,
// twitch, tiktok, snapchat, celebrity, sex-tape, leaked, leak, manyvids, amateur, homemade, private)
var TST_PERSONAL = [5777, 23028, 16894, 17619, 17798, 3045, 17039, 18377, 3787, 25310, 5761, 3409, 30034, 18337, 3668, 29748, 5008];
var TST_PERSONAL_WORDS = /leak|only ?fans|\bppv\b|sex ?tape|fansly|patreon|snapchat|manyvids|homemade|private (video|show)/i;
var TST_HOSTS = ['luluvido.com', 'luluvdoo.com', 'luluvdo.com', 'lulustream.com'];
var TST_STREAM_HOSTS = ['tnmr.org', 'cdn-tnmr.org'];
var TST_PAGE = 24;

/** A post of one of the studios and nothing personal, else false */
function tstAllowed(post) {
  var tags = post.tags || [], title = unescapeHtml(post.title && post.title.rendered || '');
  return TST_STUDIOS.some(function (s) { return tags.indexOf(s.tag) !== -1; }) &&
    !tags.some(function (t) { return TST_PERSONAL.indexOf(t) !== -1; }) && !TST_PERSONAL_WORDS.test(title);
}

/** A post → { id, title, studio, date, video (its LuluStream page), poster } or null (not allowed, no video) */
function tstItem(post) {
  if (!tstAllowed(post)) return null;
  var links = (String(post.content && post.content.rendered || '').match(/href="(https:\/\/[^"]+)"/g) || [])
    .map(function (h) { return unescapeHtml(h.slice(6, -1)); });
  var video = links.filter(function (u) { return onHosts(u, TST_HOSTS); })[0];
  if (!video) return null;
  var studio = TST_STUDIOS.filter(function (s) { return post.tags.indexOf(s.tag) !== -1; })[0],
    code = (/\/(?:e\/|d\/)?([a-z0-9]{8,})(?:[/?#]|$)/i.exec(video.replace(/^https:\/\/[^/]+/, '')) || [])[1];
  return {
    id: String(post.id),
    title: unescapeHtml(post.title.rendered).replace(/\s+/g, ' ').trim(),
    studio: studio.name,
    date: post.date ? String(post.date).slice(0, 10) : null,
    video: video,
    // LuluStream's own still of the video
    poster: code ? 'https://img.lulucdn.com/' + code + '_xt.jpg' : null
  };
}

function tstGet(path, params) {
  return getText(TST_API + path + '?' + qs(params), { timeoutMs: 5000 }).then(function (text) { return JSON.parse(text); });
}

/** A page of the studios' posts (the words searched, else the newest) → { items, more } */
function tstPosts(q, page, studios) {
  var tags = (studios || TST_STUDIOS).map(function (s) { return s.tag; });
  return tstGet('posts', { tags: tags.join(','), tags_exclude: TST_PERSONAL.join(','), search: q || null, page: page,
    per_page: TST_PAGE, _fields: 'id,date,title,content,tags' }).then(function (posts) {
    var items = (Array.isArray(posts) ? posts : []).map(tstItem).filter(Boolean);
    return { items: items, more: Array.isArray(posts) && posts.length === TST_PAGE };
  }, function (err) {
    // past the last page WordPress answers 400
    if (/HTTP 400/.test(err.message)) return { items: [], more: false };
    throw err;
  });
}

/** One post by id, only when it's a studio's (a client gives the id) */
function tstPost(id) {
  if (!/^\d{1,9}$/.test(String(id))) return Promise.resolve(null);
  return tstGet('posts/' + id, { _fields: 'id,date,title,content,tags' }).then(tstItem, function (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  });
}

/** LuluStream's page → its HLS source, or null */
function tstStream(item) {
  return getText(item.video, { fresh: true, headers: { Referer: 'https://thesextube.net/' }, timeoutMs: 4000 }).then(function (html) {
    var code = unpack(html), file = code && /file\s*:\s*"(https:\/\/[^"]+\.m3u8[^"]*)"/.exec(code);
    if (!file || !onHosts(file[1], TST_STREAM_HOSTS)) return null;
    // the CDN's token holds for the User-Agent the page was read with
    return { kind: 'hls', url: file[1], headers: streamHeaders(item.video), label: clip(item.title, 200),
      notes: [item.studio, 'TheSexTube'].concat(item.date ? [item.date] : []) };
  }).catch(function (err) {
    playpex.log.info('TheSexTube: a video didn\'t play', { host: originOf(item.video), error: err.message });
    return null;
  });
}

function tstOn(ctx) {
  return playpex.settings.get('theSexTube', ctx).then(function (v) { return v !== false; }, function () { return true; });
}

/** A post as a direct link of the releases template */
function tstRelease(it) {
  var out = { title: clip(it.title, 300), call: { data: 'play', args: { provider: 'thesextube', id: it.id } }, via: it.studio,
    notes: ['TheSexTube'] };
  if (it.date) out.uploadedAt = it.date + 'T00:00:00Z';
  return out;
}

/** A scene's TheSexTube stream as a list ([] when switched off, not one of the studios', not found) */
function tstStreamsFor(ctx, scene) {
  return tstOn(ctx).then(function (on) {
    return on ? tstSceneStream(scene).then(function (s) { return s ? [s] : []; }) : [];
  }).catch(function (err) {
    playpex.log.info('TheSexTube didn\'t answer', { error: err.message });
    return [];
  });
}

/** A scene of one of the studios (the second provider's) → its post's stream, or null */
function tstSceneStream(scene) {
  var studio = scene.studio && TST_STUDIOS.filter(function (s) {
    return compact(scene.studio.name) === compact(s.name) || compact(scene.studio.short) === s.id;
  })[0];
  var wanted = compact(scene.title);
  if (!studio || wanted.length < 6) return Promise.resolve(null);
  return tstPosts(scene.title, 1, [studio]).then(function (p) {
    var it = p.items.filter(function (x) { return compact(x.title).indexOf(wanted) !== -1; })[0];
    return it ? tstStream(it) : null;
  });
}

// ── Sites: tube sites on the big screen (the "Sites" view) ──────────────────
//
// The third View of the section (Posters, List, Sites): a site's own rows
// (trending, newest, best), its categories, performers and channels, its
// search, its videos played from its HLS streams. One site for now
// (xHamster); SITES is the list the Site filter offers.
//
// xHamster (checked Nov 2026): every page carries its data as JSON
// (`window.initials`): a listing's videos are its `videoThumbProps` (46 a
// page; the longest such list on the page), a video page its `videoModel`,
// `videoTagsComponent` (categories, performers, channel) and
// `xplayerSettings.sources`, whose URLs are ciphered: a hex string whose byte
// 0 names a generator, bytes 1–4 its seed (little-endian int32), and the
// rest XORed with its bytes (as yt-dlp's extractor reads them). The H.264
// HLS playlist plays as it is (AAC audio, up to 1080p); the MP4 links are
// tied to the reader's address, not used. Listing URLs:
//   <base>[/hd | /4k][/newest | /best/weekly | /best/monthly][/<page>]?quality=1080p&min-duration=…&max-duration=…
//   base: '' (the whole site), /categories/<slug>, /pornstars/<slug>, /channels/<slug>, /creators/<slug>
//   search: /search/<words>?sort=newest&page=<n> (and the same quality / duration parameters)

var XH = 'https://xhamster.com';
var XH_HOSTS = ['xhamster.com', 'xhcdn.com'];
var XH_PAGE_MS = 10 * 60 * 1000;   // listings change often: 10 minutes

// The Category filter (the site has some 400; these are its most used)
var XH_CATEGORIES = [
  ['amateur', 'Amateur'], ['anal', 'Anal'], ['asian', 'Asian'], ['babe', 'Babe'], ['bbw', 'BBW'], ['big-ass', 'Big Ass'],
  ['big-natural-tits', 'Big Natural Tits'], ['big-tits', 'Big Tits'], ['blonde', 'Blonde'], ['blowjob', 'Blowjob'],
  ['brunette', 'Brunette'], ['couple', 'Couple'], ['creampie', 'Creampie'], ['cumshot', 'Cumshot'], ['black', 'Ebony'],
  ['european', 'European'], ['hardcore', 'Hardcore'], ['homemade', 'Homemade'], ['interracial', 'Interracial'],
  ['japanese', 'Japanese'], ['latina', 'Latina'], ['lesbian', 'Lesbian'], ['lingerie', 'Lingerie'], ['massage', 'Massage'],
  ['female-masturbation', 'Masturbation'], ['mature', 'Mature'], ['milf', 'MILF'], ['orgasm', 'Orgasm'], ['outdoor', 'Outdoor'],
  ['pov', 'POV'], ['public-sex', 'Public'], ['redhead', 'Redhead'], ['russian', 'Russian'], ['small-tits', 'Small Tits'],
  ['solo', 'Solo'], ['squirting', 'Squirting'], ['stockings', 'Stockings'], ['threesome', 'Threesome'], ['vintage', 'Vintage'],
  ['webcam', 'Webcam']
].map(function (c) { return { slug: c[0], name: c[1] }; });

// A home row of each of these (after the site's own rows)
var XH_HOME_CATEGORIES = ['amateur', 'milf', 'lesbian', 'anal', 'asian', 'homemade', 'massage', 'big-tits', 'latina', 'black', 'japanese', 'mature'];

var XH_SORTS = { trending: '', newest: '/newest', weekly: '/best/weekly', monthly: '/best/monthly' };
var XH_SORT_NAMES = { trending: 'Trending', newest: 'Newest', weekly: 'Best this week', monthly: 'Best this month' };
var XH_QUALITIES = [['720p', 'HD'], ['1080p', '1080p'], ['2160p', '4K']];
var XH_DURATIONS = [['10', '10+ min'], ['30', '30+ min'], ['60', '1 h+']];

// ciphered source URLs: the generators, by byte 0 (all 32-bit)
var XH_ALGOS = {
  1: function (g) { g.s = (Math.imul(g.s, 1664525) + 1013904223) | 0; return g.s; },
  2: function (g) { var s = g.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; g.s = s | 0; return g.s; },
  3: function (g) {
    var s = g.s = (g.s + 0x9e3779b9) | 0;
    s ^= s >>> 16; s = Math.imul(s, 0x85ebca77); s ^= s >>> 13; s = Math.imul(s, 0xc2b2ae3d);
    return (s ^ (s >>> 16)) | 0;
  },
  4: function (g) {
    var s = g.s = (g.s + 0x6d2b79f5) | 0;
    s = (s << 7) | (s >>> 25); s = (s + 0x9e3779b9) | 0; s ^= s >>> 11;
    return Math.imul(s, 0x27d4eb2d);
  },
  5: function (g) { var s = g.s; s ^= s << 7; s ^= s >>> 9; s ^= s << 8; g.s = (s + 0xa5a5a5a5) | 0; return g.s; },
  6: function (g) {
    var s = g.s = (Math.imul(g.s, 0x2c9277b5) + 0xac564b05) | 0;
    return ((s ^ (s >>> 18)) >>> ((s >>> 27) & 31)) | 0;
  },
  7: function (g) {
    var s = g.s = (g.s + 0x9e3779b9) | 0, e = s ^ (s << 5);
    e = Math.imul(e, 0x7feb352d); e ^= e >>> 15;
    return Math.imul(e, 0x846ca68b);
  }
};

function xhDecipherHex(hex) {
  var bytes = [];
  for (var i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  var algo = XH_ALGOS[bytes[0]];
  if (!algo || bytes.length < 6) return null;
  var g = { s: bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24) }, out = '';
  for (var j = 5; j < bytes.length; j++) out += String.fromCharCode(bytes[j] ^ (algo(g) & 0xff));
  return out;
}

/** A source URL as the page gives it (ciphered whole, or a URL with a ciphered first segment) → the URL, or null */
function xhDecipherUrl(u) {
  u = String(u || '');
  if (/^[0-9a-fA-F]{12,}$/.test(u)) return xhDecipherHex(u);
  var m = /^(https:\/\/[^/]+)\/([0-9a-fA-F]{12,})([\/,].+)$/.exec(u);
  if (m) {
    var d = xhDecipherHex(m[2]);
    return d ? m[1] + '/' + d + m[3] : null;
  }
  return /^https:\/\//.test(u) ? u : null;
}

function xhOn(ctx) {
  return playpex.settings.get('xhamster', ctx).then(function (v) { return v !== false; }, function () { return true; });
}

/** A page's `window.initials` (cached 10 minutes unless `fresh`) */
function xhPage(path, fresh) {
  return getText(XH + path, { fresh: fresh, timeoutMs: 8000, ttlMs: XH_PAGE_MS }).then(function (html) {
    var m = /window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html);
    if (!m) throw new Error('xHamster answered a page without its data');
    return JSON.parse(m[1]);
  });
}

/** The listing of a page: its longest `videoThumbProps` list */
function xhThumbs(o) {
  var best = [];
  (function walk(x, depth) {
    if (!x || typeof x !== 'object' || depth > 8) return;
    if (Array.isArray(x)) {
      for (var i = 0; i < x.length; i++) walk(x[i], depth + 1);
      return;
    }
    Object.keys(x).forEach(function (k) {
      if (k === 'videoThumbProps' && Array.isArray(x[k])) {
        if (x[k].length > best.length) best = x[k];
      } else {
        walk(x[k], depth + 1);
      }
    });
  })(o, 0);
  return best;
}

/** A video's id: the last segment of its page's path (/videos/<slug>-<id>) */
function xhIdOf(pageUrl) {
  var m = /\/videos\/([A-Za-z0-9-]+)\/?$/.exec(String(pageUrl || ''));
  return m ? m[1] : null;
}

function xhLength(seconds) {
  var s = Math.max(0, Math.round(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r : m + ':' + (r < 10 ? '0' : '') + r;
}

function xhViews(n) {
  n = Number(n) || 0;
  return n >= 1e6 ? (Math.round(n / 1e5) / 10) + 'M views' : n >= 1e3 ? Math.round(n / 1e3) + 'K views' : n + ' views';
}

function xhDate(created) {
  var t = Number(created) || 0;
  return t ? new Date(t * 1000).toISOString().slice(0, 10) : null;
}

/** A listing's video → { id, title, duration, views, date, thumb, image } */
function xhItem(v) {
  return {
    id: xhIdOf(v.pageURL), title: v.title || 'Untitled', duration: Number(v.duration) || 0, views: Number(v.views) || 0,
    date: xhDate(v.created), thumb: v.thumbURL || v.imageURL || null, image: v.imageURL || v.thumbURL || null
  };
}

function xhGood(it) {
  return it.id && it.thumb && onHosts(it.thumb, XH_HOSTS);
}

/**
 * A listing's path: o = { base ('' or /categories/<slug>, /pornstars/<slug>…), q (a search), sort, quality, duration, page }
 */
function xhPath(o) {
  var page = Math.max(1, o.page || 1), params = {};
  if (o.quality === '1080p') params.quality = '1080p';
  if (o.duration) params['min-duration'] = o.duration;
  if (o.q) {
    if (o.sort === 'newest') params.sort = 'newest';
    if (page > 1) params.page = page;
    var query = qs(params);
    return '/search/' + encodeURIComponent(o.q) + (query ? '?' + query : '');
  }
  var path = o.base || '';
  // the whole site and categories have quality paths; performers and channels don't
  if (!o.base || /^\/categories\//.test(o.base)) {
    if (o.quality === '2160p') path += '/4k';
    else if (o.quality === '720p' || o.quality === '1080p') path += '/hd';
  }
  path += XH_SORTS[o.sort] || '';
  if (page > 1) path += '/' + page;
  var q2 = qs(params);
  return (path || '/') + (q2 ? '?' + q2 : '');
}

/** A page of a listing: { items, last } */
function xhList(o) {
  return xhPage(xhPath(o)).then(function (data) {
    var seen = {}, items = xhThumbs(data).map(xhItem).filter(function (it) {
      return xhGood(it) && !seen[it.id] && (seen[it.id] = true);
    });
    return { items: items, last: items.length < 10 || (o.page || 1) >= 200 };
  });
}

/** Thumbnails of the categories, by slug (from the site's categories page, cached an hour) */
function xhCategoryThumbs() {
  return getText(XH + '/categories', { timeoutMs: 8000, ttlMs: 6 * CACHE_MS }).then(function (html) {
    var m = /window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html), out = {};
    if (!m) return out;
    (function walk(x, depth) {
      if (!x || typeof x !== 'object' || depth > 8) return;
      if (Array.isArray(x)) { x.forEach(function (y) { walk(y, depth + 1); }); return; }
      var slug = typeof x.url === 'string' && /\/categories\/([a-z0-9-]+)$/.exec(x.url);
      if (slug && typeof x.thumb === 'string' && onHosts(x.thumb, XH_HOSTS)) out[slug[1]] = x.thumb;
      Object.keys(x).forEach(function (k) { walk(x[k], depth + 1); });
    })(JSON.parse(m[1]), 0);
    return out;
  }).catch(function () { return {}; });
}

/** One video's page → its details and its tags: { item, stars, channel, categories, related, sources } */
function xhVideo(id, fresh) {
  return xhPage('/videos/' + encodeURIComponent(id), fresh).then(function (data) {
    var v = data.videoModel || {}, tags = ((data.videoTagsComponent || {}).tags || []);
    var who = function (t) { return { name: t.name, path: (/^https:\/\/[^/]+(\/[a-z]+\/[A-Za-z0-9_-]+)$/.exec(t.url || '') || [])[1] }; };
    var related = (((data.relatedVideosComponent || {}).videoTabInitialData || {}).videoListProps || {}).videoThumbProps || [];
    return {
      item: Object.assign(xhItem(v), { id: id, rating: v.rating && Number(v.rating.value) || null, description: v.description || '' }),
      stars: tags.filter(function (t) { return t.isPornstar || t.isCreator; }).map(who).filter(function (t) { return t.path; }),
      channel: tags.filter(function (t) { return t.isChannel || t.isBrand; }).map(who).filter(function (t) { return t.path; })[0] || null,
      categories: tags.filter(function (t) { return t.isCategory && /\/categories\//.test(t.url || ''); }).map(function (t) { return t.name; }),
      related: related.map(xhItem).filter(xhGood),
      sources: (data.xplayerSettings || {}).sources || {}
    };
  });
}

/** A video's stream: its H.264 HLS playlist (read fresh: its token expires), as a play source */
function xhStream(id) {
  return xhVideo(id, true).then(function (v) {
    var hls = v.sources.hls || {}, h264 = hls.h264 || {};
    var url = [h264.url, h264.fallback, typeof hls.url === 'string' ? hls.url : null].map(function (u) {
      return u ? xhDecipherUrl(u) : null;
    }).filter(function (u) { return u && /\.m3u8(\?|$)/.test(u) && onHosts(u, XH_HOSTS); })[0];
    if (!url) {
      playpex.log.info('xHamster: no stream found', { id: id });
      return null;
    }
    return {
      video: v,
      source: { kind: 'hls', url: url, headers: { 'User-Agent': SE_HEADERS['User-Agent'], Referer: XH + '/' },
        label: clip(v.item.title, 200), codec: 'H.264', audio: 'AAC', notes: ['xHamster'] }
    };
  });
}

var SITES = [{ id: 'xhamster', name: 'xHamster' }];

// cards and rows of the Sites view
function siteCard(site, it) {
  var meta = [{ kind: 'text', text: xhLength(it.duration) }, { kind: 'text', text: xhViews(it.views) }];
  if (it.date) meta.push({ kind: 'text', text: it.date });
  return {
    key: 'velvet:site:' + site + ':' + clip(it.id, 80),
    title: clip(it.title, 200),
    variant: 'still',
    image: it.thumb,
    subtitle: clip(xhLength(it.duration) + ' · ' + xhViews(it.views), 200),
    intent: { screen: 'plugin.velvet.siteVideo', params: { site: site, id: it.id } },
    info: { title: clip(it.title, 200), eyebrow: 'xHamster', meta: meta, backdrop: it.image || it.thumb }
  };
}

function siteRow(key, title, args) {
  return { key: 'velvet:site:' + clip(key, 80), title: clip(title, 200), variant: 'still', page: { data: 'rowPage', args: Object.assign({ provider: 'site' }, args) } };
}

/** The rows of a listing base: its sorts, with the quality and duration chosen */
function siteSortRows(site, base, label, f) {
  return Object.keys(XH_SORTS).map(function (sort) {
    return siteRow(site + ':' + (base || 'all') + ':' + sort + ':' + (f.quality || '') + ':' + (f.duration || ''),
      (label ? label + ': ' : '') + XH_SORT_NAMES[sort], { site: site, base: base, sort: sort, quality: f.quality, duration: f.duration });
  });
}

/** A paged row of the Sites view (rowPage with provider 'site') */
function siteRowPage(args, page) {
  return xhList({ base: args.base, q: args.q, sort: args.sort, quality: args.quality, duration: args.duration, page: page }).then(function (p) {
    return { items: p.items.slice(0, 100).map(function (it) { return siteCard(args.site || 'xhamster', it); }), last: p.last };
  });
}

/** The categories as a row of cards (each opens its page); a category the site has no picture for shows its first video's */
function siteCategoriesRow(site) {
  return xhCategoryThumbs().then(function (thumbs) {
    return Promise.all(XH_CATEGORIES.filter(function (c) { return !thumbs[c.slug]; }).map(function (c) {
      return xhList({ base: '/categories/' + c.slug }).then(function (p) {
        if (p.items[0]) thumbs[c.slug] = p.items[0].thumb;
      }, function () {});
    })).then(function () { return thumbs; });
  }).then(function (thumbs) {
    return {
      key: 'velvet:site:' + site + ':categories', title: 'Categories', variant: 'still',
      items: XH_CATEGORIES.map(function (c) {
        return Object.assign({ key: 'velvet:site:' + site + ':category:' + c.slug, title: c.name, variant: 'still',
          intent: { screen: 'plugin.velvet.siteList', params: { site: site, list: 'categories.' + c.slug, name: c.name } } },
        thumbs[c.slug] ? { image: thumbs[c.slug] } : {});
      })
    };
  });
}

// ── cards and rows ──────────────────────────────────────────────────────────

function infoOf(it, details) {
  var meta = [];
  if (it.scene && it.releaseDate) meta.push({ kind: 'text', text: String(it.releaseDate).slice(0, 10) });
  else if (it.year) meta.push({ kind: 'text', text: String(it.year) });
  meta.push({ kind: 'seal', text: '18+' });
  if (details && details.runtime) meta.push({ kind: 'text', text: details.runtime + ' min' });
  if (it.rating) meta.push({ kind: 'score', source: 'provider', value: Math.min(10, it.rating) });
  var info = {
    title: clip(it.title, 200),
    meta: meta,
    overview: clip(it.overview, 4000),
    overviewFallback: 'No description.',
    backdrop: it.backdrop || null
  };
  if (it.studio && it.studio.name) info.eyebrow = clip(it.studio.name, 200);
  if (details) {
    var credits = [];
    if (details.performers.length) credits.push({ label: 'Starring', names: details.performers.slice(0, 20).map(function (p) { return clip(p.name, 80); }) });
    if (details.director) credits.push({ label: 'Director', names: [clip(details.director, 80)] });
    if (credits.length) info.credits = credits;
  }
  return info;
}

function cardOf(providerId, it) {
  var scene = providerId === 'scenes';
  return {
    key: 'velvet:' + providerId + ':' + it.id,
    title: clip(it.title, 200),
    // a scene's picture is a frame of it: landscape
    variant: scene ? 'still' : 'poster',
    image: scene ? it.backdrop || it.poster : it.poster,
    subtitle: scene ? clip([it.studio && it.studio.name, it.releaseDate && String(it.releaseDate).slice(0, 10)].filter(Boolean).join(', '), 200) || undefined :
      it.year ? String(it.year) : undefined,
    rating: it.rating ? { source: 'provider', value: Math.min(10, it.rating) } : null,
    intent: { screen: 'plugin.velvet.title', params: { provider: providerId, id: it.id } },
    info: infoOf(it)
  };
}

/** The site's row: its search for the words, else its newest films */
function seRow(q) {
  return q ? pagedRow('search-sexempire', 'Sex-Empire for “' + clip(q, 60) + '”', { provider: 'sexempire', q: q }) :
    pagedRow('sexempire:latest', 'New on Sex-Empire', { provider: 'sexempire', row: 'latest' });
}

function pagedRow(key, title, args) {
  return { key: 'velvet:' + key, title: clip(title, 200), variant: args.provider === 'scenes' ? 'still' : 'poster', page: { data: 'rowPage', args: args } };
}

// ── the layout, per profile ─────────────────────────────────────────────────

function layoutKey(ctx) {
  return 'layout:' + (ctx && ctx.profile ? ctx.profile.id : 'none');
}

function viewGroup(current) {
  return { key: 'view', label: 'View', options: [
    { value: 'posters', label: 'Posters', on: current === 'posters' },
    { value: 'list', label: 'List', on: current === 'list' },
    { value: 'sites', label: 'Sites', on: current === 'sites' }
  ] };
}

/** The view the user just chose (a filter), kept; else the profile's last one */
function layoutOf(args, ctx, screen) {
  var chosen = args.filters && args.filters.view && args.filters.view[0];
  if (chosen === 'posters' || chosen === 'list' || chosen === 'sites') {
    return playpex.store.set(layoutKey(ctx), chosen).then(function () { return { layout: chosen, chosen: true }; });
  }
  return playpex.store.get(layoutKey(ctx)).then(function (v) {
    return { layout: v === 'list' || v === 'posters' || v === 'sites' ? v : screen, chosen: false };
  });
}

function switchTo(screen) {
  return [{ type: 'open', intent: { screen: 'plugin.velvet.' + screen, replace: true } }];
}

// ── data handlers ───────────────────────────────────────────────────────────

// The poster layout: the films' home rows, then new scenes and the studios the
// profile follows; a studio / period → its sorts within them; "Kind" keeps films
// or scenes; a search → a row of each
playpex.data('browse', function (args, ctx) {
  args = args || {};
  return layoutOf(args, ctx, 'posters').then(function (l) {
    if (l.layout === 'list' || l.layout === 'sites') {
      return { data: { rows: [] }, effects: switchTo(l.layout === 'list' ? 'releases' : 'sites') };
    }
    return Promise.all([catalogFor(ctx), catalogFor(ctx, 'scenes'), seOn(ctx)]).then(function (cs) {
      var c = cs[0], s = cs[1], site = cs[2];
      if (!c && !s) {
        // no catalog key: the site's films alone, when it's on
        var q0 = String(args.query || '').trim();
        return { data: { title: '18+', rows: site ? [seRow(q0)] : [], search: site, filters: [viewGroup('posters')],
          empty: !site ? NO_KEY : q0 ? 'Nothing found for “' + clip(q0, 60) + '”.' : 'Nothing to show.' } };
      }
      return followedStudios(ctx, s).then(function (followed) {
        var f = args.filters || {}, kind = (f.kind || [])[0] || '', studio = (f.studio || [])[0] || null, period = (f.period || [])[0] || '',
          q = String(args.query || '').trim(), rows = [];
        // films unless only scenes are asked for (or there is no film catalog)
        var films = c && kind !== 'scenes' ? c : null, scenes = s && (kind === 'scenes' || !c || (kind !== 'films' && !studio && !period)) ? s : null,
          focus = kind === 'scenes' || !c ? s : c,
          names = { popular: 'Popular', newest: 'Newest', rated: 'Top rated', longest: 'Longest' };
        if (q) {
          if (films) rows.push(pagedRow('search', 'Films for “' + clip(q, 60) + '”', { provider: films.id, q: q, period: period }));
          if (scenes) rows.push(pagedRow('search-scenes', 'Scenes for “' + clip(q, 60) + '”', { provider: 'scenes', q: q, period: period }));
        } else if (studio || period) {
          rows = focus.provider.sorts.map(function (x) {
            return pagedRow('discover:' + x, names[x], { provider: focus.id, sort: x, studio: studio, period: period,
              studios: focus.id === 'scenes' ? PROVIDERS.scenes.studiosOf(followed).join(',') : undefined });
          });
        } else {
          if (films) rows = films.provider.home().map(function (r) { return pagedRow('row:' + r.row, r.title, { provider: films.id, row: r.row }); });
          if (scenes) {
            var sceneRows = scenes.provider.home(followed);
            // only scenes: the usual studios too
            if (!films) {
              sceneRows = sceneRows.concat(SCENE_SITES.slice(0, HOME_STUDIOS).filter(function (x) {
                return !followed.some(function (y) { return y.id === x.id; });
              }).map(function (x) { return { row: 'studio:' + x.id, title: x.name }; }));
            }
            rows = rows.concat(sceneRows.map(function (r) {
              return pagedRow('scenes:' + r.row, r.title, r.studios ? { provider: 'scenes', row: r.row, studios: r.studios } : { provider: 'scenes', row: r.row });
            }));
          }
        }
        // the site's films: its search, else its newest (not under a studio, a period or scenes only)
        if (site && (q || (!studio && !period && kind !== 'scenes'))) {
          rows.push(seRow(q));
        }
        // the studios offered: the followed ones first, for scenes
        var studios = focus.id === 'scenes' ? followed.concat(SCENE_SITES.filter(function (x) {
          return !followed.some(function (y) { return y.id === x.id; });
        })) : focus.provider.studios.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
        var filters = [viewGroup('posters')];
        if (c && s) {
          filters.push({ key: 'kind', label: 'Kind', options: [
            { value: 'films', label: 'Films', on: kind === 'films' },
            { value: 'scenes', label: 'Scenes', on: kind === 'scenes' }
          ] });
        }
        filters.push(
          { key: 'studio', label: 'Studio', options: studios.slice(0, 60).map(function (x) { return { value: x.id, label: clip(x.name, 40), on: x.id === studio }; }) },
          { key: 'period', label: 'Released', options: focus.provider.periods.filter(function (p) { return p[0]; })
            .map(function (p) { return { value: p[0], label: p[1], on: p[0] === period }; }) }
        );
        return {
          data: {
            title: '18+',
            rows: rows,
            search: true,
            filters: filters,
            empty: q ? 'Nothing found for “' + clip(q, 60) + '”.' : 'Nothing to show.'
          }
        };
      });
    });
  });
});

playpex.data('rowPage', function (args, ctx) {
  args = args || {};
  var page = Math.max(1, args.page || 1);
  if (args.provider === 'site') {
    return siteRowPage(args, page).then(function (p) { return { data: p }; });
  }
  if (args.provider === 'sexempire') {
    return seRowPage(args, page).then(function (p) {
      return { data: { items: p.items.map(function (f) { return cardOf('sexempire', seItem(f)); }), last: p.last } };
    });
  }
  return catalogFor(ctx, args.provider).then(function (c) {
    if (!c) {
      return { data: { items: [], last: true } };
    }
    var read = args.q ? c.provider.search(c.key, { q: args.q, period: args.period, page: page }) :
      args.row ? c.provider.row(c.key, args.row, page, args) :
        c.provider.discover(c.key, { studio: args.studio, studios: args.studios, period: args.period, sort: args.sort, page: page });
    return read.then(function (p) {
      return { data: { items: p.items.slice(0, 100).map(function (it) { return cardOf(c.id, it); }), last: p.page >= p.totalPages || !p.items.length } };
    });
  });
});

// One title: details, Play, Find releases, performers (→ releases searched
// for them), More from its studio
playpex.data('title', function (args, ctx) {
  var params = (args && args.params) || {};
  if (params.provider === 'sexempire') {
    return seFilmById(params.id).then(function (f) {
      var t = seItem(f), rows = [];
      if (t.performers.length) {
        rows.push({ key: 'velvet:cast', title: 'Starring', variant: 'portrait', items: t.performers.slice(0, 30).map(function (p, i) {
          return { key: 'velvet:performer:' + i, title: clip(p.name, 200), variant: 'portrait', image: null,
            intent: { screen: 'plugin.velvet.find', params: { q: clip(p.name, 60) } } };
        }) });
      }
      return {
        data: {
          info: infoOf(t, t),
          actions: [
            { key: 'velvet:play', label: 'Play', icon: 'play', call: { data: 'play', args: { provider: 'sexempire', id: t.id } } },
            { key: 'velvet:releases', label: 'Find releases', icon: 'search', intent: { screen: 'plugin.velvet.find', params: { q: clip(t.title + (t.year ? ' ' + t.year : ''), 60) } } }
          ],
          rows: rows
        }
      };
    });
  }
  return catalogFor(ctx, params.provider).then(function (c) {
    if (!c) {
      return { data: { info: { title: '18+', notes: [NO_KEY] } } };
    }
    return c.provider.title(c.key, params.id).then(function (t) {
      var rows = [];
      if (t.performers.length) {
        rows.push({ key: 'velvet:cast', title: 'Starring', variant: 'portrait', items: t.performers.slice(0, 30).map(function (p, i) {
          return { key: 'velvet:performer:' + i, title: clip(p.name, 200), variant: 'portrait', image: p.photo || null,
            intent: { screen: 'plugin.velvet.find', params: { q: clip(p.name, 60) } } };
        }) });
      }
      if (t.browsableStudio && t.studio) {
        rows.push(pagedRow('more', 'More from ' + t.studio.name, { provider: c.id, row: 'studio:' + t.browsableStudio }));
      }
      return {
        data: {
          info: infoOf(t, t),
          actions: [
            { key: 'velvet:play', label: 'Play', icon: 'play', call: { data: 'play', args: { provider: c.id, id: t.id } } },
            { key: 'velvet:releases', label: 'Find releases', icon: 'search', intent: { screen: 'plugin.velvet.find', params: { q: clip(releaseQuery(c.id, t), 60) } } }
          ],
          rows: rows
        }
      };
    });
  });
});

// Play: the film's streams from Sex-Empire (when it has the film) and its
// torrents, best first, in the core's source picker; nothing is saved
function playEffect(t, streams, torrents) {
  return { type: 'play', request: {
    title: clip(t.title, 200),
    subtitle: t.studio ? clip(t.studio.name, 200) : undefined,
    artwork: Object.assign({}, t.poster ? { poster: t.poster } : {}, t.backdrop ? { backdrop: t.backdrop } : {}),
    tracking: 'none',
    sources: streams.concat(torrents.slice(0, 50 - streams.length).map(function (x) {
      return { kind: 'magnet', magnet: magnetOf(x.hash, x.name), label: clip(x.name, 200), quality: x.quality,
        size: x.size, seeds: x.seeds, codec: x.codec, audio: x.audio, notes: notesOf(x).slice(0, 6) };
    }))
  } };
}

/** A film's Sex-Empire streams ([] when the source is off, the site doesn't have it or didn't answer) */
function seStreamsFor(ctx, t) {
  return seOn(ctx).then(function (on) {
    return on ? seFind(t.title, t.year).then(function (f) { return f ? seSources(f) : []; }) : [];
  }).catch(function (err) {
    playpex.log.info('Sex-Empire didn\'t answer', { error: err.message });
    return [];
  });
}

playpex.data('play', function (args, ctx) {
  args = args || {};
  if (args.provider === 'site') {
    return xhOn(ctx).then(function (on) {
      return on ? xhStream(String(args.id || '')) : null;
    }).then(function (r) {
      if (!r) {
        return { data: null, effects: [{ type: 'toast', tone: 'info', text: 'This video can\'t be played now' }] };
      }
      var it = r.video.item;
      return { data: null, effects: [{ type: 'play', request: { title: clip(it.title, 200), subtitle: 'xHamster',
        artwork: it.image ? { backdrop: it.image } : {}, tracking: 'none', sources: [r.source] } }] };
    });
  }
  if (args.provider === 'sexempire') {
    return seFilmById(args.id).then(function (f) {
      return seSources(f).then(function (streams) {
        if (!streams.length) {
          return { data: null, effects: [{ type: 'toast', tone: 'info', text: 'None of this film\'s players can be played here now' }] };
        }
        return { data: null, effects: [playEffect(seItem(f), streams, [])] };
      });
    });
  }
  if (args.provider === 'thesextube') {
    return tstOn(ctx).then(function (on) {
      return on ? tstPost(args.id) : null;
    }).then(function (it) {
      // switched off, not a studio's post, or no video
      if (!it) {
        return { data: null, effects: [{ type: 'toast', tone: 'info', text: 'This video isn\'t available' }] };
      }
      return tstStream(it).then(function (stream) {
        if (!stream) {
          return { data: null, effects: [{ type: 'toast', tone: 'info', text: 'This video can\'t be played now' }] };
        }
        return { data: null, effects: [playEffect({ title: it.title, studio: { name: it.studio }, backdrop: it.poster }, [stream], [])] };
      });
    });
  }
  return catalogFor(ctx, args.provider).then(function (c) {
    if (!c) {
      return { data: null, effects: [{ type: 'toast', text: 'Enter a catalog key in the 18+ plugin\'s settings', tone: 'error' }] };
    }
    return c.provider.title(c.key, args.id).then(function (t) {
      // films: Sex-Empire's streams; a studio's scene: its TheSexTube video
      return Promise.all([
        c.id === 'scenes' ? findSceneTorrents(t) : findTorrents(t.title, t.year),
        c.id === 'scenes' ? tstStreamsFor(ctx, t) : seStreamsFor(ctx, t)
      ]).then(function (r) {
        var found = r[0], streams = r[1];
        if (!found.torrents.length && !streams.length) {
          return { data: null, effects: [{ type: 'toast', tone: found.failed ? 'error' : 'info',
            text: found.failed ? 'The torrent sites didn\'t answer' : 'Nothing found to play this title' }] };
        }
        return { data: null, effects: [playEffect(t, streams, found.torrents)] };
      });
    });
  });
});

var QUALITY_LABELS = [['2160p', '4K'], ['1080p', '1080p'], ['720p', '720p'], ['SD', 'SD']];

// Sex-Empire in the Source filter (while its switch is on): direct links, not torrents
var SE_SOURCE = { id: 'sexempire', name: 'Sex-Empire (direct links)', direct: true };
// TheSexTube's studios (while its switch is on): direct links too
var TST_SOURCE = { id: 'thesextube', name: 'TheSexTube (studios)', direct: true };

// The list layout (and Find releases: screen `find`, its params.q): one
// source's releases, most seeded first; a filtered page reads on (up to 3)
// until 20 are kept. Sex-Empire's are direct links (a `call` each: the play
// handler resolves its players when one is chosen), in the site's order
playpex.data('releases', function (args, ctx) {
  args = args || {};
  var params = args.params || {}, f = args.filters || {}, page = Math.max(1, args.page || 1),
    section = !params.q;
  var go = Promise.all([section ? layoutOf(args, ctx, 'list') : Promise.resolve({ layout: 'list' }), seOn(ctx), tstOn(ctx)]);
  return go.then(function (r) {
    var l = r[0], sources = SOURCES.concat(r[1] ? [SE_SOURCE] : [], r[2] ? [TST_SOURCE] : []);
    if (l.layout === 'posters' || l.layout === 'sites') {
      return { data: { releases: [], last: true }, effects: switchTo(l.layout === 'posters' ? 'browse' : 'sites') };
    }
    var source = sources.filter(function (s) { return s.id === (f.source || [])[0]; })[0] || sources[0],
      quality = (f.quality || [])[0] || '',
      playableOnly = (f.plays || [])[0] === 'yes',
      q = String(args.query || params.q || '').trim(),
      filters = (section ? [viewGroup('list')] : []).concat([
        { key: 'source', label: 'Source', options: sources.map(function (s) { return { value: s.id, label: s.name, on: s === source }; }) },
        { key: 'quality', label: 'Quality', options: QUALITY_LABELS.map(function (x) { return { value: x[0], label: x[1], on: x[0] === quality }; }) },
        { key: 'plays', label: 'Plays here', options: [{ value: 'yes', label: 'Only those that play', on: playableOnly }] }
      ]);
    if (source === TST_SOURCE) {
      // its studios' videos, newest first (quality unknown until one plays: the Quality filter keeps them all)
      return tstPosts(q, page).then(function (found) {
        return {
          data: {
            title: q ? 'Studio videos for “' + clip(q, 60) + '”' : 'New from the studios',
            releases: found.items.slice(0, 200).map(tstRelease),
            last: !found.more,
            filters: filters,
            empty: q ? 'No studio video for “' + clip(q, 60) + '”.' : 'No studio videos.'
          }
        };
      });
    }
    if (source.direct) {
      return seReleases(q, page).then(function (found) {
        // every link plays here (H.264 / AAC streams): "Plays here" keeps them all
        var films = found.films.filter(function (x) { return !quality || x.quality === quality || (quality === 'SD' && x.quality === '480p'); });
        return {
          data: {
            title: q ? 'Direct links for “' + clip(q, 60) + '”' : 'New on Sex-Empire',
            releases: films.slice(0, 200).map(seRelease),
            last: !found.more,
            filters: filters,
            empty: q ? 'Sex-Empire has nothing for “' + clip(q, 60) + '”.' : 'Nothing on Sex-Empire.'
          }
        };
      });
    }
    if (page > 1 && !source.paged) {
      return { data: { releases: [], last: true, filters: filters } };
    }
    var seen = {};
    function keep(t) {
      if (seen[t.hash]) return false;
      seen[t.hash] = true;
      return (!quality || t.quality === quality || (quality === 'SD' && t.quality === '480p')) &&
        (!playableOnly || (t.playable && t.audio !== 'unsupported'));
    }
    function read(from, kept, reads) {
      return source.list({ q: q, quality: quality, page: from }).then(function (r) {
        var list = kept.concat(r.results.map(function (t) { return Object.assign(t, describe(t.name)); }).filter(keep));
        if (source.paged && r.hasMore && list.length < 20 && reads + 1 < 3) {
          return read(from + 1, list, reads + 1);
        }
        return { list: list, more: source.paged && r.hasMore };
      });
    }
    return read(page, [], 0).then(function (r) {
      r.list.sort(function (a, b) { return b.seeds - a.seeds; });
      return {
        data: {
          title: q ? 'Releases of “' + clip(q, 60) + '”' : '18+',
          releases: r.list.slice(0, 200).map(function (t) {
            var out = { title: clip(present(t.name).title, 300), magnet: magnetOf(t.hash, t.name), seeds: t.seeds, size: t.size,
              notes: notesOf(t).concat([clip(t.name, 80)]).slice(-6) };
            if (t.peers != null) out.peers = t.peers;
            if (t.quality) out.quality = t.quality;
            if (t.added) out.uploadedAt = new Date(t.added * 1000).toISOString();
            return out;
          }),
          // the core asks for page + 1 next; a filtered page may have read several
          last: !r.more,
          filters: filters,
          empty: q ? 'No releases found for “' + clip(q, 60) + '”.' : 'No releases.'
        }
      };
    });
  });
});

// The search page's chip: the catalog's search for the query
playpex.data('searchFilter', function (args, ctx) {
  var q = String((args && args.context && args.context.query) || '').trim();
  var chip = { key: 'velvet:18', label: '18+' };
  if (q.length < 3) {
    return Promise.resolve({ data: { chip: chip, rows: [] } });
  }
  // the torrents for the words: the find screen (releases by seeders, its filters); no key needed
  var releases = { key: 'velvet:search-releases', title: 'Releases', variant: 'compact', items: [{
    key: 'velvet:find', title: clip('Torrents for “' + q + '”', 200), subtitle: 'Most seeded first',
    intent: { screen: 'plugin.velvet.find', params: { q: clip(q, 60) } }
  }] };
  function results(c, title, key) {
    if (!c) {
      return Promise.resolve([]);
    }
    return c.provider.search(c.key, { q: q, page: 1 }).then(function (p) {
      return p.items.length ? [{ key: 'velvet:' + key, title: title, variant: c.id === 'scenes' ? 'still' : 'poster',
        items: p.items.slice(0, 100).map(function (it) { return cardOf(c.id, it); }) }] : [];
    }, function () { return []; });
  }
  function site(on) {
    if (!on) {
      return Promise.resolve([]);
    }
    return seRowPage({ q: q }, 1).then(function (p) {
      return p.items.length ? [{ key: 'velvet:search-sexempire', title: 'Sex-Empire', variant: 'poster',
        items: p.items.map(function (f) { return cardOf('sexempire', seItem(f)); }) }] : [];
    }, function () { return []; });
  }
  return Promise.all([catalogFor(ctx), catalogFor(ctx, 'scenes'), seOn(ctx)]).then(function (cs) {
    return Promise.all([results(cs[0], 'Films', 'search-results'), results(cs[1], 'Scenes', 'search-scenes'), site(cs[2])]);
  }).then(function (r) {
    return { data: { chip: chip, rows: r[0].concat(r[1], r[2], [releases]) } };
  });
});

// tests (Node, not the sandbox): the pure parts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { present: present, describe: describe, match: match, compare: compare, notesOf: notesOf,
    sceneMatch: sceneMatch, sceneSearches: sceneSearches, releaseQuery: releaseQuery,
    unpack: unpack, seList: seList, seFilm: seFilm, seFind: seFind, onHosts: onHosts, vidhideStream: vidhideStream,
    tstAllowed: tstAllowed, tstItem: tstItem };
}

// The Sites view: a site's rows (trending, newest, best), its categories, a
// row per popular category; a category / quality / length → that listing's
// sorts; a search → its results, most relevant and newest
playpex.data('sites', function (args, ctx) {
  args = args || {};
  return layoutOf(args, ctx, 'sites').then(function (l) {
    if (l.layout !== 'sites') {
      return { data: { rows: [] }, effects: switchTo(l.layout === 'list' ? 'releases' : 'browse') };
    }
    return xhOn(ctx).then(function (on) {
      var f = args.filters || {}, site = 'xhamster', q = String(args.query || '').trim(),
        category = XH_CATEGORIES.filter(function (c) { return c.slug === (f.category || [])[0]; })[0] || null,
        chosen = { quality: (f.quality || [])[0] || '', duration: (f.duration || [])[0] || '' },
        filters = [
          viewGroup('sites'),
          { key: 'site', label: 'Site', options: SITES.map(function (s) { return { value: s.id, label: s.name, on: s.id === site }; }) },
          { key: 'category', label: 'Category', options: XH_CATEGORIES.map(function (c) { return { value: c.slug, label: c.name, on: c === category }; }) },
          { key: 'quality', label: 'Quality', options: XH_QUALITIES.map(function (x) { return { value: x[0], label: x[1], on: x[0] === chosen.quality }; }) },
          { key: 'duration', label: 'Length', options: XH_DURATIONS.map(function (x) { return { value: x[0], label: x[1], on: x[0] === chosen.duration }; }) }
        ];
      if (!on) {
        return { data: { title: '18+', rows: [], filters: [viewGroup('sites')],
          empty: 'The sites are switched off in the 18+ plugin\'s settings on the server\'s dashboard.' } };
      }
      if (q) {
        return { data: { title: '18+', search: true, filters: filters, rows: [
          siteRow(site + ':search:' + q, 'xHamster for “' + clip(q, 60) + '”', { site: site, q: q, quality: chosen.quality, duration: chosen.duration }),
          siteRow(site + ':search-new:' + q, 'Newest for “' + clip(q, 60) + '”', { site: site, q: q, sort: 'newest', quality: chosen.quality, duration: chosen.duration })
        ], empty: 'Nothing found for “' + clip(q, 60) + '”.' } };
      }
      if (category || chosen.quality || chosen.duration) {
        return { data: { title: '18+', search: true, filters: filters,
          rows: siteSortRows(site, category ? '/categories/' + category.slug : '', category ? category.name : '', chosen) } };
      }
      return siteCategoriesRow(site).then(function (categories) {
        var rows = siteSortRows(site, '', '', chosen).slice(0, 3)
          .concat([siteRow(site + ':4k', '4K', { site: site, quality: '2160p' }), categories])
          .concat(XH_HOME_CATEGORIES.map(function (slug) {
            var c = XH_CATEGORIES.filter(function (x) { return x.slug === slug; })[0];
            return siteRow(site + ':home:' + slug, c.name, { site: site, base: '/categories/' + slug });
          }));
        return { data: { title: '18+', search: true, filters: filters, rows: rows } };
      });
    });
  });
});

// A category, performer or channel of a site: its sorts, a quality / length chosen
playpex.data('siteList', function (args, ctx) {
  args = args || {};
  // params.list: <kind>.<slug> (categories.lesbian, pornstars.<name>, channels.<name>, creators.<name>)
  var p = args.params || {}, f = args.filters || {},
    list = /^(categories|pornstars|channels|creators)\.([A-Za-z0-9_-]{1,80})$/.exec(p.list || ''),
    kind = list ? list[1] : null, slug = list ? list[2] : null,
    chosen = { quality: (f.quality || [])[0] || '', duration: (f.duration || [])[0] || '' },
    name = clip(p.name || slug || '', 80);
  return xhOn(ctx).then(function (on) {
    if (!on || !slug) {
      return { data: { title: name, rows: [], empty: on ? 'Nothing to show.' : 'The sites are switched off in the 18+ plugin\'s settings.' } };
    }
    var filters = [
      { key: 'quality', label: 'Quality', options: XH_QUALITIES.map(function (x) { return { value: x[0], label: x[1], on: x[0] === chosen.quality }; }) },
      { key: 'duration', label: 'Length', options: XH_DURATIONS.map(function (x) { return { value: x[0], label: x[1], on: x[0] === chosen.duration }; }) }
    ];
    // performers and channels have no quality pages
    if (kind !== 'categories') filters.shift();
    return { data: { title: name, filters: filters, rows: siteSortRows('xhamster', '/' + kind + '/' + slug, '', chosen) } };
  });
});

// A site's video: what it is, Play, related videos, more with its performers and from its channel
playpex.data('siteVideo', function (args, ctx) {
  args = args || {};
  var id = String((args.params || {}).id || '');
  return xhOn(ctx).then(function (on) {
    if (!on || !/^[A-Za-z0-9-]{1,300}$/.test(id)) {
      return { data: { info: { title: 'This video isn\'t available' } } };
    }
    return xhVideo(id).then(function (v) {
      var it = v.item, meta = [{ kind: 'text', text: xhLength(it.duration) }, { kind: 'text', text: xhViews(it.views) }], rows = [], credits = [];
      if (it.rating) meta.push({ kind: 'score', source: 'provider', value: Math.min(10, it.rating / 10), label: 'Liked ' + it.rating + '%' });
      if (it.date) meta.push({ kind: 'text', text: it.date });
      if (v.stars.length) credits.push({ label: 'With', names: v.stars.slice(0, 20).map(function (s) { return clip(s.name, 80); }) });
      if (v.channel) credits.push({ label: 'Channel', names: [clip(v.channel.name, 80)] });
      if (v.related.length) {
        rows.push({ key: 'velvet:site:related', title: 'Related', variant: 'still', items: v.related.slice(0, 100).map(function (r) { return siteCard('xhamster', r); }) });
      }
      v.stars.slice(0, 3).forEach(function (s) {
        rows.push(siteRow('xhamster:with:' + s.path, 'More with ' + s.name, { site: 'xhamster', base: s.path }));
      });
      if (v.channel) {
        rows.push(siteRow('xhamster:from:' + v.channel.path, 'More from ' + v.channel.name, { site: 'xhamster', base: v.channel.path }));
      }
      // the people and the channel as pages of their own
      var pages = v.stars.slice(0, 4).concat(v.channel ? [v.channel] : []).map(function (s) {
        var m = /^\/([a-z]+)\/([A-Za-z0-9_-]+)$/.exec(s.path);
        return m ? { key: 'velvet:site:page:' + clip(s.path, 80), label: clip(s.name, 40), icon: 'grid',
          intent: { screen: 'plugin.velvet.siteList', params: { site: 'xhamster', list: m[1] + '.' + m[2], name: clip(s.name, 80) } } } : null;
      }).filter(Boolean);
      return { data: {
        info: { title: clip(it.title, 200), eyebrow: 'xHamster', meta: meta.slice(0, 10),
          genres: v.categories.slice(0, 8).map(function (c) { return clip(c, 40); }),
          overview: it.description ? clip(it.description, 4000) : undefined, credits: credits, backdrop: it.image || undefined },
        actions: [{ key: 'velvet:play', label: 'Play', icon: 'play', call: { data: 'play', args: { provider: 'site', site: 'xhamster', id: id } } }]
          .concat(pages).slice(0, 8),
        rows: rows.slice(0, 10)
      } };
    });
  });
});
