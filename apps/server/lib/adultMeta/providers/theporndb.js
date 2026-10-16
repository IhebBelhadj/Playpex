'use strict';

// ThePornDB (theporndb.net): metadata built for adult films (DVD covers,
// performers, studios = "sites", tags). Needs a free API token:
// THEPORNDB_API_KEY (.env). API: api.theporndb.net, Bearer token, Laravel
// style answers `{ data, meta: { current_page, last_page, total } }`.
//
// What the API offers (checked Oct 2026 with a key) and how it's used here:
// - /movies sorts: only `orderBy=recently_released | recently_created` (any
//   other value → 422): no popularity or rating sort, so this provider only
//   offers "newest" (`sorts`).
// - recently_released starts with scraped junk dated in the future (3024-…);
//   `date_from/date_to` are ignored, `year=` works: future dates are dropped.
// - One site per request (`site_id`, a number); no multi-site filter. The
//   global listing mixes every niche, so "New releases" merges the newest
//   titles of the curated studios below instead.
// - Covers: `image` (~500×700) and `posters.*` / `background.*` (~1070×1500)
//   are the front cover; there is no landscape art, the cover is the backdrop.

var axios = require('axios').default;
var settings = require('../../settings');

var BASE = 'https://api.theporndb.net';
var CACHE_TTL = 60 * 60 * 1000;
var PER_PAGE = 30;
var MERGED_PER_SITE = 6;       // per studio and page in "New releases"

// ThePornDB site ids (checked Oct 2026: exact name, each with ≥ 50 movies).
// Order = order of the studio rows and of the filter; the first HOME_ROWS get
// a row on the home page and make up "New releases".
var SITES = [
  { id: '92', name: 'Brazzers' },
  { id: '3372', name: 'Vixen' },
  { id: '200', name: 'Blacked' },
  { id: '3417', name: 'Tushy' },
  { id: '4611', name: 'Evil Angel' },
  { id: '347', name: 'Digital Playground' },
  { id: '6551', name: 'Marc Dorcel' },
  { id: '130', name: 'Naughty America' },
  { id: '20', name: 'Reality Kings' },
  { id: '1052', name: 'Elegant Angel' },
  { id: '202', name: 'Blacked Raw' },
  { id: '247', name: 'Tushy Raw' },
  { id: '3373', name: 'Deeper' },
  { id: '3374', name: 'New Sensations' },
  { id: '765', name: 'Private' },
  { id: '4633', name: 'Pure Taboo' },
  { id: '4432', name: 'Adult Time' },
  { id: '4628', name: 'Wicked' },
  { id: '36685', name: 'Hustler' },
  { id: '65', name: 'Mofos' },
  { id: '278', name: 'Team Skeet' },
  { id: '4404', name: 'Girlfriends Films' },
  { id: '263', name: 'Sweetheart Video' },
  { id: '1287', name: 'Zero Tolerance' },
  { id: '4635', name: "Devil's Film" },
  { id: '3418', name: 'Digital Sin' },
  { id: '4376', name: 'Erotica X' },
  { id: '4388', name: 'Dark X' },
  { id: '6103', name: 'Slayed' },
  { id: '2274', name: 'MissaX' },
  { id: '353', name: 'Kink' },
  { id: '1001', name: 'Penthouse' },
  { id: '6497', name: 'Vivid' },
  { id: '1006', name: 'Lethal Hardcore' },
  { id: '1056', name: 'Adam & Eve' }
];
var HOME_ROWS = 10;

var PERIODS = [
  { id: '', label: 'Any time' },
  { id: 'year', label: 'This year' },
  { id: 'last', label: 'Last year' }
];

var cache = new Map();

function get(path, params) {
  var token = settings.get('providers.thePornDbApiKey');
  if (!token) {
    return Promise.reject(new Error('THEPORNDB_API_KEY is not set'));
  }
  var key = path + '?' + JSON.stringify(params || {});
  var cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }
  var value = axios.get(BASE + path, {
    params: params,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    timeout: 15000
  }).then(function (res) {
    return res.data || {};
  });
  cache.set(key, { value: value, expires: Date.now() + CACHE_TTL });
  value.catch(function () { cache.delete(key); });
  return value;
}

