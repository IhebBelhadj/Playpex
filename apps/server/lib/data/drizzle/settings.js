'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema');

var TABLES = {
  profile: { table: schema.profileSettings, owner: 'profileId' },
  device: { table: schema.deviceSettings, owner: 'deviceId' }
};

function tableOf(owner) {
  var t = TABLES[owner && owner.kind];
  if (!t) {
    throw new Error('settings owner must be { kind: "profile" | "device", id }');
  }
  return t;
}

function toEntry(row) {
  return { key: row.key, value: row.value, updatedAt: row.updatedAt };
}

/** @returns {import('../contracts').SettingsRepository} */
module.exports = function settingsRepository(db) {
  function ownerWhere(t, owner) {
    return orm.eq(t.table[t.owner], owner.id);
  }

  function keyWhere(t, owner, key) {
    return orm.and(ownerWhere(t, owner), orm.eq(t.table.key, key));
  }

  // Builds (does not run) the statement that writes or deletes one key
  function statement(owner, key, value, at) {
    var t = tableOf(owner);
    if (value === null) {
      return db.delete(t.table).where(keyWhere(t, owner, key));
    }
    var row = { key: key, value: value, updatedAt: at };
    row[t.owner] = owner.id;
    return db.insert(t.table).values(row).onConflictDoUpdate({
      target: [t.table[t.owner], t.table.key],
      set: { value: value, updatedAt: at }
    });
  }

  return {
    list: function (owner) {
      var t = tableOf(owner);
      return db.select().from(t.table).where(ownerWhere(t, owner)).orderBy(orm.asc(t.table.key))
        .then(function (rows) { return rows.map(toEntry); });
    },

    get: function (owner, key) {
      var t = tableOf(owner);
      return db.select().from(t.table).where(keyWhere(t, owner, key)).limit(1)
        .then(function (rows) { return rows.length ? toEntry(rows[0]) : null; });
    },

    set: function (owner, key, value, at) {
      return statement(owner, key, value, at).then(function () {});
    },

    setMany: function (owner, values, at) {
      var keys = Object.keys(values);
      if (!keys.length) {
        return Promise.resolve();
      }
      // one BEGIN/COMMIT (lib/db/driver.js: no db.transaction())
      return db.batch(keys.map(function (k) { return statement(owner, k, values[k], at); })).then(function () {});
    },

    remove: function (owner, key) {
      var t = tableOf(owner);
      return db.delete(t.table).where(keyWhere(t, owner, key)).returning({ key: t.table.key })
        .then(function (rows) { return rows.length > 0; });
    },

    removeAll: function (owner) {
      var t = tableOf(owner);
      return db.delete(t.table).where(ownerWhere(t, owner)).returning({ key: t.table.key })
        .then(function (rows) { return rows.length; });
    }
  };
};
