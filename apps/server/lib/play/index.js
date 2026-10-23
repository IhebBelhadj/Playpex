'use strict';

// The play pipeline (docs/media-server-plan.md §6): "what can I play for this
// title", answered in one place for every client (POST /play/sources).
//
//   request ─► collect ─► rank ─► policy ─► { sources, policy, errors }
//
// collect: handlers, each answering Source[] for the title (the core's are in
//   ./handlers.js: library, downloads, yts, episodes); one that fails or runs
//   past its timeout only drops its own sources (named in `errors`).
// rank: one ordering (files on this server first when the profile prefers
//   them, then what plays here, then each kind's own order), after the same
//   file found twice is dropped.
// policy: whether a client may start the top source without asking.
// Plugins (docs/plugins-plan.md, P3) add collect handlers through use() and
// rank handlers later; the core's handlers are written the same way.
//
//   Source = { id, type: 'file' | 'download' | 'torrent', provider, label, quality, size,
//              playable: 'yes' | 'audio-converted' | 'maybe' | 'no', badges[], notes[],
//              ref? (file, download), infoHash? / path? (download, torrent), magnet? (torrent),
//              seeds?, peers?, progress? (download), codec?, audio? }

var path = require('path'),
  ffmpeg = require('../ffmpeg'),
  episodes = require('../episodes'),
  invalid = require('../services/errors').invalid,
  log = require('../logger').child('play');

var collectors = [];

var PLAY_RANK = { yes: 3, 'audio-converted': 2, maybe: 1, no: 0 },
  // a disk file plays at once: the larger the picture the better
  DISK_QUALITY = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, SD: 1 },
  KINDS = ['movie', 'episode'],
  IMDB_ID = /^tt\d{5,10}$/,
  FFMPEG_CHECK_MS = 60 * 1000;

/**
 * Adds a collect handler: { id, order, kinds?: ['movie' | 'episode'],
 * network?: bool, timeoutMs?, run(title, context) → Promise<Source[]> }.
 * Lower `order` runs first (the order sources are listed in before ranking).
 */
function use(handler) {
  collectors = collectors.filter(function (h) { return h.id !== handler.id; }).concat(handler)
    .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * The title asked for, checked; throws INVALID.
 * { kind, tmdbId, imdbId, title, year, season, episode, profileId }
 */
function titleOf(body) {
  body = body || {};
  if (KINDS.indexOf(body.kind) === -1) {
    throw invalid('kind must be one of ' + KINDS.join(', '));
  }
  if (!positiveInt(body.tmdbId)) {
    throw invalid('tmdbId must be a positive integer (an episode: the show\'s)');
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
    throw invalid('title is required (≤ 200 characters)');
  }
  if (body.imdbId != null && !(typeof body.imdbId === 'string' && IMDB_ID.test(body.imdbId))) {
    throw invalid('imdbId must look like tt0123456');
  }
  if (body.year != null && !(Number.isInteger(body.year) && body.year > 1800 && body.year < 3000)) {
    throw invalid('year must be a year');
  }
  if (body.kind === 'episode' && !(Number.isInteger(body.season) && body.season >= 0 && positiveInt(body.episode))) {
    throw invalid('an episode needs season (≥ 0) and episode (≥ 1)');
  }
  if (body.profileId != null && typeof body.profileId !== 'string') {
    throw invalid('profileId must be a string');
  }
  return {
    kind: body.kind,
    tmdbId: body.tmdbId,
    imdbId: body.imdbId || null,
    title: body.title.trim(),
    year: body.year || null,
    season: body.kind === 'episode' ? body.season : null,
    episode: body.kind === 'episode' ? body.episode : null,
    profileId: body.profileId || null
  };
}

// ffmpeg converts audio Chromium can't decode; checked once a minute (it spawns them)
var ffmpegCheck = null;
function ffmpegAvailable() {
  if (!ffmpegCheck || Date.now() - ffmpegCheck.at > FFMPEG_CHECK_MS) {
    ffmpegCheck = {
      at: Date.now(),
      available: ffmpeg.info().then(function (i) { return i.available; }, function () { return false; })
    };
  }
  return ffmpegCheck.available;
}

function withTimeout(promise, ms, id) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(new Error(id + ' took longer than ' + ms / 1000 + ' s')); }, ms);
    })
  ]).then(function (value) {
    clearTimeout(timer);
    return value;
  }, function (err) {
    clearTimeout(timer);
    throw err;
  });
}

function collect(title, context) {
  var errors = [];
  var runs = collectors.filter(function (h) {
    return !h.kinds || h.kinds.indexOf(title.kind) !== -1;
  }).map(function (h) {
    var ms = h.timeoutMs || (h.network ? 10000 : 4000);
    return withTimeout(Promise.resolve().then(function () { return h.run(title, context); }), ms, h.id)
      .then(function (found) {
        // a handler can report trouble without failing (a provider down among two)
        (found && found.errors || []).forEach(function (message) {
          errors.push({ handler: h.id, message: message });
        });
        return (Array.isArray(found) ? found : found && found.sources || []).map(function (s) {
          return Object.assign({ badges: [], notes: [], handler: h.id }, s);
        });
      }, function (err) {
        log.warn('play.collect ' + h.id + ': ' + err.message);
        errors.push({ handler: h.id, message: err.message });
        return [];
      });
  });
  return Promise.all(runs).then(function (lists) {
    return { sources: [].concat.apply([], lists), errors: errors };
  });
}

