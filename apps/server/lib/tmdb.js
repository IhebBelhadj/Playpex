'use strict';

// Minimal TMDB client for the server (the UI calls TMDB directly). Used as the
// recommendations "catalog". Key: TMDB_API_KEY (environment or the repo's .env,
// loaded by server.js); without it every call rejects and recommendations are empty.

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
    adult: !!r.adult
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

module.exports = {
  recommendations: recommendations
};
