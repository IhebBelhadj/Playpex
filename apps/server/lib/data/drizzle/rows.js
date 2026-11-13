'use strict';

// Section layouts (docs/rows-plan.md §4): the admin's default per section, a
// profile's own per section. A layout is { rows, known } JSON.

var orm = require('drizzle-orm'),
  schema = require('../../db/schema');

function toLayout(row) {
  return row ? { layout: row.layout, updatedAt: row.updatedAt } : null;
}

/** @returns {import('../contracts').RowsRepository} */
module.exports = function rowsRepository(db) {
  var D = schema.rowLayouts, P = schema.profileRowLayouts;

  function profileWhere(profileId, section) {
    return orm.and(orm.eq(P.profileId, profileId), orm.eq(P.section, section));
  }

  return {
    getDefault: function (section) {
      return db.select().from(D).where(orm.eq(D.section, section)).limit(1).then(function (rows) { return toLayout(rows[0]); });
    },

    setDefault: function (section, layout, at) {
      return db.insert(D).values({ section: section, layout: layout, updatedAt: at }).onConflictDoUpdate({
        target: D.section, set: { layout: layout, updatedAt: at }
      }).then(function () {});
    },

    removeDefault: function (section) {
      return db.delete(D).where(orm.eq(D.section, section)).returning({ section: D.section }).then(function (rows) { return rows.length > 0; });
    },

    getProfile: function (profileId, section) {
      return db.select().from(P).where(profileWhere(profileId, section)).limit(1).then(function (rows) { return toLayout(rows[0]); });
    },

    setProfile: function (profileId, section, layout, at) {
      return db.insert(P).values({ profileId: profileId, section: section, layout: layout, updatedAt: at }).onConflictDoUpdate({
        target: [P.profileId, P.section], set: { layout: layout, updatedAt: at }
      }).then(function () {});
    },

    removeProfile: function (profileId, section) {
      return db.delete(P).where(profileWhere(profileId, section)).returning({ section: P.section }).then(function (rows) { return rows.length > 0; });
    }
  };
};
