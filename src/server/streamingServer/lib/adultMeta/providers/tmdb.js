'use strict';

// TMDB as the 18+ catalog. TMDB lists adult films (`adult: true`, posters,
// backdrops, cast = performers) but has no adult filter or genres for them:
// they're reached through their studios (production companies) with
// include_adult=true, and searches keep only `adult` results.
// Key: TMDB_API_KEY (.env), like lib/tmdb.js.

var axios = require('axios').default;

var BASE = 'https://api.themoviedb.org/3';
var POSTER = 'https://image.tmdb.org/t/p/w342';
var BACKDROP = 'https://image.tmdb.org/t/p/w1280';
var PROFILE = 'https://image.tmdb.org/t/p/w185';
var CACHE_TTL = 60 * 60 * 1000;
var PAGE_SIZE = 20;
var MAX_PAGE = 500;            // TMDB answers no page past 500

// TMDB company ids of adult studios (checked Oct 2026: each lists ≥ 40 adult
// titles with posters). Order = order of the studio rows and of the filter.
var STUDIOS = [
  { id: 8552, name: 'Brazzers' },
  { id: 97168, name: 'Vixen' },
  { id: 63844, name: 'Blacked' },
  { id: 72478, name: 'Tushy' },
  { id: 6463, name: 'Evil Angel' },
  { id: 6112, name: 'Digital Playground' },
  { id: 6258, name: 'Dorcel' },
  { id: 6316, name: 'Naughty America' },
  { id: 15887, name: 'Reality Kings' },
  { id: 33400, name: 'Jules Jordan Video' },
  { id: 6886, name: 'Elegant Angel' },
  { id: 6122, name: 'New Sensations' },
  { id: 5788, name: 'Private' },
  { id: 5979, name: 'Vivid Entertainment' },
  { id: 120963, name: 'Deeper' },
  { id: 103790, name: 'Blacked Raw' },
  { id: 117838, name: 'Tushy Raw' },
  { id: 97187, name: 'Pure Taboo' },
  { id: 114045, name: 'Adult Time' },
  { id: 6978, name: 'Girlfriends Films' },
  { id: 10294, name: 'Sweetheart Video' },
  { id: 6115, name: 'Hustler Video' },
  { id: 56675, name: 'Bang Bros' },
  { id: 107132, name: 'Mofos' },
  { id: 46264, name: 'Team Skeet' },
  { id: 8248, name: "Devil's Film" },
  { id: 8027, name: 'Lethal Hardcore' },
  { id: 6228, name: 'Zero Tolerance' },
  { id: 6121, name: 'Digital Sin' },
  { id: 65222, name: 'Mile High Xtreme' },
  { id: 32777, name: 'Erotica X' },
  { id: 99678, name: 'Dark X' },
  { id: 111525, name: 'MissaX' },
  { id: 122166, name: 'Bellesa Films' },
  { id: 168340, name: 'Slayed' },
  { id: 8679, name: 'Kink' }
];
var STUDIO_ROWS = 10;          // the first ones get a row on the home page
var ALL_STUDIOS = STUDIOS.map(function (s) { return s.id; }).join('|');

var PERIODS = [
  { id: '', label: 'Any time' },
  { id: 'year', label: 'This year' },
  { id: '5y', label: 'Last 5 years' },
  { id: 'classic', label: 'Before 2015' }
];

var cache = new Map();

function get(path, params) {
  if (!process.env.TMDB_API_KEY) {
    return Promise.reject(new Error('TMDB_API_KEY is not set'));
  }
  var query = Object.assign({ api_key: process.env.TMDB_API_KEY, language: 'en-US' }, params);
  var key = path + '?' + JSON.stringify(query);
  var cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }
  var value = axios.get(BASE + path, { params: query, timeout: 15000 }).then(function (res) {
    return res.data;
  });
  cache.set(key, { value: value, expires: Date.now() + CACHE_TTL });
  value.catch(function () { cache.delete(key); });
  return value;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function studioOf(id) {
  return STUDIOS.filter(function (s) { return s.id === Number(id); })[0] || null;
}

function item(r, studio) {
  var date = r.release_date || '';
  return {
    id: String(r.id),
    title: r.title || r.original_title || 'Untitled',
    year: date ? Number(date.slice(0, 4)) : null,
    releaseDate: date || null,
    overview: r.overview || '',
    poster: r.poster_path ? POSTER + r.poster_path : null,
    backdrop: r.backdrop_path ? BACKDROP + r.backdrop_path : null,
    rating: r.vote_count >= 3 && r.vote_average ? r.vote_average : null,
    studio: studio || null
  };
}

// TMDB page → ours; only adult titles. Browsing (withPoster) also skips
// titles without a poster: they'd be blank cards in a poster row
function toPage(data, studio, withPoster) {
  return {
    items: (data.results || [])
      .filter(function (r) { return r.adult && (!withPoster || r.poster_path); })
      .map(function (r) { return item(r, studio); }),
    page: data.page || 1,
    totalPages: Math.min(data.total_pages || 1, MAX_PAGE)
  };
}

function periodParams(period) {
  var year = new Date().getFullYear();
  switch (period) {
    case 'year': return { 'primary_release_date.gte': year + '-01-01' };
    case '5y': return { 'primary_release_date.gte': (year - 5) + '-01-01' };
    case 'classic': return { 'primary_release_date.lte': '2014-12-31' };
    default: return {};
  }
}

