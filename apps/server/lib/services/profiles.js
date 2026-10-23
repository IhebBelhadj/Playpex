'use strict';

// Profiles ("Who's watching?"). A profile may have an optional 4–6 digit PIN.
// The PIN only gates the UI: the database file itself is not encrypted.

var crypto = require('crypto'),
  errors = require('./errors'),
  validate = require('./validate'),
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

// Deprecated `preferences` (settings plan §6): always {} now (the settings
// it was a view of left with the 18+ section, docs/plugins-plan.md P5);
// writes are checked to be an object and ignored, so older clients still work
function preferences(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.invalid('preferences must be an object');
  }
  return value;
}

/** What leaves the service: never the PIN hash or salt */
function toPublic(profile) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    isKid: profile.isKid,
    hasPin: !!profile.pinHash,
    preferences: {},
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

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ now?: function(): Date }} [options]
 */
module.exports = function profilesService(repositories, options) {
  var repo = repositories.profiles,
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
    return Promise.resolve(toPublic(profile));
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
        if (input.preferences != null) {
          preferences(input.preferences);
        }
        return repo.count().then(function (count) {
          if (count >= MAX_PROFILES) {
            throw errors.conflict('At most ' + MAX_PROFILES + ' profiles');
          }
          return repo.insert(profile);
        });
      }).then(present, onDuplicate);
    },

    /** @param {{ name?: string, avatar?: string|null, isKid?: boolean, preferences?: object }} patch preferences (deprecated) is ignored */
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
        if (patch.preferences !== undefined) {
          preferences(patch.preferences);
        }
        if (!Object.keys(changes).length) {
          return profile;
        }
        return repo.update(id, changes);
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
