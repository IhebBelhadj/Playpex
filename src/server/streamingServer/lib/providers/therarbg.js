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

// category: only that category ('XXX'); the plain keywords search mixes them
function query(keywords, category) {
  var mirrors = MIRRORS.slice();
  var path = category
    ? '/get-posts/keywords:' + encodeURIComponent(keywords) + ':category:' + category + '/'
    : '/get-posts/';

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + path, {
      params: category ? { format: 'json' } : { keywords: keywords, format: 'json' },
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

// 18+ movies (category XXX) whose release name mentions `title`;
// adult.js does the matching and ranking
function searchAdult(title) {
  var name = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return query(name, 'XXX').then(function (results) {
    return results
      .filter(function (r) {
        return r.h && r.c === 'XXX';
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

// The 18+ section's list: category XXX, most seeded first, 50 per page.
// keywords: optional search words (the quality filter adds e.g. "1080p" so
// pages aren't emptied by filtering afterwards)
function browseAdult(keywords, page) {
  var filters = 'order:-se:category:XXX';
  var words = String(keywords || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (words) {
    filters = 'keywords:' + encodeURIComponent(words) + ':' + filters;
  }
  var mirrors = MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/get-posts/' + filters + '/', {
      params: { format: 'json', page: page > 1 ? page : undefined },
      timeout: 15000
    }).then(function (res) {
      var data = res.data || {};
      return {
        results: (data.results || [])
          .filter(function (r) {
            return r.h && r.c === 'XXX';
          })
          .map(function (r) {
            var hash = r.h.toLowerCase();
            return {
              provider: 'TheRARBG',
              name: r.n,
              hash: hash,
              magnet: trackers.build(hash, r.n),
              seeds: Number(r.se) || 0,
              peers: Number(r.le) || 0,
              size: Number(r.s) || 0,
              added: Number(r.a) || 0
            };
          }),
        hasMore: !!(data.links && data.links.next)
      };
    }).catch(function (err) {
      if (mirrors.length) {
        return attempt();
      }
      throw err;
    });
  }

  return attempt();
}

module.exports = {
  name: 'TheRARBG',
  search: search,
  searchAdult: searchAdult,
  browseAdult: browseAdult
};
