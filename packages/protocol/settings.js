'use strict';

// User settings registry (docs/settings-plan.md §4), shared by the server
// (validates every write) and clients (defaults, choices, Settings UI). Values
// live in the server's playpex.db: `device` settings per client device id
// (X-Playpex-Device), `profile` settings per profile.
//
// Key rules
//   - a registered key is `<area>.<name>` (lowercase area, camelCase name)
//   - `client.<clientId>.<name>`: a client's private value, free JSON of at
//     most CLIENT_VALUE_MAX bytes, stored in the scope of the route it is sent to
//   - anything else is refused (INVALID)
//   - null as a value resets the key (its row is deleted, the default applies)
// Adding a key is a protocol change (openapi.yaml + this file), not an API
// version bump: clients ignore keys they don't know.
// CommonJS with no dependencies, like index.js.

var SETTINGS = {
  'display.uiScale': { scope: 'device', type: 'number', enum: [0.7, 0.8, 0.9, 1, 1.15], default: 0.8 },
  'display.safeArea': { scope: 'device', type: 'number', min: 0, max: 0.06, step: 0.005, default: 0 },
  'player.volume': { scope: 'device', type: 'number', min: 0, max: 100, step: 5, default: 100 },
  'subtitles.size': { scope: 'device', type: 'string', enum: ['small', 'medium', 'large', 'largest'], default: 'medium' },
  'subtitles.provider': { scope: 'profile', type: 'string', nullable: true, default: null },
  'player.autoplayNext': { scope: 'profile', type: 'boolean', default: true },
  'player.preferLocalFiles': { scope: 'profile', type: 'boolean', default: true }
};

var SCOPES = ['device', 'profile'];

var KEY = /^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/,
  CLIENT_KEY = /^client\.[a-z0-9][a-z0-9-]{0,31}\.[a-z][A-Za-z0-9]{0,63}$/,
  CLIENT_VALUE_MAX = 4096,
  STRING_MAX = 200;

function isClientKey(key) {
  return typeof key === 'string' && CLIENT_KEY.test(key);
}

/** The definition of a registered key, or null */
function definition(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : null;
}

/** Registered keys of one scope */
function keys(scope) {
  return Object.keys(SETTINGS).filter(function (k) { return !scope || SETTINGS[k].scope === scope; });
}

/** { key: default } of one scope */
function defaults(scope) {
  return keys(scope).reduce(function (all, k) {
    all[k] = SETTINGS[k].default;
    return all;
  }, {});
}

function close(a, b) {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Checks one value for a key, written in `scope`.
 * @returns {string|null} a message for people, or null when valid. null values
 *   (= reset) are valid for every known key.
 */
function validate(key, value, scope) {
  if (isClientKey(key)) {
    if (value === null) {
      return null;
    }
    var json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return key + ' must be JSON';
    }
    if (json === undefined) {
      return key + ' must be JSON';
    }
    // UTF-8 bytes, without Buffer (browsers load this file too)
    if (unescape(encodeURIComponent(json)).length > CLIENT_VALUE_MAX) {
      return key + ' must be at most ' + CLIENT_VALUE_MAX + ' bytes of JSON';
    }
    return null;
  }
  var def = definition(key);
  if (!def) {
    return KEY.test(String(key)) ? 'unknown setting ' + key : 'not a setting key: ' + key;
  }
  if (scope && def.scope !== scope) {
    return key + ' is a ' + def.scope + ' setting';
  }
  if (value === null) {
    return null;
  }
  if (def.type === 'number') {
    if (typeof value !== 'number' || !isFinite(value)) {
      return key + ' must be a number';
    }
    if (def.enum && !def.enum.some(function (v) { return close(v, value); })) {
      return key + ' must be one of ' + def.enum.join(', ');
    }
    if ((def.min != null && value < def.min) || (def.max != null && value > def.max)) {
      return key + ' must be between ' + def.min + ' and ' + def.max;
    }
    if (def.step && !close(Math.round((value - (def.min || 0)) / def.step) * def.step + (def.min || 0), value)) {
      return key + ' must be a multiple of ' + def.step;
    }
    return null;
  }
  if (def.type === 'string') {
    if (typeof value !== 'string' || !value || value.length > STRING_MAX) {
      return key + ' must be a non-empty string of at most ' + STRING_MAX + ' characters';
    }
    if (def.enum && def.enum.indexOf(value) === -1) {
      return key + ' must be one of ' + def.enum.join(', ');
    }
    return null;
  }
  if (def.type === 'boolean') {
    return typeof value === 'boolean' ? null : key + ' must be true or false';
  }
  return key + ' has an unknown type';
}

module.exports = {
  SETTINGS: SETTINGS,
  SCOPES: SCOPES,
  CLIENT_VALUE_MAX: CLIENT_VALUE_MAX,
  isClientKey: isClientKey,
  definition: definition,
  keys: keys,
  defaults: defaults,
  validate: validate
};