// sort: 'popular' | 'newest' | 'rated'
function discoverPage(options) {
  var studio = options.studio ? studioOf(options.studio) : null;
  var params = Object.assign({
    include_adult: true,
    with_companies: studio ? String(studio.id) : ALL_STUDIOS,
    page: Math.min(Math.max(1, options.page || 1), MAX_PAGE)
  }, periodParams(options.period));

  if (!params['primary_release_date.lte']) {
    params['primary_release_date.lte'] = today();
  }
  if (options.sort === 'newest') {
    params.sort_by = 'primary_release_date.desc';
  } else if (options.sort === 'rated') {
    params.sort_by = 'vote_average.desc';
    params['vote_count.gte'] = 5;
  } else {
    params.sort_by = 'popularity.desc';
  }
  return get('/discover/movie', params).then(function (data) {
    return toPage(data, studio, true);
  });
}

function home() {
  return Promise.resolve([
    { key: 'popular', title: 'Popular now' },
    { key: 'newest', title: 'New releases' },
    { key: 'rated', title: 'Top rated' }
  ].concat(STUDIOS.slice(0, STUDIO_ROWS).map(function (s) {
    return { key: 'studio:' + s.id, title: s.name };
  })));
}

function row(key, page) {
  var studio = /^studio:(\d+)$/.exec(key);
  if (studio) {
    return discoverPage({ studio: studio[1], page: page });
  }
  if (['popular', 'newest', 'rated'].indexOf(key) === -1) {
    return Promise.reject(Object.assign(new Error('Unknown row: ' + key), { status: 404 }));
  }
  return discoverPage({ sort: key, page: page });
}

function discover(options) {
  return discoverPage({ studio: options.studio, period: options.period, sort: options.sort, page: options.page });
}

// TMDB ranks every regular match before the adult ones: the adult results
// start after the regular count (include_adult=false gives it). Our page n
// reads the TMDB page where they start + n − 1, and the one after (a page can
// hold the tail of the regular results).
function search(options) {
  var q = String(options.q || '').trim();
  var page = Math.max(1, options.page || 1);
  if (!q) {
    return Promise.resolve({ items: [], page: 1, totalPages: 1 });
  }
  return Promise.all([
    get('/search/movie', { query: q, include_adult: false, page: 1 }),
    get('/search/movie', { query: q, include_adult: true, page: 1 })
  ]).then(function (counts) {
    var regular = counts[0].total_results || 0;
    var all = counts[1].total_results || 0;
    var first = Math.floor(regular / PAGE_SIZE) + 1;
    var last = Math.min(Math.ceil(all / PAGE_SIZE), MAX_PAGE);
    var from = first + (page - 1) * 2;
    if (from > last) {
      return { items: [], page: page, totalPages: page };
    }
    var reads = [from, from + 1].filter(function (p) { return p <= last; }).map(function (p) {
      return p === 1 ? Promise.resolve(counts[1]) : get('/search/movie', { query: q, include_adult: true, page: p });
    });
    return Promise.all(reads).then(function (pages) {
      var seen = {};
      var period = periodParams(options.period);
      var items = [];
      pages.forEach(function (data) {
        toPage(data).items.forEach(function (it) {
          if (seen[it.id]) return;
          seen[it.id] = true;
          if (period['primary_release_date.gte'] && (!it.releaseDate || it.releaseDate < period['primary_release_date.gte'])) return;
          if (period['primary_release_date.lte'] && (!it.releaseDate || it.releaseDate > period['primary_release_date.lte'])) return;
          items.push(it);
        });
      });
      return {
        items: items,
        page: page,
        totalPages: Math.max(page, Math.ceil((last - first + 1) / 2))
      };
    });
  });
}

function studios() {
  return Promise.resolve(STUDIOS.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  }));
}

function title(id) {
  return get('/movie/' + encodeURIComponent(id), { append_to_response: 'credits' }).then(function (m) {
    if (!m.adult) {
      throw Object.assign(new Error('Not an 18+ title'), { status: 404 });
    }
    var companies = (m.production_companies || []).map(function (c) {
      return { id: String(c.id), name: c.name };
    });
    var known = companies.filter(function (c) { return studioOf(c.id); })[0];
    var result = item(m, known || companies[0] || null);
    var credits = m.credits || {};
    var director = (credits.crew || []).filter(function (c) { return c.job === 'Director'; })[0];
    return Object.assign(result, {
      runtime: m.runtime || null,
      performers: (credits.cast || []).slice(0, 20).map(function (c) {
        return { name: c.name, photo: c.profile_path ? PROFILE + c.profile_path : null };
      }),
      director: director ? director.name : null,
      studios: companies,
      // a studio of ours: the title page offers "More from <studio>"
      browsableStudio: known ? known.id : null
    });
  });
}

module.exports = {
  id: 'tmdb',
  name: 'TMDB',
  description: 'The Movie Database: posters, cast and studios of released films. Uses TMDB_API_KEY.',
  periods: PERIODS,
  isConfigured: function () { return !!process.env.TMDB_API_KEY; },
  home: home,
  row: row,
  discover: discover,
  search: search,
  studios: studios,
  title: title,
  STUDIOS: STUDIOS
};
