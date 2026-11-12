'use strict';

// Plugins' pictures through the server (docs/plugin-layer-plan.md §3): a
// client never fetches an image from a plugin's hosts. When a plugin's answer
// leaves for a client, every picture URL in it (cards, backdrops, a release's
// picture, a programme's, a play request's artwork, a search result's poster)
// becomes `images/<token>`, a path of the plugin like `assets/…`:
// GET /api/v1/plugins/{id}/images/{token}. The server fetches it as the plugin
// (its hosts: permissions.network, permissions.images, image.tmdb.org, the
// hosts the admin granted it, picture hosts learned from what the server
// fetched for it (lib/plugins/grants.js#learn, scope image); the address
// rules on every hop), checks by its
// first bytes that it is a JPEG / PNG / WebP / GIF / AVIF (never SVG: scripts),
// ≤ 5 MB, and keeps it on disk 24 h (≤ 500 MB, the least recently used go).
//
//   rewrite(plugin, value) → a copy of value with its picture URLs as images/<token>
//   apiPath(plugin, url) → '/plugins/{id}/images/{token}' (under the API prefix: live programmes, search results), or null
//   token(plugin, url) → the token (base64url of the URL + an HMAC of plugin id + URL)
//   serve(req, res, pluginId, token)   the route
//   configure({ dir, maxBytes }) for tests

var crypto = require('crypto'),
  fs = require('fs'),
  path = require('path'),
  http = require('./http'),
  secretBox = require('../secretBox'),
  paths = require('../paths'),
  log = require('../logger').child('plugins');

var IMAGE_KEYS = { image: true, backdrop: true, poster: true },
  TMDB_IMAGES = 'image.tmdb.org',
  MAX_BYTES = 5 * 1024 * 1024,
  TTL_MS = 24 * 60 * 60 * 1000,
  FAILURE_TTL_MS = 10 * 60 * 1000,
  MAX_DEPTH = 12,
  TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

var options = { dir: null, maxBytes: 500 * 1024 * 1024 },
  key = null,
  failures = new Map(),     // token → time it failed
  inflight = new Map(),     // token → Promise<{ file, type }>
  writes = 0;

function cacheDir() {
  return options.dir || path.join(paths.cache, 'plugin-images');
}

function hmacKey() {
  if (!key) {
    key = secretBox.derive('plugin-images');
  }
  return key;
}

function mac(pluginId, url) {
  return crypto.createHmac('sha256', hmacKey()).update(pluginId + '\n' + url).digest('base64url').slice(0, 22);
}

function token(plugin, url) {
  return Buffer.from(url, 'utf8').toString('base64url') + '.' + mac(plugin.id, url);
}

/** The URL a token names for that plugin, or null (forged, another plugin's) */
function untoken(pluginId, t) {
  var m = /^([A-Za-z0-9_-]{4,3000})\.([A-Za-z0-9_-]{22})$/.exec(String(t || ''));
  if (!m) {
    return null;
  }
  var url = Buffer.from(m[1], 'base64url').toString('utf8'),
    expected = mac(pluginId, url);
  if (expected.length !== m[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) {
    return null;
  }
  return url;
}

function isPictureUrl(v) {
  return typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v) && v.length <= 2048;
}

/** A copy of `value` with every picture URL (keys image / backdrop / poster) as images/<token> */
function rewrite(plugin, value, depth) {
  depth = depth || 0;
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(function (v) { return rewrite(plugin, v, depth + 1); });
  }
  var out = {};
  Object.keys(value).forEach(function (k) {
    var v = value[k];
    if (IMAGE_KEYS[k] && isPictureUrl(v)) {
      out[k] = 'images/' + token(plugin, v);
    } else {
      out[k] = rewrite(plugin, v, depth + 1);
    }
  });
  return out;
}

/** A picture URL as a path under the API prefix (answers that aren't a plugin's own data) */
function apiPath(plugin, url) {
  return isPictureUrl(url) ? '/plugins/' + plugin.id + '/images/' + token(plugin, url) : null;
}

/** What a picture's bytes are, by their start: an extension of TYPES, or null */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) {
    return 'gif';
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(buf.slice(8, 12).toString('latin1'))) {
    return 'avif';
  }
  return null;
}

/** The plugin as the image fetch sees it: its network hosts + its image hosts + TMDB's images */
function imageView(plugin) {
  var perms = plugin.permissions || {},
    network = (perms.network || []).concat(perms.images || [], [TMDB_IMAGES]);
  var view = Object.create(plugin);
  view.permissions = Object.assign({}, perms, { network: network });
  return view;
}

function fileOf(t) {
  return path.join(cacheDir(), crypto.createHash('sha1').update(t).digest('hex'));
}

