'use strict';

var validate = require('./validate'),
  changes = require('./changes');

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date, publish?: function }} options
 */
module.exports = function watchlistService(repositories, options) {
  var repo = repositories.watchlist,
    changed = changes(options.publish),
    profiles = options.profiles,
    now = options.now || function () { return new Date(); };

  // by: 'user' (default) or 'plugin:<id>' (its internal event, lib/services/changes.js)
  function add(profileId, item, by) {
    return profiles.requireProfile(profileId).then(function () {
      var ref = validate.mediaRef(item);
      return repo.find(profileId, ref).then(function (existing) {
        return Promise.all([existing, repo.add({
        profileId: profileId,
        mediaType: ref.mediaType,
        tmdbId: ref.tmdbId,
        title: validate.optionalString(item.title, 'title'),
        posterPath: validate.optionalString(item.posterPath, 'posterPath'),
        backdropPath: validate.optionalString(item.backdropPath, 'backdropPath'),
        addedAt: now()
      })]);
      }).then(function (r) {
        if (!r[0]) {
          changed('watchlist.added', profileId, Object.assign({}, ref, { title: item.title }), by);
        }
        return r[1];
      });
    });
  }

  function remove(profileId, ref, by) {
    return profiles.requireProfile(profileId).then(function () {
      var key = validate.mediaRef(ref);
      return repo.remove(profileId, key).then(function (removed) {
        if (removed) {
          changed('watchlist.removed', profileId, key, by);
        }
        return removed;
      });
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
    toggle: function (profileId, item, by) {
      return profiles.requireProfile(profileId).then(function () {
        return repo.find(profileId, validate.mediaRef(item));
      }).then(function (existing) {
        return existing
          ? remove(profileId, item, by).then(function () { return { inWatchlist: false }; })
          : add(profileId, item, by).then(function () { return { inWatchlist: true }; });
      });
    }
  };
};
