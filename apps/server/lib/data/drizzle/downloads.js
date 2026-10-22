'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var downloads = schema.downloads;

/** @returns {import('../contracts').DownloadsRepository} */
module.exports = function downloadsRepository(db) {
  return {
    list: function () {
      return db.select().from(downloads).orderBy(orm.asc(downloads.addedAt));
    },

    find: function (infoHash) {
      return db.select().from(downloads).where(orm.eq(downloads.infoHash, infoHash)).limit(1).then(util.first);
    },

    insert: function (record) {
      return db.insert(downloads).values(record).onConflictDoNothing().returning().then(util.first);
    },

    update: function (infoHash, patch) {
      return db.update(downloads).set(patch).where(orm.eq(downloads.infoHash, infoHash)).returning().then(util.first);
    },

    remove: function (infoHash) {
      return db.delete(downloads).where(orm.eq(downloads.infoHash, infoHash)).returning({ infoHash: downloads.infoHash })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
