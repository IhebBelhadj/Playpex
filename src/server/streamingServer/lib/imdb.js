'use strict';

// IMDb ratings of a series and of each of its episodes, read from IMDb's own
// GraphQL API (the one imdb.com uses; no key). Season ratings don't exist on
// IMDb: a season's is the mean of its rated episodes'. Cached 6 h per title.
// IMDb allows only limited non-commercial use of this data (see the API's
// "disclaimer"), which is what this educational project is.
// Routes: /api/imdb/:id, /api/imdb/:id/episodes (api.js).

var axios = require('axios').default;

var ENDPOINTS = ['https://caching.graphql.imdb.com/', 'https://api.graphql.imdb.com/'];
var CACHE_TTL = 6 * 60 * 60 * 1000;
var PAGE_SIZE = 250;
var MAX_PAGES = 8;            // 2000 episodes: long-running soaps stop there

// Without browser-like headers the API answers 403
var HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'x-imdb-client-name': 'imdb-web-next',
  origin: 'https://www.imdb.com'
};

var TITLE_QUERY = 'query($id:ID!){ title(id:$id) { ratingsSummary { aggregateRating voteCount } } }';

var EPISODES_QUERY = 'query($id:ID!,$after:ID){ title(id:$id) {' +
  ' ratingsSummary { aggregateRating voteCount }' +
  ' episodes { episodes(first:' + PAGE_SIZE + ', after:$after) {' +
  '  pageInfo { hasNextPage endCursor }' +
  '  edges { node { id ratingsSummary { aggregateRating voteCount }' +
  '   series { displayableEpisodeNumber { episodeNumber { text } displayableSeason { text } } } } }' +
  ' } } } }';

var cache = new Map();

function isImdbId(id) {
  return /^tt\d{5,10}$/.test(String(id || ''));
}

function query(text, variables) {
  function attempt(i) {
    return axios.post(ENDPOINTS[i], { query: text, variables: variables }, { headers: HEADERS, timeout: 10000 })
      .then(function (response) {
        var data = response.data || {};
        if (!data.data || !data.data.title) {
          var message = data.errors && data.errors[0] ? data.errors[0].message : 'no such title';
          throw new Error('IMDb: ' + message);
        }
        return data.data.title;
      })
      .catch(function (error) {
        if (i + 1 < ENDPOINTS.length) {
          return attempt(i + 1);
        }
        throw error;
      });
  }
  return attempt(0);
}

function ratingOf(summary) {
  return {
    rating: summary && summary.aggregateRating ? summary.aggregateRating : null,
    votes: summary && summary.voteCount ? summary.voteCount : 0
  };
}

// Same id + kind within CACHE_TTL: one request (also while it's in flight);
// a failure isn't kept
function cached(key, load) {
  var hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  var value = load().catch(function (error) {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { value: value, expires: Date.now() + CACHE_TTL });
  return value;
}

/**
 * A title's IMDb rating.
 * @returns {Promise<{ id, rating: number|null, votes: number }>}
 */
function title(id) {
  return cached('title:' + id, function () {
    return query(TITLE_QUERY, { id: id }).then(function (t) {
      return Object.assign({ id: id }, ratingOf(t.ratingsSummary));
    });
  });
}

/**
 * A series' rating, its seasons' (mean of the rated episodes) and its episodes'.
 * @returns {Promise<{ id, rating, votes, seasons: [{ season, rating, rated, episodes: [{ episode, id, rating, votes }] }] }>}
 */
function episodes(id) {
  return cached('episodes:' + id, function () {
    var bySeason = {};
    var series = null;

    function read(after, pages) {
      return query(EPISODES_QUERY, { id: id, after: after || null }).then(function (t) {
        series = series || ratingOf(t.ratingsSummary);
        var list = t.episodes && t.episodes.episodes;
        if (!list) {
          return;
        }
        list.edges.forEach(function (edge) {
          var node = edge.node;
          var number = node.series && node.series.displayableEpisodeNumber;
          var season = number && parseInt(number.displayableSeason && number.displayableSeason.text, 10);
          var episode = number && parseInt(number.episodeNumber && number.episodeNumber.text, 10);
          // "unknown" season / episode: nothing to match it with
          if (!(season >= 0) || !(episode >= 0)) {
            return;
          }
          (bySeason[season] = bySeason[season] || []).push(Object.assign({ episode: episode, id: node.id }, ratingOf(node.ratingsSummary)));
        });
        if (list.pageInfo && list.pageInfo.hasNextPage && pages + 1 < MAX_PAGES) {
          return read(list.pageInfo.endCursor, pages + 1);
        }
      });
    }

    return read(null, 0).then(function () {
      var seasons = Object.keys(bySeason).map(Number).sort(function (a, b) {
        return a - b;
      }).map(function (season) {
        var list = bySeason[season].sort(function (a, b) {
          return a.episode - b.episode;
        });
        var rated = list.filter(function (e) {
          return e.rating;
        });
        var sum = rated.reduce(function (total, e) {
          return total + e.rating;
        }, 0);
        return {
          season: season,
          rating: rated.length ? Math.round(sum / rated.length * 10) / 10 : null,
          rated: rated.length,
          episodes: list
        };
      });
      return Object.assign({ id: id }, series, { seasons: seasons });
    });
  });
}

module.exports = {
  isImdbId: isImdbId,
  title: title,
  episodes: episodes
};
