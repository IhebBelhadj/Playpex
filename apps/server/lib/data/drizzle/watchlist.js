'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var watchlist = schema.watchlist;

/** @returns {import('../contracts').WatchlistRepository} */
module.exports = function watchlistRepository(db) {
  function find(profileId, ref) {
    return db.select().from(watchlist).where(util.titleWhere(watchlist, profileId, ref)).limit(1).then(util.first);
  }

  return {
    list: function (profileId, options) {
      options = options || {};
      var query = db.select().from(watchlist)
        .where(orm.and(
          orm.eq(watchlist.profileId, profileId),
          options.mediaType ? orm.eq(watchlist.mediaType, options.mediaType) : undefined
        ))
        .orderBy(orm.desc(watchlist.addedAt));
      return options.limit ? query.limit(options.limit) : query;
    },

    find: find,

    add: function (item) {
      return db.insert(watchlist).values(item).onConflictDoNothing()
        .then(function () { return find(item.profileId, item); });
    },

    remove: function (profileId, ref) {
      return db.delete(watchlist).where(util.titleWhere(watchlist, profileId, ref)).returning({ tmdbId: watchlist.tmdbId })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
