'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var progress = schema.progress;

/** @returns {import('../contracts').ProgressRepository} */
module.exports = function progressRepository(db) {
  return {
    find: function (profileId, key) {
      return db.select().from(progress).where(util.episodeWhere(progress, profileId, key)).limit(1).then(util.first);
    },

    upsert: function (record) {
      return db.insert(progress).values(record)
        .onConflictDoUpdate({
          target: [progress.profileId, progress.mediaType, progress.tmdbId, progress.season, progress.episode],
          set: {
            title: record.title,
            posterPath: record.posterPath,
            backdropPath: record.backdropPath,
            positionS: record.positionS,
            durationS: record.durationS,
            infoHash: record.infoHash,
            filePath: record.filePath,
            fileId: record.fileId === undefined ? null : record.fileId,
            audioTrack: record.audioTrack === undefined ? null : record.audioTrack,
            subtitleTrack: record.subtitleTrack === undefined ? null : record.subtitleTrack,
            finished: record.finished,
            updatedAt: record.updatedAt
          }
        })
        .returning().then(util.first);
    },

    listRecent: function (profileId, options) {
      var query = db.select().from(progress)
        .where(orm.eq(progress.profileId, profileId))
        .orderBy(orm.desc(progress.updatedAt));
      return options && options.limit ? query.limit(options.limit) : query;
    },

    listForTitle: function (profileId, ref) {
      return db.select().from(progress)
        .where(util.titleWhere(progress, profileId, ref))
        .orderBy(orm.asc(progress.season), orm.asc(progress.episode));
    },

    remove: function (profileId, key) {
      return db.delete(progress).where(util.episodeWhere(progress, profileId, key)).returning({ tmdbId: progress.tmdbId })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
