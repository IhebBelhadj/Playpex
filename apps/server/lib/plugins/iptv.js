'use strict';

// Host utilities for live plugins (docs/providers-plan.md §8.1): IPTV files
// are big (a playlist of thousands of channels, a guide of tens of MB), too
// big for the sandbox's 2 s / 64 MB, so the host fetches and parses them.
//
//   iptv.m3u ({ url } | { text })
//     → { channels: [entry], epg: [url], total, truncated }
//       entry: { id, name, url, number?, group?, logo?, tvgId?, tvgName?, country?, language?, userAgent?, referrer? }
//       `id` is stable: the tvg-id when it is unique in the list, else a hash of the name and group (and URL)
//   iptv.xmltv ({ url, channels: [{ id, tvgId?, name? }] (≤ 200), from, to (≤ 48 h) })
//     → { programmes: [programme (live.guide's)], matched }   a channel by its tvg-id, else by its name
//
// Both fetch as the plugin (./http.js#stream: the hosts it declared or the
// admin gave it, the address rules on every hop), gzip allowed (by the
// answer's encoding or the file's first bytes), ≤ 200 MB, cached on disk for
// 6 h per plugin and URL (<cache>/iptv/: an older copy is used when the
// source fails), parsed once (the last few kept in memory). A playlist
// fetched from the admin's address (a url setting with streamHosts) teaches
// ./grants.js the hosts it lists.
//
// Errors: INVALID, UPSTREAM (the source failed and nothing is cached),
// TOO_LARGE, RATE_LIMITED, and ./http.js's (HOST_NOT_ALLOWED…).

var crypto = require('crypto'),
  fs = require('fs'),
  path = require('path'),
  zlib = require('zlib'),
  sax = require('sax'),
  protocol = require('@playpex/protocol/plugins'),
  http = require('./http'),
  grants = require('./grants'),
  paths = require('../paths'),
  RateLimiter = require('./ratelimit'),
  log = require('../logger').child('plugins');

var LIVE = protocol.LIMITS.live,
  TEXT_MAX = 8 * 1024 * 1024,
  PLAYLIST_MAX = 64 * 1024 * 1024,     // decompressed, read as one string
  DECODED_MAX = 1024 * 1024 * 1024,     // a guide, decompressed (parsed as a stream)
  ENTRIES_MAX = 50000,                  // read from a playlist; channels answered: LIVE.channels
  DESCRIPTION_MAX = 600,
  KEEP_BEFORE_MS = 12 * 3600 * 1000,    // a guide keeps programmes from 12 h ago…
  KEEP_AFTER_MS = 8 * 24 * 3600 * 1000, // …to 8 days ahead
  PARSED_KEPT = 3;

var limiter = new RateLimiter(),
  inflight = new Map(),   // download key → Promise
  parsed = [],            // [{ key, value }] newest last
  parsing = new Map();

var testing = { now: null };

function now() {
  return testing.now ? testing.now() : Date.now();
}

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function dir() {
  return path.join(paths.cache, 'iptv');
}

// ── downloads ──────────────────────────────────────────────────────────────

function keyOf(plugin, url) {
  return crypto.createHash('sha1').update(plugin.id + '\n' + url).digest('hex').slice(0, 24);
}

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
  } catch (e) {
    return null;
  }
}

