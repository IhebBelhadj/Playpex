'use strict';

// EZTV official API: every torrent for a show, looked up by IMDb id.
// The API has no season/episode filter, so all pages are fetched once and cached.

var axios = require('axios').default;

// Mirrors of the same API, tried in order
var MIRRORS = ['https://eztvx.to', 'https://eztv.wf', 'https://eztv.tf'];
var PAGE_SIZE = 100;
var MAX_PAGES = 15;
var CACHE_TTL = 30 * 60 * 1000;

var cache = {};

function getPage(imdbId, page) {
  var mirrors = MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/api/get-torrents', {
      params: { imdb_id: imdbId, limit: PAGE_SIZE, page: page },
      timeout: 15000
    }).then(function (res) {
      return res.data;
    }).catch(function (err) {
      if (mirrors.length) {
        return attempt();
      }
      throw err;
    });
  }

  return attempt();
}

function fetchAll(imdbId) {
  var all = [];

  function next(page) {
    return getPage(imdbId, page).then(function (data) {
      var torrents = data.torrents || [];
      all = all.concat(torrents);
      var total = Number(data.torrents_count) || 0;
      if (torrents.length === PAGE_SIZE && all.length < total && page < MAX_PAGES) {
        return next(page + 1);
      }
      return all;
    });
  }

  return next(1);
}

function getShowTorrents(imdbId) {
  var cached = cache[imdbId];
  if (cached && cached.expires > Date.now()) {
    return cached.torrents;
  }
  var torrents = fetchAll(imdbId);
  cache[imdbId] = { torrents: torrents, expires: Date.now() + CACHE_TTL };
  torrents.catch(function () {
    delete cache[imdbId];
  });
  return torrents;
}

// imdbId: digits only (no "tt")
function search(imdbId, season, episode) {
  return getShowTorrents(imdbId).then(function (torrents) {
    return torrents
      .filter(function (t) {
        var ep = Number(t.episode);
        // episode 0 = whole-season pack
        return Number(t.season) === season && (ep === episode || ep === 0) && t.hash;
      })
      .map(function (t) {
        return {
          provider: 'EZTV',
          name: t.title || t.filename,
          hash: t.hash.toLowerCase(),
          magnet: t.magnet_url,
          seeds: Number(t.seeds) || 0,
          size: Number(t.size_bytes) || 0
        };
      });
  });
}

module.exports = {
  name: 'EZTV',
  search: search
};
