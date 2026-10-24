'use strict';

// The host API (SERVER_PLUGIN_API 1, docs/plugins-plan.md §4.2): what a
// plugin's `playpex.*` calls do on the server. Every call is checked against
// the plugin's granted permissions here, whatever the sandbox let through,
// and counted per plugin (its activity, plan §6.5).
//
//   createHost(plugin, services) → function (api, args, bytes, callId) → Promise<{ value, bytes? }>
//     plugin: { id, dir, manifest, permissions, stats, strings(locale) }
//
// Errors reach the plugin as rejections with `code`: PERMISSION_DENIED,
// HOST_NOT_ALLOWED, ADDRESS_NOT_ALLOWED, RATE_LIMITED, QUOTA_EXCEEDED,
// NOT_RUNNING, CALL_FAILED, INVALID… (NOT_AVAILABLE: a part of the API a later step brings;
// none left since P4b). Writes are ./writes.js, schedules ./scheduler.js,
// notifications ./notifications.js, link status ./links.js (plan step P3b);
// plugins.call runs another plugin's exported data handler (P4b); core data
// (tmdb.*, imdb.*, library.find) ./core.js; release names, HTML and .torrent
// files (names.*, html.select, torrent.info) ./utilities.js.

var http = require('./http'),
  protocol = require('@playpex/protocol/plugins'),
  writes = require('./writes'),
  core = require('./core'),
  utilities = require('./utilities'),
  scheduler = require('./scheduler'),
  notifications = require('./notifications');

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function denied(message) {
  return Promise.reject(failure('PERMISSION_DENIED', message));
}

// The plan step that brings each part not built yet (none left)
var LATER = {};

function interpolate(text, vars) {
  return !vars ? text : text.replace(/\{(\w+)\}/g, function (all, name) {
    return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all;
  });
}

function count(stats, key) {
  stats.host[key] = (stats.host[key] || 0) + 1;
}

/**
 * @param {object} plugin
 * @param {function(): Promise<object>} services userData.services
 */
