'use strict';

// The Pirate Bay, through its JSON API (apibay.org, what thepiratebay.org's own
// page calls). Used for 18+ movies only: category 500 "Porn".
// Result fields: name, info_hash, seeders, leechers, size (bytes), category.
// No match answers one fake row with an all-zero info hash.

var axios = require('axios').default;
var trackers = require('../trackers');

var MIRRORS = ['https://apibay.org'];

// Porn subcategories that hold films: 501 Movies, 505 HD - Movies,
// 506 Movie clips, 507 UHD/4k - Movies (not DVDR images, pictures, games)
var ADULT_MOVIE_CATEGORIES = ['501', '505', '506', '507'];

var NO_HASH = /^0+$/;

// Names come HTML-escaped ("Laurent Sky &amp; Julia Grandi")
function unescape(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// path: '/q.php' with params, or a precompiled top-100 list
function get(path, params) {
  var mirrors = MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + path, {
      params: params,
      timeout: 15000
    }).then(function (res) {
      return Array.isArray(res.data) ? res.data : [];
    }).catch(function (err) {
      if (mirrors.length) {
        return attempt();
      }
      throw err;
    });
  }

  return attempt();
}

function query(keywords, category) {
  return get('/q.php', { q: keywords, cat: category });
}

// 18+ movies whose release name mentions `title`; adult.js does the matching
function searchAdult(title) {
  var name = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return query(name, '500').then(function (results) {
    return results
      .filter(function (r) {
        return r.info_hash && !NO_HASH.test(r.info_hash) &&
          ADULT_MOVIE_CATEGORIES.indexOf(String(r.category)) !== -1;
      })
      .map(function (r) {
        var hash = r.info_hash.toLowerCase();
        return {
          provider: 'The Pirate Bay',
          name: unescape(r.name),
          hash: hash,
          magnet: trackers.build(hash, unescape(r.name)),
          seeds: Number(r.seeders) || 0,
          size: Number(r.size) || 0
        };
      });
  });
}

// The 18+ section's list. No keywords: the site's 100 most seeded of the
// category; keywords: its search (up to 100 results). No paging either way.
// category: '500' (all porn) or one of ADULT_MOVIE_CATEGORIES
function browseAdult(keywords, category) {
  var words = String(keywords || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var list = words
    ? query(words, category)
    : get('/precompiled/data_top100_' + category + '.json');

  return list.then(function (results) {
    return {
      results: results
        .filter(function (r) {
          return r.info_hash && !NO_HASH.test(r.info_hash) &&
            ADULT_MOVIE_CATEGORIES.indexOf(String(r.category)) !== -1;
        })
        .map(function (r) {
          var hash = r.info_hash.toLowerCase();
          return {
            provider: 'The Pirate Bay',
            name: unescape(r.name),
            hash: hash,
            magnet: trackers.build(hash, unescape(r.name)),
            seeds: Number(r.seeders) || 0,
            peers: Number(r.leechers) || 0,
            size: Number(r.size) || 0,
            added: Number(r.added) || 0
          };
        }),
      hasMore: false
    };
  });
}

module.exports = {
  name: 'The Pirate Bay',
  searchAdult: searchAdult,
  browseAdult: browseAdult,
  ADULT_MOVIE_CATEGORIES: ADULT_MOVIE_CATEGORIES
};
