'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var history = schema.history;

/** @returns {import('../contracts').HistoryRepository} */
module.exports = function historyRepository(db) {
  return {
    add: function (entry) {
      return db.insert(history).values(entry).returning().then(util.first);
    },

    list: function (profileId, options) {
      options = options || {};
      var query = db.select().from(history)
        .where(orm.and(
          orm.eq(history.profileId, profileId),
          options.mediaType ? orm.eq(history.mediaType, options.mediaType) : undefined,
          options.minRatio != null ? orm.gte(history.watchedRatio, options.minRatio) : undefined
        ))
        .orderBy(orm.desc(history.watchedAt), orm.desc(history.id));
      return options.limit ? query.limit(options.limit) : query;
    },

    watchedTitles: function (profileId) {
      return db.selectDistinct({ mediaType: history.mediaType, tmdbId: history.tmdbId })
        .from(history)
        .where(orm.eq(history.profileId, profileId));
    },

    removeForTitle: function (profileId, ref) {
      return db.delete(history).where(util.titleWhere(history, profileId, ref)).returning({ id: history.id })
        .then(function (rows) { return rows.length; });
    }
  };
};
