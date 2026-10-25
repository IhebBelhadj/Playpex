'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var direct = schema.directDownloads;

/** @returns {import('../contracts').DirectDownloadsRepository} */
module.exports = function directDownloadsRepository(db) {
  return {
    list: function () {
      return db.select().from(direct).orderBy(orm.desc(direct.addedAt));
    },

    find: function (id) {
      return db.select().from(direct).where(orm.eq(direct.id, id)).limit(1).then(util.first);
    },

    insert: function (record) {
      return db.insert(direct).values(record).returning().then(util.first);
    },

    update: function (id, patch) {
      return db.update(direct).set(patch).where(orm.eq(direct.id, id)).returning().then(util.first);
    },

    remove: function (id) {
      return db.delete(direct).where(orm.eq(direct.id, id)).returning({ id: direct.id })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
