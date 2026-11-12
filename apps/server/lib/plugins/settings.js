'use strict';

// A plugin's options as the dashboard edits them (docs/plugins-plan.md §4.3,
// §6.3: Plugins › <name> › Settings and Profiles). The manifest declares them
// (`contributes.settings`); the admin sets them here; handlers read them with
// `playpex.settings.get` and `playpex.secrets.get`. Clients never see them.
//
//   view(id, locale)                  { definitions, server, secrets, personal, profiles (+ shown, grants, values) }
//   update(id, { profile?, values })  values checked against the definitions; null = back to the default
//   grant(id, { profile, permission, granted })   a personal permission for a profile (decision G)
//   show(id, { profile, shown })      shown to a profile or hidden from it (plan §6.3 Profiles)
//   run(id, key, locale)              an `action` setting: its data handler's { data, effects }
//
// Works for a disabled installed plugin too (its manifest read from disk), so
// it can be set up before it's switched on. A change publishes
// `plugin.changed { id, state, reason: 'settings' }`: clients read the plugin's
// screens again, which then show what the new values give.

var fs = require('fs'),
  path = require('path'),
  protocol = require('@playpex/protocol/plugins'),
  plugins = require('./index'),
  userData = require('../userData');

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function services() {
  return userData.services();
}

