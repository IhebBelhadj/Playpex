'use strict';

// Profiles ("Who's watching?"). A profile may have an optional 4–6 digit PIN.
// The PIN only gates the UI: the database file itself is not encrypted.

var crypto = require('crypto'),
  errors = require('./errors'),
  validate = require('./validate'),
  registry = require('@playpex/protocol/settings'),
  dataErrors = require('../data/errors');

var MAX_PROFILES = 8,
  NAME_MAX = 30,
  PIN_PATTERN = /^\d{4,6}$/,
  MAX_PIN_FAILURES = 5,
  PIN_LOCKOUT_MS = 30 * 1000;

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function pinMatches(profile, pin) {
  var expected = Buffer.from(profile.pinHash, 'hex'),
    actual = Buffer.from(hashPin(String(pin), profile.pinSalt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Deprecated `preferences` (settings plan §6): a read-only view of the
// profile's adult.* settings, { adult: { layout, metadataProvider } }, kept
// for one release; writes of preferences.adult go to the settings.
var ADULT_PREFERENCES = { layout: 'adult.layout', metadataProvider: 'adult.metadataProvider' };

function preferencesFrom(entries) {
  var adult = {};
  Object.keys(ADULT_PREFERENCES).forEach(function (field) {
    var entry = entries.filter(function (e) { return e.key === ADULT_PREFERENCES[field]; })[0];
    adult[field] = entry ? entry.value : registry.SETTINGS[ADULT_PREFERENCES[field]].default;
  });
  return { adult: adult };
}

/** What leaves the service: never the PIN hash or salt */
function toPublic(profile, entries) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    isKid: profile.isKid,
    hasPin: !!profile.pinHash,
    preferences: profile.isKid ? {} : preferencesFrom(entries || []),
    createdAt: profile.createdAt,
    lastUsedAt: profile.lastUsedAt
  };
}

function name(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw errors.invalid('name is required');
  }
  value = value.trim().replace(/\s+/g, ' ');
  if (value.length > NAME_MAX) {
    throw errors.invalid('name must be at most ' + NAME_MAX + ' characters');
  }
  return value;
}

function pinFields(pin) {
  if (pin == null || pin === '') {
    return { pinHash: null, pinSalt: null };
  }
  if (!PIN_PATTERN.test(String(pin))) {
    throw errors.invalid('PIN must be 4 to 6 digits');
  }
  var salt = crypto.randomBytes(16).toString('hex');
  return { pinHash: hashPin(String(pin), salt), pinSalt: salt };
}

function preferences(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.invalid('preferences must be an object');
  }
  return value;
}

// preferences.adult → { 'adult.layout': …, 'adult.metadataProvider': … } (validated)
function adultSettings(value) {
  var adult = preferences(value).adult, patch = {};
  if (adult == null) {
    return patch;
  }
  if (typeof adult !== 'object' || Array.isArray(adult)) {
    throw errors.invalid('preferences.adult must be an object');
  }
  Object.keys(ADULT_PREFERENCES).forEach(function (field) {
    if (adult[field] !== undefined) {
      var problem = registry.validate(ADULT_PREFERENCES[field], adult[field], 'profile');
      if (problem) {
        throw errors.invalid(problem);
      }
      patch[ADULT_PREFERENCES[field]] = adult[field];
    }
  });
  return patch;
}

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ now?: function(): Date }} [options]
 */
