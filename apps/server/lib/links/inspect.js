'use strict';

// What a link is (docs/search-plan.md §4), for the dashboard's Search: the
// admin pastes a URL, the server reads it and says what it is, or, for a web
// page, what it links to: magnets, .torrent files, video files, HLS
// playlists. Video files and playlists become media refs (`r_` / `h_`) the
// admin plays or downloads; the client never needs to reach the URL itself.
//
// Fetched as the core principal LINKS through lib/plugins/http.js (decision
// A): plain http and any port, but public addresses only, every redirect
// checked again (the server sits on the LAN: a pasted link mustn't reach the
// router's admin page). A magnet isn't fetched.
//
//   inspect(url) → Promise<{ url, kind, title, items, truncated }>
//   LINKS: the principal (also the direct downloads' for links)

var http = require('../plugins/http'),
  remote = require('../plugins/remote'),
  hls = require('../media/hls'),
  parseTorrent = require('parse-torrent'),
  htmlParser = require('node-html-parser');

// The core's fetches of links the admin gave: any public host, http too, any port
var LINKS = { id: 'links', core: true, anyHost: true, openStream: true, permissions: {} };

var PAGE_MAX = 2 * 1024 * 1024,
  TORRENT_MAX = 10 * 1024 * 1024,
  ITEMS_MAX = 200,
  VIDEO = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|mpg|mpeg|wmv|flv|ogv)$/i,
  PLAYLIST = /\.m3u8$/i,
  TORRENT = /\.torrent$/i,
  HLS_TYPES = /mpegurl/i,
  MAGNET = /magnet:\?[^\s"'<>`]+/gi,
  M3U8_URL = /https?:\/\/[^\s"'<>`\\]+?\.m3u8(?:\?[^\s"'<>`\\]*)?/gi;

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function unescapeHtml(text) {
  return String(text).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// A magnet's info hash, lowercase hex (base32 converted), else null
function hashOf(magnet) {
  return require('../play/plugins').hashOf({ magnet: magnet });
}

function magnetLabel(magnet, hash) {
  var dn = /[?&]dn=([^&]+)/.exec(magnet);
  try {
    return dn ? decodeURIComponent(dn[1].replace(/\+/g, ' ')).slice(0, 300) : hash;
  } catch (e) {
    return hash;
  }
}

/** The last part of a URL's path, decoded: a file's name */
function fileName(url) {
  try {
    var last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).slice(0, 300);
  } catch (e) {
    return '';
  }
}

function extOf(url) {
  var name = fileName(url), dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return '';
  }
}

// What a URL's name says it is
function kindByName(url) {
  var p = pathOf(url);
  return PLAYLIST.test(p) ? 'hls' : TORRENT.test(p) ? 'torrent' : VIDEO.test(p) ? 'video' : null;
}

// What an answer's type says it is ('page': read it)
function kindByType(type, url) {
  type = String(type || '').split(';')[0].trim().toLowerCase();
  if (HLS_TYPES.test(type)) {
    return 'hls';
  }
  if (type === 'application/x-bittorrent') {
    return 'torrent';
  }
  if (/^video\//.test(type) || type === 'application/mp4' || type === 'video/mp2t') {
    return 'video';
  }
  if (type === 'text/html' || type === 'application/xhtml+xml') {
    return 'page';
  }
  // octet-stream and the like: the name decides
  return kindByName(url) || (/^text\//.test(type) ? 'page' : null);
}

function magnetItem(magnet) {
  var hash = hashOf(magnet);
  return hash ? { kind: 'magnet', label: magnetLabel(magnet, hash), url: magnet, infoHash: hash, size: null, contentType: null } : null;
}

/** A video file or a playlist as an item with its ref */
function mediaItem(kind, url, label, size, contentType) {
  var name = label || fileName(url) || url;
  if (kind === 'hls') {
    return { kind: 'hls', label: name, url: url, ref: hls.register(LINKS, { kind: 'hls', url: url, label: name }).ref,
      size: null, contentType: contentType || null };
  }
  var ext = extOf(url);
  return {
    kind: 'video', label: name, url: url,
    ref: remote.register(LINKS, { kind: 'http', url: url, label: name, size: size || undefined, container: ext || undefined }).ref,
    size: size || null, contentType: contentType || null
  };
}

// Reads an answer's body up to `max` bytes: { buffer, truncated }
function read(answer, max) {
  return new Promise(function (resolve, reject) {
    var chunks = [], total = 0, done = false;
    function finish(truncated) {
      if (!done) {
        done = true;
        resolve({ buffer: Buffer.concat(chunks), truncated: truncated });
      }
    }
    answer.body.on('data', function (chunk) {
      if (done) {
        return;
      }
      if (total + chunk.length > max) {
        chunks.push(chunk.subarray(0, max - total));
        total = max;
        answer.abort();
        return finish(true);
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    answer.body.on('end', function () { finish(false); });
    answer.body.on('error', function (err) {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function sizeOf(headers) {
  var range = /\/(\d+)\s*$/.exec(String(headers['content-range'] || ''));
  var n = range ? parseInt(range[1], 10) : parseInt(headers['content-length'], 10);
  return n > 0 ? n : null;
}

/** A web page's links: magnets, .torrent files, videos, playlists, each once */
function scrape(html, base) {
  // <pre> parsed too: server directory listings put their links in one
  var root = htmlParser.parse(html, { blockTextElements: { script: true, noscript: true, style: true } }),
    items = [], seen = {};

  function absolute(href) {
    try {
      var u = new URL(unescapeHtml(href).trim(), base);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'magnet:' ? u.toString() : null;
    } catch (e) {
      return null;
    }
  }
  function label(text, url) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    // "Download", "torrent", "here": the file's name says more
    var generic = /^(download|torrent|magnet|link|here|click here|watch|play|mirror|direct link|get|\.torrent)\b.{0,12}$/i.test(t);
    return (t && !generic && t.length > 2 && t.length < 300 ? t : '') || fileName(url) || url;
  }
  function add(kind, url, text) {
    if (!url || items.length >= ITEMS_MAX) {
      return;
    }
    var key = kind === 'magnet' ? 'm:' + (hashOf(url) || url) : url;
    if (seen[key]) {
      return;
    }
    seen[key] = true;
    var item = kind === 'magnet' ? magnetItem(url) :
      kind === 'torrent' ? { kind: 'torrent', label: label(text, url), url: url, size: null, contentType: null } :
        mediaItem(kind, url, label(text, url));
    if (item) {
      items.push(item);
    }
  }

  // links, by what they point at
  root.querySelectorAll('a[href]').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (/^magnet:/i.test(href.trim())) {
      return add('magnet', unescapeHtml(href.trim()), null);
    }
    var url = absolute(href), kind = url && kindByName(url);
    if (kind) {
      add(kind, url, a.text || a.getAttribute('title'));
    }
  });
  // players
  root.querySelectorAll('video[src], video source[src], audio source[src], source[src]').forEach(function (el) {
    var url = absolute(el.getAttribute('src')),
      type = el.getAttribute('type') || '';
    if (url) {
      add(HLS_TYPES.test(type) || PLAYLIST.test(pathOf(url)) ? 'hls' : 'video', url, el.getAttribute('title'));
    }
  });
  root.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')
    .forEach(function (m) {
      var url = absolute(m.getAttribute('content'));
      if (url && (kindByName(url) === 'video' || kindByName(url) === 'hls')) {
        add(kindByName(url), url, null);
      }
    });
  // anywhere in the text and scripts: magnets, playlists
  // (scripts write "https:\/\/…" in JSON strings)
  var plain = html.replace(/\\\//g, '/');
  (plain.match(MAGNET) || []).forEach(function (m) { add('magnet', unescapeHtml(m), null); });
  (plain.match(M3U8_URL) || []).forEach(function (u) { add('hls', absolute(u), null); });

  var title = root.querySelector('meta[property="og:title"]'),
    tag = root.querySelector('title');
  return {
    title: ((title && title.getAttribute('content')) || (tag && tag.text) || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    items: items
  };
}

function inspect(given) {
  var text = String(given || '').trim();
  if (/^magnet:/i.test(text)) {
    var item = magnetItem(text);
    return item ? Promise.resolve({ url: text, kind: 'magnet', title: null, items: [item], truncated: false }) :
      Promise.reject(failure('INVALID', 'a magnet link without an info hash'));
  }
  if (/^[0-9a-f]{40}$/i.test(text)) {
    return inspect('magnet:?xt=urn:btih:' + text.toLowerCase());
  }
  if (!/^https?:\/\//i.test(text)) {
    return Promise.reject(failure('INVALID', 'a link: http(s)://… or magnet:…'));
  }
  return http.stream(LINKS, { url: text }).catch(function (err) {
    // the address rules, in words the admin can act on
    if (err.code === 'ADDRESS_NOT_ALLOWED') {
      throw failure('INVALID', 'The server only reads links on the internet, not on this network or this machine');
    }
    if (err.code === 'INVALID' || err.code === 'HTTPS_ONLY') {
      throw failure('INVALID', err.message);
    }
    throw failure('UPSTREAM', 'Could not read the link: ' + err.message);
  }).then(function (answer) {
    var url = answer.url,
      type = answer.headers['content-type'] || null;
    if (answer.status >= 400) {
      answer.abort();
      throw failure('UPSTREAM', 'The link answered HTTP ' + answer.status);
    }
    var kind = kindByType(type, url);
    if (kind === 'video' || kind === 'hls') {
      answer.abort();
      return { url: url, kind: kind, title: null, items: [mediaItem(kind, url, fileName(url), sizeOf(answer.headers), type)], truncated: false };
    }
    if (kind === 'torrent') {
      return read(answer, TORRENT_MAX).then(function (body) {
        var parsed;
        try {
          parsed = parseTorrent(body.buffer);
        } catch (e) {
          throw failure('INVALID', 'Not a .torrent file the server can read');
        }
        return {
          url: url, kind: 'torrent', title: null, truncated: false,
          items: [{ kind: 'torrent', label: parsed.name || fileName(url), url: url, infoHash: parsed.infoHash, size: parsed.length || null, contentType: type }]
        };
      });
    }
    if (kind !== 'page') {
      answer.abort();
      throw failure('INVALID', 'Not a page, a video, a playlist or a torrent (' + (type || 'no type') + ')');
    }
    return read(answer, PAGE_MAX).then(function (body) {
      var page = scrape(body.buffer.toString('utf8'), url);
      return { url: url, kind: 'page', title: page.title, items: page.items, truncated: body.truncated };
    });
  });
}

module.exports = {
  inspect: inspect,
  scrape: scrape,
  LINKS: LINKS
};