/** { id, manifest, strings(locale), state } of a loaded plugin, else of an installed one on disk */
function source(id) {
  var loaded = plugins.get(id);
  if (loaded) {
    return Promise.resolve({ id: id, manifest: loaded.manifest, strings: loaded.strings, state: loaded.state });
  }
  var dir = require('./install').dirOf(id);
  return fs.promises.readFile(path.join(dir, 'playpex-plugin.json'), 'utf8').then(function (text) {
    var tables = {};
    try {
      fs.readdirSync(path.join(dir, 'i18n')).forEach(function (f) {
        var m = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(f);
        if (m) {
          tables[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', f), 'utf8'));
        }
      });
    } catch (e) { /* no translations */ }
    return {
      id: id,
      manifest: JSON.parse(text),
      state: 'disabled',
      strings: function (locale) {
        return locale ? tables[locale] || tables[String(locale).split('-')[0]] || null : null;
      }
    };
  }, function () {
    throw failure('NOT_FOUND', 'No plugin ' + id);
  });
}

function definitionsOf(src) {
  return (src.manifest.contributes && src.manifest.contributes.settings) || [];
}

/** A definition as the dashboard renders it: labels translated, options as { value, label } */
function present(src, d, locale) {
  var t = function (text) { return plugins.localize(src, text, locale); },
    out = { key: d.key, scope: d.scope, type: d.type, label: t(d.label), level: d.level || 'basic' };
  ['description', 'group', 'confirm', 'placeholder'].forEach(function (k) {
    if (d[k] !== undefined) {
      out[k] = t(d[k]);
    }
  });
  ['visibleIf', 'enabledIf', 'min', 'max', 'step', 'unit', 'integer', 'maxLength', 'pattern', 'schemes', 'grantsHost', 'streamHosts', 'default'].forEach(function (k) {
    if (d[k] !== undefined) {
      out[k] = d[k];
    }
  });
  if (d.options) {
    out.options = d.options.map(function (o) { return { value: o[0], label: t(o[1]) }; });
  }
  if (d.type === 'list') {
    ['minItems', 'maxItems', 'unique', 'titleField'].forEach(function (k) {
      if (d[k] !== undefined) {
        out[k] = d[k];
      }
    });
    if (d.itemLabel !== undefined) {
      out.itemLabel = t(d.itemLabel);
    }
    if (d.fields) {
      out.fields = d.fields.map(function (f) { return present(src, Object.assign({ scope: d.scope }, f), locale); });
    }
    if (d.item) {
      out.item = present(src, Object.assign({ key: 'item', scope: d.scope, label: d.label }, d.item), locale);
    }
  }
  return out;
}

var ENTRY_ID = /^e_[a-z2-7]{8}$/;

function entryId() {
  var alphabet = 'abcdefghijklmnopqrstuvwxyz234567', bytes = require('crypto').randomBytes(8), out = 'e_';
  for (var i = 0; i < 8; i++) {
    out += alphabet[bytes[i] & 31];
  }
  return out;
}

/** A field's value when an entry leaves it out */
function fieldDefault(f) {
  if (f.default !== undefined) {
    return f.default;
  }
  return f.type === 'text' || f.type === 'url' ? '' : f.type === 'switch' ? false : null;
}

/**
 * A list's value as it will be saved: a fields list's entries keep their id
 * (or get one) and every field (missing ones at their default); an item list
 * as it is. Anything not an array or an object is left for problem() to refuse.
 */
function normalizeList(d, value) {
  if (!Array.isArray(value) || !d.fields) {
    return value;
  }
  return value.map(function (entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    var out = { id: typeof entry.id === 'string' && ENTRY_ID.test(entry.id) ? entry.id : entryId() };
    d.fields.forEach(function (f) {
      out[f.key] = entry[f.key] === undefined || entry[f.key] === null ? fieldDefault(f) : entry[f.key];
    });
    Object.keys(entry).forEach(function (k) {
      if (k !== 'id' && !d.fields.some(function (f) { return f.key === k; })) {
        out[k] = entry[k];   // an unknown field: refused by problem()
      }
    });
    return out;
  });
}

/** Why a list's (normalized) value can't be saved, or null; problems name their entry (`[2].url …`) */
function listProblem(d, value) {
  if (!Array.isArray(value)) {
    return 'must be a list';
  }
  if (value.length > d.maxItems) {
    return 'holds at most ' + d.maxItems;
  }
  if (value.length < (d.minItems || 0)) {
    return 'needs at least ' + d.minItems;
  }
  if (d.item) {
    for (var i = 0; i < value.length; i++) {
      var why = value[i] === null || value[i] === undefined ? 'is empty' : problem(d.item, value[i]);
      if (why) {
        return '[' + i + '] ' + why;
      }
    }
    if (d.unique && new Set(value.map(function (v) { return typeof v === 'string' ? v.toLowerCase() : v; })).size !== value.length) {
      return 'holds a value twice';
    }
    return null;
  }
  var ids = {};
  for (var j = 0; j < value.length; j++) {
    var entry = value[j];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return '[' + j + '] must be an entry';
    }
    if (ids[entry.id]) {
      return '[' + j + '] has the id of another entry';
    }
    ids[entry.id] = true;
    var unknown = Object.keys(entry).filter(function (k) {
      return k !== 'id' && !d.fields.some(function (f) { return f.key === k; });
    });
    if (unknown.length) {
      return '[' + j + '] has no field ' + unknown[0];
    }
    for (var k = 0; k < d.fields.length; k++) {
      var f = d.fields[k], v = entry[f.key],
        fwhy = v === null && (f.type === 'number' || f.type === 'choice') ? null : problem(f, v);
      if (fwhy) {
        return '[' + j + '].' + f.key + ' ' + fwhy;
      }
    }
  }
  return null;
}

