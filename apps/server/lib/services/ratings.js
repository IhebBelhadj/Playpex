'use strict';

// Thumbs up / down per title. Likes seed recommendations, dislikes are excluded.

var validate = require('./validate'),
  errors = require('./errors'),
  changes = require('./changes');

// rating.set events carry a 0–10 rating (plugins think in Trakt's scale): a like is 10, a dislike 1
var EVENT_RATING = { '1': 10, '-1': 1 };

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date }} options
 */
module.exports = function ratingsService(repositories, options) {
  var repo = repositories.ratings,
    profiles = options.profiles,
    changed = changes(options.publish),
    now = options.now || function () { return new Date(); };

  function withProfile(profileId, work) {
    return profiles.requireProfile(profileId).then(work);
  }

  return {
    /** @param {{ mediaType, tmdbId, title?, genreIds? }} item  @param {1|-1} value */
    rate: function (profileId, item, value, by) {
      item = item || {};
      return withProfile(profileId, function () {
        if (value !== 1 && value !== -1) {
          throw errors.invalid('value must be 1 (like) or -1 (dislike)');
        }
        var ref = validate.mediaRef(item);
        return repo.upsert({
          profileId: profileId,
          mediaType: ref.mediaType,
          tmdbId: ref.tmdbId,
          title: validate.optionalString(item.title, 'title'),
          genreIds: validate.genreIds(item.genreIds),
          value: value,
          ratedAt: now()
        }).then(function (saved) {
          changed('rating.set', profileId, Object.assign({}, ref, { title: item.title }), by, { rating: EVENT_RATING[value] });
          return saved;
        });
      });
    },

    /** The rating value (1 / -1) or null */
    get: function (profileId, ref) {
      return withProfile(profileId, function () {
        return repo.find(profileId, validate.mediaRef(ref));
      }).then(function (rating) { return rating ? rating.value : null; });
    },

    /** A rating.set event without a rating: none any more */
    clear: function (profileId, ref, by) {
      return withProfile(profileId, function () {
        var key = validate.mediaRef(ref);
        return repo.remove(profileId, key).then(function (removed) {
          if (removed) {
            changed('rating.set', profileId, key, by);
          }
          return removed;
        });
      });
    },

    /** @param {{ value?: 1|-1, limit?: number }} [filter] */
    list: function (profileId, filter) {
      filter = filter || {};
      return withProfile(profileId, function () {
        return repo.list(profileId, {
          value: filter.value === 1 || filter.value === -1 ? filter.value : undefined,
          limit: validate.limit(filter.limit, 100, 500)
        });
      });
    }
  };
};
