'use strict';

// User settings (docs/settings-plan.md): per device and per profile, keys and
// defaults from the registry in @playpex/protocol settings.js. Reads answer
// effective values (stored, else the default) for every registered key of the
// scope, plus the stored `client.<clientId>.<name>` keys.
//
// Owners: { kind: 'profile', id: <profile id> } | { kind: 'device', id: <client device id> }.
// Which device a request is, is the route's business (lib/routes/settings.js).

var registry = require('@playpex/protocol/settings'),
  errors = require('./errors');

var DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date, publish?: function(string, object) }} options
 *   publish: events.publish (lib/events.js), for `settings.changed`
 */
module.exports = function settingsService(repositories, options) {
  var repo = repositories.settings,
    profiles = options.profiles,
    now = options.now || function () { return new Date(); },
    publish = options.publish || function () {};

  function deviceOwner(deviceId) {
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
      throw errors.ServiceError('DEVICE_REQUIRED', 'This route needs the calling device: send X-Playpex-Device (or ?device=)');
    }
    return { kind: 'device', id: deviceId };
  }

  function effective(scope, entries) {
    var values = {};
    registry.keys(scope).forEach(function (key) {
      values[key] = registry.SETTINGS[key].default;
    });
    entries.forEach(function (entry) {
      if (registry.definition(entry.key) ? registry.SETTINGS[entry.key].scope === scope :
          registry.isClientKey(entry.key)) {
        values[entry.key] = entry.value;
      }
    });
    return values;
  }

  // Validates a whole patch (all or nothing) → { key: value | null }
  function checkPatch(scope, patch) {
    if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw errors.invalid('The body must be an object of { key: value | null }');
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw errors.invalid('Nothing to change');
    }
    var problems = [];
    keys.forEach(function (key) {
      var value = patch[key] === undefined ? null : patch[key],
        problem = registry.validate(key, value, scope);
      if (problem) {
        problems.push(problem);
      }
    });
    if (problems.length) {
      var err = errors.invalid(problems.join('; '));
      err.errors = problems;
      throw err;
    }
    return keys.reduce(function (all, key) {
      all[key] = patch[key] === undefined ? null : patch[key];
      return all;
    }, {});
  }

  function readDevice(deviceId) {
    var owner = deviceOwner(deviceId);
    return repo.list(owner).then(function (entries) { return effective('device', entries); });
  }

  function readProfile(profileId) {
    return profiles.requireProfile(profileId).then(function (profile) {
      return repo.list({ kind: 'profile', id: profile.id }).then(function (entries) {
        return effective('profile', entries);
      });
    });
  }

  function changed(owner, keys) {
    publish('settings.changed', { scope: owner.kind, ownerId: owner.id, keys: keys });
  }

  return {
    /**
     * @param {{ deviceId: string, profileId?: string, definitions?: boolean }} query
     * @returns {Promise<{ device: object, profile: object|null, definitions?: object }>}
     */
    get: function (query) {
      query = query || {};
      return Promise.resolve().then(function () {
        return Promise.all([
          readDevice(query.deviceId),
          query.profileId ? readProfile(query.profileId) : null
        ]);
      }).then(function (r) {
        var answer = { device: r[0], profile: r[1] };
        if (query.definitions) {
          answer.definitions = registry.SETTINGS;
        }
        return answer;
      });
    },

    device: readDevice,

    profile: readProfile,

    /** @param {object} patch { key: value | null } → the device's effective settings */
    updateDevice: function (deviceId, patch) {
      return Promise.resolve().then(function () {
        var owner = deviceOwner(deviceId),
          values = checkPatch('device', patch);
        return repo.setMany(owner, values, now()).then(function () {
          changed(owner, Object.keys(values));
          return readDevice(deviceId);
        });
      });
    },

    /** @param {object} patch { key: value | null } → the profile's effective settings */
    updateProfile: function (profileId, patch) {
      return profiles.requireProfile(profileId).then(function (profile) {
        var owner = { kind: 'profile', id: profile.id },
          values = checkPatch('profile', patch);
        return repo.setMany(owner, values, now()).then(function () {
          changed(owner, Object.keys(values));
          return readProfile(profileId);
        });
      });
    },

    /** Deletes every setting of the device → its (default) effective settings */
    resetDevice: function (deviceId) {
      return Promise.resolve().then(function () {
        var owner = deviceOwner(deviceId);
        return repo.list(owner).then(function (entries) {
          return repo.removeAll(owner).then(function () {
            if (entries.length) {
              changed(owner, entries.map(function (e) { return e.key; }));
            }
            return readDevice(deviceId);
          });
        });
      });
    },

    /** Revoking a device (lib/auth): drops its rows, no event (the device is gone) */
    forgetDevice: function (deviceId) {
      if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
        return Promise.resolve(0);
      }
      return repo.removeAll({ kind: 'device', id: deviceId });
    }
  };
};
