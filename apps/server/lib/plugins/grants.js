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
//   match(plugin, url, { stream }) → { host, port, scheme } | null   what grants this URL, if anything
//   learn(plugin, url, urls)           the stream hosts a document fetched from `url` lists
//   describe(plugin) → [{ key, text, personal: false }]               "Talks to …" lines for the dashboard

var protocol = require('@playpex/protocol/plugins'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

var LEARNED_MAX = 5000;

function stateOf(plugin) {
  if (!plugin.grants) {
    plugin.grants = { hosts: [], learned: new Map() };
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
    var before = state.hosts.map(function (h) { return h.key + ' ' + h.host; }).join(','),
      hosts = [];
    defs.forEach(function (d) {
      var g = protocol.grantOf(values.server[d.key]);
      if (g) {
        hosts.push(Object.assign(g, { key: d.key, label: require('./index').localize(plugin, d.label, 'en'), streamHosts: !!d.streamHosts }));
      }
    });
    state.hosts = hosts;
    // a new address: what the old one listed no longer counts
    if (before !== hosts.map(function (h) { return h.key + ' ' + h.host; }).join(',')) {
      state.learned = new Map();
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
  if (options && options.stream && state.learned.has(host)) {
    return { host: host, port: port, scheme: scheme };
  }
  return null;
}

/**
 * A document fetched from `url` (iptv.m3u) listed these URLs: when `url` is
 * the value of a url setting with streamHosts, their hosts may be streamed from
 */
function learn(plugin, url, urls) {
  var state = stateOf(plugin), from = hostOf(url);
  if (!state.hosts.some(function (g) { return g.streamHosts && g.host === from; })) {
    return 0;
  }
  var added = 0;
  urls.forEach(function (u) {
    var h = u && hostOf(u);
    if (h && !state.learned.has(h) && state.learned.size < LEARNED_MAX) {
      state.learned.set(h, true);
      added++;
    }
  });
  return added;
}

/** The plugin's granted hosts in words (its Permissions on the dashboard) */
function describe(plugin) {
  var state = stateOf(plugin);
  return state.hosts.map(function (g) {
    var learned = g.streamHosts && state.learned.size;
    return {
      key: 'network.' + g.key,
      text: 'Talks to ' + g.host + (g.port === (g.scheme === 'https' ? 443 : 80) ? '' : ':' + g.port) +
        (g.scheme === 'http' ? ' (plain http)' : '') + ', the address given in its setting ' + JSON.stringify(g.label) +
        (learned ? ', and the ' + learned + ' stream host' + (learned === 1 ? '' : 's') + ' it lists' : ''),
      personal: false
    };
  });
}

module.exports = {
  refresh: refresh,
  hosts: hosts,
  match: match,
  learn: learn,
  describe: describe
};