/** A cached copy: { file, type } when fresh */
function cached(t) {
  var base = fileOf(t), exts = Object.keys(TYPES);
  for (var i = 0; i < exts.length; i++) {
    var file = base + '.' + exts[i];
    try {
      var st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < TTL_MS) {
        // touched when read: the sweep drops the least recently used
        var now = new Date();
        try { fs.utimesSync(file, now, now); } catch (e) { /* read-only: fine */ }
        return { file: file, type: TYPES[exts[i]] };
      }
      fs.unlink(file, function () {});
    } catch (e) { /* not this extension */ }
  }
  return null;
}

/** Drops the least recently used files past maxBytes (every 50 writes) */
function sweep() {
  var dir = cacheDir(), list;
  try {
    list = fs.readdirSync(dir).map(function (name) {
      var st = fs.statSync(path.join(dir, name));
      return { file: path.join(dir, name), size: st.size, at: st.mtimeMs };
    });
  } catch (e) {
    return;
  }
  var total = list.reduce(function (n, f) { return n + f.size; }, 0);
  list.sort(function (a, b) { return a.at - b.at; });
  while (total > options.maxBytes && list.length) {
    var f = list.shift();
    total -= f.size;
    try { fs.unlinkSync(f.file); } catch (e) { /* gone */ }
  }
}

function fetchImage(plugin, t, url) {
  return http.stream(imageView(plugin), { url: url, scope: 'image', headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9' } }).then(function (r) {
    if (r.status !== 200) {
      r.abort();
      throw Object.assign(new Error('HTTP ' + r.status), { code: 'UPSTREAM' });
    }
    var length = parseInt(r.headers['content-length'], 10);
    if (length > MAX_BYTES) {
      r.abort();
      throw Object.assign(new Error('larger than 5 MB'), { code: 'TOO_LARGE' });
    }
    return new Promise(function (resolve, reject) {
      var chunks = [], size = 0, done = false;
      function fail(err) {
        if (!done) {
          done = true;
          r.abort();
          reject(err);
        }
      }
      r.body.on('data', function (c) {
        size += c.length;
        if (size > MAX_BYTES) {
          return fail(Object.assign(new Error('larger than 5 MB'), { code: 'TOO_LARGE' }));
        }
        chunks.push(c);
      });
      r.body.on('error', fail);
      r.body.on('end', function () {
        if (done) {
          return;
        }
        done = true;
        resolve(Buffer.concat(chunks));
      });
    });
  }).then(function (buf) {
    var ext = sniff(buf);
    if (!ext) {
      throw Object.assign(new Error('not a picture (JPEG, PNG, WebP, GIF or AVIF)'), { code: 'NOT_AN_IMAGE' });
    }
    var file = fileOf(t) + '.' + ext;
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(file + '.part', buf);
    fs.renameSync(file + '.part', file);
    if (++writes % 50 === 0) {
      setImmediate(sweep);
    }
    return { file: file, type: TYPES[ext] };
  });
}

/** GET /plugins/{id}/images/{token} */
function serve(req, res, pluginId, t) {
  var plugin = require('./index').get(pluginId),
    url = plugin && plugin.state === 'enabled' ? untoken(pluginId, t) : null;
  function notFound() {
    res.status(404).set('Cache-Control', 'private, max-age=600').end();
  }
  if (!url) {
    return notFound();
  }
  var failedAt = failures.get(t);
  if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) {
    return notFound();
  }
  function send(found) {
    res.set({
      'Content-Type': found.type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.sendFile(found.file, function (err) {
      if (err && !res.headersSent) {
        notFound();
      }
    });
  }
  var hit = cached(t);
  if (hit) {
    return send(hit);
  }
  if (!inflight.has(t)) {
    inflight.set(t, fetchImage(plugin, t, url).finally(function () { inflight.delete(t); }));
  }
  inflight.get(t).then(send, function (err) {
    failures.set(t, Date.now());
    if (failures.size > 5000) {
      failures.delete(failures.keys().next().value);
    }
    var host;
    try { host = new URL(url).hostname; } catch (e) { host = '?'; }
    log.info('plugin ' + pluginId + ': picture from ' + host + ' refused: ' + (err.code ? err.code + ': ' : '') + err.message, { plugin: pluginId });
    notFound();
  });
}

function configure(o) {
  options = Object.assign({ dir: null, maxBytes: 500 * 1024 * 1024 }, o || {});
  failures.clear();
}

module.exports = {
  rewrite: rewrite,
  apiPath: apiPath,
  token: token,
  untoken: untoken,
  sniff: sniff,
  serve: serve,
  configure: configure
};
