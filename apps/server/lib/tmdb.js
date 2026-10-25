'use strict';

// The server's TMDB client: the catalog clients browse (lib/catalog.js,
// /catalog/*), the recommendations "catalog", the library's matching
// (lib/library/match.js) and plugins (`playpex.tmdb.*`, lib/plugins/core.js:
// `get`). Key: the admin's (`providers.tmdbApiKey`, TMDB_API_KEY), else the
// app key Playpex ships (decision B of docs/providers-plan.md: a fresh server
// shows a catalog).

var axios = require('axios').default;
var settings = require('./settings');

var BASE = 'https://api.themoviedb.org/3';
// Playpex's own TMDB app key (TMDB allows app keys in distributed apps)
var DEFAULT_KEY = '0067d3f9de200e949bc7f144b1ff83f1';
var CACHE_TTL = 6 * 60 * 60 * 1000,
  CACHE_MAX = 2000;        // entries: plugins can ask for many different pages

var cache = new Map();

function apiKey() {
  return settings.get('providers.tmdbApiKey') || DEFAULT_KEY;
}

// Kept 6 h (or `ttl` ms); past CACHE_MAX the oldest entry goes (a Map keeps insertion order)
function remember(key, results, ttl) {
  cache.delete(key);
  cache.set(key, { results: results, expires: Date.now() + (ttl || CACHE_TTL) });
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  results.catch(function () { cache.delete(key); });
}

function toCandidate(mediaType, r) {
  return {
    mediaType: mediaType,
    tmdbId: r.id,
    title: r.title || r.name || null,
    overview: r.overview || null,
    posterPath: r.poster_path || null,
    backdropPath: r.backdrop_path || null,
    genreIds: r.genre_ids || [],
    voteAverage: r.vote_average || 0,
    releaseDate: r.release_date || r.first_air_date || null,
    adult: !!r.adult   // plugins-check: allow (recommendations leave adult titles out)
  };
}

/**
 * TMDB's recommendations for a title (first page, ~20), cached 6 h.
 * @param {{ mediaType: 'movie'|'tv', tmdbId: number }} ref
 */
function recommendations(ref) {
  var key = ref.mediaType + ':' + ref.tmdbId,
    cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.results;
  }
  var results = axios.get(BASE + '/' + ref.mediaType + '/' + ref.tmdbId + '/recommendations', {
    params: { api_key: apiKey(), language: 'en-US', page: 1 },
    timeout: 15000
  }).then(function (res) {
    return (res.data.results || []).map(function (r) { return toCandidate(ref.mediaType, r); });
  });
  remember(key, results);
  return results;
}

// GET <path> with params (`language` en-US unless given), cached 6 h or
// `options.ttl` ms (failures are not kept)
function get(path, params, options) {
  var key = path + '?' + JSON.stringify(params || {}),
    cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.results;
  }
  var results = axios.get(BASE + path, {
    params: Object.assign({ api_key: apiKey(), language: 'en-US' }, params),
    timeout: 15000
  }).then(function (res) {
    return res.data;
  });
  remember(key, results, options && options.ttl);
  return results;
}

// Always: the admin's key, else Playpex's
function configured() {
  return true;
}

// The admin set no key of their own (the dashboard says so)
function builtInKey() {
  return !settings.get('providers.tmdbApiKey');
}

// search/movie · search/tv: the first page's results
function search(mediaType, query, year) {
  var params = { query: query, include_adult: false };
  if (year) {
    params[mediaType === 'movie' ? 'year' : 'first_air_date_year'] = year;
  }
  return get('/search/' + mediaType, params).then(function (data) { return data.results || []; });
}

module.exports = {
  recommendations: recommendations,
  configured: configured,
  builtInKey: builtInKey,
  get: get,
  search: search,
  movie: function (id) { return get('/movie/' + id, { append_to_response: 'external_ids' }); },
  tv: function (id) { return get('/tv/' + id, { append_to_response: 'external_ids' }); },
  season: function (id, season) { return get('/tv/' + id + '/season/' + season); },
  // An IMDb / TVDB id → { movie_results, tv_results, tv_episode_results }
  find: function (id, source) { return get('/find/' + id, { external_source: source || 'imdb_id' }); }
};
