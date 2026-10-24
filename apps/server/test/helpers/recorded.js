'use strict';

// Recorded answers of the torrent sites (test/fixtures/providers/*.json), for
// the providers' parity test: the core's providers read them through an axios
// adapter, the plugins through a stub `playpex.http.request`. Both ask the same
// questions, so an answer is found by its request: host + path + its query
// parameters sorted (however the caller wrote them).
//
//   key(url, params?)   the request's key
//   load(name)          { <key>: <answer body> } of a fixture file
//   adapter(answers)    an axios adapter answering them (404 for anything else)
//   request(answers)    a playpex.http.request answering them
//   plugin(dir, request)   a plugin's server.js in Node: { id, manifest, permissions, hooks },
//                          with a stub `playpex` (that http.request, the core's names.*)

var fs = require('fs'),
  path = require('path'),
  vm = require('vm'),
  names = require('../../lib/media/names');

var DIR = path.join(__dirname, '..', 'fixtures', 'providers');

// What was recorded (scripts/record-providers.js) and is compared: titles
// for Play, and release lists (lib/releases.js#browse options)
var PLAY = [
  { name: 'dune', title: { kind: 'movie', tmdbId: 438631, imdbId: 'tt1160419', title: 'Dune', year: 2021 } },
  { name: 'severance-s01e01', title: { kind: 'episode', tmdbId: 95396, imdbId: 'tt11280740', title: 'Severance', year: 2022, season: 1, episode: 1 } },
  // EZTV's IMDb lookup answers another show ("Breaking Brad"): only TheRARBG's matches stay
  { name: 'breaking-bad-s02e03', title: { kind: 'episode', tmdbId: 1396, imdbId: 'tt0903747', title: 'Breaking Bad', year: 2008, season: 2, episode: 3 } }
];

var RELEASES = [
  { kind: 'movie', provider: 'piratebay' },
  { kind: 'movie', provider: 'piratebay', q: 'dune' },
  { kind: 'movie', provider: 'piratebay', quality: '1080p' },
  { kind: 'movie', provider: 'therarbg' },
  { kind: 'movie', provider: 'therarbg', q: 'dune' },
  { kind: 'movie', provider: 'therarbg', page: 2 },
  { kind: 'movie', provider: 'yts' },
  { kind: 'movie', provider: 'yts', q: 'dune', quality: '1080p' },
  { kind: 'tv', provider: 'piratebay' },
  { kind: 'tv', provider: 'piratebay', q: 'severance' },
  { kind: 'tv', provider: 'therarbg', q: 'severance', playable: true },
  { kind: 'tv', provider: 'eztv' },
  { kind: 'tv', provider: 'eztv', imdb: 'tt11280740', q: '1080p' }
];

function key(url, params) {
  var u = new URL(url), query = [];
  u.searchParams.forEach(function (value, name) {
    query.push([name, value]);
  });
  Object.keys(params || {}).forEach(function (name) {
    if (params[name] !== undefined && params[name] !== null) {
      query.push([name, String(params[name])]);
    }
  });
  query.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return u.host + decodeURIComponent(u.pathname) + (query.length ? '?' + query.map(function (q) {
    return q[0] + '=' + q[1];
  }).join('&') : '');
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
}

function notFound(k) {
  var err = new Error('not recorded: ' + k);
  err.response = { status: 404, data: null };
  return err;
}

function adapter(answers) {
  return function (config) {
    var k = key(config.url, config.params);
    if (!Object.prototype.hasOwnProperty.call(answers, k)) {
      return Promise.reject(notFound(k));
    }
    return Promise.resolve({ data: answers[k], status: 200, statusText: 'OK', headers: {}, config: config, request: {} });
  };
}

function request(answers) {
  return function (options) {
    var k = key(options.url);
    if (!Object.prototype.hasOwnProperty.call(answers, k)) {
      return Promise.resolve({ status: 404, headers: {}, body: null });
    }
    var body = answers[k];
    return Promise.resolve({ status: 200, headers: {}, body: options.responseType === 'json' ? body : JSON.stringify(body) });
  };
}

function plugin(dir, request) {
  var hooks = {}, manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playpex-plugin.json'), 'utf8'));
  var playpex = {
    hooks: { on: function (name, fn) { hooks[name] = fn; } },
    http: {
      request: function (o) {
        if (manifest.permissions.network.indexOf(new URL(o.url).hostname) === -1) {
          return Promise.reject(new Error(manifest.id + ' asked an undeclared host: ' + o.url));
        }
        return request(o);
      }
    },
    names: {
      parse: function (n) { return Promise.resolve(names.parse(n)); },
      describe: function (n) { return Promise.resolve(names.describe(n)); },
      matches: function (n, title) {
        return Promise.resolve(Array.isArray(n) ? n.map(function (x) { return names.matches(x, title); }) : names.matches(n, title));
      },
      rank: function (items) { return Promise.resolve(names.rank(items)); }
    },
    log: { info: function () {}, warn: function () {}, error: function () {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), { playpex: playpex });
  return { id: manifest.id, manifest: manifest, permissions: manifest.permissions, hooks: hooks };
}

module.exports = {
  plugin: plugin,
  DIR: DIR,
  PLAY: PLAY,
  RELEASES: RELEASES,
  key: key,
  load: load,
  adapter: adapter,
  request: request
};