// The same file twice: a finished download is also a library file (the
// download folder is in the library), a torrent may be a known download
function dedupe(sources) {
  var files = {}, downloads = {};
  sources.forEach(function (s) {
    if (s.type === 'file') {
      files[path.basename(s.label) + ':' + s.size] = true;
    } else if (s.type === 'download') {
      downloads[s.infoHash] = true;
    }
  });
  var seen = {};
  return sources.filter(function (s) {
    var drop = (s.type === 'download' && s.progress === 1 && files[path.basename(s.label) + ':' + s.size]) ||
      (s.type === 'torrent' && downloads[s.infoHash]) || seen[s.id];
    seen[s.id] = true;
    return !drop;
  });
}

function onDisk(s) {
  return s.type === 'file' || (s.type === 'download' && s.progress === 1);
}

// file, then a finished download, then one downloading, then torrents
function group(s) {
  return s.type === 'file' ? 0 : s.type === 'download' ? (s.progress === 1 ? 1 : 2) : 3;
}

function rank(sources, context) {
  var indexed = sources.map(function (s, i) { return { s: s, i: i }; });
  indexed.sort(function (x, y) {
    var a = x.s, b = y.s;
    var local = context.preferLocal ?
      (onDisk(b) && b.playable !== 'no') - (onDisk(a) && a.playable !== 'no') : 0;
    return local ||
      (PLAY_RANK[b.playable] || 0) - (PLAY_RANK[a.playable] || 0) ||
      group(a) - group(b) ||
      (onDisk(a) ? (DISK_QUALITY[b.quality] || 0) - (DISK_QUALITY[a.quality] || 0) || (b.size || 0) - (a.size || 0) : 0) ||
      (a.type === 'download' && group(a) === 2 ? (b.progress || 0) - (a.progress || 0) : 0) ||
      x.i - y.i;   // torrents keep their provider's ranking
  });
  return indexed.map(function (x) { return x.s; });
}

// A lone file on this server that plays: no need to ask
function policy(sources, context) {
  var local = sources.filter(function (s) {
    return onDisk(s) && (s.playable === 'yes' || s.playable === 'audio-converted');
  });
  return { autoplay: context.preferLocal && local.length === 1 && sources[0] === local[0] ? local[0].id : null };
}

/**
 * The sources of a title for a profile, best first.
 * @param {object} body       the request (titleOf)
 * @param {object} services   lib/services
 * @returns {Promise<{ sources, policy: { autoplay: string|null }, errors: [{ handler, message }] }>}
 */
function sources(body, services) {
  return Promise.resolve().then(function () {
    var title = titleOf(body);
    var profile = title.profileId ? services.profiles.get(title.profileId) : Promise.resolve(null),
      settings = title.profileId ? services.settings.profile(title.profileId) : Promise.resolve(null);
    return Promise.all([profile, settings, ffmpegAvailable()]).then(function (r) {
      var context = {
        services: services,
        play: module.exports,
        profile: r[0],
        kid: !!(r[0] && r[0].isKid),
        preferLocal: r[1] ? r[1]['player.preferLocalFiles'] !== false : true,
        ffmpeg: r[2]
      };
      return collect(title, context).then(function (found) {
        var ranked = rank(dedupe(found.sources), context);
        if (ranked.length) {
          ranked[0].badges = ranked[0].badges.concat('best');
        }
        return { sources: ranked, policy: policy(ranked, context), errors: found.errors };
      });
    });
  });
}

/**
 * How a release plays here, from its name (torrents; files without a probe):
 * XviD never, HEVC / 10-bit / 4K maybe (hardware), Dolby / DTS audio
 * converted by ffmpeg, else silent.
 */
function playableByName(name, ffmpegAvailable) {
  var d = episodes.describe(name);
  if (d.codec === 'xvid') {
    return { playable: 'no', notes: ['Won\'t play here (XviD)'], description: d };
  }
  if (!d.playable) {
    return { playable: 'maybe', notes: ['May not play (x265 / 10-bit / 4K)'], description: d };
  }
  if (d.audio === 'unsupported') {
    return ffmpegAvailable ?
      { playable: 'audio-converted', notes: ['Dolby / DTS sound converted by the server'], description: d } :
      { playable: 'no', notes: ['Probably no sound (Dolby / DTS audio)'], description: d };
  }
  return { playable: 'yes', notes: [], description: d };
}

module.exports = {
  use: use,
  sources: sources,
  titleOf: titleOf,
  playableByName: playableByName,
  // tests
  rank: rank,
  dedupe: dedupe,
  policy: policy
};

require('./handlers').register(module.exports);
