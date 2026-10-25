'use strict';

// Plugins' `http` sources as media refs `r_…` (docs/plugins-plan.md §4.7):
// the server keeps the URL and its headers (a token) and proxies the bytes,
// so a client never sees either. Every request goes through ./http.js#stream
// as the plugin: its declared hosts, the SSRF rules on every hop. A ref lives
// in memory for an hour after its last use (play.collect makes it again on
// Resume); the same source of the same plugin keeps its ref meanwhile.
//
//   register(plugin, source) → entry { ref, pluginId, label, size, quality, container, codec, audio }
//   media(ref) → Promise<Media>   lib/media's resolve for kind 'remote' (size asked from the source when unknown)
//   open(media, range) → Promise<Readable>

var crypto = require('crypto'),
  http = require('./http'),
  refs = require('../media/refs'),
  log = require('../logger').child('plugins');

var TTL_MS = 60 * 60 * 1000,
  MAX = 2000,
  SECRET = crypto.randomBytes(32);

var entries = new Map();

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function sweep() {
  var now = Date.now();
  entries.forEach(function (e, id) {
    if (now - e.usedAt > TTL_MS) {
      entries.delete(id);
    }
  });
  while (entries.size > MAX) {
    entries.delete(entries.keys().next().value);   // the oldest
  }
}

// A file name the media routes can type: the label, with the container's extension
function nameOf(source) {
  var name = String(source.label || 'video').replace(/[\\/\0\r\n]/g, ' ').slice(0, 200),
    ext = source.container ? String(source.container).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return ext && name.toLowerCase().slice(-ext.length - 1) !== '.' + ext ? name + '.' + ext : name;
}

/**
 * Keeps an http source (already checked: the plugin may use http sources and
 * its host) and answers its entry.
 */
function register(plugin, source) {
  sweep();
  var id = crypto.createHmac('sha256', SECRET)
    .update(plugin.id + '\n' + source.url + '\n' + JSON.stringify(source.headers || {})).digest('hex').slice(0, 32);
  var entry = entries.get(id);
  if (!entry) {
    entry = {
      ref: refs.remote(id),
      pluginId: plugin.id,
      // the core's own fetches (a link the admin gave, lib/links): no plugin to look up
      principal: plugin.core ? plugin : null,
      url: source.url,
      headers: source.headers || {},
      label: source.label,
      name: nameOf(source),
      size: source.size || null,
      quality: source.quality || null,
      container: source.container || null,
      codec: source.codec || null,
      audio: source.audio || null,
      usedAt: Date.now()
    };
    entries.set(id, entry);
  }
  entry.usedAt = Date.now();
  return entry;
}

function pluginOf(entry) {
  if (entry.principal) {
    return entry.principal;
  }
  var plugin = require('./index').get(entry.pluginId);
  return plugin && plugin.state === 'enabled' ? plugin : null;
}

function upstream(err) {
  return failure('UPSTREAM', 'the plugin\'s source didn\'t answer: ' + err.message);
}

// The size, from a one-byte range (or the whole answer's length)
function sizeOf(plugin, entry) {
  return http.stream(plugin, { url: entry.url, headers: entry.headers, range: { start: 0, end: 0 } }).then(function (r) {
    r.abort();
    var total = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || '')),
      size = r.status === 206 && total ? parseInt(total[1], 10) :
        r.status === 200 ? parseInt(r.headers['content-length'], 10) : NaN;
    if (r.status >= 400) {
      throw new Error('HTTP ' + r.status);
    }
    if (!(size > 0)) {
      throw new Error('no size (HTTP ' + r.status + ')');
    }
    return size;
  });
}

/** The Media of an r_ ref (lib/media); rejects NOT_FOUND (expired, its plugin gone) or UPSTREAM */
function media(ref) {
  var parsed = refs.parse(ref),
    entry = parsed && parsed.kind === 'remote' ? entries.get(parsed.id) : null,
    plugin = entry && pluginOf(entry);
  if (!entry || !plugin || Date.now() - entry.usedAt > TTL_MS) {
    return Promise.reject(failure('NOT_FOUND', 'No such media'));
  }
  entry.usedAt = Date.now();
  var size = entry.size ? Promise.resolve(entry.size) : sizeOf(plugin, entry).then(function (n) {
    entry.size = n;
    return n;
  }, function (err) {
    log.warn('plugin ' + entry.pluginId + ' source not reachable: ' + err.message, { plugin: entry.pluginId, code: err.code });
    throw upstream(err);
  });
  return size.then(function (n) {
    return {
      ref: entry.ref,
      kind: 'remote',
      key: entry.ref,
      name: entry.name,
      path: entry.name,
      size: n,
      pluginId: entry.pluginId
    };
  });
}

// Stops passing bytes after `max` (a source answering 200 to a range from 0)
function truncate(body, max) {
  var Transform = require('stream').Transform,
    left = max;
  var t = new Transform({
    transform: function (chunk, enc, done) {
      if (left <= 0) {
        return done();
      }
      var part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      left -= part.length;
      done(null, part);
      if (left <= 0) {
        body.destroy();
        t.end();
      }
    }
  });
  body.on('error', function (err) { t.destroy(err); });
  return body.pipe(t);
}

/** Bytes start…end (inclusive) of a remote Media as a Readable */
function open(m, range) {
  var parsed = refs.parse(m.ref),
    entry = parsed && entries.get(parsed.id),
    plugin = entry && pluginOf(entry);
  if (!entry || !plugin) {
    return Promise.reject(failure('NOT_FOUND', 'No such media'));
  }
  entry.usedAt = Date.now();
  var start = range ? range.start : 0,
    end = range ? range.end : m.size - 1;
  return http.stream(plugin, { url: entry.url, headers: entry.headers, range: { start: start, end: end } }).then(function (r) {
    if (r.status === 206) {
      return r.body;
    }
    if (r.status === 200 && start === 0) {
      return truncate(r.body, end + 1);
    }
    r.abort();
    throw new Error(r.status === 200 ? 'the source ignores ranges' : 'HTTP ' + r.status);
  }).catch(function (err) {
    log.warn('plugin ' + entry.pluginId + ' stream failed: ' + err.message, { plugin: entry.pluginId, code: err.code });
    throw upstream(err);
  });
}

/**
 * What an r_ ref fetches, for a direct download (lib/downloads/direct.js):
 * { url, headers, label, name, size, by: 'links' | the plugin's id }, or null
 */
function source(ref) {
  var parsed = refs.parse(ref),
    entry = parsed && parsed.kind === 'remote' ? entries.get(parsed.id) : null;
  if (!entry || !pluginOf(entry) || Date.now() - entry.usedAt > TTL_MS) {
    return null;
  }
  return { url: entry.url, headers: entry.headers, label: entry.label, name: entry.name, size: entry.size,
    by: entry.principal ? entry.principal.id : entry.pluginId };
}

/** Forgets a plugin's refs (it was unloaded) */
function forget(pluginId) {
  entries.forEach(function (e, id) {
    if (e.pluginId === pluginId) {
      entries.delete(id);
    }
  });
}

module.exports = {
  register: register,
  media: media,
  open: open,
  source: source,
  forget: forget,
  // tests
  reset: function () { entries.clear(); }
};
