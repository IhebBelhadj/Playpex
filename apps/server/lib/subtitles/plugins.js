'use strict';

// Plugins with `subtitles.providers` (docs/plugins-plan.md §4.3) as subtitle
// providers of the registry (./index.js): id `plugin:<id>`, after the core's.
// A plugin answers URLs on its declared hosts; clients get an opaque ref the
// server keeps (6 h) and the server fetches the file as the plugin (its
// hosts, the SSRF rules: lib/plugins/http.js), never an arbitrary URL.
// `audience: adults` plugins are left out (the player sends no profile).

var crypto = require('crypto'),
  plugins = require('../plugins'),
  http = require('../plugins/http');

var PREFIX = 'plugin:',
  TTL_MS = 6 * 60 * 60 * 1000,
  MAX = 5000,
  NO_ADULTS = { profile: { id: '', kids: true }, device: null, locale: 'en' };

var refs = new Map();

function remember(pluginId, sub) {
  var now = Date.now();
  refs.forEach(function (r, key) {
    if (now - r.at > TTL_MS) {
      refs.delete(key);
    }
  });
  while (refs.size >= MAX) {
    refs.delete(refs.keys().next().value);
  }
  var key = crypto.randomBytes(12).toString('hex');
  refs.set(key, { pluginId: pluginId, url: sub.url, format: sub.format || null, at: now });
  return key;
}

function isPlugin(id) {
  return typeof id === 'string' && id.indexOf(PREFIX) === 0;
}

/** The registry's entries of the plugins */
function list() {
  return plugins.withHook('subtitles.providers', NO_ADULTS).map(function (p) {
    return {
      id: PREFIX + p.id,
      name: p.name,
      description: 'From the ' + p.name + ' plugin',
      supports: { movie: true, episode: true },
      enabled: true
    };
  });
}

/** [{ ref, language, name }] for query { imdbId, season?, episode? } and the languages asked (639-1 codes, or none) */
function search(providerId, query, codes) {
  var id = providerId.slice(PREFIX.length),
    title = query.season ? { kind: 'episode', imdbId: query.imdbId, season: query.season, episode: query.episode } :
      { kind: 'movie', imdbId: query.imdbId };
  return plugins.runHook('subtitles.providers', { title: title, languages: codes || [] }, NO_ADULTS, { only: id }).then(function (r) {
    if (!r.results.length) {
      throw new Error((r.errors[0] ? r.errors[0].message : 'no plugin ' + id));
    }
    return r.results[0].output.map(function (sub) {
      return {
        ref: remember(id, sub),
        language: sub.language,
        name: sub.label + (sub.hearingImpaired ? ' (SDH)' : '')
      };
    });
  });
}

/** { buffer, format } of a ref search() gave */
function fetch(providerId, ref) {
  var entry = refs.get(ref),
    plugin = entry && plugins.get(entry.pluginId);
  if (!entry || PREFIX + entry.pluginId !== providerId || !plugin || plugin.state !== 'enabled') {
    return Promise.reject(new Error('this subtitle is gone: search again'));
  }
  return http.request(plugin, { url: entry.url, responseType: 'bytes' }).then(function (r) {
    if (r.value.status !== 200) {
      throw new Error('HTTP ' + r.value.status);
    }
    return { buffer: r.bytes, format: entry.format };
  });
}

module.exports = {
  isPlugin: isPlugin,
  list: list,
  search: search,
  fetch: fetch
};
