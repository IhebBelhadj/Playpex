'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  util = require('./util');

var profiles = schema.profiles;

/** @returns {import('../contracts').ProfilesRepository} */
module.exports = function profilesRepository(db) {
  return {
    list: function () {
      return db.select().from(profiles).orderBy(orm.asc(profiles.createdAt));
    },

    findById: function (id) {
      return db.select().from(profiles).where(orm.eq(profiles.id, id)).limit(1).then(util.first);
    },

    findByName: function (name) {
      return db.select().from(profiles)
        .where(orm.sql`lower(${profiles.name}) = lower(${name})`)
        .limit(1).then(util.first);
    },

    count: function () {
      return db.$count(profiles);
    },

    insert: function (profile) {
      return db.insert(profiles).values(profile).returning()
        .then(util.first, util.translate('A profile with this name already exists'));
    },

    update: function (id, patch) {
      return db.update(profiles).set(patch).where(orm.eq(profiles.id, id)).returning()
        .then(util.first, util.translate('A profile with this name already exists'));
    },

    remove: function (id) {
      return db.delete(profiles).where(orm.eq(profiles.id, id)).returning({ id: profiles.id })
        .then(function (rows) { return rows.length > 0; });
    }
  };
};
