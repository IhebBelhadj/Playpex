'use strict';

// ThePornDB (theporndb.net): metadata built for adult films (posters,
// performers, sites). Needs a free API token: THEPORNDB_API_KEY (.env).
// Written against its public API (api.theporndb.net, Bearer token, Laravel
// style `{ data, meta: { current_page, last_page } }` answers) — not verified
// end to end without a key: fields are read defensively.

var axios = require('axios').default;

var BASE = 'https://api.theporndb.net';
var CACHE_TTL = 60 * 60 * 1000;
var PER_PAGE = 30;

var PERIODS = [
  { id: '', label: 'Any time' },
  { id: 'year', label: 'This year' },
  { id: '5y', label: 'Last 5 years' },
  { id: 'classic', label: 'Before 2015' }
];

var cache = new Map();

function get(path, params) {
  var token = process.env.THEPORNDB_API_KEY;
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

function site(s) {
  return s && s.name ? { id: String(s.id || s.uuid || s._id), name: s.name } : null;
}

function item(m) {
  var date = m.date || m.release_date || '';
  return {
    id: String(m.id || m._id),
    title: m.title || 'Untitled',
    year: date ? Number(String(date).slice(0, 4)) : null,
    releaseDate: date || null,
    overview: m.description || '',
    poster: pick(m, ['posters.large', 'posters.medium', 'poster', 'image']),
    backdrop: pick(m, ['background.large', 'background.full', 'back_image', 'image']),
    rating: m.rating ? Number(m.rating) : null,
    studio: site(m.site)
  };
}

function inPeriod(it, period) {
  if (!period) return true;
  if (!it.year) return false;
  var year = new Date().getFullYear();
  if (period === 'year') return it.year >= year;
  if (period === '5y') return it.year >= year - 5;
  if (period === 'classic') return it.year < 2015;
  return true;
}

function toPage(data, period) {
  var meta = data.meta || {};
  return {
    items: (data.data || []).map(item).filter(function (it) { return inPeriod(it, period); }),
    page: meta.current_page || 1,
    totalPages: meta.last_page || 1
  };
}

function movies(params, period) {
  return get('/movies', Object.assign({ per_page: PER_PAGE }, params)).then(function (data) {
    return toPage(data, period);
  });
}

// The busiest sites first, as rows and as the studio filter
function studios() {
  return get('/sites', { per_page: 40 }).then(function (data) {
    return (data.data || []).map(site).filter(Boolean);
  });
}

function home() {
  return studios().catch(function () { return []; }).then(function (sites) {
    return [{ key: 'latest', title: 'New releases' }].concat(sites.slice(0, 10).map(function (s) {
      return { key: 'studio:' + s.id, title: s.name };
    }));
  });
}

function row(key, page) {
  var studio = /^studio:(.+)$/.exec(key);
  if (studio) {
    return movies({ site_id: studio[1], page: page });
  }
  return movies({ page: page });
}

function discover(options) {
  // its listing is newest first; other sorts aren't offered
  var params = { page: options.page || 1 };
  if (options.studio) params.site_id = options.studio;
  return movies(params, options.period);
}

function search(options) {
  return movies({ q: options.q, page: options.page || 1 }, options.period);
}

function title(id) {
  return get('/movies/' + encodeURIComponent(id)).then(function (data) {
    var m = data.data || data;
    var result = item(m);
    var duration = Number(m.duration) || 0;
    var director = (m.directors || [])[0];
    return Object.assign(result, {
      runtime: duration ? Math.round(duration / 60) : null,
      performers: (m.performers || []).map(function (p) {
        return {
          name: p.name || (p.parent && p.parent.name) || '',
          photo: pick(p, ['face', 'image', 'parent.face', 'parent.image'])
        };
      }).filter(function (p) { return p.name; }),
      director: director ? director.name : null,
      studios: result.studio ? [result.studio] : [],
      browsableStudio: result.studio ? result.studio.id : null
    });
  });
}

module.exports = {
  id: 'theporndb',
  name: 'ThePornDB',
  description: 'Metadata made for adult films: posters, performers and sites. Needs THEPORNDB_API_KEY (free at theporndb.net).',
  periods: PERIODS,
  isConfigured: function () { return !!process.env.THEPORNDB_API_KEY; },
  home: home,
  row: row,
  discover: discover,
  search: search,
  studios: studios,
  title: title
};
