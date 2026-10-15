'use strict';

// YTS movie API (list_movies.json / movie_details.json). yts.mx stopped
// answering in 2026; the API itself announces movies-api.accel.li as its new
// base URL. Used by lib/api.js (/api/movies proxy) and the movie release list.
// YTS releases are small x264 (or x265 for 2160p) encodes with AAC audio.
// Seed counts are capped at 100 by the API. Its `sort_by=seeds|peers` is broken
// (answers the newest uploads, 0 seeders): lists sort by download_count.

var axios = require('axios').default;
var trackers = require('../trackers');

var MIRRORS = ['https://movies-api.accel.li', 'https://yts.lt', 'https://yts.ag'];
var PAGE_SIZE = 50;

// endpoint: 'list_movies.json' | 'movie_details.json'; resolves the axios response
function get(endpoint, params) {
  var mirrors = MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/api/v2/' + endpoint, { params: params, timeout: 15000 })
      .catch(function (err) {
        if (mirrors.length) {
          return attempt();
        }
        throw err;
      });
  }

  return attempt();
}

// "Dune: Part Two (2024) [1080p] [BluRay] [x265] [10bit] [AAC 5.1] [YTS]":
// the codec tags let episodes.describe() classify it like any other release
function releaseName(movie, t) {
  var type = { bluray: 'BluRay', web: 'WEB', webrip: 'WEBRip' }[String(t.type).toLowerCase()] || t.type;
  return [
    movie.title_long || (movie.title + ' (' + movie.year + ')'),
    '[' + t.quality + ']',
    type ? '[' + type + ']' : '',
    t.video_codec ? '[' + t.video_codec + ']' : '',
    String(t.bit_depth) === '10' ? '[10bit]' : '',
    '[AAC' + (t.audio_channels ? ' ' + t.audio_channels : '') + ']',
    '[YTS]'
  ].filter(Boolean).join(' ');
}

// A release list (releases.js): every torrent of each listed movie (no 3D ones).
// No keywords: the most downloaded movies; keywords: query_term. 50 movies per page.
// quality: '2160p' | '1080p' | '720p' narrows the movies listed (filtered again by releases.js)
function browse(keywords, quality, page) {
  var params = {
    limit: PAGE_SIZE,
    page: page > 1 ? page : 1,
    sort_by: 'download_count'
  };
  var words = String(keywords || '').trim();
  if (words) {
    params.query_term = words;
  }
  if (quality === '2160p' || quality === '1080p' || quality === '720p') {
    params.quality = quality;
  }

  return get('list_movies.json', params).then(function (res) {
    var data = res.data && res.data.data;
    if (!data) {
      throw new Error('YTS: unexpected answer');
    }
    var movies = data.movies || [];
    var results = [];
    movies.forEach(function (movie) {
      (movie.torrents || []).forEach(function (t) {
        if (!t.hash || t.quality === '3D') {
          return;
        }
        var hash = String(t.hash).toLowerCase();
        var name = releaseName(movie, t);
        results.push({
          provider: 'YTS',
          name: name,
          hash: hash,
          magnet: trackers.build(hash, name),
          seeds: Number(t.seeds) || 0,
          peers: Number(t.peers) || 0,
          size: Number(t.size_bytes) || 0,
          added: Number(t.date_uploaded_unix) || 0,
          // the movie's own title / year beat what a parser makes of the name
          title: movie.title_english || movie.title,
          year: Number(movie.year) || null
        });
      });
    });
    return {
      results: results,
      hasMore: params.page * PAGE_SIZE < (Number(data.movie_count) || 0)
    };
  });
}

module.exports = {
  name: 'YTS',
  MIRRORS: MIRRORS,
  get: get,
  browse: browse
};
