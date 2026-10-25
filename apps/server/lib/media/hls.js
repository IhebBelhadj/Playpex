'use strict';

// Plugins' HLS and live streams (docs/providers-plan.md §8.2, step 8): the
// server fetches them as the plugin (./plugins/http.js#stream: its declared
// hosts, the address rules on every hop, the source's headers), so a client
// never sees a URL, a token or a header.
//
//   h_<32 hex>  an `hls` source (VOD or live), or a `live` one that is a
//               playlist: GET /media/h_…/index.m3u8 answers the playlist with
//               every URI in it rewritten to r/<token> beside it (variant
//               playlists, segments, #EXT-X-KEY / -MAP / -MEDIA / …, relative
//               or absolute); /media/h_…/r/<token>/<name> answers a playlist
//               rewritten the same way, anything else streamed through (ranges
//               passed on). A token is the target URL signed with a per-process
//               key: nothing else can be asked through it; <name> is the
//               target's file name, unread (players such as ffmpeg judge a
//               segment by its extension). Live playlists are
//               fetched again on every request (nothing cached).
//   l_<32 hex>  a `live` source that is a continuous stream (MPEG-TS): GET
//               /media/l_… is ffmpeg reading it (piped from the plugin's
//               stream) and writing Matroska, video copied, audio AAC; no
//               size, no ranges, one ffmpeg per viewer.
//
// Live viewers (a device watching a live playlist or stream) are counted
// against streaming.maxLive; an HLS viewer counts while it asks for its
// playlist (hls.js does every target duration), a continuous one while its
// answer is open.
//
//   register(plugin, source, { open? }) → entry { ref, format: 'hls' | 'live', … }
//     open: a stream the admin's address gave (lib/live: a channel from a host
//     the admin granted): its parts may come from any public host
//   media(ref) → Promise<Media>        lib/media's resolve for kinds 'hls' / 'live'
//   playlist(req, res, media, token)   GET …/index.m3u8 (token null) and …/r/<token>
//   live(req, res, media, lease)       GET /media/l_…
//   left(ref, deviceId)                the device let go (DELETE /media/{ref})
//   forget(pluginId)

var crypto = require('crypto'),
  spawn = require('child_process').spawn,
  http = require('../plugins/http'),
  refs = require('./refs'),
  settings = require('../settings'),
  ffmpeg = require('../ffmpeg'),
  log = require('../logger').child('plugins');

var TTL_MS = 60 * 60 * 1000,
  MAX = 2000,
  PLAYLIST_MAX = 4 * 1024 * 1024,
  VIEWER_IDLE_MS = 30 * 1000,
  SECRET = crypto.randomBytes(32);

// Tags whose URI attribute names another playlist; every other URI="…" is a
// file (a key, an init segment, a part)
var PLAYLIST_TAGS = ['#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-RENDITION-REPORT'];

var TYPES = {
  ts: 'video/mp2t', m4s: 'video/mp4', mp4: 'video/mp4', m4v: 'video/mp4', m4a: 'audio/mp4', aac: 'audio/aac',
  mp3: 'audio/mpeg', vtt: 'text/vtt', webvtt: 'text/vtt', key: 'application/octet-stream'
};

var entries = new Map(),
  viewers = new Map();   // ref + ' ' + deviceId → { lastSeen, res? }

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
    entries.delete(entries.keys().next().value);
  }
}

// A `live` source is a playlist when it says so, or when its path ends in .m3u8 / .m3u
function isPlaylist(source) {
  if (source.kind === 'hls') {
    return true;
  }
  if (source.format) {
    return source.format === 'hls';
  }
  try {
    return /\.m3u8?$/i.test(new URL(source.url).pathname);
  } catch (e) {
    return false;
  }
}

/**
 * Keeps an hls / live source (already checked: the plugin may use the kind
 * and the host) and answers its entry; the same source keeps its ref.
 */