// The answer's first bytes, put back: gzip or not
function sniff(stream) {
  return new Promise(function (ok, fail) {
    function done() {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    }
    function onData(chunk) {
      done();
      stream.pause();
      stream.unshift(chunk);
      ok(chunk);
    }
    function onEnd() {
      done();
      ok(Buffer.alloc(0));
    }
    function onError(err) {
      done();
      fail(err);
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function download(plugin, url, file) {
  var tmp = file + '.' + process.pid + '.part';
  return http.stream(plugin, { url: url, headers: { accept: '*/*' } }).then(function (r) {
    if (r.status !== 200) {
      r.abort();
      throw failure('UPSTREAM', 'HTTP ' + r.status);
    }
    var declared = parseInt(r.headers['content-length'], 10);
    if (declared > LIVE.downloadBytes) {
      r.abort();
      throw failure('TOO_LARGE', 'larger than ' + LIVE.downloadBytes / 1024 / 1024 + ' MB');
    }
    return sniff(r.body).then(function (first) {
      var gzipped = /gzip/i.test(String(r.headers['content-encoding'] || '')) || (first[0] === 0x1f && first[1] === 0x8b);
      return new Promise(function (ok, fail) {
        var received = 0, written = 0, settled = false,
          out = fs.createWriteStream(tmp),
          stream = r.body,
          timer = setTimeout(function () { stop(failure('UPSTREAM', 'not downloaded in ' + LIVE.downloadTimeoutMs / 1000 + ' s')); },
            LIVE.downloadTimeoutMs);
        function stop(err) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          r.abort();
          out.destroy();
          fs.unlink(tmp, function () {});
          fail(err);
        }
        r.body.on('data', function (chunk) {
          received += chunk.length;
          if (received > LIVE.downloadBytes) {
            stop(failure('TOO_LARGE', 'larger than ' + LIVE.downloadBytes / 1024 / 1024 + ' MB'));
          }
        });
        r.body.on('error', function (err) { stop(failure('UPSTREAM', err.message)); });
        if (gzipped) {
          stream = r.body.pipe(zlib.createGunzip());
          stream.on('error', function (err) { stop(failure('INVALID', 'not a gzip file: ' + err.message)); });
        }
        stream.on('data', function (chunk) {
          written += chunk.length;
          if (written > DECODED_MAX) {
            stop(failure('TOO_LARGE', 'larger than ' + DECODED_MAX / 1024 / 1024 + ' MB unpacked'));
          }
        });
        stream.pipe(out);
        out.on('error', function (err) { stop(err); });
        out.on('finish', function () {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          fs.rename(tmp, file, function (err) {
            if (err) {
              return fail(err);
            }
            var meta = { url: url, fetchedAt: now(), size: written };
            fs.writeFile(file + '.json', JSON.stringify(meta), function () { ok(meta); });
          });
        });
      });
    });
  });
}

/** The file of `url` on disk, fresh (≤ 6 h), else downloaded now (an older copy when the source fails) */
function fetchDoc(plugin, url) {
  try {
    http.target(plugin, url, { stream: true });
  } catch (err) {
    return Promise.reject(err);
  }
  var key = keyOf(plugin, url), file = path.join(dir(), key);
  if (inflight.has(key)) {
    return inflight.get(key);
  }
  var meta = readMeta(file);
  if (meta && meta.url === url && now() - meta.fetchedAt < LIVE.cacheMs && fs.existsSync(file)) {
    return Promise.resolve({ file: file, fetchedAt: meta.fetchedAt });
  }
  fs.mkdirSync(dir(), { recursive: true });
  var job = download(plugin, url, file).then(function (m) {
    return { file: file, fetchedAt: m.fetchedAt };
  }, function (err) {
    if (meta && meta.url === url && fs.existsSync(file)) {
      log.warn('[' + plugin.id + '] ' + url.replace(/[?#].*$/, '') + ' not fetched again (' + err.message + '): the copy from ' +
        new Date(meta.fetchedAt).toISOString() + ' is used', { plugin: plugin.id });
      return { file: file, fetchedAt: meta.fetchedAt };
    }
    if (!err.code || err.code === 'NETWORK' || err.code === 'TIMEOUT') {
      err.code = 'UPSTREAM';
    }
    throw err;
  }).finally(function () {
    inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

// Parsed once per file and download
function memo(key, work) {
  var hit = parsed.filter(function (p) { return p.key === key; })[0];
  if (hit) {
    parsed.splice(parsed.indexOf(hit), 1);
    parsed.push(hit);
    return Promise.resolve(hit.value);
  }
  if (parsing.has(key)) {
    return parsing.get(key);
  }
  var job = Promise.resolve().then(work).then(function (value) {
    parsed.push({ key: key, value: value });
    while (parsed.length > PARSED_KEPT) {
      parsed.shift();
    }
    return value;
  }).finally(function () {
    parsing.delete(key);
  });
  parsing.set(key, job);
  return job;
}

// ── M3U ────────────────────────────────────────────────────────────────────

function attributes(text) {
  var out = {}, re = /([A-Za-z0-9_-]+)="([^"]*)"/g, m;
  while ((m = re.exec(text))) {
    out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function webUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(value || '') && value.length <= 4096 ? value : null;
}

function hash(text) {
  return 'm' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function idSafe(value) {
  var id = String(value || '').replace(/[^A-Za-z0-9._:@-]/g, '').slice(0, 100);
  return id || null;
}

/** An M3U (extended or plain) playlist's entries */
function parseM3u(text) {
  var lines = text.replace(/^﻿/, '').split(/\r?\n/),
    entries = [], epg = [], pending = null, total = 0;
  lines.forEach(function (raw) {
    var line = raw.trim();
    if (!line) {
      return;
    }
    if (/^#EXTM3U/i.test(line)) {
      var head = attributes(line);
      [head['url-tvg'], head['x-tvg-url'], head['tvg-url']].forEach(function (v) {
        String(v || '').split(',').forEach(function (u) {
          u = webUrl(u.trim());
          if (u && epg.indexOf(u) === -1) {
            epg.push(u);
          }
        });
      });
      return;
    }
    if (/^#EXTINF:/i.test(line)) {
      // the name is after the last comma outside the attributes' quotes
      var body = line.slice(8), inQuotes = false, comma = -1;
      for (var i = 0; i < body.length; i++) {
        if (body[i] === '"') {
          inQuotes = !inQuotes;
        } else if (body[i] === ',' && !inQuotes) {
          comma = i;
          break;
        }
      }
      var a = attributes(comma === -1 ? body : body.slice(0, comma));
      pending = {
        name: (comma === -1 ? '' : body.slice(comma + 1)).trim(),
        tvgId: a['tvg-id'] || null,
        tvgName: a['tvg-name'] || null,
        logo: webUrl(a['tvg-logo']),
        group: a['group-title'] ? a['group-title'].slice(0, 60) : null,
        number: /^\d{1,5}$/.test(a['tvg-chno'] || a['channel-number'] || '') ? parseInt(a['tvg-chno'] || a['channel-number'], 10) : null,
        country: /^[A-Za-z]{2}$/.test(a['tvg-country'] || '') ? a['tvg-country'].toUpperCase() : null,
        language: a['tvg-language'] || null,
        userAgent: a['http-user-agent'] || a['user-agent'] || null,
        referrer: a['http-referrer'] || a['referrer'] || null
      };
      return;
    }
    if (line[0] === '#') {
      if (!pending) {
        return;
      }
      var m;
      if ((m = /^#EXTGRP:(.*)$/i.exec(line)) && !pending.group) {
        pending.group = m[1].trim().slice(0, 60) || null;
      } else if ((m = /^#EXTVLCOPT:http-user-agent=(.*)$/i.exec(line))) {
        pending.userAgent = m[1].trim();
      } else if ((m = /^#EXTVLCOPT:http-referr?er=(.*)$/i.exec(line))) {
        pending.referrer = m[1].trim();
      }
      return;
    }
    total++;
    var url = webUrl(line), entry = pending || {};
    pending = null;
    if (!url || entries.length >= ENTRIES_MAX) {
      return;
    }
    entry.url = url;
    entry.name = (entry.name || entry.tvgName || decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || '') || 'Channel').slice(0, 100);
    entries.push(entry);
  });

  // stable ids: the tvg-id when unique, else the name and group, else with the URL
  var count = function (list) {
    var c = {};
    list.forEach(function (k) { c[k] = (c[k] || 0) + 1; });
    return c;
  };
  var tvg = count(entries.map(function (e) { return idSafe(e.tvgId) || ''; })),
    named = count(entries.map(function (e) { return e.name + '\n' + (e.group || ''); })),
    seen = {};
  entries.forEach(function (e) {
    var t = idSafe(e.tvgId), id;
    if (t && tvg[t] === 1) {
      id = t;
    } else if (named[e.name + '\n' + (e.group || '')] === 1) {
      id = hash(e.name + '\n' + (e.group || ''));
    } else {
      id = hash(e.name + '\n' + (e.group || '') + '\n' + e.url);
    }
    while (seen[id]) {
      id = hash(id + '+');
    }
    seen[id] = true;
    e.id = id;
    Object.keys(e).forEach(function (k) {
      if (e[k] === null) {
        delete e[k];
      }
    });
  });
  return { entries: entries, epg: epg, total: total };
}

function m3u(plugin, args) {
  if (typeof args.text === 'string') {
    if (Buffer.byteLength(args.text) > TEXT_MAX) {
      return Promise.reject(failure('INVALID', 'text: at most 8 MB (give the url: the host fetches big playlists)'));
    }
    return Promise.resolve(answerM3u(parseM3u(args.text)));
  }
  if (typeof args.url !== 'string') {
    return Promise.reject(failure('INVALID', 'iptv.m3u needs a url or the text'));
  }
  return fetchDoc(plugin, args.url).then(function (doc) {
    return memo('m3u ' + doc.file + ' ' + doc.fetchedAt, function () {
      var size = fs.statSync(doc.file).size;
      if (size > PLAYLIST_MAX) {
        throw failure('TOO_LARGE', 'a playlist of at most ' + PLAYLIST_MAX / 1024 / 1024 + ' MB');
      }
      var text = fs.readFileSync(doc.file, 'utf8');
      if (!/^﻿?\s*(#EXTM3U|#EXTINF|https?:\/\/)/i.test(text.slice(0, 2048))) {
        throw failure('INVALID', 'not an M3U playlist');
      }
      return parseM3u(text);
    }).then(function (list) {
      // the admin's address listed these: they may be streamed from (streamHosts)
      var learned = grants.learn(plugin, args.url, list.entries.map(function (e) { return e.url; })
        .concat(list.entries.map(function (e) { return e.logo; }), list.epg));
      if (learned) {
        log.info('[' + plugin.id + '] ' + learned + ' stream hosts from its playlist', { plugin: plugin.id });
      }
      return answerM3u(list);
    });
  });
}

function answerM3u(list) {
  return {
    channels: list.entries.slice(0, LIVE.channels),
    epg: list.epg,
    total: list.total,
    truncated: list.entries.length > LIVE.channels
  };
}

// ── XMLTV ──────────────────────────────────────────────────────────────────

/** "20261025210000 +0200" → ms (no offset: UTC); NaN when it isn't one */
function xmltvTime(value) {
  var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{2}):?(\d{2}))?/.exec(String(value || '').trim());
  if (!m) {
    return NaN;
  }
  var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)),
    sign = m[7] ? (m[7][0] === '-' ? -1 : 1) : 0,
    offset = m[7] ? sign * (Math.abs(parseInt(m[7], 10)) * 60 + parseInt(m[8] || '0', 10)) : 0;
  return utc - offset * 60000;
}

function normalize(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(hd|fhd|uhd|sd|4k|hevc|h265|h264|backup|\d{3,4}p)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function episodeOf(nums) {
  var onscreen = nums.filter(function (n) { return n.system === 'onscreen'; })[0];
  if (onscreen && onscreen.text) {
    return onscreen.text.slice(0, 30);
  }
  var ns = nums.filter(function (n) { return n.system === 'xmltv_ns'; })[0], m;
  if (ns && (m = /^\s*(\d*)\s*(?:\/\s*\d+)?\s*\.\s*(\d*)/.exec(ns.text))) {
    var s = m[1] === '' ? null : +m[1] + 1, e = m[2] === '' ? null : +m[2] + 1;
    return (s ? 'S' + s + (e ? ' ' : '') : '') + (e ? 'E' + e : '') || null;
  }
  return null;
}

/** A guide file → { ids: Map(id → id), byName: Map(normalized → id), programmes: Map(id → [p]) } */
function parseXmltv(file) {
  return new Promise(function (ok, fail) {
    var parser = sax.createStream(true, { trim: false, normalize: false }),
      index = { ids: new Map(), lower: new Map(), byName: new Map(), programmes: new Map(), count: 0 },
      low = now() - KEEP_BEFORE_MS, high = now() + KEEP_AFTER_MS,
      channel = null, programme = null, field = null, text = '';

    parser.on('opentag', function (node) {
      var name = node.name, a = node.attributes;
      if (name === 'channel' && a.id) {
        channel = { id: String(a.id), names: [] };
        index.ids.set(channel.id, channel.id);
        index.lower.set(channel.id.toLowerCase(), channel.id);
      } else if (name === 'programme' && a.channel) {
        var start = xmltvTime(a.start), stop = xmltvTime(a.stop);
        programme = isFinite(start) && isFinite(stop) && stop > start && stop > low && start < high
          ? { channel: String(a.channel), start: start, end: stop, title: '', nums: [] } : null;
      } else if (programme && (name === 'title' || name === 'sub-title' || name === 'desc' || name === 'category' || name === 'episode-num')) {
        field = { name: name, system: a.system || null };
        text = '';
      } else if (programme && name === 'icon' && a.src && /^https:\/\//.test(a.src) && !programme.image) {
        programme.image = String(a.src).slice(0, 2048);
      } else if (channel && name === 'display-name') {
        field = { name: name };
        text = '';
      }
    });
    parser.on('text', function (t) {
      if (field && text.length < 4000) {
        text += t;
      }
    });
    parser.on('cdata', function (t) {
      if (field && text.length < 4000) {
        text += t;
      }
    });
    parser.on('closetag', function (name) {
      if (field && name === field.name) {
        var value = text.replace(/\s+/g, ' ').trim();
        if (value) {
          if (name === 'display-name' && channel) {
            channel.names.push(value);
          } else if (programme) {
            if (name === 'title' && !programme.title) {
              programme.title = value.slice(0, 200);
            } else if (name === 'sub-title' && !programme.subtitle) {
              programme.subtitle = value.slice(0, 200);
            } else if (name === 'desc' && !programme.description) {
              programme.description = value.length > DESCRIPTION_MAX ? value.slice(0, DESCRIPTION_MAX - 1) + '…' : value;
            } else if (name === 'category' && !programme.category) {
              programme.category = value.slice(0, 60);
            } else if (name === 'episode-num') {
              programme.nums.push({ system: field.system, text: value });
            }
          }
        }
        field = null;
      } else if (name === 'channel' && channel) {
        channel.names.forEach(function (n) {
          var key = normalize(n);
          if (key && !index.byName.has(key)) {
            index.byName.set(key, channel.id);
          }
        });
        channel = null;
      } else if (name === 'programme' && programme) {
        if (programme.title) {
          var ep = episodeOf(programme.nums);
          delete programme.nums;
          if (ep) {
            programme.episode = ep;
          }
          var list = index.programmes.get(programme.channel);
          if (!list) {
            index.programmes.set(programme.channel, list = []);
          }
          list.push(programme);
          index.count++;
        }
        programme = null;
      }
    });
    parser.on('error', function (err) {
      // a broken document: keep what was read
      this._parser.error = null;
      this._parser.resume();
      log.debug('xmltv: ' + err.message);
    });
    parser.on('end', function () {
      index.programmes.forEach(function (list) {
        list.sort(function (a, b) { return a.start - b.start; });
      });
      ok(index);
    });
    var input = fs.createReadStream(file);
    input.on('error', fail);
    input.pipe(parser);
  });
}

function xmltv(plugin, args) {
  var from = Date.parse(args.from), to = Date.parse(args.to),
    asked = Array.isArray(args.channels) ? args.channels : null;
  if (typeof args.url !== 'string') {
    return Promise.reject(failure('INVALID', 'iptv.xmltv needs the guide\'s url'));
  }
  if (!asked || asked.length > LIVE.guideChannels || asked.some(function (c) { return !c || typeof c.id !== 'string'; })) {
    return Promise.reject(failure('INVALID', 'channels: a list (≤ ' + LIVE.guideChannels + ') of { id, tvgId?, name? }'));
  }
  if (!isFinite(from) || !isFinite(to) || to <= from || to - from > LIVE.guideHours * 3600000) {
    return Promise.reject(failure('INVALID', 'from / to: dates, at most ' + LIVE.guideHours + ' h apart'));
  }
  return fetchDoc(plugin, args.url).then(function (doc) {
    return memo('xmltv ' + doc.file + ' ' + doc.fetchedAt, function () { return parseXmltv(doc.file); });
  }).then(function (index) {
    var out = [], matched = 0;
    asked.forEach(function (c) {
      var tvg = typeof c.tvgId === 'string' ? c.tvgId : null,
        id = (tvg && (index.ids.get(tvg) || index.lower.get(tvg.toLowerCase()))) ||
          (c.name && index.byName.get(normalize(c.name))) || (tvg && index.byName.get(normalize(tvg)));
      var list = id && index.programmes.get(id);
      if (!list) {
        return;
      }
      matched++;
      for (var i = 0; i < list.length && out.length < LIVE.programmes; i++) {
        var p = list[i];
        if (p.start >= to) {
          break;
        }
        if (p.end > from) {
          var item = { channel: c.id, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), title: p.title };
          ['subtitle', 'description', 'category', 'episode', 'image'].forEach(function (k) {
            if (p[k]) {
              item[k] = p[k];
            }
          });
          out.push(item);
        }
      }
    });
    return { programmes: out, matched: matched };
  });
}

/**
 * @param {object} plugin  { id, stats, permissions, … }
 */
module.exports = function iptv(plugin) {
  function limited(service, work) {
    plugin.stats.host[service] = (plugin.stats.host[service] || 0) + 1;
    return limiter.acquire(plugin.id + ' ' + service, protocol.LIMITS.core).then(function (release) {
      return Promise.resolve().then(work).then(function (value) {
        release();
        return { value: value };
      }, function (err) {
        release();
        plugin.stats.host[service + '.' + (err.code || 'error')] = (plugin.stats.host[service + '.' + (err.code || 'error')] || 0) + 1;
        throw err;
      });
    });
  }
  return {
    'iptv.m3u': function (args) {
      return limited('iptv', function () { return m3u(plugin, args || {}); });
    },
    'iptv.xmltv': function (args) {
      return limited('iptv', function () { return xmltv(plugin, args || {}); });
    }
  };
};

// tests
module.exports.parseM3u = parseM3u;
module.exports.xmltvTime = xmltvTime;
module.exports.normalize = normalize;
module.exports.configure = function (options) {
  testing = Object.assign({ now: null }, options || {});
};
module.exports.reset = function () {
  parsed = [];
  limiter.reset();
};
