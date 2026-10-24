'use strict';

// The play pipeline (docs/media-server-plan.md §6): "what can I play for this
// title", answered in one place for every client (POST /play/sources).
//
//   request ─► collect ─► dedupe ─► resolve check ─► rank ─► play.rank ─► policy
//           ─► groups ─► { request, sources, groups, hidden, policy, errors }
//   start { request, source, confirmed? } ─► play.before ─► play.resolve
//           ─► { action: 'play', source } | { action: 'ask', … } | { action: 'refuse', … }
//
// collect: handlers, each answering Source[] for the title (the core's are in
//   ./handlers.js: library, downloads, yts, episodes); one that fails or runs
//   past its timeout only drops its own sources (named in `errors`).
// rank: one ordering (files on this server first when the profile prefers
//   them, then what plays here, then each kind's own order), after the same
//   file found twice is dropped.
// groups: the ways to play, in a fixed order (docs/providers-plan.md §5.1):
//   server (a library file, a download), stream (a plugin's stream, a torrent
//   a resolver plays at once), torrent; each source says its group and how
//   soon it plays (`readiness`), each group its best source and count.
// policy: whether a client may start the top source without asking.
// Plugins (docs/plugins-plan.md §4.3, P3; ./plugins.js) add a collect
// handler, mark torrents a resolver serves (`cached`), reorder and hide
// (`hidden`, with their reasons), and at start() may ask, refuse or resolve.
// The core's handlers are written the way a plugin's are.
//
//   Source = { id, type: 'file' | 'download' | 'torrent' | 'plugin', provider, label, quality, size,
//              playable: 'yes' | 'audio-converted' | 'maybe' | 'no', badges[], notes[],
//              ref? (file, download, plugin), infoHash? / path? (download, torrent), magnet? (torrent),
//              seeds?, peers?, progress? (download), codec?, audio?, plugin? (a plugin's),
//              resolver? { plugin, label } (a torrent a plugin serves at once),
//              file? { name?, index? } (torrent: the file a plugin named),
//              group: 'server' | 'stream' | 'torrent', readiness: 'instant' | 'seconds' | 'slow' | 'unknown' }

var path = require('path'),
  ffmpeg = require('../ffmpeg'),
  names = require('../media/names'),
  serviceErrors = require('../services/errors'),
  invalid = serviceErrors.invalid,
  notFound = serviceErrors.notFound,
  log = require('../logger').child('play');

var collectors = [],
  // the answers start() picks from: request id → { title, sources, context, at }
  requests = new Map(),
  REQUEST_TTL_MS = 30 * 60 * 1000,
  REQUESTS_MAX = 200;

