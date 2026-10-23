'use strict';

var orm = require('drizzle-orm'),
  schema = require('../../db/schema'),
  first = require('./util').first;

var installed = schema.plugins,
  store = schema.pluginStore,
  secrets = schema.pluginSecrets,
  settings = schema.pluginSettings,
  grants = schema.pluginGrants;

function storeWhere(pluginId, key) {
  return orm.and(orm.eq(store.pluginId, pluginId), orm.eq(store.key, key));
}

function settingsWhere(pluginId, scope, ownerId) {
  return orm.and(orm.eq(settings.pluginId, pluginId), orm.eq(settings.scope, scope), orm.eq(settings.ownerId, ownerId || ''));
}

/** @returns {import('../contracts').PluginsRepository} */
module.exports = function pluginsRepository(db) {
  return {
    installedList: function () {
      return db.select().from(installed).orderBy(orm.asc(installed.id));
    },

    installedGet: function (id) {
      return db.select().from(installed).where(orm.eq(installed.id, id)).limit(1).then(first);
    },

    installedSave: function (row) {
      var set = Object.assign({}, row);
      delete set.id;
      delete set.installedAt;
      return db.insert(installed).values(row).onConflictDoUpdate({ target: installed.id, set: set })
        .then(function () {});
    },

    installedRemove: function (id) {
      return db.delete(installed).where(orm.eq(installed.id, id)).then(function () {});
    },

    storeGet: function (pluginId, key) {
      return db.select().from(store).where(storeWhere(pluginId, key)).limit(1).then(first);
    },

    storeSet: function (pluginId, key, value, size, at) {
      return db.insert(store).values({ pluginId: pluginId, key: key, value: value, size: size, updatedAt: at })
        .onConflictDoUpdate({ target: [store.pluginId, store.key], set: { value: value, size: size, updatedAt: at } })
        .then(function () {});
    },

    storeRemove: function (pluginId, key) {
      return db.delete(store).where(storeWhere(pluginId, key)).returning({ key: store.key })
        .then(function (rows) { return rows.length > 0; });
    },

    storeKeys: function (pluginId, prefix, limit) {
      var where = orm.eq(store.pluginId, pluginId);
      if (prefix) {
        // LIKE with the prefix's own % and _ escaped
        where = orm.and(where, orm.sql`${store.key} LIKE ${prefix.replace(/[\\%_]/g, '\\$&') + '%'} ESCAPE '\\'`);
      }
      return db.select({ key: store.key }).from(store).where(where).orderBy(orm.asc(store.key)).limit(limit)
        .then(function (rows) { return rows.map(function (r) { return r.key; }); });
    },

    storeUsage: function (pluginId) {
      return db.select({ total: orm.sql`coalesce(sum(${store.size}), 0)` }).from(store).where(orm.eq(store.pluginId, pluginId))
        .then(function (rows) { return Number(rows[0].total) || 0; });
    },

    secretGet: function (pluginId, name, profileId) {
      return db.select().from(secrets).where(orm.and(orm.eq(secrets.pluginId, pluginId), orm.eq(secrets.name, name),
        orm.eq(secrets.profileId, profileId || ''))).limit(1).then(function (rows) { return rows.length ? rows[0].value : null; });
    },

    secretSet: function (pluginId, name, profileId, value, at) {
      var where = orm.and(orm.eq(secrets.pluginId, pluginId), orm.eq(secrets.name, name), orm.eq(secrets.profileId, profileId || ''));
      if (value === null) {
        return db.delete(secrets).where(where).then(function () {});
      }
      return db.insert(secrets).values({ pluginId: pluginId, name: name, profileId: profileId || '', value: value, updatedAt: at })
        .onConflictDoUpdate({ target: [secrets.pluginId, secrets.name, secrets.profileId], set: { value: value, updatedAt: at } })
        .then(function () {});
    },

    settingsList: function (pluginId, scope, ownerId) {
      return db.select().from(settings).where(settingsWhere(pluginId, scope, ownerId))
        .then(function (rows) { return rows.map(function (r) { return { key: r.key, value: r.value }; }); });
    },

    settingSet: function (pluginId, scope, ownerId, key, value, at) {
      var where = orm.and(settingsWhere(pluginId, scope, ownerId), orm.eq(settings.key, key));
      if (value === null) {
        return db.delete(settings).where(where).then(function () {});
      }
      return db.insert(settings).values({ pluginId: pluginId, scope: scope, ownerId: ownerId || '', key: key, value: value, updatedAt: at })
        .onConflictDoUpdate({ target: [settings.pluginId, settings.scope, settings.ownerId, settings.key], set: { value: value, updatedAt: at } })
        .then(function () {});
    },

    /** [{ profileId, permission }] of a plugin */
    grantsList: function (pluginId) {
      return db.select({ profileId: grants.profileId, permission: grants.permission }).from(grants)
        .where(orm.eq(grants.pluginId, pluginId));
    },

    grantSet: function (pluginId, profileId, permission, on, at) {
      var where = orm.and(orm.eq(grants.pluginId, pluginId), orm.eq(grants.profileId, profileId), orm.eq(grants.permission, permission));
      if (!on) {
        return db.delete(grants).where(where).then(function () {});
      }
      return db.insert(grants).values({ pluginId: pluginId, profileId: profileId, permission: permission, grantedAt: at })
        .onConflictDoNothing().then(function () {});
    },

    removeAll: function (pluginId) {
      return db.batch([
        db.delete(store).where(orm.eq(store.pluginId, pluginId)),
        db.delete(secrets).where(orm.eq(secrets.pluginId, pluginId)),
        db.delete(settings).where(orm.eq(settings.pluginId, pluginId)),
        db.delete(grants).where(orm.eq(grants.pluginId, pluginId))
      ]).then(function () {});
    }
  };
};
