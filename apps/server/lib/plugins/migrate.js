'use strict';

// Settings carried across a plugin's update (docs/plugin-layer-plan.md §4.5,
// API 1.5). A manifest naming `contributes.migrate` gets that data handler
// called once after an update, with every value stored for it (whatever its
// old manifest declared: rows the new one no longer names are still there):
//
//   args { fromVersion, toVersion, server: { key: value }, profiles: { <profile id>: { key: value } } }
//   answer { data: { server?: values, profiles?: { <profile id>: values } } }
//
// The answer's values are saved as a save from the dashboard would (checked
// against the new definitions, all or nothing per scope); keys the new
// manifest doesn't declare are dropped. The old rows stay (a rollback finds
// them). A handler that fails or answers something refused keeps everything
// as it was: the plugin starts on its defaults and the log says why.
//
//   run(pluginId, fromVersion) → Promise<{ migrated: boolean, reason? }>

var plugins = require('./index'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

function asValues(rows) {
  var out = {};
  rows.forEach(function (r) { out[r.key] = r.value; });
  return out;
}

/** The values of `values` the new definitions can take in that scope */
function keep(defs, scope, values) {
  var out = {};
  Object.keys(values && typeof values === 'object' && !Array.isArray(values) ? values : {}).forEach(function (k) {
    var d = defs[k];
    if (d && d.scope === scope && d.type !== 'action' && d.type !== 'secret') {
      out[k] = values[k];
    }
  });
  return out;
}

function run(pluginId, fromVersion) {
  var plugin = plugins.get(pluginId),
    handler = plugin && plugin.manifest.contributes && plugin.manifest.contributes.migrate;
  if (!handler || plugin.state !== 'enabled') {
    return Promise.resolve({ migrated: false, reason: 'no migration' });
  }
  var s, defs = {};
  ((plugin.manifest.contributes && plugin.manifest.contributes.settings) || []).forEach(function (d) { defs[d.key] = d; });
  return userData.services().then(function (svc) {
    s = svc;
    return Promise.all([s.plugins.settings.rows(pluginId, 'server', ''), s.profiles.list()]);
  }).then(function (r) {
    var profiles = (r[1].profiles || r[1]).map(function (p) { return p.id; });
    return Promise.all(profiles.map(function (id) { return s.plugins.settings.rows(pluginId, 'profile', id); })).then(function (rows) {
      var byProfile = {};
      profiles.forEach(function (id, i) {
        if (rows[i].length) {
          byProfile[id] = asValues(rows[i]);
        }
      });
      return { server: asValues(r[0]), profiles: byProfile };
    });
  }).then(function (old) {
    if (!Object.keys(old.server).length && !Object.keys(old.profiles).length) {
      return { migrated: false, reason: 'nothing stored' };
    }
    return plugins.data(pluginId, handler, {
      fromVersion: fromVersion || null, toVersion: plugin.manifest.version, server: old.server, profiles: old.profiles
    }, { profile: null, device: null, locale: 'en' }).then(function (answer) {
      var data = answer && answer.data && typeof answer.data === 'object' ? answer.data : {},
        settings = require('./settings'),
        work = [],
        server = keep(defs, 'server', data.server);
      if (Object.keys(server).length) {
        work.push(function () { return settings.update(pluginId, { values: server }); });
      }
      Object.keys(data.profiles && typeof data.profiles === 'object' ? data.profiles : {}).forEach(function (id) {
        var values = keep(defs, 'profile', data.profiles[id]);
        if (Object.keys(values).length && old.profiles[id]) {
          work.push(function () { return settings.update(pluginId, { profile: id, values: values }); });
        }
      });
      return work.reduce(function (p, w) { return p.then(w); }, Promise.resolve()).then(function () {
        log.info('plugin ' + pluginId + ': settings from ' + (fromVersion || 'its last version') + ' carried over to ' +
          plugin.manifest.version + ' (' + work.length + ' scope' + (work.length === 1 ? '' : 's') + ')', { plugin: pluginId });
        return { migrated: true };
      });
    });
  }).catch(function (err) {
    log.warn('plugin ' + pluginId + ': settings from ' + (fromVersion || 'its last version') + ' not carried over: ' +
      (err.code ? err.code + ': ' : '') + err.message, { plugin: pluginId });
    return { migrated: false, reason: err.message };
  });
}

module.exports = {
  run: run
};
