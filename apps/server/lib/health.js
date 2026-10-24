'use strict';

// Provider health for the dashboard's Overview (docs/server-separation-plan.md §7):
// the last success and failure of every upstream service, recorded by axios
// interceptors on the shared axios instance every provider uses
// (require('axios')). Requests to hosts not listed in SERVICES aren't tracked.
// Plugins' hosts come from their requests (lib/plugins/host.js: one entry per
// plugin and host, `plugin:<id>:<host>`, once it has asked something); the
// core lists no torrent site (docs/providers-plan.md §4.1).
//
//   health.install()   once, from index.js#start (idempotent)
//   health.plugin(plugin, host, err?)   a plugin's request to host answered (or failed with err)
//   health.list()      → [{ id, name, plugin?, host?, lastSuccess, lastFailure, lastError, ok, failures }]

var axios = require('axios');

// id → name and the hosts that belong to it (a host matches itself and its subdomains)
var SERVICES = [
  { id: 'tmdb', name: 'TMDB', hosts: ['api.themoviedb.org'] },
  { id: 'imdb', name: 'IMDb', hosts: ['graphql.imdb.com'] },
  { id: 'stremio-opensubtitles', name: 'OpenSubtitles (Stremio)', hosts: ['opensubtitles-v3.strem.io'] },
  { id: 'opensubtitles', name: 'OpenSubtitles.com', hosts: ['api.opensubtitles.com'] },
  { id: 'yify', name: 'YIFY Subtitles', hosts: ['yts-subs.com'] },
  { id: 'wyzie', name: 'Wyzie Subs', hosts: ['sub.wyzie.io'] }
];

var state = {},   // id → { lastSuccess, lastFailure, lastError, failures (in a row) }
  plugins = {},   // 'plugin:<id>:<host>' → { plugin, name, host }, in the order first seen
  installed = false;

function serviceOf(config) {
  var host;
  try {
    host = new URL(config && config.url, config && config.baseURL).hostname;
  } catch (e) {
    return null;
  }
  for (var i = 0; i < SERVICES.length; i++) {
    if (SERVICES[i].hosts.some(function (h) { return host === h || host.slice(-h.length - 1) === '.' + h; })) {
      return SERVICES[i].id;
    }
  }
  return null;
}

function entry(id) {
  return state[id] || (state[id] = { lastSuccess: null, lastFailure: null, lastError: null, failures: 0 });
}

function succeeded(id) {
  var e = entry(id);
  e.lastSuccess = new Date().toISOString();
  e.failures = 0;
}

// error: a status or network error code only (messages may carry URLs with keys)
function failedWith(id, error) {
  var e = entry(id);
  e.lastFailure = new Date().toISOString();
  e.lastError = error;
  e.failures += 1;
}

function install() {
  if (installed) {
    return;
  }
  installed = true;
  axios.interceptors.response.use(function (res) {
    var id = serviceOf(res.config);
    if (id) {
      succeeded(id);
    }
    return res;
  }, function (err) {
    var id = serviceOf(err && err.config);
    // A 404 is an answer (nothing found), not an outage
    if (id && !(err.response && err.response.status === 404)) {
      failedWith(id, err.response ? 'HTTP ' + err.response.status : (err.code || 'request failed'));
    }
    return Promise.reject(err);
  });
}

// A plugin's request (playpex.http.request): an answer is a success unless
// the site failed (5xx); err = the request failed (its code, never its message)
function plugin(p, host, err, status) {
  var id = 'plugin:' + p.id + ':' + host;
  if (!plugins[id]) {
    plugins[id] = { plugin: p.id, name: (p.manifest && p.manifest.name) || p.id, host: host };
  }
  if (err) {
    failedWith(id, err.code || 'request failed');
  } else if (status >= 500) {
    failedWith(id, 'HTTP ' + status);
  } else {
    succeeded(id);
  }
}

// ok: null = never used since start; false = its last call failed
function row(id, fields) {
  var e = state[id] || {};
  var ok = !e.lastSuccess && !e.lastFailure ? null : !e.lastFailure || (e.lastSuccess && e.lastSuccess > e.lastFailure);
  return Object.assign({ id: id }, fields, {
    ok: ok,
    lastSuccess: e.lastSuccess || null,
    lastFailure: e.lastFailure || null,
    lastError: e.lastError || null,
    failures: e.failures || 0
  });
}

function list() {
  return SERVICES.map(function (s) {
    return row(s.id, { name: s.name });
  }).concat(Object.keys(plugins).map(function (id) {
    var p = plugins[id];
    return row(id, { name: p.name + ' (' + p.host + ')', plugin: p.plugin, host: p.host });
  }));
}

module.exports = {
  install: install,
  plugin: plugin,
  list: list
};