module.exports = function profilesService(repositories, options) {
  var repo = repositories.profiles,
    settings = repositories.settings,
    now = (options && options.now) || function () { return new Date(); },
    failures = new Map();   // profileId → { count, lockedUntil }

  function requireProfile(id) {
    return repo.findById(id).then(function (profile) {
      if (!profile) {
        throw errors.notFound('Profile not found');
      }
      return profile;
    });
  }

  function present(profile) {
    if (!profile) {
      return profile;
    }
    return settings.list({ kind: 'profile', id: profile.id }).then(function (entries) {
      return toPublic(profile, entries);
    });
  }

  function writePreferences(profile, value) {
    var patch = adultSettings(value);
    if (!Object.keys(patch).length) {
      return Promise.resolve(profile);
    }
    if (profile.isKid) {
      throw errors.forbidden('Kids profiles have no 18+ settings');
    }
    return settings.setMany({ kind: 'profile', id: profile.id }, patch, now()).then(function () { return profile; });
  }

  function onDuplicate(err) {
    throw dataErrors.isDuplicate(err) ? errors.conflict('A profile with this name already exists') : err;
  }

  function checkLockout(id) {
    var state = failures.get(id);
    if (state && state.lockedUntil > now().getTime()) {
      throw errors.tooManyAttempts('Too many wrong PINs, try again in a moment');
    }
  }

  function recordFailure(id) {
    var state = failures.get(id) || { count: 0, lockedUntil: 0 };
    state.count += 1;
    if (state.count >= MAX_PIN_FAILURES) {
      state.count = 0;
      state.lockedUntil = now().getTime() + PIN_LOCKOUT_MS;
    }
    failures.set(id, state);
  }

  return {
    MAX_PROFILES: MAX_PROFILES,

    list: function () {
      return repo.list().then(function (rows) { return Promise.all(rows.map(present)); });
    },

    get: function (id) {
      return requireProfile(id).then(present);
    },

    /** The profile used last, to preselect it in the picker (null when none) */
    lastUsed: function () {
      return repo.list().then(function (rows) {
        var used = rows.filter(function (p) { return p.lastUsedAt; })
          .sort(function (a, b) { return b.lastUsedAt - a.lastUsedAt; });
        return used.length ? present(used[0]) : null;
      });
    },

    /** @param {{ name: string, avatar?: string, isKid?: boolean, pin?: string, preferences?: object }} input */
    create: function (input) {
      input = input || {};
      var prefs;
      return Promise.resolve().then(function () {
        var profile = Object.assign({
          id: crypto.randomUUID(),
          name: name(input.name),
          avatar: validate.optionalString(input.avatar, 'avatar', 200),
          isKid: !!input.isKid,
          preferences: {},
          createdAt: now(),
          lastUsedAt: null
        }, pinFields(input.pin));
        prefs = input.preferences == null ? null : input.preferences;
        if (prefs) {
          adultSettings(prefs);   // validate before inserting
        }
        return repo.count().then(function (count) {
          if (count >= MAX_PROFILES) {
            throw errors.conflict('At most ' + MAX_PROFILES + ' profiles');
          }
          return repo.insert(profile);
        });
      }).then(function (profile) {
        return prefs && !profile.isKid ? writePreferences(profile, prefs) : profile;
      }, onDuplicate).then(present);
    },

    /** @param {{ name?: string, avatar?: string|null, isKid?: boolean, preferences?: object }} patch preferences.adult (deprecated) is written to the settings */
    update: function (id, patch) {
      patch = patch || {};
      return requireProfile(id).then(function (profile) {
        var changes = {};
        if (patch.name !== undefined) {
          changes.name = name(patch.name);
        }
        if (patch.avatar !== undefined) {
          changes.avatar = validate.optionalString(patch.avatar, 'avatar', 200);
        }
        if (patch.isKid !== undefined) {
          changes.isKid = !!patch.isKid;
        }
        var write = patch.preferences !== undefined ? function (p) {
          return writePreferences(Object.assign({}, p, { isKid: changes.isKid !== undefined ? changes.isKid : p.isKid }),
            patch.preferences).then(function () { return p; });
        } : function (p) { return p; };
        if (patch.preferences !== undefined) {
          adultSettings(patch.preferences);   // validate before writing anything
        }
        if (!Object.keys(changes).length) {
          return write(profile);
        }
        return repo.update(id, changes).then(write);
      }).then(present, onDuplicate);
    },

    /** Set, change or (with null) remove the PIN */
    setPin: function (id, pin) {
      return requireProfile(id).then(function (profile) {
        failures.delete(id);
        return repo.update(profile.id, pinFields(pin));
      }).then(present);
    },

    /**
     * Select a profile. Checks the PIN when the profile has one and records it
     * as the last used profile.
     */
    unlock: function (id, pin) {
      return requireProfile(id).then(function (profile) {
        if (profile.pinHash) {
          checkLockout(id);
          if (pin == null || !pinMatches(profile, pin)) {
            recordFailure(id);
            throw errors.forbidden('Wrong PIN');
          }
          failures.delete(id);
        }
        return repo.update(id, { lastUsedAt: now() });
      }).then(present);
    },

    /** Deletes the profile and its watchlist, progress, history and ratings */
    remove: function (id) {
      return repo.remove(id).then(function (removed) {
        if (!removed) {
          throw errors.notFound('Profile not found');
        }
        failures.delete(id);
        return true;
      });
    },

    /** Resolves with the stored profile or rejects NOT_FOUND; used by the other services */
    requireProfile: requireProfile
  };
};