function createHost(plugin, services) {
  var p = plugin.permissions,
    quota = protocol.parseSize(p.storage) || 0,
    secrets = p.secrets || [];

  var API = {
    'http.request': function (args, bytes) {
      if (!p.network || !p.network.length) {
        return denied('http needs permissions.network');
      }
      var host = '';
      try {
        host = new URL(args && args.url).hostname;
      } catch (e) {}
      count(plugin.stats, 'http ' + (host || '?'));
      return http.request(plugin, args, bytes).catch(function (err) {
        count(plugin.stats, 'http.' + (err.code || 'error'));
        throw err;
      });
    },

    'store.get': function (args) {
      if (!quota) {
        return denied('store needs permissions.storage');
      }
      return services().then(function (s) { return s.plugins.store.get(plugin.id, args.key); })
        .then(function (value) { return { value: value }; });
    },
    'store.set': function (args) {
      if (!quota) {
        return denied('store needs permissions.storage');
      }
      return services().then(function (s) { return s.plugins.store.set(plugin.id, args.key, args.value, quota); })
        .then(function () { return { value: true }; });
    },
    'store.delete': function (args) {
      if (!quota) {
        return denied('store needs permissions.storage');
      }
      return services().then(function (s) { return s.plugins.store.delete(plugin.id, args.key); })
        .then(function (removed) { return { value: removed }; });
    },
    'store.list': function (args) {
      if (!quota) {
        return denied('store needs permissions.storage');
      }
      return services().then(function (s) { return s.plugins.store.list(plugin.id, args.prefix); })
        .then(function (keys) { return { value: keys }; });
    },

    'secrets.get': function (args) {
      if (secrets.indexOf(args.name) === -1) {
        return denied(String(args.name) + ' isn\'t in permissions.secrets');
      }
      count(plugin.stats, 'secrets');
      return services().then(function (s) { return s.plugins.secrets.get(plugin.id, args.name, ''); })
        .then(function (value) { return { value: value }; });
    },

    'settings.get': function (args) {
      var def = (plugin.manifest.contributes && plugin.manifest.contributes.settings || []).filter(function (d) {
        return d.key === args.key;
      })[0];
      if (!def || def.type === 'action' || def.type === 'secret') {
        return Promise.reject(failure('INVALID', String(args.key) + ' isn\'t one of its settings' +
          (def && def.type === 'secret' ? ' (a secret: secrets.get)' : '')));
      }
      if (def.scope === 'profile' && !args.profileId) {
        return Promise.reject(failure('INVALID', args.key + ' is a profile setting: pass the handler\'s ctx'));
      }
      return services().then(function (s) {
        return s.plugins.settings.values(plugin.id, plugin.manifest.contributes.settings, def.scope === 'profile' ? args.profileId : null);
      }).then(function (values) {
        return { value: (def.scope === 'profile' ? values.profile : values.server)[def.key] };
      });
    },

    'schedule.every': function (args) {
      if (!p.schedule) {
        return denied('schedule needs permissions.schedule');
      }
      count(plugin.stats, 'schedule');
      return { value: scheduler.every(plugin, args.name, args.interval, args.options) };
    },
    'schedule.cancel': function (args) {
      return { value: scheduler.cancel(plugin.id, args.name) };
    },

    'notify.send': function (args) {
      if (!p.notify) {
        return denied('notify needs permissions.notify');
      }
      count(plugin.stats, 'notify');
      return notifications.send(plugin, args.profiles, args.message).then(function (r) { return { value: r }; });
    },

    'link.status': function (args) {
      count(plugin.stats, 'link');
      return require('./links').status(plugin, args.name, args.profileId).then(function (r) { return { value: r }; });
    },

    // Another plugin's exported data handler (plan §6.2): only one this plugin
    // `requires`, only a name it `exports`; it runs in the callee's sandbox with
    // the callee's permissions, for the profile named (its audience and hidden
    // rules apply); the caller gets its `data`, nothing else
    'plugins.call': function (args) {
      var callee = String(args.id || ''), name = String(args.name || '');
      if (!(plugin.manifest.requires || []).some(function (q) { return q.id === callee; })) {
        return denied('calling ' + callee + ' needs it in requires');
      }
      var plugins = require('./index'), target = plugins.get(callee);
      if (!target || target.state !== 'enabled') {
        return Promise.reject(failure('NOT_RUNNING', callee + ' isn\'t running'));
      }
      if ((target.manifest.exports || []).indexOf(name) === -1) {
        return denied(callee + ' doesn\'t export ' + name);
      }
      var who = args.profileId ? services().then(function (s) {
        return s.profiles.get(args.profileId).then(function (p) { return { id: p.id, kids: !!p.isKid }; }, function () {
          throw failure('NOT_FOUND', 'no profile ' + args.profileId);
        });
      }) : Promise.resolve(null);
      count(plugin.stats, 'call ' + callee);
      return who.then(function (profile) {
        return plugins.data(callee, name, args.args, { profile: profile, device: null, locale: args.locale || 'en' });
      }).then(function (answer) {
        return { value: answer.data };
      }, function (err) {
        // the callee's failure is the caller's to handle, never its caller's "no such handler"
        throw failure(err.code === 'FORBIDDEN' ? 'PERMISSION_DENIED' : 'CALL_FAILED', callee + ' ' + name + ': ' + err.message);
      });
    },

    'i18n.t': function (args) {
      var key = String(args.key || ''),
        tables = [plugin.strings(args.locale), plugin.strings('en')],
        text = tables.map(function (t) { return t && t[key]; }).filter(function (v) { return typeof v === 'string'; })[0];
      return Promise.resolve({ value: interpolate(text === undefined ? key : text, args.vars) });
    }
  };

  Object.assign(API, writes(plugin, services), core(plugin, services), utilities(plugin));

  return function host(api, args, bytes) {
    args = args || {};
    if (API[api]) {
      try {
        return Promise.resolve(API[api](args, bytes));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (LATER[api]) {
      return Promise.reject(failure('NOT_AVAILABLE', api + ' isn\'t available on this server yet (plugins plan step ' + LATER[api] + ')'));
    }
    return Promise.reject(failure('INVALID', 'no host API ' + String(api).slice(0, 60)));
  };
}

module.exports = {
  createHost: createHost
};
