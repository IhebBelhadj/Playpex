'use strict';

// TheRARBG (therarbg.to): community successor of RARBG, which shut down in 2023.
// Uses the JSON mode of its search page: /get-posts/?keywords=...&format=json
// Result fields: n = name, h = info hash, s = size (bytes), se = seeders, c = category.

var axios = require('axios').default;
var trackers = require('../trackers');

var MIRRORS = ['https://therarbg.to', 'https://therarbg.com'];

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function query(keywords) {
  var mirrors = MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/get-posts/', {
      params: { keywords: keywords, format: 'json' },
      timeout: 15000
    }).then(function (res) {
      return (res.data && res.data.results) || [];
    }).catch(function (err) {
      if (mirrors.length) {
        return attempt();
      }
      throw err;
    });
  }

  return attempt();
}

// title: show name, e.g. "Game of Thrones"
// Returns single-episode releases and that season's packs; episodes.js does
// the strict title/episode matching for every provider
function search(title, season, episode) {
  var name = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  var episodeQuery = query(name + ' S' + pad(season) + 'E' + pad(episode));
  var packQuery = query(name + ' S' + pad(season)).catch(function () {
    return [];
  });

  return Promise.all([episodeQuery, packQuery]).then(function (lists) {
    return lists[0].concat(lists[1])
      .filter(function (r) {
        return r.h && /tv/i.test(r.c || '');
      })
      .map(function (r) {
        return {
          provider: 'TheRARBG',
          name: r.n,
          hash: r.h.toLowerCase(),
          magnet: trackers.build(r.h.toLowerCase(), r.n),
          seeds: Number(r.se) || 0,
          size: Number(r.s) || 0
        };
      });
  });
}

module.exports = {
  name: 'TheRARBG',
  search: search
};
