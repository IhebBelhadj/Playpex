'use strict';

// Hosts the admin gave a plugin (decision J of docs/providers-plan.md): a
// manifest's `url` setting with `grantsHost` adds the host of the value the
// admin saves to the plugin's network permission: that host and port, over
// https or plain http (an IPTV subscription, a self-hosted service the plugin
// couldn't name when it was packed). With `streamHosts` too, the hosts of the
// streams (and logos, and a guide) the document at that address lists
// (iptv.m3u) may be streamed from: the admin's document named them, not the
// plugin. Addresses must still be public (./http.js resolves and checks
// every hop); a plugin's own requests (http.request) never use stream hosts.
//
//   refresh(plugin) → Promise          its url settings read again (load, the admin's change)
//   hosts(plugin) → [{ host, port, scheme, key, label }]
//   match(plugin, url, { stream, image }) → { host, port, scheme } | null   what grants this URL, if anything
//   learn(plugin, url, urls, { scope, from })   hosts the server read in something it fetched itself (API 1.5,
//                                      docs/plugin-layer-plan.md §7): scope `stream` (a source's bytes, logos;
//                                      never http.request) or `image` (pictures through lib/plugins/images.js);
//                                      from `document` (default: `url` must be a streamHosts setting's address)
//                                      or `answer` (a core-only host call's answer: its caller vouches)
//   learnedCount(plugin, scope)
//   describe(plugin) → [{ key, text, personal: false }]               "Talks to …" lines for the dashboard

var protocol = require('@playpex/protocol/plugins'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

var LEARNED_MAX = 5000;

function stateOf(plugin) {
  if (!plugin.grants) {
    // learned: stream hosts; images: picture hosts (each least recently used first out past LEARNED_MAX)
    plugin.grants = { hosts: [], learned: new Map(), images: new Map() };
  }
  return plugin.grants;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch (e) {
    return null;
  }
}

/** Reads the plugin's url settings with grantsHost again */
function refresh(plugin) {
  var defs = protocol.grantingSettings(plugin.manifest), state = stateOf(plugin);
  if (!defs.length) {
    state.hosts = [];
    return Promise.resolve();
  }
  var all = (plugin.manifest.contributes && plugin.manifest.contributes.settings) || [];
  return userData.services().then(function (s) {
    return s.plugins.settings.values(plugin.id, all, null);
  }).then(function (values) {
    var before = state.hosts.map(function (h) { return h.key + ' ' + (h.entry || '') + ' ' + h.host; }).join(','),
      hosts = [];
    var label = function (text) { return require('./index').localize(plugin, text, 'en'); };
    defs.forEach(function (d) {
      if (d.list) {
        // a list's url field (API 1.5): every entry's address grants its host
        (Array.isArray(values.server[d.key]) ? values.server[d.key] : []).forEach(function (entry) {
          var g = entry && protocol.grantOf(entry[d.field]);
          if (g) {
            hosts.push(Object.assign(g, {
              key: d.key, entry: entry.id || null, field: d.field,
              label: label(d.label) + (entry.id ? ' › ' + (entry.name || entry.title || entry.id) : ''), streamHosts: !!d.streamHosts
            }));
          }
        });
        return;
      }
      var g = protocol.grantOf(values.server[d.key]);
      if (g) {
        hosts.push(Object.assign(g, { key: d.key, label: label(d.label), streamHosts: !!d.streamHosts }));
      }
    });
    state.hosts = hosts;
    // a new address: what the old one listed no longer counts
    if (before !== hosts.map(function (h) { return h.key + ' ' + (h.entry || '') + ' ' + h.host; }).join(',')) {
      state.learned = new Map();
      state.images = new Map();
    }
  }, function (err) {
    log.warn('plugin ' + plugin.id + ': granted hosts not read: ' + err.message, { plugin: plugin.id });
  });
}

function hosts(plugin) {
  return stateOf(plugin).hosts.slice();
}

/**
 * What grants this URL: a granted host (its scheme and port, or the other
 * scheme's default port), else with `options.stream` a learned stream host
 * (any port, either scheme); null when nothing does
 */
function match(plugin, url, options) {
  var u;
  try {
    u = url instanceof URL ? url : new URL(url);
  } catch (e) {
    return null;
  }
  var state = stateOf(plugin),
    scheme = u.protocol.replace(/:$/, ''),
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''),
    port = u.port ? parseInt(u.port, 10) : scheme === 'https' ? 443 : 80;
  if (scheme !== 'http' && scheme !== 'https') {
    return null;
  }
  var granted = state.hosts.filter(function (g) {
    return g.host === host && (g.port === port || port === (scheme === 'https' ? 443 : 80));
  })[0];
  if (granted) {
    return { host: host, port: port, scheme: scheme };
  }
  var learned = options && options.image ? state.images : options && options.stream ? state.learned : null;
  if (learned && learned.has(host)) {
    // used: kept longest
    learned.delete(host);
    learned.set(host, true);
    return { host: host, port: port, scheme: scheme };
  }
  return null;
}

/**
 * Something the server fetched itself listed these URLs: a document from `url`
 * (iptv.m3u; `url` must be the value of a url setting with streamHosts), or a
 * core-only host call's answer (`from: 'answer'`, its caller vouches). Their
 * hosts may then be used in `scope` only. Never callable by plugin code.
 */
function learn(plugin, url, urls, options) {
  options = options || {};
  var state = stateOf(plugin),
    scope = options.scope === 'image' ? state.images : state.learned;
  if (options.from !== 'answer') {
    var from = hostOf(url);
    if (!state.hosts.some(function (g) { return g.streamHosts && g.host === from; })) {
      return 0;
    }
  }
  var added = 0;
  (urls || []).forEach(function (u) {
    var h = u && /^https?:\/\//i.test(String(u)) && hostOf(u);
    if (!h) {
      return;
    }
    if (scope.has(h)) {
      scope.delete(h);
    } else {
      added++;
    }
    scope.set(h, true);
    if (scope.size > LEARNED_MAX) {
      scope.delete(scope.keys().next().value);
    }
  });
  return added;
}

function learnedCount(plugin, scope) {
  var state = stateOf(plugin);
  return (scope === 'image' ? state.images : state.learned).size;
}

/** The plugin's granted hosts in words (its Permissions on the dashboard) */
function describe(plugin) {
  var state = stateOf(plugin);
  return state.hosts.map(function (g) {
    var learned = g.streamHosts && state.learned.size, pictures = g.streamHosts && state.images.size;
    return {
      key: 'network.' + g.key + (g.entry ? '.' + g.entry : ''),
      text: 'Talks to ' + g.host + (g.port === (g.scheme === 'https' ? 443 : 80) ? '' : ':' + g.port) +
        (g.scheme === 'http' ? ' (plain http)' : '') + ', the address given in ' + (g.entry ? 'its list ' : 'its setting ') + JSON.stringify(g.label) +
        (learned ? ', and the ' + learned + ' stream host' + (learned === 1 ? '' : 's') + ' it lists' : '') +
        (pictures ? ' (pictures from ' + pictures + ' host' + (pictures === 1 ? '' : 's') + ')' : ''),
      personal: false
    };
  });
}

module.exports = {
  refresh: refresh,
  hosts: hosts,
  match: match,
  learn: learn,
  learnedCount: learnedCount,
  describe: describe
};
