'use strict';

// EZTV official API: every torrent for a show, looked up by IMDb id.
// The API has no season/episode filter, so all pages are fetched once and cached.

var axios = require('axios').default;
var trackers = require('../trackers');

// Mirrors of the same API, tried in order
var MIRRORS = ['https://eztvx.to', 'https://eztv.wf', 'https://eztv.tf'];
var PAGE_SIZE = 100;
var MAX_PAGES = 15;
var CACHE_TTL = 30 * 60 * 1000;

var cache = {};

// imdbId: digits only, or null for the site's latest torrents
function getPage(imdbId, page) {
  var mirrors = MIRRORS.slice();
  var params = { limit: PAGE_SIZE, page: page };
  if (imdbId) {
    params.imdb_id = imdbId;
  }

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/api/get-torrents', {
      params: params,
      timeout: 15000
    }).then(function (res) {
      if (!res.data || typeof res.data !== 'object') {
        throw new Error('EZTV: unexpected answer');
      }
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

function toRelease(t) {
  var hash = String(t.hash).toLowerCase();
  var name = t.title || t.filename;
  return {
    provider: 'EZTV',
    name: name,
    hash: hash,
    magnet: trackers.build(hash, name, t.magnet_url ? [t.magnet_url] : []),
    seeds: Number(t.seeds) || 0,
    peers: Number(t.peers) || 0,
    size: Number(t.size_bytes) || 0,
    added: Number(t.date_released_unix) || 0
  };
}

function wordsOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// every word of the keywords appears in the release name (loosely: punctuation ignored)
function matchesWords(name, words) {
  if (!words.length) {
    return true;
  }
  var have = ' ' + wordsOf(name).join(' ') + ' ';
  return words.every(function (w) {
    return have.indexOf(' ' + w + ' ') !== -1;
  });
}

// A release list (releases.js).
// imdbId given (digits, "tt" optional): that show's torrents (cached), filtered by
// the keywords, most seeded first, paged locally (PAGE_SIZE per page).
// No imdbId: the site's latest torrents, page by page (it has no keyword search:
// keywords only filter each page).
function browse(keywords, imdbId, page) {
  var words = wordsOf(keywords);
  page = Math.max(1, page || 1);

  if (imdbId) {
    return getShowTorrents(String(imdbId).replace(/^tt/, '')).then(function (torrents) {
      var list = torrents
        .filter(function (t) {
          return t.hash && matchesWords(t.title || t.filename, words);
        })
        .map(toRelease)
        .sort(function (a, b) {
          return b.seeds - a.seeds;
        });
      return {
        results: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        hasMore: list.length > page * PAGE_SIZE
      };
    });
  }

  return getPage(null, page).then(function (data) {
    var torrents = data.torrents || [];
    var total = Number(data.torrents_count) || 0;
    return {
      results: torrents
        .filter(function (t) {
          return t.hash && matchesWords(t.title || t.filename, words);
        })
        .map(toRelease),
      hasMore: torrents.length === PAGE_SIZE && page * PAGE_SIZE < total
    };
  });
}

module.exports = {
  name: 'EZTV',
  search: search,
  browse: browse
};
