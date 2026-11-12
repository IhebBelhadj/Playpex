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
// An http source with `archive` (API 1.5: a stored file inside a rar / zip / tar
// on the web) is indexed by ../media/archive.js on first use (its headers read
// with ranges, kept with the entry); its Media is that file (its name, its
// size) and its ranges are ranges of the parts.

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
    .update(plugin.id + '\n' + source.url + '\n' + JSON.stringify(source.headers || {}) + '\n' + JSON.stringify(source.archive || null)).digest('hex').slice(0, 32);
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
      archive: source.archive ? { format: source.archive.format, parts: source.archive.parts.map(function (p) { return { url: p.url, size: p.size || null }; }),
        fileIndex: source.archive.fileIndex, fileMustInclude: source.archive.fileMustInclude || null } : null,
      index: null,
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

// One part of an archive: a range, as the plugin (its hosts, the address rules on every hop)
function partRange(plugin, entry, part, start, end) {
  var url = entry.archive.parts[part].url;
  return http.stream(plugin, { url: url, headers: entry.headers, range: { start: start, end: end } }).then(function (r) {
    if (r.status === 206 || (r.status === 200 && start === 0)) {
      return r.status === 206 ? r.body : truncate(r.body, end + 1);
    }
    r.abort();
    throw failure('UPSTREAM', 'part ' + (part + 1) + ': ' + (r.status === 200 ? 'the host ignores ranges' : 'HTTP ' + r.status));
  });
}

function collect(body) {
  return new Promise(function (ok, fail) {
    var chunks = [];
    body.on('data', function (c) { chunks.push(c); });
    body.on('end', function () { ok(Buffer.concat(chunks)); });
    body.on('error', fail);
  });
}

/** The archive's index (its file's place in the parts), read once per entry */
function indexOf(plugin, entry) {
  if (!entry.index) {
    var a = entry.archive;
    entry.index = archive().index(a.format, {
      parts: a.parts.length,
      read: function (part, start, end) {
        return partRange(plugin, entry, part, start, end).then(collect);
      },
      size: function (part) {
        return a.parts[part].size ? Promise.resolve(a.parts[part].size) :
          sizeOf(plugin, { url: a.parts[part].url, headers: entry.headers }).then(function (n) { a.parts[part].size = n; return n; });
      }
    }, { index: a.fileIndex, include: a.fileMustInclude });
    entry.index.catch(function () { entry.index = null; });
  }
  return entry.index;
}

function archive() {
  return require('../media/archive');
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
  if (entry.archive) {
    return indexOf(plugin, entry).then(function (ix) {
      return { ref: entry.ref, kind: 'remote', key: entry.ref, name: ix.name, path: ix.name, size: ix.size, pluginId: entry.pluginId };
    }, function (err) {
      log.warn('plugin ' + entry.pluginId + ' archive not readable: ' + err.message, { plugin: entry.pluginId, code: err.code });
      throw err.code === 'UNSUPPORTED' || err.code === 'NOT_FOUND' ? failure('UNSUPPORTED', err.message) : upstream(err);
    });
  }
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
  if (entry.archive) {
    return indexOf(plugin, entry).then(function (ix) {
      return archive().stream(ix, start, end, function (part, s, e) { return partRange(plugin, entry, part, s, e); });
    }).catch(function (err) {
      log.warn('plugin ' + entry.pluginId + ' archive stream failed: ' + err.message, { plugin: entry.pluginId, code: err.code });
      throw upstream(err);
    });
  }
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
  if (!entry || !pluginOf(entry) || Date.now() - entry.usedAt > TTL_MS || entry.archive) {
    return null;   // an archive's file isn't one URL: not a direct download (yet)
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

/** Whose an r_ ref is, without using it: { pluginId, core } or null (unknown, expired) (lib/cast) */
function owner(ref) {
  var parsed = refs.parse(ref),
    entry = parsed && parsed.kind === 'remote' ? entries.get(parsed.id) : null;
  return entry && Date.now() - entry.usedAt <= TTL_MS ? { pluginId: entry.pluginId, core: !!entry.principal } : null;
}

module.exports = {
  register: register,
  media: media,
  owner: owner,
  open: open,
  source: source,
  forget: forget,
  // tests
  reset: function () { entries.clear(); }
};
