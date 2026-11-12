'use strict';

// The bridge's requests to a Stremio add-on (docs/stremio-bridge-plan.md §6.1,
// §9): made by the core, never by the adapter, to the add-on's address (its
// host, port and scheme: a granted host, as an address the admin typed), its
// redirects to any public https host; every hop checked by ../http.js. Answers are size-capped, parsed and cleaned
// (@playpex/protocol/stremio), then cached by the add-on's own cacheMaxAge /
// staleRevalidate / staleError (capped), else our defaults; a stale answer is
// served while it is asked again, and when the add-on fails within staleError.
//
//   principal(owner, address) → what ../http.js checks requests against
//   manifest(owner, address, { fresh }) → the add-on's manifest, cleaned ({ manifest, unused })
//   get(owner, address, resource, type, id, extra) → the cleaned answer (+ stale: true when served stale)
//   forget(ownerId)   its cached answers dropped (removed, reconfigured)
//   configure({ now })   tests

var stremio = require('@playpex/protocol/stremio'),
  http = require('../http'),
  health = require('../../health'),
  log = require('../../logger').child('plugins');

var CACHE_BYTES = 64 * 1024 * 1024,
  MANIFEST_TTL_S = 24 * 3600,
  TIMEOUT_MS = { stream: 7000, subtitles: 7000, catalog: 10000, meta: 10000, manifest: 10000 };

var cache = new Map(),   // key → { at, bytes, value, maxAge, staleRevalidate, staleError }
  cacheBytes = 0,
  inflight = new Map(),
  testing = { now: null };

function now() {
  return testing.now ? testing.now() : Date.now();
}

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Who asks: the owner's id (its rate limits, its health). The first request is
 * always to the add-on's address (its port and scheme granted); its redirects
 * may go to any public https host, as Stremio follows them (Cinemeta's
 * catalogs live on another host): every hop checked by ../http.js
 */
function principal(owner, address) {
  return {
    id: owner.id,
    anyHost: true,
    permissions: { network: [] },
    stats: owner.stats,
    grants: {
      hosts: [{ host: address.host, port: address.port, scheme: address.scheme, key: 'stremio' }],
      learned: new Map(),
      images: new Map()
    }
  };
}

function remember(key, entry) {
  var old = cache.get(key);
  if (old) {
    cacheBytes -= old.bytes;
    cache.delete(key);
  }
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while (cacheBytes > CACHE_BYTES && cache.size > 1) {
    var first = cache.keys().next().value, gone = cache.get(first);
    cache.delete(first);
    cacheBytes -= gone.bytes;
  }
}

function forget(ownerId) {
  Array.from(cache.keys()).forEach(function (k) {
    if (k.indexOf(ownerId + '\n') === 0) {
      cacheBytes -= cache.get(k).bytes;
      cache.delete(k);
    }
  });
}

/** One GET of the add-on, cleaned; 404 = the empty answer (an add-on that has nothing for that id) */
function ask(owner, address, resource, urlPath) {
  var url = address.base + urlPath,
    who = principal(owner, address),
    started = now();
  return http.request(who, { url: url, headers: { accept: 'application/json' }, timeoutMs: TIMEOUT_MS[resource] }).then(function (r) {
    var res = r.value;
    health.plugin(owner, address.host, null, res.status);
    if (res.status === 404 && resource !== 'manifest') {
      return { value: stremio.empty(resource), bytes: 0 };
    }
    if (res.status !== 200) {
      throw failure('UPSTREAM', 'the add-on answered HTTP ' + res.status);
    }
    var text = res.body || '';
    if (Buffer.byteLength(text) > (resource === 'manifest' ? stremio.LIMITS.manifestBytes : stremio.LIMITS.answerBytes)) {
      throw failure('TOO_LARGE', 'the add-on\'s answer is larger than ' + (resource === 'manifest' ? '256 KB' : '2 MB'));
    }
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw failure('INVALID', 'the add-on didn\'t answer JSON');
    }
    var value = resource === 'manifest' ? stremio.cleanManifest(json) : stremio.clean(resource, json);
    owner.stats.host['stremio ' + resource + ' ms'] = now() - started;
    return { value: value, bytes: text.length };
  }, function (err) {
    if (['INVALID', 'HTTPS_ONLY', 'PORT_NOT_ALLOWED', 'HOST_NOT_ALLOWED'].indexOf(err.code) === -1) {
      health.plugin(owner, address.host, err);
    }
    throw err;
  });
}

function lifetimes(resource, value) {
  var c = value.cache || {},
    def = resource === 'manifest' ? MANIFEST_TTL_S : stremio.LIMITS.cacheDefault[resource];
  return {
    maxAge: (c.maxAge == null ? def : c.maxAge) * 1000,
    staleRevalidate: (c.staleRevalidate == null ? 0 : c.staleRevalidate) * 1000,
    // an add-on that fails: what it answered before, for a day at least
    staleError: Math.max(c.staleError == null ? 0 : c.staleError, 24 * 3600) * 1000
  };
}

function cached(owner, address, resource, urlPath, fresh) {
  var key = owner.id + '\n' + address.base + urlPath,
    hit = cache.get(key),
    age = hit ? now() - hit.at : Infinity;

  function fetchNow() {
    if (inflight.has(key)) {
      return inflight.get(key);
    }
    var p = ask(owner, address, resource, urlPath).then(function (r) {
      inflight.delete(key);
      remember(key, Object.assign({ at: now(), bytes: r.bytes + 200, value: r.value }, lifetimes(resource, r.value)));
      return r.value;
    }, function (err) {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, p);
    return p;
  }

  if (hit && !fresh && age < hit.maxAge) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit.value);
  }
  if (hit && !fresh && age < hit.maxAge + hit.staleRevalidate) {
    fetchNow().catch(function (err) {
      log.debug('plugin ' + owner.id + ': ' + resource + ' not asked again: ' + err.message, { plugin: owner.id });
    });
    return Promise.resolve(Object.assign({}, hit.value, { stale: true }));
  }
  return fetchNow().catch(function (err) {
    if (hit && age < hit.maxAge + hit.staleError) {
      log.info('plugin ' + owner.id + ': the add-on failed (' + err.message + '): its earlier ' + resource + ' answer is used', { plugin: owner.id });
      return Object.assign({}, hit.value, { stale: true });
    }
    throw err;
  });
}

function manifest(owner, address, options) {
  return cached(owner, address, 'manifest', '/manifest.json', options && options.fresh);
}

function get(owner, address, resource, type, id, extra) {
  var urlPath;
  try {
    urlPath = stremio.requestPath(resource, type, id, extra);
  } catch (err) {
    return Promise.reject(err);
  }
  return cached(owner, address, resource, urlPath, false);
}

function configure(options) {
  testing = Object.assign({ now: null }, options || {});
  cache.clear();
  cacheBytes = 0;
  inflight.clear();
}

module.exports = {
  principal: principal,
  manifest: manifest,
  get: get,
  forget: forget,
  configure: configure
};
