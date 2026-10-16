'use strict';

// YouTube trailer streaming through youtubei.js (ESM-only, loaded with dynamic import).
// Resolves a direct googlevideo URL for the requested format, then serves the
// browser's Range requests from it so seeking works without re-encoding.

var rangeParser = require('range-parser');
var log = require('./logger').child('youtube'),
  fail = require('./errors').fail;

var VIDEO_ID = /^[\w-]{11}$/;

// The iOS client currently returns plain, range-capable URLs without a PO token.
// The WEB/ANDROID clients return formats with no usable URL. If trailers break
// again, try another client name from youtubei.js (e.g. 'TV', 'MWEB') here first.
var CLIENT = 'IOS';

// googlevideo URLs expire after ~6h; refetch info well before that
var INFO_TTL = 60 * 60 * 1000;

// googlevideo rejects (403) unbounded or very large ranges, so every response
// is assembled from bounded upstream requests of at most this size
var CHUNK_SIZE = 4 * 1024 * 1024;

var innertube = null;
var infoCache = {};

function getInnertube() {
  if (!innertube) {
    innertube = import('youtubei.js').then(function (m) {
      return m.Innertube.create();
    });
    innertube.catch(function () {
      innertube = null;
    });
  }
  return innertube;
}

function getInfo(id) {
  var cached = infoCache[id];
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }
  var info = getInnertube().then(function (yt) {
    return yt.getBasicInfo(id, { client: CLIENT });
  });
  infoCache[id] = { info: info, expires: Date.now() + INFO_TTL };
  info.catch(function () {
    delete infoCache[id];
  });
  return info;
}

function isMp4(format, kind) {
  return format.mime_type && format.mime_type.indexOf(kind + '/mp4') === 0;
}

// type: 'video' | 'audio' | anything else (muxed video+audio)
// quality: optional itag, e.g. '136' (720p H.264) or '140' (AAC)
function chooseFormat(info, type, quality) {
  var streaming = info.streaming_data || {};
  var adaptive = streaming.adaptive_formats || [];
  var itag = Number(quality);

  if (type == 'video' || type == 'audio') {
    var exact = itag && adaptive.find(function (f) {
      return f.itag === itag;
    });
    if (exact) {
      return exact;
    }
    // Prefer H.264 / AAC in mp4, which Chromium always plays
    var candidates = adaptive.filter(function (f) {
      return isMp4(f, type) && f.content_length;
    });
    candidates.sort(function (a, b) {
      return type == 'video'
        ? (b.height || 0) - (a.height || 0)
        : (b.bitrate || 0) - (a.bitrate || 0);
    });
    var avc = candidates.find(function (f) {
      return type == 'audio' || f.mime_type.indexOf('avc1') !== -1;
    });
    if (avc || candidates[0]) {
      return avc || candidates[0];
    }
    return info.chooseFormat({ type: type, quality: 'best', format: 'mp4' });
  }

  return info.chooseFormat({ type: 'video+audio', quality: 'best' });
}

function resolve(id, type, quality) {
  return Promise.all([getInnertube(), getInfo(id)]).then(function (results) {
    var yt = results[0];
    var format = chooseFormat(results[1], type, quality);
    return Promise.resolve(format.decipher(yt.session.player)).then(function (url) {
      return {
        url: url,
        mimeType: (format.mime_type || 'video/mp4').split(';')[0],
        length: format.content_length
      };
    });
  });
}

function fetchChunk(url, start, end) {
  return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
}

function waitForDrain(res) {
  return new Promise(function (resolve) {
    function done() {
      res.removeListener('drain', done);
      res.removeListener('close', done);
      resolve();
    }
    res.on('drain', done);
    res.on('close', done);
  });
}

// Writes [start, end] to res, fetching upstream chunk by chunk. `first` is the
// already-fetched response for the first chunk.
async function writeChunks(url, start, end, first, res) {
  var upstream = first;
  for (var pos = start; pos <= end; pos += CHUNK_SIZE) {
    if (!upstream) {
      upstream = await fetchChunk(url, pos, Math.min(pos + CHUNK_SIZE - 1, end));
      if (!upstream.ok) {
        throw new Error('youtube upstream responded ' + upstream.status);
      }
    }
    for await (var piece of upstream.body) {
      if (res.destroyed) {
        return;
      }
      if (!res.write(piece)) {
        await waitForDrain(res);
      }
    }
    upstream = null;
  }
  res.end();
}

function stream(req, res, type, retried) {
  var id = req.params.videoId;

  if (!VIDEO_ID.test(id)) {
    return fail(res, 'NOT_FOUND', 'Not a YouTube video id');
  }

  return resolve(id, type, req.query.quality)
    .then(function (format) {
      var total = Number(format.length);
      if (!total) {
        throw new Error('format has no content length');
      }

      var range = req.headers.range && rangeParser(total, req.headers.range)[0];
      if (req.headers.range && !range) {
        res.setHeader('Content-Range', 'bytes */' + total);
        return res.sendStatus(416);
      }
      var start = range ? range.start : 0;
      var end = range ? range.end : total - 1;

      if (req.method === 'HEAD') {
        res.setHeader('Accept-Ranges', 'bytes');
        res.type(format.mimeType);
        res.setHeader('Content-Length', total);
        return res.end();
      }

      // Fetch the first chunk before sending headers so a stale URL can be retried
      return fetchChunk(format.url, start, Math.min(start + CHUNK_SIZE - 1, end)).then(function (first) {
        if (first.status === 403 && !retried) {
          delete infoCache[id];
          first.body && first.body.cancel();
          return stream(req, res, type, true);
        }
        if (!first.ok) {
          first.body && first.body.cancel();
          throw new Error('youtube upstream responded ' + first.status);
        }

        res.statusCode = range ? 206 : 200;
        res.setHeader('Accept-Ranges', 'bytes');
        res.type(format.mimeType);
        res.setHeader('Content-Length', end - start + 1);
        if (range) {
          res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
        }
        req.socket.setTimeout(3600000);

        return writeChunks(format.url, start, end, first, res);
      });
    })
    .catch(function (err) {
      log.warn('youtube ' + id + ': ' + err.message);
      if (!res.headersSent) {
        fail(res, 'NOT_FOUND', 'Trailer unavailable');
      } else {
        res.destroy();
      }
    });
}

module.exports = {
  stream: stream
};
