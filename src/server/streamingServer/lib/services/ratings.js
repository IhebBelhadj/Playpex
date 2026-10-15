'use strict';

// Thumbs up / down per title. Likes seed recommendations, dislikes are excluded.

var validate = require('./validate'),
  errors = require('./errors');

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date }} options
 */
module.exports = function ratingsService(repositories, options) {
  var repo = repositories.ratings,
    profiles = options.profiles,
    now = options.now || function () { return new Date(); };

  function withProfile(profileId, work) {
    return profiles.requireProfile(profileId).then(work);
  }

  return {
    /** @param {{ mediaType, tmdbId, title?, genreIds? }} item  @param {1|-1} value */
    rate: function (profileId, item, value) {
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
        });
      });
    },

    /** The rating value (1 / -1) or null */
    get: function (profileId, ref) {
      return withProfile(profileId, function () {
        return repo.find(profileId, validate.mediaRef(ref));
      }).then(function (rating) { return rating ? rating.value : null; });
    },

    clear: function (profileId, ref) {
      return withProfile(profileId, function () {
        return repo.remove(profileId, validate.mediaRef(ref));
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
