'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var ratings = schema.ratings;

/** @returns {import('../contracts').RatingsRepository} */
module.exports = function ratingsRepository(db) {
  return {
    find: function (profileId, ref) {
      return db.select().from(ratings).where(util.titleWhere(ratings, profileId, ref)).limit(1).then(util.first);
    },

    upsert: function (rating) {
      return db.insert(ratings).values(rating)
        .onConflictDoUpdate({
          target: [ratings.profileId, ratings.mediaType, ratings.tmdbId],
          set: { title: rating.title, genreIds: rating.genreIds, value: rating.value, ratedAt: rating.ratedAt }
        })
        .returning().then(util.first);
    },

    list: function (profileId, options) {
      options = options || {};
      var query = db.select().from(ratings)
        .where(orm.and(
          orm.eq(ratings.profileId, profileId),
          options.value ? orm.eq(ratings.value, options.value) : undefined
        ))
        .orderBy(orm.desc(ratings.ratedAt));
      return options.limit ? query.limit(options.limit) : query;
    },

    remove: function (profileId, ref) {
      return db.delete(ratings).where(util.titleWhere(ratings, profileId, ref)).returning({ tmdbId: ratings.tmdbId })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