/** Why `value` can't be this setting's, or null */
function problem(d, value) {
  switch (d.type) {
    case 'switch':
      return typeof value === 'boolean' ? null : 'must be on or off';
    case 'choice':
      return d.options.some(function (o) { return o[0] === value; }) ? null : 'must be one of its options';
    case 'slider':
    case 'number':
      if (typeof value !== 'number' || !isFinite(value)) {
        return 'must be a number';
      }
      if ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max)) {
        return 'must be between ' + (d.min !== undefined ? d.min : '…') + ' and ' + (d.max !== undefined ? d.max : '…');
      }
      if (d.integer && Math.round(value) !== value) {
        return 'must be a whole number';
      }
      return null;
    case 'text':
    case 'secret':
      if (typeof value !== 'string') {
        return 'must be text';
      }
      if (value.length > (d.maxLength || 500)) {
        return 'is longer than ' + (d.maxLength || 500) + ' characters';
      }
      if (d.type === 'text' && d.pattern && value !== '' && !new RegExp('^(?:' + d.pattern + ')$').test(value)) {
        return 'doesn\'t have the expected form';
      }
      return null;
    case 'url':
      // empty: not set
      if (typeof value !== 'string') {
        return 'must be a web address';
      }
      if (value.length > (d.maxLength || 2048)) {
        return 'is longer than ' + (d.maxLength || 2048) + ' characters';
      }
      return value === '' ? null : protocol.urlProblem(value, d.schemes);
    case 'list':
      return listProblem(d, value);
    default:
      return 'can\'t be set';
  }
}

function profilesFor(src) {
  return services().then(function (s) {
    return Promise.all([s.profiles.list(), s.plugins.installed.get(src.id)]);
  }).then(function (r) {
    // an adults plugin (its manifest, or the admin's "Treat as adults") serves no kids profile
    var adults = src.manifest.audience === 'adults' || !!(r[1] && r[1].adults);
    return (r[0].profiles || r[0]).filter(function (p) {
      return !(p.isKid && adults);
    });
  });
}

function view(id, locale) {
  return source(id).then(function (src) {
    var defs = definitionsOf(src),
      secretKeys = defs.filter(function (d) { return d.type === 'secret'; }).map(function (d) { return d.key; }),
      personal = protocol.describePermissions(src.manifest).filter(function (x) { return x.personal; })
        .map(function (x) { return { key: x.key, text: x.text }; });
    return services().then(function (s) {
      return Promise.all([
        s.plugins.settings.values(id, defs, null),
        Promise.all(secretKeys.map(function (k) { return s.plugins.secrets.get(id, k); })),
        profilesFor(src),
        s.plugins.grants.byProfile(id),
        s.plugins.hidden.list(id)
      ]).then(function (r) {
        return Promise.all(r[2].map(function (p) {
          return s.plugins.settings.values(id, defs, p.id).then(function (v) {
            return {
              id: p.id, name: p.name, kids: !!p.isKid, shown: r[4].indexOf(p.id) === -1,
              values: v.profile || {}, grants: r[3][p.id] || []
            };
          });
        })).then(function (profiles) {
          var secrets = {};
          // set by the admin, or provided by the server's environment (./envSecrets.js)
          secretKeys.forEach(function (k, i) { secrets[k] = !!r[1][i] || !!require('./envSecrets').get(id, k); });
          return {
            plugin: id,
            state: src.state,
            definitions: defs.map(function (d) { return present(src, d, locale); }),
            server: r[0].server,
            secrets: secrets,
            personal: personal,
            profiles: profiles
          };
        });
      });
    });
  });
}

/**
 * Saves values of one scope: server (no profile) or a profile's. All or
 * nothing: an unknown key, a key of the other scope or a bad value refuses
 * the whole change with `errors`.
 */
