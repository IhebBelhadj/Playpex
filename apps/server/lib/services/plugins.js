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
  SCOPES = ['server', 'profile'],
  HIDDEN = 'hidden',
  ORIGINS = ['upload', 'url', 'repository'],
  POLICIES = ['auto', 'notify', 'never'];

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
      /**
       * { id, version, origin, source, signer, repository?, enabled?, held? }: installs or updates the row
       * (the update policy is kept; `held` is cleared unless given)
       */
      save: function (row) {
        if (!row || typeof row.id !== 'string' || typeof row.version !== 'string' || ORIGINS.indexOf(row.origin) === -1) {
          return Promise.reject(errors.invalid('an installed plugin needs id, version and origin (' + ORIGINS.join(', ') + ')'));
        }
        if ((row.origin === 'repository') !== (typeof row.repository === 'string' && !!row.repository)) {
          return Promise.reject(errors.invalid('a plugin from a repository names it, and only then'));
        }
        var at = now();
        return repo.installedGet(row.id).then(function (old) {
          return repo.installedSave({
            id: row.id,
            version: row.version,
            origin: row.origin,
            source: row.source || null,
            signer: row.signer || null,
            repository: row.repository || null,
            updatePolicy: old ? old.updatePolicy : null,
            held: row.held || null,
            enabled: row.enabled === undefined ? (old ? old.enabled : true) : !!row.enabled,
            installedAt: old ? old.installedAt : at,
            updatedAt: at
          });
        });
      },
      /** On or off; `held` = why the server switched it off (null: the admin did, or it's on) */
      setEnabled: function (id, enabled, held) {
        return repo.installedGet(id).then(function (old) {
          if (!old) {
            throw errors.notFound('No installed plugin ' + id);
          }
          return repo.installedSave(Object.assign({}, old, { enabled: !!enabled, held: enabled ? null : held || null, updatedAt: now() }));
        });
      },
      /** auto | notify | never, or null: the server's plugins.updates */
      setUpdatePolicy: function (id, policy) {
        if (policy !== null && POLICIES.indexOf(policy) === -1) {
          return Promise.reject(errors.invalid('updatePolicy must be one of ' + POLICIES.join(', ') + ', or null'));
        }
        return repo.installedGet(id).then(function (old) {
          if (!old) {
            throw errors.notFound('No installed plugin ' + id);
          }
          return repo.installedSave(Object.assign({}, old, { updatePolicy: policy }));
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
          rows.forEach(function (r) {
            if (r.permission !== HIDDEN) {
              (out[r.profileId] = out[r.profileId] || []).push(r.permission);
            }
          });
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

    // Profiles the admin hid the plugin from (plan §6.3 Profiles): a row of the
    // same table, permission `hidden`, so it goes with the plugin's grants
    hidden: {
      /** [profileId] */
      list: function (pluginId) {
        return repo.grantsList(pluginId).then(function (rows) {
          return rows.filter(function (r) { return r.permission === HIDDEN; }).map(function (r) { return r.profileId; });
        });
      },
      set: function (pluginId, profileId, hidden) {
        return repo.grantSet(pluginId, profileId, HIDDEN, !!hidden, now());
      }
    },

    // Repositories (plan §6.1): rows only; lib/plugins/repositories.js fetches and checks their indexes
    repositories: {
      list: function () {
        return repo.repositoriesList();
      },
      get: function (id) {
        return repo.repositoryGet(id);
      },
      /** A whole row: { id, url, name, key, … } (addedAt kept when it exists) */
      save: function (row) {
        if (!row || !/^[a-z][a-z0-9-]{1,31}$/.test(row.id || '') || !/^https:\/\//.test(row.url || '') || !row.key) {
          return Promise.reject(errors.invalid('a repository needs an id, an https url and a key'));
        }
        return repo.repositoryGet(row.id).then(function (old) {
          return repo.repositorySave(Object.assign({ enabled: true, builtin: false, pendingKey: null, etag: null, fetchedAt: null,
            checkedAt: null, error: null }, old || {}, row, { addedAt: old ? old.addedAt : now() }));
        });
      },
      remove: function (id) {
        return repo.repositoryRemove(id);
      }
    },

    /** A replacement's settings from the plugin it replaces (migratesFrom): rows it has already stay */
    copySettings: function (fromId, toId) {
      return repo.settingsCopy(fromId, toId, now());
    },

    /** Plugin ids something is kept for, with row counts per table */
    owners: function () {
      return repo.owners();
    },

    /** Everything a plugin kept (removal, plan §6.4) */
    removeAll: function (pluginId) {
      return repo.removeAll(pluginId);
    }
  };
};