function register(plugin, source, options) {
  sweep();
  var open = !!(options && options.open),
    playlist = isPlaylist(source),
    id = crypto.createHmac('sha256', SECRET)
      .update(plugin.id + '\n' + source.kind + '\n' + source.url + '\n' + JSON.stringify(source.headers || {}) + (open ? '\nopen' : ''))
      .digest('hex').slice(0, 32),
    entry = entries.get(id);
  if (!entry) {
    entry = {
      id: id,
      ref: playlist ? refs.hls(id) : refs.live(id),
      format: playlist ? 'hls' : 'live',
      // a live playlist: said by the source, else learnt from the playlist (no #EXT-X-ENDLIST)
      live: source.kind === 'live' ? true : source.live === undefined ? null : !!source.live,
      pluginId: plugin.id,
      url: source.url,
      headers: source.headers || {},
      label: source.label,
      open: open,
      name: String(source.label || 'stream').replace(/[\\/\0\r\n]/g, ' ').slice(0, 200),
      usedAt: Date.now()
    };
    entries.set(id, entry);
  }
  entry.usedAt = Date.now();
  return entry;
}

// The plugin its parts are fetched as: an open entry's may come from any public host
function pluginOf(entry) {
  var plugin = require('../plugins').get(entry.pluginId);
  if (!plugin || plugin.state !== 'enabled') {
    return null;
  }
  return entry.open ? Object.assign(Object.create(plugin), { openStream: true }) : plugin;
}

function entryOf(ref) {
  var parsed = refs.parse(ref),
    entry = parsed && (parsed.kind === 'hls' || parsed.kind === 'live') ? entries.get(parsed.id) : null;
  if (!entry || !pluginOf(entry) || Date.now() - entry.usedAt > TTL_MS) {
    return null;
  }
  entry.usedAt = Date.now();
  return entry;
}

/** The Media of an h_ / l_ ref (lib/media); rejects NOT_FOUND (expired, its plugin gone) */
function media(ref) {
  var entry = entryOf(ref);
  if (!entry) {
    return Promise.reject(failure('NOT_FOUND', 'No such media'));
  }
  return Promise.resolve({
    ref: entry.ref,
    kind: entry.format,
    key: entry.ref,
    name: entry.name,
    path: entry.name,
    size: null,
    live: entry.live,
    pluginId: entry.pluginId
  });
}

// ── tokens ─────────────────────────────────────────────────────────────────

function b64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(entry, payload) {
  return b64(crypto.createHmac('sha256', SECRET).update(entry.id + '\n' + payload).digest().subarray(0, 16));
}

// `type` p (a playlist) or s (anything else) + the URL
function tokenOf(entry, type, url) {
  var payload = type + url;
  return b64(Buffer.from(payload, 'utf8')) + '.' + sign(entry, payload);
}

// { type, url } of a token of this entry, else null
function untoken(entry, token) {
  var m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!m) {
    return null;
  }
  var payload = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    expected = Buffer.from(sign(entry, payload)),
    given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given) || !/^[ps]https?:\/\//.test(payload)) {
    return null;
  }
  return { type: payload[0], url: payload.slice(1) };
}

// ── playlists ──────────────────────────────────────────────────────────────

/**
 * A playlist with every URI rewritten to `prefix + token` (absolute or
 * relative to `base`, the URL it was fetched from after redirects).
 * Answers { text, master, live }.
 */
function rewrite(entry, text, base, prefix) {
  var lines = text.replace(/^﻿/, '').split(/\r?\n/),
    master = lines.some(function (l) { return /^#EXT-X-STREAM-INF/.test(l); }),
    ended = lines.some(function (l) { return /^#EXT-X-ENDLIST/.test(l.trim()); });

  function target(uri, type) {
    var url;
    try {
      url = new URL(uri, base);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    url.hash = '';
    return prefix + tokenOf(entry, type, url.toString()) + '/' + named(url);
  }

  // the target's file name after its token: r/<token>/seg1.ts
  function named(url) {
    var last = url.pathname.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '').slice(-64);
    return last && last !== '.' && last !== '..' ? last : 'part';
  }

  var out = lines.map(function (raw) {
    var line = raw.trim();
    if (!line) {
      return '';
    }
    if (line[0] === '#') {
      if (line.indexOf('URI="') === -1) {
        return line;
      }
      var type = PLAYLIST_TAGS.some(function (t) { return line.indexOf(t + ':') === 0; }) ? 'p' : 's';
      return line.replace(/URI="([^"]*)"/g, function (all, uri) {
        var t = target(uri, type);
        return t ? 'URI="' + t + '"' : all;   // data: and other schemes stay as they are
      });
    }
    return target(line, master ? 'p' : 's') || '';
  });
  return { text: out.join('\n') + '\n', master: master, live: !master && !ended };
}

// The upstream answer as a Buffer, ≤ PLAYLIST_MAX
function readAll(r) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    r.body.on('data', function (c) {
      size += c.length;
      if (size > PLAYLIST_MAX) {
        r.abort();
        return reject(new Error('the playlist is larger than 4 MB'));
      }
      chunks.push(c);
    });
    r.body.on('end', function () { resolve(Buffer.concat(chunks)); });
    r.body.on('error', reject);
  });
}

