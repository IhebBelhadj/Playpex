'use strict';

// Minimal TMDB client for the server (the UI calls TMDB directly). Used as the
// recommendations "catalog" and by the library's matching (lib/library/match.js).
// Key: TMDB_API_KEY (environment or the repo's .env, loaded by server.js);
// without it every call rejects (code PROVIDER_NOT_CONFIGURED) and
// recommendations are empty.

var axios = require('axios').default;
var settings = require('./settings');

var BASE = 'https://api.themoviedb.org/3';
var CACHE_TTL = 6 * 60 * 60 * 1000;

var cache = new Map();

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
  if (!settings.get('providers.tmdbApiKey')) {
    return Promise.reject(new Error('TMDB_API_KEY is not set'));
  }
  var results = axios.get(BASE + '/' + ref.mediaType + '/' + ref.tmdbId + '/recommendations', {
    params: { api_key: settings.get('providers.tmdbApiKey'), language: 'en-US', page: 1 },
    timeout: 15000
  }).then(function (res) {
    return (res.data.results || []).map(function (r) { return toCandidate(ref.mediaType, r); });
  });
  cache.set(key, { results: results, expires: Date.now() + CACHE_TTL });
  results.catch(function () { cache.delete(key); });
  return results;
}

// GET <path> with params, cached 6 h (failures are not kept)
function get(path, params) {
  var key = path + '?' + JSON.stringify(params || {}),
    cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.results;
  }
  if (!settings.get('providers.tmdbApiKey')) {
    var err = new Error('TMDB_API_KEY is not set');
    err.code = 'PROVIDER_NOT_CONFIGURED';
    return Promise.reject(err);
  }
  var results = axios.get(BASE + path, {
    params: Object.assign({ api_key: settings.get('providers.tmdbApiKey'), language: 'en-US' }, params),
    timeout: 15000
  }).then(function (res) {
    return res.data;
  });
  cache.set(key, { results: results, expires: Date.now() + CACHE_TTL });
  results.catch(function () { cache.delete(key); });
  return results;
}

function configured() {
  return !!settings.get('providers.tmdbApiKey');
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
  search: search,
  movie: function (id) { return get('/movie/' + id, { append_to_response: 'external_ids' }); },
  tv: function (id) { return get('/tv/' + id, { append_to_response: 'external_ids' }); },
  season: function (id, season) { return get('/tv/' + id + '/season/' + season); },
  // An IMDb / TVDB id → { movie_results, tv_results, tv_episode_results }
  find: function (id, source) { return get('/find/' + id, { external_source: source || 'imdb_id' }); }
};