function pick(obj, paths) {
  for (var i = 0; i < paths.length; i++) {
    var value = paths[i].split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
    if (value) return value;
  }
  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function yearOf(period) {
  var year = new Date().getFullYear();
  if (period === 'year') return year;
  if (period === 'last') return year - 1;
  return null;
}

function siteOf(id) {
  return SITES.filter(function (s) { return s.id === String(id); })[0] || null;
}

function site(s) {
  return s && s.name ? { id: String(s.id), name: s.name } : null;
}

function item(m) {
  var date = m.date || '';
  var cover = pick(m, ['image', 'posters.medium', 'posters.large', 'poster']);
  return {
    id: String(m.id || m._id),
    title: m.title || 'Untitled',
    year: date ? Number(String(date).slice(0, 4)) : null,
    releaseDate: date || null,
    overview: m.description || '',
    poster: cover,
    // no landscape art for movies: the (large) cover, blurred by the shell
    backdrop: pick(m, ['posters.large', 'background.large', 'image']),
    rating: Number(m.rating) > 0 ? Number(m.rating) : null,
    studio: site(m.site)
  };
}

// Released titles with a cover (drops the future-dated scraped entries)
function usable(it) {
  return it.poster && (!it.releaseDate || it.releaseDate <= today());
}

function movies(params) {
  var query = Object.assign({ per_page: PER_PAGE, orderBy: 'recently_released' }, params);
  return get('/movies', query).then(function (data) {
    var meta = data.meta || {};
    return {
      items: (data.data || []).map(item).filter(usable),
      page: meta.current_page || query.page || 1,
      totalPages: meta.last_page || 1
    };
  });
}

// "New releases": page n of each home studio, merged newest first
function merged(page, year) {
  var reads = SITES.slice(0, HOME_ROWS).map(function (s) {
    var params = { site_id: s.id, page: page, per_page: MERGED_PER_SITE };
    if (year) params.year = year;
    return movies(params);
  });
  return Promise.allSettled(reads).then(function (results) {
    var pages = results.filter(function (r) { return r.status === 'fulfilled'; }).map(function (r) { return r.value; });
    if (!pages.length) {
      throw results[0].reason;
    }
    var items = [].concat.apply([], pages.map(function (p) { return p.items; }));
    items.sort(function (a, b) { return (b.releaseDate || '').localeCompare(a.releaseDate || ''); });
    return {
      items: items,
      page: page,
      totalPages: Math.max.apply(null, pages.map(function (p) { return p.totalPages; }))
    };
  });
}

function studios() {
  return Promise.resolve(SITES.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  }));
}

function home() {
  return Promise.resolve([{ key: 'latest', title: 'New releases' }].concat(
    SITES.slice(0, HOME_ROWS).map(function (s) {
      return { key: 'studio:' + s.id, title: s.name };
    })
  ));
}

function row(key, page) {
  var studio = /^studio:(\d+)$/.exec(key);
  if (studio) {
    return movies({ site_id: studio[1], page: page });
  }
  if (key === 'latest' || key === 'newest') {
    return merged(page);
  }
  return Promise.reject(Object.assign(new Error('Unknown row: ' + key), { status: 404 }));
}

// Newest first whatever `sort` asks (the only order the API has)
function discover(options) {
  var year = yearOf(options.period);
  var page = options.page || 1;
  if (!options.studio) {
    return merged(page, year);
  }
  var params = { site_id: options.studio, page: page };
  if (year) params.year = year;
  return movies(params);
}

function search(options) {
  var params = { q: options.q, page: options.page || 1 };
  var year = yearOf(options.period);
  if (year) params.year = year;
  // relevance order for searches (the API's default), not newest first
  return get('/movies', Object.assign({ per_page: PER_PAGE }, params)).then(function (data) {
    var meta = data.meta || {};
    return {
      items: (data.data || []).map(item).filter(usable),
      page: meta.current_page || params.page,
      totalPages: meta.last_page || 1
    };
  });
}

function title(id) {
  return get('/movies/' + encodeURIComponent(id)).then(function (data) {
    var m = data.data || data;
    var result = item(m);
    var duration = Number(m.duration) || 0;
    var director = (m.directors || [])[0];
    var known = result.studio && siteOf(result.studio.id);
    return Object.assign(result, {
      runtime: duration ? Math.round(duration / 60) : null,
      performers: (m.performers || []).map(function (p) {
        return {
          name: p.name || (p.parent && p.parent.name) || '',
          photo: pick(p, ['face', 'parent.face', 'image', 'parent.image'])
        };
      }).filter(function (p) { return p.name; }),
      director: director ? director.name : null,
      studios: result.studio ? [result.studio] : [],
      // any site works as a row here (studio:<site id>), not only the curated ones
      browsableStudio: result.studio && /^\d+$/.test(result.studio.id) ? result.studio.id : (known ? known.id : null)
    });
  });
}

module.exports = {
  id: 'theporndb',
  name: 'ThePornDB',
  description: 'Metadata made for adult films: DVD covers, performers and studios. Newest first only. Needs THEPORNDB_API_KEY (free at theporndb.net).',
  periods: PERIODS,
  sorts: ['newest'],
  isConfigured: function () { return !!settings.get('providers.thePornDbApiKey'); },
  home: home,
  row: row,
  discover: discover,
  search: search,
  studios: studios,
  title: title,
  SITES: SITES
};
