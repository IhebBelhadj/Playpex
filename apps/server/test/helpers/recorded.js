'use strict';

// Recorded answers of the torrent sites (test/fixtures/providers/*.json), for
// the providers' parity test: the plugins (plugins/torrents/*) read them
// through a stub `playpex.http.request`; an answer is found by its request:
// host + path + its query parameters sorted (however the caller wrote them).
// expected.json holds what the core's own providers answered on these
// recordings before they left the core (docs/providers-plan.md step 5).
//
//   key(url, params?)   the request's key
//   load(name)          { <key>: <answer body> } of a fixture file
//   adapter(answers)    an axios adapter answering them (404 for anything else)
//   request(answers)    a playpex.http.request answering them
//   plugin(dir, request)   a plugin's server.js in Node: { id, manifest, permissions, hooks },
//                          with a stub `playpex` (that http.request, the core's names.*)
//   host(plugins, loaded)  lib/plugins answering with those plugins (get, withHook,
//                          runHook; answers checked against the hooks' schemas):
//                          { enable(ids), restore() }
//   brief(source), listed(page)   what is compared of a Play source / a release list

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

function out(value) {
  return JSON.parse(JSON.stringify(value));
}

function host(plugins, loaded) {
  var schemas = require('../../lib/plugins/schemas'),
    ids = Object.keys(loaded),
    enabled = ids.slice(),
    real = { get: plugins.get, withHook: plugins.withHook, runHook: plugins.runHook };

  function hooked(name) {
    return enabled.filter(function (id) { return loaded[id].hooks[name]; }).sort();
  }

  plugins.get = function (id) {
    return loaded[id] || null;
  };
  plugins.withHook = function (name) {
    return hooked(name).map(function (id) { return { id: id, name: loaded[id].manifest.name }; });
  };
  plugins.runHook = function (name, input, ctx, options) {
    var problem = schemas.hookProblem(name, 'input', input);
    if (problem) {
      return Promise.reject(new Error(name + ' input: ' + problem));
    }
    var results = [], errors = [];
    return Promise.all(hooked(name).filter(function (id) { return !options || !options.only || options.only === id; }).map(function (id) {
      return Promise.resolve().then(function () {
        return loaded[id].hooks[name](out(input), ctx);
      }).then(function (output) {
        output = out(output);
        var bad = schemas.hookProblem(name, 'output', output);
        if (bad) {
          throw new Error('out of schema: ' + bad);
        }
        results.push({ plugin: id, output: output });
      }, function (err) {
        errors.push({ plugin: id, code: 'HANDLER_ERROR', message: err.message });
      });
    })).then(function () {
      results.sort(function (a, b) { return a.plugin < b.plugin ? -1 : 1; });
      return { results: results, errors: errors };
    });
  };
  return {
    enable: function (list) { enabled = (list || ids).slice(); },
    restore: function () { Object.assign(plugins, real); }
  };
}

function brief(s) {
  return { infoHash: s.infoHash, label: s.label, seeds: s.seeds, quality: s.quality, playable: s.playable, pack: s.badges.indexOf('pack') !== -1 };
}

// through JSON, as expected.json keeps it (no undefined fields)
function listed(r) {
  return out(r.torrents.map(function (t) {
    return { hash: t.hash, name: t.name, seeds: t.seeds, peers: t.peers, size: t.size, added: t.added, quality: t.quality,
      playable: t.playable, audio: t.audio, season: t.season, episode: t.episode, pack: t.pack };
  }));
}

module.exports = {
  plugin: plugin,
  host: host,
  brief: brief,
  listed: listed,
  DIR: DIR,
  PLAY: PLAY,
  RELEASES: RELEASES,
  key: key,
  load: load,
  adapter: adapter,
  request: request
};
