'use strict';

// Section layouts (docs/rows-plan.md §4): the admin's default per section and a
// profile's own, checked by @playpex/protocol rows.js. A layout is
// { rows: [entry], known: [plugin id] }; `known` lists the plugins already
// offered to it (lib/rows joins the others at the end).
//
// Which plugins exist, and what rows mean, is lib/rows' business: this only
// keeps and checks the lists.

var rows = require('@playpex/protocol/rows'),
  defaults = require('../rows/defaults'),
  errors = require('./errors');

var KNOWN_MAX = 200,
  PLUGIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

function section(value) {
  if (rows.SECTIONS.indexOf(value) === -1) {
    throw errors.invalid('section must be one of ' + rows.SECTIONS.join(', '));
  }
  return value;
}

/** A layout from a client, checked: { rows, known } */
function checked(sectionName, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw errors.invalid('The body must be { rows, known? }');
  }
  var problems = rows.checkLayout(sectionName, input.rows);
  var known = input.known === undefined ? [] : input.known;
  if (!Array.isArray(known) || known.length > KNOWN_MAX || known.some(function (k) { return typeof k !== 'string' || !PLUGIN_ID.test(k); })) {
    problems.push('known must be a list of plugin ids');
  }
  if (problems.length) {
    var err = errors.invalid(problems.join('; '));
    err.errors = problems;
    throw err;
  }
  return {
    rows: input.rows.map(function (e) { return JSON.parse(JSON.stringify(e)); }),
    known: known.filter(function (k, i) { return known.indexOf(k) === i; })
  };
}

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ profiles: object, now?: function(): Date }} options
 */
module.exports = function layoutsService(repositories, options) {
  var repo = repositories.rows,
    profiles = options.profiles,
    now = options.now || function () { return new Date(); };

  function readDefault(name) {
    return repo.getDefault(name).then(function (stored) {
      return stored ? Object.assign({ section: name, own: false, custom: true, updatedAt: stored.updatedAt }, stored.layout) :
        Object.assign({ section: name, own: false, custom: false, updatedAt: null }, defaults.layout(name));
    });
  }

  return {
    /** The admin's default: { section, rows, known, custom (the admin changed it), updatedAt } */
    getDefault: function (name) {
      return Promise.resolve().then(function () { return readDefault(section(name)); });
    },

    setDefault: function (name, input) {
      return Promise.resolve().then(function () {
        var layout = checked(section(name), input);
        return repo.setDefault(name, layout, now()).then(function () { return readDefault(name); });
      });
    },

    /** Back to the built-in default */
    resetDefault: function (name) {
      return Promise.resolve().then(function () {
        return repo.removeDefault(section(name));
      }).then(function () { return readDefault(name); });
    },

    /** The layout a profile sees: its own (own: true), else the default */
    get: function (profileId, name) {
      return Promise.resolve().then(function () {
        section(name);
        return profiles.requireProfile(profileId);
      }).then(function () {
        return repo.getProfile(profileId, name);
      }).then(function (stored) {
        return stored ? Object.assign({ section: name, own: true, custom: true, updatedAt: stored.updatedAt }, stored.layout) : readDefault(name);
      });
    },

    set: function (profileId, name, input) {
      var layout;
      return Promise.resolve().then(function () {
        layout = checked(section(name), input);
        return profiles.requireProfile(profileId);
      }).then(function () {
        return repo.setProfile(profileId, name, layout, now());
      }).then(function () {
        return Object.assign({ section: name, own: true, custom: true, updatedAt: now() }, layout);
      });
    },

    /** Back to the default (Reset to default) */
    reset: function (profileId, name) {
      return Promise.resolve().then(function () {
        section(name);
        return profiles.requireProfile(profileId);
      }).then(function () {
        return repo.removeProfile(profileId, name);
      }).then(function () { return readDefault(name); });
    }
  };
};