function upstreamFailed(entry, err, res) {
  log.warn('plugin ' + entry.pluginId + ' stream failed: ' + err.message, { plugin: entry.pluginId, code: err.code });
  if (!res.headersSent && !res.destroyed) {
    var gone = err.code === 'NOT_FOUND';
    res.status(gone ? 404 : 502).json({
      error: gone ? 'The stream has no such part (any more)' : 'The plugin\'s stream didn\'t answer: ' + err.message,
      code: gone ? 'NOT_FOUND' : 'UPSTREAM'
    });
  } else {
    res.destroy();
  }
}

function statusError(status) {
  return failure(status === 404 || status === 410 ? 'NOT_FOUND' : 'UPSTREAM', 'HTTP ' + status);
}

// A live viewer (ref + device): false past streaming.maxLive
function admit(entry, deviceId) {
  var now = Date.now(), key = entry.ref + ' ' + deviceId;
  viewers.forEach(function (v, k) {
    if (!v.res && now - v.lastSeen > VIEWER_IDLE_MS) {
      viewers.delete(k);
    }
  });
  var seen = viewers.get(key);
  if (seen) {
    seen.lastSeen = now;
    return true;
  }
  if (viewers.size >= settings.get('streaming.maxLive')) {
    return false;
  }
  viewers.set(key, { lastSeen: now, res: null });
  return true;
}

function busy(res) {
  res.status(503).json({
    error: 'This server already plays ' + settings.get('streaming.maxLive') + ' live streams; try again later',
    code: 'BUSY'
  });
}

/**
 * GET /media/h_…/index.m3u8 (token null) and /media/h_…/r/<token>: a
 * playlist rewritten, or a segment / key / map streamed through.
 */
function playlist(req, res, m, token, deviceId) {
  var entry = entryOf(m.ref),
    plugin = entry && pluginOf(entry);
  if (!entry || entry.format !== 'hls' || !plugin) {
    return res.status(404).json({ error: 'No such media', code: 'NOT_FOUND' });
  }
  var asked = token == null ? { type: 'p', url: entry.url } : untoken(entry, token);
  if (!asked) {
    return res.status(404).json({ error: 'No such part of this stream', code: 'NOT_FOUND' });
  }
  if (asked.type === 's') {
    return segment(req, res, entry, plugin, asked.url);
  }
  if (entry.live === true && !admit(entry, deviceId)) {
    return busy(res);
  }
  http.stream(plugin, { url: asked.url, headers: entry.headers }).then(function (r) {
    if (r.status !== 200) {
      r.abort();
      throw statusError(r.status);
    }
    return readAll(r).then(function (buffer) {
      var text = buffer.toString('utf8');
      if (!/^﻿?#EXTM3U/.test(text)) {
        throw failure('UPSTREAM', 'not an HLS playlist');
      }
      // index.m3u8's parts are r/<token>/<name>; a part's, its siblings (../<token>/<name>)
      var done = rewrite(entry, text, r.url, token == null ? 'r/' : '../');
      if (done.live && entry.live !== true) {
        entry.live = true;
        if (!admit(entry, deviceId)) {
          return busy(res);
        }
      } else if (!done.master && entry.live === null) {
        entry.live = false;
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.end(done.text);
    });
  }).catch(function (err) {
    upstreamFailed(entry, err, res);
  });
}

// A segment, key, init section or part: streamed through, with the viewer's range
function segment(req, res, entry, plugin, url) {
  var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''),
    range = m ? { start: parseInt(m[1], 10), end: m[2] ? parseInt(m[2], 10) : null } : null;
  http.stream(plugin, { url: url, headers: entry.headers, range: range, method: req.method === 'HEAD' ? 'HEAD' : 'GET' }).then(function (r) {
    if (r.status !== 200 && r.status !== 206) {
      r.abort();
      throw statusError(r.status);
    }
    if (res.destroyed) {
      return r.abort();
    }
    var ext = (/\.([a-z0-9]{1,6})$/i.exec(new URL(url).pathname) || [])[1],
      type = String(r.headers['content-type'] || '');
    res.status(r.status);
    res.setHeader('Content-Type', !type || /octet-stream|text\/plain/i.test(type) ? TYPES[String(ext).toLowerCase()] || 'application/octet-stream' : type);
    ['content-length', 'content-range', 'accept-ranges'].forEach(function (h) {
      if (r.headers[h]) {
        res.setHeader(h, r.headers[h]);
      }
    });
    res.setHeader('Cache-Control', 'no-store');
    res.on('close', function () { r.abort(); });
    if (req.method === 'HEAD') {
      r.abort();
      return res.end();
    }
    r.body.on('error', function () { res.destroy(); });
    r.body.pipe(res);
  }).catch(function (err) {
    upstreamFailed(entry, err, res);
  });
}