var PLAY_RANK = { yes: 3, 'audio-converted': 2, maybe: 1, no: 0 },
  // a disk file plays at once: the larger the picture the better
  DISK_QUALITY = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, SD: 1 },
  KINDS = ['movie', 'episode'],
  IMDB_ID = /^tt\d{5,10}$/,
  GROUPS = ['server', 'stream', 'torrent'],
  HEALTHY_SEEDS = 10;

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
        (found && found.errors || []).forEach(function (e) {
          errors.push(typeof e === 'string' ? { handler: h.id, message: e } : e);
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

// file, then a finished download, then one downloading, then what plays at
// once from elsewhere (a plugin's http source, a torrent a resolver has), then torrents
function group(s) {
  return s.type === 'file' ? 0 : s.type === 'download' ? (s.progress === 1 ? 1 : 2) :
    s.type === 'plugin' || s.resolver ? 3 : 4;
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

function groupOf(s) {
  return s.type === 'file' || s.type === 'download' ? 'server' : s.type === 'plugin' || s.resolver ? 'stream' : 'torrent';
}

// How soon it plays: on disk or a stream at once; a torrent with a healthy
// swarm in seconds, with few people sharing slowly; a download still running
// depends on its swarm too, which the source doesn't carry
function readinessOf(s) {
  if (onDisk(s) || s.type === 'plugin' || s.resolver) {
    return 'instant';
  }
  if (s.type === 'download') {
    return s.state === 'downloading' ? 'seconds' : 'unknown';
  }
  if (s.seeds === null || s.seeds === undefined) {
    return 'unknown';
  }
  return s.seeds >= HEALTHY_SEEDS ? 'seconds' : 'slow';
}

// Each ranked source's group and readiness; each group's best (its first) and count
function groups(sources) {
  var found = {};
  sources.forEach(function (s) {
    s.group = groupOf(s);
    s.readiness = readinessOf(s);
    if (!found[s.group]) {
      found[s.group] = { group: s.group, best: s.id, count: 0, readiness: s.readiness };
    }
    found[s.group].count++;
  });
  return GROUPS.filter(function (g) { return found[g]; }).map(function (g) { return found[g]; });
}

function plays(s) {
  return s.playable === 'yes' || s.playable === 'audio-converted';
}

// No need to ask: a lone file on this server that plays (when the profile
// prefers them), else the best of the group the profile always plays from
// (setting player.autoplayKind), when it plays
function policy(sources, context, found) {
  var local = sources.filter(function (s) { return onDisk(s) && plays(s); });
  if (context.preferLocal && local.length === 1 && sources[0] === local[0]) {
    return { autoplay: local[0].id };
  }
  var kind = (found || []).filter(function (g) { return g.group === context.autoplayKind; })[0],
    best = kind && sources.filter(function (s) { return s.id === kind.best; })[0];
  return { autoplay: best && plays(best) ? best.id : null };
}

function remember(answer, title, context) {
  var now = Date.now();
  requests.forEach(function (r, id) {
    if (now - r.at > REQUEST_TTL_MS) {
      requests.delete(id);
    }
  });
  while (requests.size >= REQUESTS_MAX) {
    requests.delete(requests.keys().next().value);
  }
  var id = bridge().requestId();
  requests.set(id, { title: title, sources: answer.sources, context: context, at: now });
  return id;
}

function bridge() {
  return require('./plugins');
}

/**
 * The context of a request: the profile's rules and the plugins' ctx.
 * options: { device: { id, name }, locale } (the route's caller)
 */
function contextOf(title, services, options) {
  options = options || {};
  var profile = title.profileId ? services.profiles.get(title.profileId) : Promise.resolve(null),
    settings = title.profileId ? services.settings.profile(title.profileId) : Promise.resolve(null);
  return Promise.all([profile, settings, ffmpeg.available()]).then(function (r) {
    return {
      services: services,
      play: module.exports,
      profile: r[0],
      kid: !!(r[0] && r[0].isKid),
      preferLocal: r[1] ? r[1]['player.preferLocalFiles'] !== false : true,
      autoplayKind: r[1] && r[1]['player.autoplayKind'] || 'ask',
      ffmpeg: r[2],
      pluginContext: {
        profile: r[0] ? { id: r[0].id, kids: !!r[0].isKid } : null,
        device: options.device ? { id: String(options.device.id), name: String(options.device.name || '') } : null,
        locale: options.locale || 'en'
      }
    };
  });
}

/**
 * The sources of a title for a profile, best first.
 * @param {object} body       the request (titleOf)
 * @param {object} services   lib/services
 * @param {object} [options]  { device, locale }: who asks (plugins' context)
 * @returns {Promise<{ request, sources, groups: [{ group, best, count, readiness }], hidden, policy: { autoplay: string|null }, errors: [{ handler, message }] }>}
 */
function sources(body, services, options) {
  return Promise.resolve().then(function () {
    var title = titleOf(body);
    return contextOf(title, services, options).then(function (context) {
      var errors;
      return collect(title, context).then(function (found) {
        errors = found.errors;
        var unique = dedupe(found.sources);
        return bridge().check(unique, context).then(function (more) {
          errors = errors.concat(more);
          return bridge().rank(title, rank(unique, context), context);
        });
      }).then(function (ranked) {
        var list = ranked.sources;
        errors = errors.concat(ranked.errors);
        if (list.length) {
          list[0].badges = list[0].badges.concat('best');
        }
        var found = groups(list),
          answer = { sources: list, groups: found, hidden: ranked.hidden, policy: policy(list, context, found), errors: errors };
        answer.request = remember(answer, title, context);
        return answer;
      });
    });
  });
}

/**
 * What to play of a sources answer: the chosen source through the plugins'
 * play.before (ask, refuse) and, for a torrent a resolver has, play.resolve.
 * body: { request, source: <source id>, confirmed?: true (the user said yes to a question) }
 * @returns {Promise<{ action: 'play', source } | { action: 'ask', question, yes, no, by } | { action: 'refuse', reason, by }>}
 */
function start(body) {
  return Promise.resolve().then(function () {
    body = body || {};
    if (typeof body.request !== 'string' || typeof body.source !== 'string') {
      throw invalid('request and source are required');
    }
    var asked = requests.get(body.request);
    if (!asked || Date.now() - asked.at > REQUEST_TTL_MS) {
      throw notFound('These sources are too old: ask for them again');
    }
    var source = asked.sources.filter(function (s) { return s.id === body.source; })[0];
    if (!source) {
      throw notFound('No such source in this answer');
    }
    return bridge().before(asked.title, source, asked.context, body.confirmed === true).then(function (stop) {
      if (stop) {
        return stop;
      }
      return (source.resolver ? bridge().resolve(asked.title, source, asked.context) : Promise.resolve(source)).then(function (played) {
        return { action: 'play', source: played };
      });
    });
  });
}

/**
 * Markers of what plays (player.markers): { markers: [{ plugin, kind, start, end?, label? }] }
 * body: the title (as sources) + { duration (s), fileName?, size? }
 */
function markers(body, services, options) {
  return Promise.resolve().then(function () {
    var title = titleOf(body);
    if (typeof body.duration !== 'number' || !(body.duration > 0) || body.duration > 100 * 3600) {
      throw invalid('duration must be the video\'s length in seconds');
    }
    if (body.fileName != null && typeof body.fileName !== 'string') {
      throw invalid('fileName must be a string');
    }
    if (body.size != null && !(Number.isInteger(body.size) && body.size >= 0)) {
      throw invalid('size must be a number of bytes');
    }
    return contextOf(title, services, options).then(function (context) {
      return bridge().markers(title, { duration: body.duration, fileName: body.fileName, size: body.size }, context);
    }).then(function (list) {
      return { markers: list };
    });
  });
}

/**
 * How a release plays here, from its name (torrents; files without a probe):
 * XviD never, HEVC / 10-bit / 4K maybe (hardware), Dolby / DTS audio
 * converted by ffmpeg, else silent.
 */
function playableByName(name, ffmpegAvailable) {
  var d = names.describe(name);
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
  start: start,
  markers: markers,
  titleOf: titleOf,
  playableByName: playableByName,
  // tests
  rank: rank,
  dedupe: dedupe,
  groups: groups,
  policy: policy
};

require('./handlers').register(module.exports);
require('./plugins').register(module.exports);
