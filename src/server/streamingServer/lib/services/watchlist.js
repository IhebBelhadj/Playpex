'use strict';

var validate = require('./validate');

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date }} options
 */
module.exports = function watchlistService(repositories, options) {
  var repo = repositories.watchlist,
    profiles = options.profiles,
    now = options.now || function () { return new Date(); };

  function add(profileId, item) {
    return profiles.requireProfile(profileId).then(function () {
      var ref = validate.mediaRef(item);
      return repo.add({
        profileId: profileId,
        mediaType: ref.mediaType,
        tmdbId: ref.tmdbId,
        title: validate.optionalString(item.title, 'title'),
        posterPath: validate.optionalString(item.posterPath, 'posterPath'),
        backdropPath: validate.optionalString(item.backdropPath, 'backdropPath'),
        addedAt: now()
      });
    });
  }

  function remove(profileId, ref) {
    return profiles.requireProfile(profileId).then(function () {
      return repo.remove(profileId, validate.mediaRef(ref));
    });
  }

  return {
    /** @param {{ mediaType?: 'movie'|'tv', limit?: number }} [filter] */
    list: function (profileId, filter) {
      filter = filter || {};
      return profiles.requireProfile(profileId).then(function () {
        return repo.list(profileId, {
          mediaType: filter.mediaType ? validate.mediaType(filter.mediaType) : undefined,
          limit: validate.limit(filter.limit, 200, 500)
        });
      });
    },

    contains: function (profileId, ref) {
      return profiles.requireProfile(profileId).then(function () {
        return repo.find(profileId, validate.mediaRef(ref));
      }).then(function (item) { return !!item; });
    },

    /** @param {{ mediaType, tmdbId, title?, posterPath?, backdropPath? }} item */
    add: add,

    remove: remove,

    /** Adds when absent, removes when present. Resolves { inWatchlist } */
    toggle: function (profileId, item) {
      return profiles.requireProfile(profileId).then(function () {
        return repo.find(profileId, validate.mediaRef(item));
      }).then(function (existing) {
        return existing
          ? remove(profileId, item).then(function () { return { inWatchlist: false }; })
          : add(profileId, item).then(function () { return { inWatchlist: true }; });
      });
    }
  };
};