/**
 * GET /media/l_…: the plugin's continuous stream through ffmpeg, as one
 * Matroska stream (video copied, audio AAC stereo). The same device asking
 * again replaces its previous one (the player reloads).
 */
function live(req, res, m, deviceId) {
  var entry = entryOf(m.ref),
    plugin = entry && pluginOf(entry);
  if (!entry || entry.format !== 'live' || !plugin) {
    return res.status(404).json({ error: 'No such media', code: 'NOT_FOUND' });
  }
  var key = entry.ref + ' ' + deviceId,
    previous = viewers.get(key);
  if (previous && previous.res) {
    previous.res.destroy();
    viewers.delete(key);
  }
  if (!admit(entry, deviceId)) {
    return busy(res);
  }
  var slot = viewers.get(key);
  slot.res = res;
  res.on('close', function () {
    if (viewers.get(key) === slot) {
      viewers.delete(key);
    }
  });
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', 'video/x-matroska');
    return res.end();
  }
  ffmpeg.available().then(function (available) {
    if (!available) {
      throw failure('TRANSCODER_UNAVAILABLE', 'This server has no ffmpeg to play live streams');
    }
    return http.stream(plugin, { url: entry.url, headers: entry.headers });
  }).then(function (r) {
    if (r.status !== 200) {
      r.abort();
      throw statusError(r.status);
    }
    if (res.destroyed) {
      return r.abort();
    }
    var child = spawn(ffmpeg.paths().ffmpeg, ['-v', 'error', '-fflags', '+genpts', '-i', 'pipe:0',
      '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      '-sn', '-dn', '-f', 'matroska', 'pipe:1']);
    child.on('error', function (e) {
      r.abort();
      if (!res.headersSent) {
        res.status(503).json({ error: 'ffmpeg unavailable: ' + e.message, code: 'TRANSCODER_UNAVAILABLE' });
      }
    });
    child.stderr.on('data', function (d) { log.debug('[' + entry.pluginId + '] live: ' + String(d).trim()); });
    child.stdin.on('error', function () {});
    r.body.on('error', function () { child.stdin.destroy(); });
    r.body.pipe(child.stdin);
    res.setHeader('Content-Type', 'video/x-matroska');
    res.setHeader('Cache-Control', 'no-store');
    child.stdout.pipe(res);
    child.on('close', function () { res.end(); });
    res.on('close', function () {
      r.abort();
      child.kill('SIGKILL');
    });
  }).catch(function (err) {
    if (err.code === 'TRANSCODER_UNAVAILABLE') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    upstreamFailed(entry, err, res);
  });
}

/** `deviceId` let go of `ref` (DELETE /media/{ref}): its live slot is free at once */
function left(ref, deviceId) {
  var key = ref + ' ' + deviceId, v = viewers.get(key);
  if (v) {
    if (v.res) {
      v.res.destroy();
    }
    viewers.delete(key);
  }
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
  playlist: playlist,
  live: live,
  left: left,
  forget: forget,
  // tests
  rewrite: rewrite,
  reset: function () {
    entries.clear();
    viewers.clear();
  }
};
