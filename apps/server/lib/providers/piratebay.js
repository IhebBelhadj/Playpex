'use strict';

// The Pirate Bay, through its JSON API (apibay.org, what thepiratebay.org's own
// page calls): the release lists of lib/releases.js (movie and TV subcategories).
// Result fields: name, info_hash, seeders, leechers, size (bytes), category.
// No match answers one fake row with an all-zero info hash.

var axios = require('axios').default;
var trackers = require('../trackers');

var MIRRORS = ['https://apibay.org'];

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

function toRelease(r) {
  var hash = r.info_hash.toLowerCase();
  var name = unescape(r.name);
  return {
    provider: 'The Pirate Bay',
    name: name,
    hash: hash,
    magnet: trackers.build(hash, name),
    seeds: Number(r.seeders) || 0,
    peers: Number(r.leechers) || 0,
    size: Number(r.size) || 0,
    added: Number(r.added) || 0
  };
}

// A release list (releases.js). No keywords: the site's 100 most seeded of each
// of `options.lists` (precompiled top-100 lists, merged, de-duplicated by hash);
// keywords: its search in `options.searchCategory` (up to 100 results). Either
// way only `options.categories` are kept. No paging.
// options: { lists: ['201', '207'], searchCategory: '200', categories: ['201', '207', '211'] }
function browse(keywords, options) {
  var words = String(keywords || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var list = words
    ? query(words, options.searchCategory)
    : Promise.all(options.lists.map(function (category) {
      return get('/precompiled/data_top100_' + category + '.json');
    })).then(function (lists) {
      return [].concat.apply([], lists);
    });

  return list.then(function (results) {
    var seen = {};
    return {
      results: results
        .filter(function (r) {
          if (!r.info_hash || NO_HASH.test(r.info_hash) ||
            options.categories.indexOf(String(r.category)) === -1 || seen[r.info_hash]) {
            return false;
          }
          seen[r.info_hash] = true;
          return true;
        })
        .map(toRelease),
      hasMore: false
    };
  });
}

module.exports = {
  name: 'The Pirate Bay',
  browse: browse
};
