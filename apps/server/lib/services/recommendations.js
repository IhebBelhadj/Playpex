'use strict';

// Per-profile recommendations, seeded from what the profile finished or liked.
//
//   seeds      titles from the history (watched >= SEED_MIN_RATIO) and likes,
//              weighted by recency (half-life HALF_LIFE_DAYS); likes count double;
//              disliked titles are never seeds
//   candidates the catalog's recommendations for the top MAX_SEEDS seeds; a
//              candidate scores seedWeight × (1 − rank / n) per seed that lists it
//   boost      × (1 + GENRE_BOOST × the profile's affinity for its genres)
//   excluded   anything watched, in progress, disliked, adult; kid profiles keep
//              only family / animation / kids titles
//
// With no history and no likes the result is empty (the UI keeps its usual rows).

var validate = require('./validate');

var SEED_MIN_RATIO = 0.7,
  HALF_LIFE_DAYS = 45,
  LIKE_WEIGHT = 2,
  MAX_SEED_WEIGHT = 3,       // a binged show must not drown everything else
  MAX_SEEDS = 10,
  GENRE_BOOST = 0.5,
  KID_GENRES = [16, 10751, 10762];   // Animation, Family, Kids (TV)

var DAY_MS = 24 * 60 * 60 * 1000;

function key(ref) {
  return ref.mediaType + ':' + ref.tmdbId;
}

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, catalog: { recommendations: function({mediaType, tmdbId}): Promise<object[]> },
 *           now?: function(): Date }} options
 */
module.exports = function recommendationsService(repositories, options) {
  var profiles = options.profiles,
    catalog = options.catalog,
    now = options.now || function () { return new Date(); };

  function decay(date) {
    var days = Math.max(0, (now() - date) / DAY_MS);
    return Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  function load(profileId) {
    return Promise.all([
      repositories.history.list(profileId, { minRatio: SEED_MIN_RATIO, limit: 300 }),
      repositories.ratings.list(profileId, { limit: 300 }),
      repositories.history.watchedTitles(profileId),
      repositories.progress.listRecent(profileId, { limit: 500 })
    ]).then(function (r) {
      return { history: r[0], ratings: r[1], watched: r[2], inProgress: r[3] };
    });
  }

  function buildSeeds(data, mediaType) {
    var seeds = new Map(), genres = new Map(), disliked = new Set();

    function addGenres(ids, weight) {
      (ids || []).forEach(function (id) { genres.set(id, (genres.get(id) || 0) + weight); });
    }

    function addSeed(entry, weight) {
      var k = key(entry), seed = seeds.get(k);
      if (!seed) {
        seed = { mediaType: entry.mediaType, tmdbId: entry.tmdbId, title: entry.title, weight: 0 };
        seeds.set(k, seed);
      }
      seed.weight = Math.min(MAX_SEED_WEIGHT, seed.weight + weight);
      seed.title = seed.title || entry.title;
    }

    data.ratings.forEach(function (r) {
      if (r.value < 0) {
        disliked.add(key(r));
      } else {
        addSeed(r, LIKE_WEIGHT * decay(r.ratedAt));
        addGenres(r.genreIds, LIKE_WEIGHT * decay(r.ratedAt));
      }
    });
    data.history.forEach(function (h) {
      if (!disliked.has(key(h))) {
        addSeed(h, decay(h.watchedAt));
        addGenres(h.genreIds, decay(h.watchedAt));
      }
    });

    var top = Array.from(seeds.values())
      .filter(function (s) { return !disliked.has(key(s)) && (!mediaType || s.mediaType === mediaType); })
      .sort(function (a, b) { return b.weight - a.weight; })
      .slice(0, MAX_SEEDS);

    var maxGenre = Math.max.apply(null, [0].concat(Array.from(genres.values())));
    genres.forEach(function (v, id) { genres.set(id, maxGenre ? v / maxGenre : 0); });

    return { seeds: top, allSeeds: seeds, genres: genres, disliked: disliked };
  }

  function affinity(genres, ids) {
    if (!ids || !ids.length) {
      return 0;
    }
    return ids.reduce(function (sum, id) { return sum + (genres.get(id) || 0); }, 0) / ids.length;
  }

  return {
    /**
     * @param {{ mediaType?: 'movie'|'tv', limit?: number }} [filter]
     * @returns {Promise<{ items: object[], seeds: number }>} items are catalog
     *   candidates plus `score` and `because` ({ mediaType, tmdbId, title } of the
     *   seed that contributed most: "Because you watched …")
     */
    forProfile: function (profileId, filter) {
      filter = filter || {};
      return profiles.requireProfile(profileId).then(function (profile) {
        var mediaType = filter.mediaType ? validate.mediaType(filter.mediaType) : null,
          limit = validate.limit(filter.limit, 20, 100);

        return load(profileId).then(function (data) {
          var built = buildSeeds(data, mediaType);
          if (!built.seeds.length) {
            return { items: [], seeds: 0 };
          }

          var excluded = new Set(built.disliked);
          data.watched.forEach(function (t) { excluded.add(key(t)); });
          data.inProgress.forEach(function (p) { excluded.add(key(p)); });
          built.allSeeds.forEach(function (s, k) { excluded.add(k); });

          return Promise.allSettled(built.seeds.map(function (seed) {
            return catalog.recommendations({ mediaType: seed.mediaType, tmdbId: seed.tmdbId });
          })).then(function (results) {
            var candidates = new Map();

            results.forEach(function (result, i) {
              if (result.status !== 'fulfilled') {
                return;
              }
              var seed = built.seeds[i], list = result.value || [];
              list.forEach(function (c, rank) {
                var k = key(c);
                if (excluded.has(k) || c.adult || (mediaType && c.mediaType !== mediaType)) {
                  return;
                }
                if (profile.isKid && !(c.genreIds || []).some(function (g) { return KID_GENRES.indexOf(g) !== -1; })) {
                  return;
                }
                var contribution = seed.weight * (1 - rank / list.length),
                  entry = candidates.get(k);
                if (!entry) {
                  entry = { candidate: c, score: 0, best: 0, because: null };
                  candidates.set(k, entry);
                }
                entry.score += contribution;
                if (contribution > entry.best) {
                  entry.best = contribution;
                  entry.because = { mediaType: seed.mediaType, tmdbId: seed.tmdbId, title: seed.title };
                }
              });
            });

            var items = Array.from(candidates.values()).map(function (e) {
              return Object.assign({}, e.candidate, {
                score: e.score * (1 + GENRE_BOOST * affinity(built.genres, e.candidate.genreIds)),
                because: e.because
              });
            }).sort(function (a, b) { return b.score - a.score; }).slice(0, limit);

            return { items: items, seeds: built.seeds.length };
          });
        });
      });
    }
  };
};
