'use strict';

// Installed packages (lib/plugins/install.js), and what the plugin sandbox
// keeps for each plugin (docs/plugins-plan.md §4.2): its key / value store
// (quota from the manifest), the secrets the admin entered, and the values of
// its contributes.settings. lib/plugins checks the permissions; this layer
// keeps the rows valid.

var errors = require('./errors');

var KEY_MAX = 200,
  VALUE_MAX = 1024 * 1024,
  LIST_MAX = 1000,
  SCOPES = ['server', 'profile'];

function checkKey(key) {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX) {
    throw errors.invalid('a store key is a string of 1–' + KEY_MAX + ' characters');
  }
}

module.exports = function pluginsService(repositories, options) {
  var repo = repositories.plugins,
    now = (options && options.now) || function () { return new Date(); };

  // Settings of one scope: { key: value } from the rows, the manifest's defaults for the rest
  function settingsOf(pluginId, definitions, scope, ownerId) {
    return repo.settingsList(pluginId, scope, ownerId).then(function (rows) {
      var values = {};
      (definitions || []).forEach(function (d) {
        if (d.scope === scope && d.type !== 'action' && d.type !== 'secret') {
          values[d.key] = d.default === undefined ? null : d.default;
        }
      });
      rows.forEach(function (r) {
        if (Object.prototype.hasOwnProperty.call(values, r.key)) {
          values[r.key] = r.value;
        }
      });
      return values;
    });
  }

  return {
    installed: {
      list: function () {
        return repo.installedList();
      },
      get: function (id) {
        return repo.installedGet(id);
      },
      /** { id, version, origin, source, signer, enabled? }: installs or updates the row */
      save: function (row) {
        if (!row || typeof row.id !== 'string' || typeof row.version !== 'string' || ['upload', 'url'].indexOf(row.origin) === -1) {
          return Promise.reject(errors.invalid('an installed plugin needs id, version and origin (upload, url)'));
        }
        var at = now();
        return repo.installedGet(row.id).then(function (old) {
          return repo.installedSave({
            id: row.id,
            version: row.version,
            origin: row.origin,
            source: row.source || null,
            signer: row.signer || null,
            enabled: row.enabled === undefined ? (old ? old.enabled : true) : !!row.enabled,
            installedAt: old ? old.installedAt : at,
            updatedAt: at
          });
        });
      },
      setEnabled: function (id, enabled) {
        return repo.installedGet(id).then(function (old) {
          if (!old) {
            throw errors.notFound('No installed plugin ' + id);
          }
          return repo.installedSave(Object.assign({}, old, { enabled: !!enabled, updatedAt: now() }));
        });
      },
      remove: function (id) {
        return repo.installedRemove(id);
      }
    },

    store: {
      get: function (pluginId, key) {
        checkKey(key);
        return repo.storeGet(pluginId, key).then(function (row) { return row ? row.value : null; });
      },

      /** quota: bytes the plugin may keep in all */
      set: function (pluginId, key, value, quota) {
        checkKey(key);
        if (value === undefined) {
          return Promise.reject(errors.invalid('store.set needs a value (store.delete removes)'));
        }
        var json = JSON.stringify(value),
          size = Buffer.byteLength(json) + Buffer.byteLength(key);
        if (size > VALUE_MAX) {
          return Promise.reject(errors.invalid('a stored value is at most 1 MB'));
        }
        return Promise.all([repo.storeUsage(pluginId), repo.storeGet(pluginId, key)]).then(function (r) {
          var used = r[0] - (r[1] ? r[1].size : 0);
          if (used + size > quota) {
            throw errors.ServiceError('QUOTA_EXCEEDED', 'storage quota exceeded (' + quota + ' bytes)');
          }
          return repo.storeSet(pluginId, key, JSON.parse(json), size, now());
        });
      },

      delete: function (pluginId, key) {
        checkKey(key);
        return repo.storeRemove(pluginId, key);
      },

      list: function (pluginId, prefix) {
        if (prefix != null && (typeof prefix !== 'string' || prefix.length > KEY_MAX)) {
          return Promise.reject(errors.invalid('a prefix is a string'));
        }
        return repo.storeKeys(pluginId, prefix || '', LIST_MAX);
      },

      usage: function (pluginId) {
        return repo.storeUsage(pluginId);
      }
    },

    secrets: {
      get: function (pluginId, name, profileId) {
        return repo.secretGet(pluginId, name, profileId || '');
      },
      /** null removes */
      set: function (pluginId, name, value, profileId) {
        if (value !== null && typeof value !== 'string') {
          return Promise.reject(errors.invalid('a secret is a string'));
        }
        return repo.secretSet(pluginId, name, profileId || '', value, now());
      }
    },

    settings: {
      /** { server: {…}, profile: {…} | null }: values with the manifest's defaults */
      values: function (pluginId, definitions, profileId) {
        return Promise.all([
          settingsOf(pluginId, definitions, 'server', ''),
          profileId ? settingsOf(pluginId, definitions, 'profile', profileId) : null
        ]).then(function (r) { return { server: r[0], profile: r[1] }; });
      },
      /** One setting's value (null resets it to the default) */
      set: function (pluginId, scope, ownerId, key, value) {
        if (SCOPES.indexOf(scope) === -1) {
          return Promise.reject(errors.invalid('scope must be server or profile'));
        }
        return repo.settingSet(pluginId, scope, scope === 'server' ? '' : ownerId, key, value, now());
      }
    },

    // Personal permissions granted per profile (decision G; plugins.js PERSONAL)
    grants: {
      /** { profileId: [permission] } */
      byProfile: function (pluginId) {
        return repo.grantsList(pluginId).then(function (rows) {
          var out = {};
          rows.forEach(function (r) { (out[r.profileId] = out[r.profileId] || []).push(r.permission); });
          return out;
        });
      },
      set: function (pluginId, profileId, permission, on) {
        if (typeof permission !== 'string' || !/^(events\.playback|write\.[a-z]+)$/.test(permission)) {
          return Promise.reject(errors.invalid('not a personal permission: ' + permission));
        }
        return repo.grantSet(pluginId, profileId, permission, !!on, now());
      }
    },

    /** Everything a plugin kept (removal, plan §6.4) */
    removeAll: function (pluginId) {
      return repo.removeAll(pluginId);
    }
  };
};
