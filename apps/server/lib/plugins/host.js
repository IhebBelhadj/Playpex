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
// NOT_AVAILABLE (a part of the API a later step brings: events, schedules,
// writes, links, notifications, calls between plugins), INVALID…

var http = require('./http'),
  protocol = require('@playpex/protocol/plugins');

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function denied(message) {
  return Promise.reject(failure('PERMISSION_DENIED', message));
}

// The plan step that brings each part not built yet
var LATER = {
  'schedule.every': 'P3b', 'schedule.cancel': 'P3b', 'notify.send': 'P3b', 'link.status': 'P3b',
  'watchlist.add': 'P3b', 'watchlist.remove': 'P3b', 'watchlist.list': 'P3b',
  'downloads.add': 'P3b', 'downloads.list': 'P3b', 'plugins.call': 'P4b'
};

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

    'i18n.t': function (args) {
      var key = String(args.key || ''),
        tables = [plugin.strings(args.locale), plugin.strings('en')],
        text = tables.map(function (t) { return t && t[key]; }).filter(function (v) { return typeof v === 'string'; })[0];
      return Promise.resolve({ value: interpolate(text === undefined ? key : text, args.vars) });
    }
  };

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
