'use strict';

// Streams and files by keywords (docs/search-plan.md §3): the plugins with
// `sources.search`, one at a time (the dashboard's Search asks them all at
// once). Their sources are checked like play.collect's (a kind and a host
// they declared) and given as the server gives sources: `http` → an `r_` ref
// (lib/plugins/remote.js), `hls` → an `h_` ref (lib/media/hls.js), a magnet →
// its hash with the server's trackers. Never `audience: adults` plugins (no
// profile here, as release lists). Each item says whether its name holds
// every keyword (`matches`, names.searchMatches).
//
//   providers() → [{ id: 'plugin:<id>', name, kinds }]
//   search({ provider, q, kind, page }) → { provider, page, hasMore, items }

var names = require('../media/names'),
  trackers = require('../trackers'),
  log = require('../logger').child('search');

var KINDS = ['movie', 'show', 'any'],
  SOURCE_KINDS = ['http', 'hls', 'magnet'],
  // what withHook filters on: as a kids profile would, so no adults plugin
  NO_ADULTS = { profile: { id: '', kids: true }, device: null, locale: 'en' };

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function plugins() {
  return require('../plugins');
}

function providers() {
  return plugins().withHook('sources.search', NO_ADULTS).map(function (p) {
    var loaded = plugins().get(p.id);
    return {
      id: 'plugin:' + p.id,
      name: p.name,
      kinds: ((loaded && loaded.permissions.sources) || []).filter(function (k) { return SOURCE_KINDS.indexOf(k) !== -1; })
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function or(value) {
  return value === undefined ? null : value;
}

// A result as an item, or null (a live source: channels are live.stream's)
function item(plugin, result, q) {
  var src = result.source,
    described = names.describe(src.label),
    out = {
      provider: plugin.id,
      label: src.label,
      title: or(result.title),
      year: or(result.year),
      season: or(result.season),
      episode: or(result.episode),
      poster: or(result.poster),
      size: src.size || null,
      quality: src.quality || described.quality,
      codec: src.codec || described.codec,
      audio: src.audio || described.audio,
      seeds: or(src.seeds),
      peers: or(src.peers),
      matches: names.searchMatches(src.label + ' ' + (result.title || ''), q)
    };
  if (src.kind === 'magnet') {
    var hash = require('../play/plugins').hashOf(src);
    if (!hash) {
      return null;
    }
    return Object.assign(out, { kind: 'torrent', infoHash: hash, magnet: trackers.build(hash, src.label) });
  }
  if (src.kind === 'http') {
    return Object.assign(out, { kind: 'file', ref: require('../plugins/remote').register(plugin, src).ref });
  }
  if (src.kind === 'hls') {
    return Object.assign(out, { kind: 'hls', ref: require('../media/hls').register(plugin, src).ref, size: null });
  }
  return null;
}

function search(options) {
  var kind = KINDS.indexOf(options.kind) === -1 ? 'any' : options.kind,
    q = names.searchWords(options.q).slice(0, 100),
    page = Math.max(1, parseInt(options.page, 10) || 1),
    id = String(options.provider || '').replace(/^plugin:/, '');
  if (!q) {
    return Promise.reject(failure('INVALID', 'q: some keywords'));
  }
  var known = plugins().withHook('sources.search', NO_ADULTS).some(function (p) { return p.id === id; });
  if (!known) {
    return Promise.reject(failure('NOT_FOUND', 'No provider ' + (options.provider || '') + ' (a plugin with sources.search)'));
  }
  return plugins().runHook('sources.search', { query: q, kind: kind, page: page }, NO_ADULTS, { only: id }).then(function (r) {
    if (!r.results.length) {
      throw failure('UPSTREAM', (r.errors[0] && r.errors[0].message) || 'no answer');
    }
    var plugin = plugins().get(id),
      allowed = require('../plugins/effects').sourceAllowed,
      dropped = 0,
      items = [];
    r.results[0].output.results.forEach(function (result) {
      var found = plugin && allowed(plugin, result.source) ? item(plugin, result, q) : null;
      if (found) {
        items.push(found);
      } else {
        dropped++;
      }
    });
    if (dropped) {
      log.warn('plugin ' + id + ' sources.search: ' + dropped + ' results of a kind or host it didn\'t declare (or live) dropped',
        { plugin: id });
    }
    return { provider: 'plugin:' + id, page: page, hasMore: !r.results[0].output.last, items: items };
  });
}

module.exports = {
  providers: providers,
  search: search
};
