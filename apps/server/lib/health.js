'use strict';

// Provider health for the dashboard's Overview (docs/server-separation-plan.md §7):
// the last success and failure of every upstream service, recorded by axios
// interceptors on the shared axios instance every provider uses
// (require('axios')). Requests to hosts not listed in SERVICES aren't tracked.
//
//   health.install()   once, from index.js#start (idempotent)
//   health.list()      → [{ id, name, hosts, lastSuccess, lastFailure, lastError, ok, failures }]

var axios = require('axios');

// id → name and the hosts that belong to it (a host matches itself and its subdomains)
var SERVICES = [
  { id: 'yts', name: 'YTS', hosts: ['movies-api.accel.li', 'yts.lt', 'yts.ag'] },
  { id: 'eztv', name: 'EZTV', hosts: ['eztvx.to', 'eztv.wf', 'eztv.tf'] },
  { id: 'therarbg', name: 'TheRARBG', hosts: ['therarbg.to', 'therarbg.com'] },
  { id: 'piratebay', name: 'The Pirate Bay', hosts: ['apibay.org'] },
  { id: 'tmdb', name: 'TMDB', hosts: ['api.themoviedb.org'] },
  { id: 'imdb', name: 'IMDb', hosts: ['graphql.imdb.com'] },
  { id: 'stremio-opensubtitles', name: 'OpenSubtitles (Stremio)', hosts: ['opensubtitles-v3.strem.io'] },
  { id: 'opensubtitles', name: 'OpenSubtitles.com', hosts: ['api.opensubtitles.com'] },
  { id: 'yify', name: 'YIFY Subtitles', hosts: ['yts-subs.com'] },
  { id: 'wyzie', name: 'Wyzie Subs', hosts: ['sub.wyzie.io'] },
  { id: 'theporndb', name: 'ThePornDB', hosts: ['api.theporndb.net'] }
];

var state = {},   // id → { lastSuccess, lastFailure, lastError, failures (in a row) }
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

function install() {
  if (installed) {
    return;
  }
  installed = true;
  axios.interceptors.response.use(function (res) {
    var id = serviceOf(res.config);
    if (id) {
      var e = entry(id);
      e.lastSuccess = new Date().toISOString();
      e.failures = 0;
    }
    return res;
  }, function (err) {
    var id = serviceOf(err && err.config);
    // A 404 is an answer (nothing found), not an outage
    if (id && !(err.response && err.response.status === 404)) {
      var e = entry(id);
      e.lastFailure = new Date().toISOString();
      // Status or network error code only: messages may carry URLs with keys
      e.lastError = err.response ? 'HTTP ' + err.response.status : (err.code || 'request failed');
      e.failures += 1;
    }
    return Promise.reject(err);
  });
}

// ok: null = never used since start; false = its last call failed
function list() {
  return SERVICES.map(function (s) {
    var e = state[s.id] || {};
    var ok = !e.lastSuccess && !e.lastFailure ? null : !e.lastFailure || (e.lastSuccess && e.lastSuccess > e.lastFailure);
    return {
      id: s.id,
      name: s.name,
      ok: ok,
      lastSuccess: e.lastSuccess || null,
      lastFailure: e.lastFailure || null,
      lastError: e.lastError || null,
      failures: e.failures || 0
    };
  });
}

module.exports = {
  install: install,
  list: list
};