function update(id, body, locale) {
  body = body || {};
  var values = body.values, profileId = body.profile || null;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    return Promise.reject(failure('INVALID', 'values must be an object of settings'));
  }
  return source(id).then(function (src) {
    var defs = {}, errors = [];
    definitionsOf(src).forEach(function (d) { defs[d.key] = d; });
    Object.keys(values).forEach(function (key) {
      if (defs[key] && defs[key].type === 'list' && values[key] !== null) {
        values[key] = normalizeList(defs[key], values[key]);
      }
      var d = defs[key], value = values[key];
      if (!d || d.type === 'action') {
        errors.push({ key: key, message: 'isn\'t one of its settings' });
      } else if ((d.scope === 'profile') !== !!profileId) {
        errors.push({ key: key, message: d.scope === 'profile' ? 'is set per profile' : 'is a server setting' });
      } else if (value !== null && !(d.type === 'secret' && value === '')) {
        var why = problem(d, value);
        if (why) {
          errors.push({ key: key, message: why });
        }
      }
    });
    if (errors.length) {
      var err = failure('INVALID', errors.map(function (e) { return e.key + ' ' + e.message; }).join('; '));
      err.errors = errors;
      throw err;
    }
    var check = profileId ? profilesFor(src).then(function (list) {
      if (!list.some(function (p) { return p.id === profileId; })) {
        throw failure('NOT_FOUND', 'No profile ' + profileId + ' for this plugin');
      }
    }) : Promise.resolve();
    return check.then(services).then(function (s) {
      return Promise.all(Object.keys(values).map(function (key) {
        var d = defs[key], value = values[key];
        if (d.type === 'secret') {
          return s.plugins.secrets.set(id, key, value === '' ? null : value);
        }
        return s.plugins.settings.set(id, d.scope, profileId, key, value);
      }));
    }).then(function () {
      // a new address the admin gave it (grantsHost), and live plugins' channels from it
      var loaded = plugins.get(id);
      return loaded ? require('./grants').refresh(loaded) : null;
    }).then(function () {
      require('../live').forget(id);
      plugins.publish({ id: id, state: src.state, reason: 'settings' });
      return view(id, locale);
    });
  });
}

/**
 * Grants (or takes back) a personal permission of the plugin for one profile
 * (events.playback, write.*: off for every profile until switched on here)
 */
function grant(id, body, locale) {
  body = body || {};
  return source(id).then(function (src) {
    var personal = protocol.describePermissions(src.manifest).filter(function (x) { return x.personal; }).map(function (x) { return x.key; });
    if (personal.indexOf(body.permission) === -1) {
      throw failure('INVALID', 'permission must be one of its personal permissions: ' + (personal.join(', ') || 'none'));
    }
    return profilesFor(src).then(function (list) {
      if (!list.some(function (p) { return p.id === body.profile; })) {
        throw failure('NOT_FOUND', 'No profile ' + body.profile + ' for this plugin');
      }
      return services();
    }).then(function (s) {
      return s.plugins.grants.set(id, body.profile, body.permission, body.granted === true);
    }).then(function () {
      require('./bus').invalidate(id);
      plugins.publish({ id: id, state: src.state, reason: 'grants' });
      return view(id, locale);
    });
  });
}

/** Shows the plugin to a profile again, or hides it (no screens, hooks, events or notifications for it) */
function show(id, body, locale) {
  body = body || {};
  if (typeof body.shown !== 'boolean') {
    return Promise.reject(failure('INVALID', 'shown must be true or false'));
  }
  return source(id).then(function (src) {
    return profilesFor(src).then(function (list) {
      if (!list.some(function (p) { return p.id === body.profile; })) {
        throw failure('NOT_FOUND', 'No profile ' + body.profile + ' for this plugin');
      }
      return services();
    }).then(function (s) {
      return s.plugins.hidden.set(id, body.profile, !body.shown);
    }).then(function () {
      return plugins.refreshHidden(id);
    }).then(function () {
      plugins.publish({ id: id, state: src.state, reason: 'profiles' });
      return view(id, locale);
    });
  });
}

/** An `action` setting: calls its data handler (server scope, no profile) and answers { data, effects } */
function run(id, key, locale) {
  return source(id).then(function (src) {
    var d = definitionsOf(src).filter(function (x) { return x.key === key; })[0];
    if (!d || d.type !== 'action') {
      throw failure('NOT_FOUND', 'No action ' + key);
    }
    if (src.state !== 'enabled') {
      throw failure('CONFLICT', 'Switch the plugin on first');
    }
    return plugins.data(id, d.data, {}, { profile: null, device: null, locale: locale || 'en' });
  });
}

module.exports = {
  view: view,
  update: update,
  grant: grant,
  show: show,
  run: run,
  problem: problem,
  normalizeList: normalizeList
};
