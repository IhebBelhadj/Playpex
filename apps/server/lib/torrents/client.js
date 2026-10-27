'use strict';

// The torrent client (docs/media-server-plan.md §4): every torrent the server
// knows is a **download**, persisted in the `downloads` table whether it runs
// or not, with a state and an intent:
//
//   intent  stream     a client watches it; it pauses when the last one leaves
//           download   someone wants it finished; it runs without clients
//   state   queued · downloading · seeding · checking   (running: "active")
//           paused · completed · error                   (stopped, data kept)
//
// The only user of the engine port (./port.js), through the registry
// (./engines); routes, sessions and the dashboard see info hashes, file paths
// and our states, whatever the engine. Data is deleted only by remove().
//
//   init({ dataDir, stateDir, configDir, engine?, engineOptions? }) / close()
//   add(link | .torrent Buffer, { intent, by, profileId, files }) → infoHash
//   prepareStream(hash, path) / stream(hash, path, range) / prefetchTail(hash, path)
//   pause · start · resume · select · remove · released (the last lease went)
//   pauseAll / resumeAll (downloads.paused) · requeue (a stream needs the slot)
//   moveInQueue · setForce · setSeedGoal · setTorrentLimits · editTrackers · reannounce
//   get / list / files / torrent / torrentStats / totals / info / torrentFile
//
// Limits: `downloads.maxActive` download-intent torrents run at once (the
// others wait, `queued`, in the admin's order, then oldest first); a force
// started one runs past it; all active torrents together stay under
// `streaming.maxTorrents`: a stream past it asks the admission hook
// (lib/sessions.js#canAdd), which makes room or answers BUSY.
//
// Trackers: a torrent's own, the server's (lib/trackers.js) and the admin's,
// less the ones the admin removed (`trackers` of the row). Every 30 minutes
// they are scraped (./scrape.js, whatever the engine): the swarm's seeds and
// leechers.
//
// Events (lib/events.js): download.added, download.updated (state changes at
// once, progress at most every POLL_MS), download.removed.

var fs = require('fs'),
  path = require('path'),
  readTorrent = require('read-torrent'),
  parseTorrent = require('parse-torrent'),
  bncode = require('bncode'),
  protocol = require('@playpex/protocol'),
  engines = require('./engines'),
  errors = require('./errors'),
  peerid = require('./peerid'),
  files = require('./files'),
  scraper = require('./scrape'),
  trackers = require('../trackers'),
  refs = require('../media/refs'),
  mediaFiles = require('../media/files'),
  progressbar = require('../progressbar'),
  settings = require('../settings'),
  events = require('../events'),
  userData = require('../userData'),
  log = require('../logger').child('torrent');

var SPEED_SAMPLES = 300,  // 10 minutes of polls
  READ_AHEAD = 16 * 1024 * 1024,   // what a player is about to read, past its position
  POLL_MS = 2000,
  PERSIST_MS = 30 * 1000,
  SCRAPE_MS = 30 * 60 * 1000,      // every download's trackers
  SCRAPE_FIRST_MS = 60 * 1000,     // after the start
  SCRAPE_STALE_MS = 5 * 60 * 1000, // the Trackers tab asks again past this
  SCRAPE_PARALLEL = 8,             // trackers asked at once
  TAIL_BYTES = 2 * 1024 * 1024,
  ACTIVE = ['checking', 'downloading', 'seeding'],
  HASH = /^[0-9a-f]{40}$/;

var engine = null,
  caps = {},
  engineInfo = { id: null, requested: null, error: null },
  downloads = {},        // infoHash → d (below)
  ready = Promise.resolve(),
  pollTimer = null,
  scrapeTimer = null,
  scraping = null,       // the running scrape (a Promise)
  discovery = true,      // false: no tracker is ever asked (tests)
  lastPersist = 0,
  admission = null,      // hash → Error | null (lib/sessions.js#canAdd)
  store = null,          // services.downloads, null without a database
  saveDir = null,
  torrentDir = null;

// d = { row (the `downloads` row), meta ({ name, length, pieceLength, files } | null),
//       live (the engine's last stats while active), inEngine, counters ({ up, down }:
//       the engine's last counters), seedingSince, tails ({ path: true }: tail read),
//       op (engine calls run one at a time per torrent), dirty, published,
//       own (its own trackers, cached), scrape ({ url: { seeds, peers, downloaded, at, error } }) }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function isActive(d) {
  return ACTIVE.indexOf(d.row.state) !== -1;
}

function isDone(d) {
  return !!d.row.sizeBytes && d.row.doneBytes >= d.row.sizeBytes;
}

function find(hash) {
  var d = typeof hash === 'string' && downloads[hash.toLowerCase()];
  if (!d) {
    throw failure('NOT_FOUND', 'No such torrent: ' + hash);
  }
  return d;
}

// Engine calls of one torrent, one after the other; the answer of `fn`
function serial(d, fn) {
  var result = d.op.then(fn);
  d.op = result.catch(function () {});
  return result;
}

// ── persistence ────────────────────────────────────────────────────────────

function persist(d, fields) {
  Object.assign(d.row, fields);
  if (store) {
    store.update(d.row.infoHash, fields).catch(function (err) {
      log.warn('cannot save download ' + d.row.infoHash + ': ' + err.message);
    });
  }
}

function flush() {
  lastPersist = Date.now();
  return Promise.all(Object.keys(downloads).map(function (hash) {
    var d = downloads[hash];
    if (!d.dirty || !store) {
      return null;
    }
    d.dirty = false;
    return store.update(hash, {
      doneBytes: d.row.doneBytes, sizeBytes: d.row.sizeBytes, uploadedBytes: d.row.uploadedBytes,
      lastActiveAt: d.row.lastActiveAt
    }).catch(function (err) {
      log.warn('cannot save download ' + hash + ': ' + err.message);
    });
  }));
}

function torrentFilePath(hash) {
  return path.join(torrentDir, hash + '.torrent');
}

function readTorrentFile(d) {
  try {
    return d.row.torrentFile ? fs.readFileSync(d.row.torrentFile) : null;
  } catch (e) {
    return null;
  }
}

function metaOf(parsed) {
  return {
    name: parsed.name,
    length: parsed.length,
    pieceLength: parsed.pieceLength,
    files: parsed.files.map(function (f) { return { path: f.path, size: f.length, offset: f.offset }; })
  };
}

// Keeps the metainfo (<config>/torrents/<hash>.torrent): with it and the row,
// any engine can take the torrent again
function saveTorrentFile(d, buffer) {
  var file = torrentFilePath(d.row.infoHash);
  try {
    fs.mkdirSync(torrentDir, { recursive: true });
    fs.writeFileSync(file, buffer);
    return file;
  } catch (e) {
    log.warn('cannot keep the .torrent of ' + d.row.infoHash + ': ' + e.message);
    return null;
  }
}

// ── trackers ───────────────────────────────────────────────────────────────

function unique(list) {
  return list.filter(function (url, i) { return url && list.indexOf(url) === i; });
}

// The admin's edits: { added, removed }
function edits(d) {
  var t = d.row.trackers;
  return { added: (t && Array.isArray(t.added)) ? t.added : [], removed: (t && Array.isArray(t.removed)) ? t.removed : [] };
}

// The torrent's own announce URLs (its .torrent, its magnet)
function ownTrackers(d) {
  if (!d.own) {
    var own = [];
    try {
      var buffer = readTorrentFile(d);
      own = own.concat(buffer ? parseTorrent(buffer).announce || [] : []);
    } catch (e) { /* unreadable: none */ }
    try {
      own = own.concat(d.row.magnet ? parseTorrent(d.row.magnet).announce || [] : []);
    } catch (e) { /* none */ }
    d.own = unique(own);
  }
  return d.own;
}

// What the torrent announces to: its own, the server's, the admin's, less
// the removed ones
function trackerList(d) {
  var e = edits(d);
  return unique(ownTrackers(d).concat(trackers.list, e.added)).filter(function (url) { return e.removed.indexOf(url) === -1; });
}

// The .torrent an engine gets: its announce list is ours (an engine adds a
// file's own trackers to the ones it is given: removed ones stay out)
function torrentFileFor(d) {
  var buffer = readTorrentFile(d);
  if (!buffer || !edits(d).removed.length) {
    return buffer;
  }
  try {
    var decoded = bncode.decode(buffer);
    return bncode.encode({ info: decoded.info, 'announce-list': trackerList(d).map(function (url) { return [url]; }) });
  } catch (e) {
    return buffer;
  }
}

function magnetFor(d) {
  var removed = edits(d).removed;
  if (!d.row.magnet || !removed.length) {
    return d.row.magnet;
  }
  return d.row.magnet.split('&').filter(function (part) {
    return !/^tr=/i.test(part) || removed.indexOf(decodeURIComponent(part.slice(3))) === -1;
  }).join('&');
}

// The most seeds and leechers any tracker counted (a scrape), or null
function swarmOf(d) {
  var best = null;
  Object.keys(d.scrape || {}).forEach(function (url) {
    var s = d.scrape[url];
    if (s.error || s.seeds === null) {
      return;
    }
    if (!best || s.seeds + (s.peers || 0) > best.seeds + best.peers) {
      best = { seeds: s.seeds, peers: s.peers || 0, at: s.at };
    }
  });
  return best ? { seeds: best.seeds, peers: best.peers, at: new Date(best.at).toISOString() } : null;
}

// ── views ──────────────────────────────────────────────────────────────────

function iso(date) {
  return date ? new Date(date).toISOString() : null;
}

var PIECE_MAP_SLICES = 100;

// The swarm strip's data (dashboard plan §3.3): the torrent cut into up to
// 100 slices, each the share of its pieces verified (0–255), base64. The last
// pieces the engine reported are kept while the torrent is stopped; a
// completed one without them is full.
function pieceMap(d) {
  var pieces = d.pieces;
  if (!pieces || !pieces.length) {
    return isDone(d) ? doneMap(d) : null;
  }
  var n = Math.min(PIECE_MAP_SLICES, pieces.length), out = Buffer.alloc(n);
  for (var i = 0; i < n; i++) {
    var from = Math.floor(i * pieces.length / n), to = Math.floor((i + 1) * pieces.length / n), have = 0;
    for (var j = from; j < to; j++) {
      have += pieces[j] ? 1 : 0;
    }
    out[i] = Math.round(have / Math.max(1, to - from) * 255);
  }
  return out.toString('base64');
}

// A finished download the engine reported no pieces of (done before a poll,
// or after a restart): its selected files' bytes are there, the rest not
function doneMap(d) {
  if (!d.meta || !d.meta.length) {
    return Buffer.from([255]).toString('base64');
  }
  var n = PIECE_MAP_SLICES, out = Buffer.alloc(n), length = d.meta.length, chosen = selectedOf(d);
  for (var i = 0; i < n; i++) {
    var from = i * length / n, to = (i + 1) * length / n, have = 0;
    chosen.forEach(function (f) {
      have += Math.max(0, Math.min(to, f.offset + f.size) - Math.max(from, f.offset));
    });
    out[i] = Math.round(have / (to - from) * 255);
  }
  return out.toString('base64');
}

// The queue's order: the admin's (queueOrder), then the others oldest first
function queueCompare(a, b) {
  var qa = a.row.queueOrder === null || a.row.queueOrder === undefined ? Infinity : a.row.queueOrder,
    qb = b.row.queueOrder === null || b.row.queueOrder === undefined ? Infinity : b.row.queueOrder;
  return qa !== qb ? (qa < qb ? -1 : 1) : a.row.addedAt - b.row.addedAt;
}

function queued() {
  return Object.keys(downloads).map(function (h) { return downloads[h]; })
    .filter(function (d) { return d.row.state === 'queued'; }).sort(queueCompare);
}

// 1-based place in the download queue (the order pump() starts them in)
function queuePosition(d) {
  return d.row.state === 'queued' ? queued().indexOf(d) + 1 : null;
}

// The API's Download
function view(d) {
  var r = d.row, live = isActive(d) ? d.live : null;
  return {
    infoHash: r.infoHash,
    name: r.name,
    state: r.state,
    intent: r.intent,
    error: r.error,
    sizeBytes: r.sizeBytes,
    doneBytes: r.doneBytes,
    progress: r.sizeBytes ? Math.min(1, r.doneBytes / r.sizeBytes) : null,
    uploadedBytes: r.uploadedBytes,
    ratio: r.sizeBytes ? Math.round(r.uploadedBytes / r.sizeBytes * 100) / 100 : null,
    downloadSpeed: live ? live.downBps : 0,
    uploadSpeed: live ? live.upBps : 0,
    peers: live ? live.peers : 0,
    seeds: live ? live.seeds : 0,
    eta: live && live.downBps > 0 && r.sizeBytes ? Math.round((r.sizeBytes - r.doneBytes) / live.downBps) : null,
    checking: live && live.checking && live.checking.total ? live.checking.done / live.checking.total : null,
    fileCount: d.meta ? d.meta.files.length : null,
    selectedFiles: r.selectedFiles,
    title: r.titleRef,
    addedBy: r.addedBy,
    profileId: r.profileId,
    removeWhenWatched: !!r.removeWhenWatched,
    label: r.label || null,
    queuePosition: queuePosition(d),
    forced: !!r.forced,
    seedRatio: r.seedRatio === undefined ? null : r.seedRatio,
    seedMinutes: r.seedMinutes === undefined ? null : r.seedMinutes,
    downLimitKBps: r.downLimitKBps || null,
    upLimitKBps: r.upLimitKBps || null,
    swarm: swarmOf(d),
    pieceMap: pieceMap(d),
    savePath: r.name ? path.join(r.saveDir, r.name) : r.saveDir,
    addedAt: iso(r.addedAt),
    completedAt: iso(r.completedAt),
    lastActiveAt: iso(r.lastActiveAt)
  };
}

function publishUpdate(d, force) {
  var v = view(d),
    key = [v.state, v.error, v.doneBytes, v.uploadedBytes, v.downloadSpeed, v.uploadSpeed, v.peers, v.checking, v.name,
      v.intent, JSON.stringify(v.selectedFiles), JSON.stringify(v.title), v.removeWhenWatched, v.label, v.queuePosition,
      v.forced, v.seedRatio, v.seedMinutes, v.downLimitKBps, v.upLimitKBps, JSON.stringify(v.swarm), v.pieceMap].join('|');
  if (force || key !== d.published) {
    d.published = key;
    events.publish('download.updated', v);
  }
}

function selectedOf(d) {
  return d.meta ? d.meta.files.filter(function (f) {
    return !d.row.selectedFiles || d.row.selectedFiles.indexOf(f.path) !== -1;
  }) : [];
}

// ── states ─────────────────────────────────────────────────────────────────

function setState(d, state, extra) {
  var fields = Object.assign({}, extra);
  if (state !== d.row.state) {
    fields.state = state;
    log.info(d.row.infoHash + ': ' + d.row.state + ' → ' + state);
    // queued again after a stop: at the back of the queue (one that waits for
    // a slot back, from running, keeps its place)
    if (state === 'queued' && !isActive(d) && d.row.queueOrder !== null && d.row.queueOrder !== undefined) {
      fields.queueOrder = null;
    }
    // a force start lasts until it stops for good
    if (d.row.forced && ['paused', 'completed', 'error'].indexOf(state) !== -1) {
      fields.forced = false;
    }
  }
  if (ACTIVE.indexOf(state) !== -1) {
    fields.lastActiveAt = new Date();
  }
  if (Object.keys(fields).length) {
    persist(d, fields);
    publishUpdate(d);
  }
}

function engineAdd(d, paused) {
  return engine.add({
    infoHash: d.row.infoHash,
    magnet: magnetFor(d) || undefined,
    torrentFile: torrentFileFor(d) || undefined,
    savePath: d.row.saveDir,
    files: d.row.selectedFiles,
    // a stream plays one file: its largest until the player names it
    onlyLargest: d.row.intent === 'stream' && !d.row.selectedFiles,
    paused: paused,
    // the server's, the admin's, less the removed ones
    trackers: trackerList(d)
  }).then(function () {
    d.inEngine = true;
  });
}

// Its own speed limits (engines with torrentLimits), after each start
function applyTorrentLimits(d) {
  if (!caps.torrentLimits || !d.inEngine || (!d.row.downLimitKBps && !d.row.upLimitKBps && !d.limited)) {
    return Promise.resolve();
  }
  d.limited = !!(d.row.downLimitKBps || d.row.upLimitKBps);
  return engine.torrentLimits(d.row.infoHash, { downBps: (d.row.downLimitKBps || 0) * 1024, upBps: (d.row.upLimitKBps || 0) * 1024 });
}

// Runs the torrent (the state changes now; the engine follows)
function activate(d) {
  d.counters = { up: 0, down: 0 };
  d.tails = {};
  setState(d, d.meta && !caps.fastResume ? 'checking' : 'downloading', { error: null });
  return serial(d, function () {
    if (!engine) {
      throw errors.EngineError('UNAVAILABLE', 'No torrent engine: ' + (engineInfo.error || 'not started'));
    }
    if (!d.inEngine) {
      return engineAdd(d, false);
    }
    // an engine that kept the torrent (its own session) may hold an older
    // selection: ours is the truth
    var selecting = d.meta ? engine.select(d.row.infoHash, d.row.selectedFiles) : Promise.resolve();
    return selecting.then(function () { return engine.start(d.row.infoHash); });
  }).then(function () {
    return applyTorrentLimits(d).catch(function (err) {
      log.warn('cannot limit the speed of ' + d.row.infoHash + ': ' + err.message);
    });
  }).catch(function (err) {
    log.warn('cannot start ' + d.row.infoHash + ': ' + err.message);
    setState(d, 'error', { error: err.message });
    pump();
    throw err;
  });
}

// Stops the torrent's traffic: paused / queued / completed / error. Data stays.
function deactivate(d, state, extra) {
  var wasActive = isActive(d);
  d.live = null;
  d.seedingSince = null;
  setState(d, state, extra);
  d.dirty = true;
  if (!wasActive || !d.inEngine) {
    return Promise.resolve();
  }
  return serial(d, function () {
    if (!engine || !downloads[d.row.infoHash]) {
      return null;
    }
    if (caps.pause) {
      return engine.pause(d.row.infoHash);
    }
    return engine.stop(d.row.infoHash).then(function () { d.inEngine = false; });
  }).catch(function (err) {
    log.warn('cannot stop ' + d.row.infoHash + ': ' + err.message);
  });
}

function globalPaused() {
  return settings.get('downloads.paused');
}

// Starts queued downloads while there is room, in the queue's order; force
// started ones first, past downloads.maxActive (never past maxTorrents)
function pump() {
  if (!engine || globalPaused()) {
    return;
  }
  var all = Object.keys(downloads).map(function (h) { return downloads[h]; }),
    active = all.filter(isActive),
    running = active.filter(function (d) { return d.row.intent === 'download' && !d.row.forced; }).length,
    maxTorrents = settings.get('streaming.maxTorrents'),
    maxActive = settings.get('downloads.maxActive'),
    waiting = queued();
  waiting.filter(function (d) { return d.row.forced; }).concat(waiting.filter(function (d) { return !d.row.forced; }))
    .forEach(function (d) {
      if ((d.row.forced || running < maxActive) && active.length < maxTorrents) {
        running += d.row.forced ? 0 : 1;
        active.push(d);
        activate(d).catch(function () {});
      }
    });
}

// Seeding rules (download intent): stop at the ratio or after the time,
// whichever comes first; neither set = no seeding. A download's own goals
// replace the server's.
function seedingOver(d) {
  var ratio = d.row.seedRatio !== null && d.row.seedRatio !== undefined ? d.row.seedRatio : settings.get('downloads.seedRatio'),
    minutes = d.row.seedMinutes !== null && d.row.seedMinutes !== undefined ? d.row.seedMinutes : settings.get('downloads.seedMinutes');
  if (!ratio && !minutes) {
    return true;
  }
  return (ratio > 0 && d.row.sizeBytes && d.row.uploadedBytes / d.row.sizeBytes >= ratio) ||
    (minutes > 0 && d.seedingSince && Date.now() - d.seedingSince >= minutes * 60 * 1000);
}

// ── engine events and polling ──────────────────────────────────────────────

function onMetadata(hash) {
  var d = downloads[hash];
  if (!d || d.meta) {
    return;
  }
  engine.metadata(hash).then(function (meta) {
    if (!downloads[hash] || d.meta) {
      return;
    }
    d.meta = { name: meta.name, length: meta.length, pieceLength: meta.pieceLength, files: meta.files };
    var fields = { name: meta.name, torrentFile: saveTorrentFile(d, meta.torrentFile) };
    d.own = null;
    // a stream without a choice yet: its largest file (the player narrows it)
    if (!d.row.selectedFiles && d.row.intent === 'stream') {
      var largest = meta.files.reduce(function (a, b) { return a.size >= b.size ? a : b; });
      fields.selectedFiles = [largest.path];
    }
    persist(d, fields);
    d.row.sizeBytes = selectedOf(d).reduce(function (sum, f) { return sum + f.size; }, 0);
    d.dirty = true;
    log.info('metadata of ' + hash + ': ' + meta.name, { files: meta.files.length });
    publishUpdate(d);
    if (fields.selectedFiles && d.inEngine) {
      return serial(d, function () { return engine.select(hash, fields.selectedFiles); });
    }
  }).catch(function (err) {
    log.warn('metadata of ' + hash + ': ' + err.message);
  });
}

function onDone(hash) {
  var d = downloads[hash];
  if (!d || !isActive(d)) {
    return;
  }
  d.row.doneBytes = d.row.sizeBytes || d.row.doneBytes;
  d.dirty = true;
  d.seedingSince = Date.now();
  var extra = d.row.completedAt ? {} : { completedAt: new Date() };
  log.info('downloaded ' + hash + (d.row.name ? ' (' + d.row.name + ')' : ''));
  if (d.row.intent === 'download' && seedingOver(d)) {
    deactivate(d, 'completed', extra).then(pump);
  } else {
    setState(d, 'seeding', extra);
  }
}

function onError(hash, err) {
  var d = downloads[hash];
  if (d) {
    log.warn(hash + ': ' + err.message);
    persist(d, { error: err.message });
    publishUpdate(d);
  }
}

function poll() {
  if (!engine) {
    return Promise.resolve();
  }
  return engine.stats().then(function (all) {
    Object.keys(downloads).forEach(function (hash) {
      var d = downloads[hash], s = all.get(hash);
      if (!isActive(d) || !s) {
        d.live = null;
        return;
      }
      d.live = s;
      if (s.pieces) {
        d.pieces = s.pieces;
      }
      var up = s.uploadedBytes >= d.counters.up ? s.uploadedBytes - d.counters.up : s.uploadedBytes;
      d.counters = { up: s.uploadedBytes, down: s.downloadedBytes };
      if (up) {
        d.row.uploadedBytes += up;
        d.dirty = true;
      }
      if (s.metadata && s.sizeBytes !== null && s.state !== 'checking' &&
        (s.doneBytes !== d.row.doneBytes || s.sizeBytes !== d.row.sizeBytes)) {
        d.row.doneBytes = s.doneBytes;
        d.row.sizeBytes = s.sizeBytes;
        d.dirty = true;
      }
      if (s.metadata && !d.meta) {
        onMetadata(hash);
      }
      if (s.state === 'error') {
        log.warn(hash + ': the engine reports ' + (s.error || 'an error'));
        deactivate(d, 'error', { error: s.error || 'engine error' }).then(pump);
        return;
      }
      var state = s.state === 'checking' ? 'checking' : s.state === 'seeding' ? 'seeding' : 'downloading';
      if (state === 'seeding' && d.row.state !== 'seeding') {
        onDone(hash);
      } else if (state !== d.row.state && state !== 'seeding') {
        setState(d, state);
      }
      if (d.row.state === 'seeding' && d.row.intent === 'download' && seedingOver(d)) {
        log.info('seeding of ' + hash + ' done (ratio ' + (d.row.uploadedBytes / d.row.sizeBytes).toFixed(2) + ')');
        deactivate(d, 'completed').then(pump);
        return;
      }
      d.row.lastActiveAt = new Date();
      d.speed = d.speed || [];
      d.speed.push([Date.now(), s.downBps, s.upBps, s.peers]);
      if (d.speed.length > SPEED_SAMPLES) {
        d.speed.splice(0, d.speed.length - SPEED_SAMPLES);
      }
      publishUpdate(d);
    });
    if (Date.now() - lastPersist > PERSIST_MS) {
      return flush();
    }
  }).catch(function (err) {
    log.warn('torrent stats: ' + err.message);
  });
}

// ── adding ─────────────────────────────────────────────────────────────────

// link → { infoHash, magnet?, torrentFile? (Buffer), name? }. Magnets, bare
// info hashes, http(s) .torrent URLs and .torrent contents only: never a path
// on this machine.
function resolveLink(link) {
  return new Promise(function (resolve, reject) {
    if (Buffer.isBuffer(link)) {
      return resolve(link);
    }
    link = typeof link === 'string' ? link.trim() : '';
    if (/^([0-9a-f]{40}|[a-z2-7]{32})$/i.test(link)) {
      link = 'magnet:?xt=urn:btih:' + link;
    }
    if (/^magnet:/i.test(link)) {
      return resolve(link);
    }
    if (/^https?:\/\//i.test(link)) {
      return readTorrent(link, function (err, parsed, data) {
        return err ? reject(err) : resolve(Buffer.isBuffer(data) ? data : parsed);
      });
    }
    reject(new Error('not a magnet link, an info hash or a .torrent URL'));
  }).then(function (source) {
    var parsed = parseTorrent(source),
      hash = String(parsed.infoHash || '').toLowerCase();
    if (!HASH.test(hash)) {
      throw new Error('no info hash');
    }
    if (Buffer.isBuffer(source) && parsed.infoBuffer) {
      return {
        infoHash: hash, name: parsed.name || null, magnet: null,
        torrentFile: bncode.encode({ info: bncode.decode(parsed.infoBuffer), 'announce-list': (parsed.announce || []).map(function (a) { return [a]; }) }),
        meta: parsed.files ? metaOf(parsed) : null
      };
    }
    return { infoHash: hash, name: parsed.name || null, magnet: typeof source === 'string' ? source : null, torrentFile: null, meta: null };
  }).catch(function (err) {
    throw failure('INVALID', 'Cannot read this torrent: ' + err.message);
  });
}

function admit(hash) {
  var refused = admission && admission(hash);
  if (refused) {
    throw failure('BUSY', refused.message);
  }
}

// A stream needs the torrent running (paused / queued / completed / error ones start again)
function ensureRunning(d) {
  if (isActive(d)) {
    return Promise.resolve();
  }
  return Promise.resolve().then(function () {
    admit(d.row.infoHash);
    return activate(d);
  });
}

/**
 * @param {string|Buffer} link  magnet, info hash, .torrent URL, or a .torrent's bytes
 * @param {{ intent?: 'stream'|'download', by?: string, profileId?: string, files?: string[] }} [options]
 * @returns {Promise<string>} the info hash; rejects INVALID / BUSY / UNAVAILABLE
 */
function add(link, options) {
  options = options || {};
  var intent = options.intent === 'download' ? 'download' : 'stream';
  return ready.then(function () {
    return resolveLink(link);
  }).then(function (src) {
    var d = downloads[src.infoHash];
    if (d) {
      if (intent === 'download' && d.row.intent !== 'download') {
        persist(d, { intent: 'download' });
      }
      var selecting = options.files ? select(src.infoHash, options.files) : Promise.resolve();
      return selecting.then(function () {
        if (intent === 'stream') {
          // a finished download plays from disk: nothing to start
          return d.row.state === 'completed' ? null : ensureRunning(d);
        }
        if (['paused', 'error'].indexOf(d.row.state) !== -1) {
          setState(d, 'queued');
          pump();
        }
        publishUpdate(d);
      }).then(function () { return src.infoHash; });
    }
    if (!engine) {
      throw failure('UNAVAILABLE', 'No torrent engine: ' + (engineInfo.error || 'not started'));
    }
    if (intent === 'stream') {
      admit(src.infoHash);
    }
    d = downloads[src.infoHash] = {
      row: {
        infoHash: src.infoHash,
        name: src.name,
        magnet: src.magnet,
        torrentFile: null,
        state: intent === 'stream' ? 'downloading' : 'queued',
        intent: intent,
        error: null,
        saveDir: saveDir,
        selectedFiles: options.files && options.files.length ? options.files.slice() : null,
        sizeBytes: null,
        doneBytes: 0,
        uploadedBytes: 0,
        addedBy: options.by || null,
        profileId: options.profileId || null,
        titleRef: null,
        removeWhenWatched: false,
        addedAt: new Date(),
        completedAt: null,
        lastActiveAt: null
      },
      meta: src.meta,
      live: null, inEngine: false, counters: { up: 0, down: 0 }, seedingSince: null, tails: {},
      op: Promise.resolve(), dirty: false, published: null
    };
    if (src.torrentFile) {
      d.row.torrentFile = saveTorrentFile(d, src.torrentFile);
    }
    if (d.meta) {
      if (intent === 'stream' && !d.row.selectedFiles) {
        d.row.selectedFiles = [d.meta.files.reduce(function (a, b) { return a.size >= b.size ? a : b; }).path];
      }
      d.row.sizeBytes = selectedOf(d).reduce(function (sum, f) { return sum + f.size; }, 0);
    }
    log.info('adding ' + src.infoHash + ' (' + intent + ')' + (options.by ? ' for ' + options.by : ''));
    var saved = store ? store.create(d.row).catch(function (err) {
      log.warn('cannot save download ' + src.infoHash + ': ' + err.message);
    }) : Promise.resolve();
    return saved.then(function () {
      events.publish('download.added', view(d));
      if (intent === 'stream') {
        d.row.state = 'queued';   // activate() announces the change
        return activate(d).catch(function (err) {
          throw failure('INVALID', 'Cannot start this torrent: ' + err.message);
        });
      }
      pump();
    }).then(function () { return src.infoHash; });
  });
}

// What a link is before adding it (the dashboard's Add dialog): its name and
// files when they are known without the swarm (a .torrent, or a torrent the
// server already keeps); a new magnet's files arrive only with its metadata
function preview(link) {
  return ready.then(function () {
    return resolveLink(link);
  }).then(function (src) {
    var known = downloads[src.infoHash] || null, meta = src.meta || (known && known.meta) || null;
    return {
      infoHash: src.infoHash,
      name: (meta && meta.name) || src.name || (known && known.row.name) || null,
      sizeBytes: meta ? meta.length : null,
      files: meta ? meta.files.map(function (f) { return { path: f.path, size: f.size }; }) : null,
      known: known ? view(known) : null
    };
  });
}

// ── streaming ──────────────────────────────────────────────────────────────

function fileOf(d, filePath) {
  return d.meta && d.meta.files.filter(function (f) { return f.path === filePath; })[0] || null;
}

// A finished file of a stopped download: read from disk, no engine
function onDisk(d, file) {
  if (isActive(d) || d.row.state !== 'completed' || selectedOf(d).indexOf(file) === -1) {
    return Promise.resolve(false);
  }
  return files.present(d.row.saveDir, file);
}

// What a stream download fetches when `file` is read: a video alone (season
// packs), plus what it already fetched of that video's audio and subtitle
// files (the player's tracks, lib/media/files#companions); another file (a
// track) is added to the selection
function streamSelection(d, file) {
  var current = d.row.selectedFiles;
  if (mediaFiles.kindOf(file.path) !== 'video') {
    return current && current.indexOf(file.path) === -1 ? current.concat(file.path) : current;
  }
  var mates = mediaFiles.companions(d.meta.files, file),
    keep = mates.audio.concat(mates.subtitles).map(function (f) { return f.path; });
  return [file.path].concat((current || []).filter(function (p) { return keep.indexOf(p) !== -1; }));
}

/**
 * Before streaming `filePath`: a stopped download starts again (admission:
 * BUSY), unless the file is finished on disk; a stream download fetches only
 * this file (season packs) and the tracks of it the player asked for, a
 * download adds it to its selection.
 * @returns {Promise<'disk'|'engine'>}
 */
function prepareStream(hash, filePath) {
  return ready.then(function () {
    var d = find(hash), file = fileOf(d, filePath);
    if (!file) {
      throw failure('NOT_FOUND', 'No such file in this torrent');
    }
    return onDisk(d, file).then(function (disk) {
      if (disk) {
        return 'disk';
      }
      var wanted = d.row.intent === 'stream' ? streamSelection(d, file) :
        d.row.selectedFiles && d.row.selectedFiles.indexOf(filePath) === -1 ? d.row.selectedFiles.concat(filePath) : null;
      var selecting = wanted && JSON.stringify(wanted) !== JSON.stringify(d.row.selectedFiles) ?
        select(hash, wanted) : Promise.resolve();
      return selecting.then(function () { return ensureRunning(d); }).then(function () { return 'engine'; });
    });
  });
}

/**
 * Where a finished file of a stopped download is on disk (ffmpeg reads it
 * there, lib/media), or null while it needs the engine.
 * @returns {Promise<string|null>}
 */
function diskPath(hash, filePath) {
  return ready.then(function () {
    var d = downloads[hash], file = d && fileOf(d, filePath);
    if (!file) {
      return null;
    }
    return onDisk(d, file).then(function (disk) {
      return disk ? files.location(d.row.saveDir, file.path) : null;
    });
  });
}

/** The bytes start…end (inclusive) of a file: from disk for a finished file of a stopped download */
function stream(hash, filePath, range) {
  return Promise.resolve().then(function () {
    var d = find(hash), file = fileOf(d, filePath);
    if (!file) {
      throw failure('NOT_FOUND', 'No such file in this torrent');
    }
    if (!isActive(d)) {
      var full = files.location(d.row.saveDir, file.path);
      if (!full) {
        throw failure('NOT_FOUND', 'No such file in this torrent');
      }
      return fs.createReadStream(full, { start: range && range.start || 0, end: range && range.end !== undefined ? range.end : file.size - 1 });
    }
    return serial(d, function () { return null; }).then(function () {
      return engine.stream(hash, filePath, range);
    }).then(function (readable) {
      return reading(d, file, range, readable);
    });
  });
}

// Where players read (the Pieces tab's streamed range): the bytes pass
// through a counter while the stream is open
function reading(d, file, range, readable) {
  var start = (range && range.start) || 0,
    read = { path: file.path, offset: file.offset, start: start, position: start, at: Date.now() },
    counter = new (require('stream').PassThrough)();
  d.reads = (d.reads || []).concat(read);
  counter.on('data', function (chunk) {
    read.position += chunk.length;
    read.at = Date.now();
  });
  require('stream').pipeline(readable, counter, function () {
    d.reads = d.reads.filter(function (r) { return r !== read; });
  });
  return counter;
}

// Players read a video's index before starting: MKV keeps it (Cues) at the end
// of the file, which would otherwise download last. Fetch the tail alongside
// the start the first time a file is streamed in this run of the torrent.
function prefetchTail(hash, filePath) {
  var d = downloads[hash], file = d && fileOf(d, filePath);
  if (!file || !isActive(d) || d.tails[filePath] || file.size <= TAIL_BYTES * 2) {
    return;
  }
  d.tails[filePath] = true;
  engine.stream(hash, filePath, { start: file.size - TAIL_BYTES, end: file.size - 1 }).then(function (tail) {
    tail.on('error', function () {});
    tail.resume();
  }, function () {});
}

// ── actions ────────────────────────────────────────────────────────────────

function select(hash, paths) {
  return ready.then(function () {
    var d = find(hash);
    if (paths !== null && (!Array.isArray(paths) || paths.some(function (p) { return typeof p !== 'string'; }))) {
      throw failure('INVALID', 'files must be a list of paths, or null for every file');
    }
    if (paths && d.meta) {
      var unknown = paths.filter(function (p) { return !fileOf(d, p); });
      if (unknown.length) {
        throw failure('INVALID', 'No such file in this torrent: ' + unknown[0]);
      }
    }
    persist(d, { selectedFiles: paths && paths.length ? paths.slice() : paths ? [] : null });
    if (d.meta) {
      d.row.sizeBytes = selectedOf(d).reduce(function (sum, f) { return sum + f.size; }, 0);
      d.dirty = true;
    }
    if (d.row.state === 'completed' && !paths) {
      // more to fetch: a download goes back to the queue
      if (d.row.intent === 'download') {
        setState(d, 'queued');
        pump();
      }
    }
    publishUpdate(d);
    // after an add still on its way to the engine (engine calls are serial)
    return serial(d, function () {
      return d.inEngine && engine ? engine.select(d.row.infoHash, d.row.selectedFiles) : null;
    });
  });
}

// The user's pause (dashboard, API): stays paused until started again
function pause(hash) {
  return ready.then(function () {
    var d = find(hash);
    if (isActive(d) || d.row.state === 'queued') {
      return deactivate(d, 'paused').then(pump);
    }
  });
}

// Starting one download while "Pause all downloads" is on ends that pause, for
// this one: the flag goes off, and the downloads it held back stay paused each on
// its own (state paused, not queued), so they don't all start again with it.
function liftPauseAllFor(d) {
  if (!globalPaused()) {
    return;
  }
  var held = 0;
  Object.keys(downloads).forEach(function (hash) {
    var other = downloads[hash];
    if (other !== d && other.row.state === 'queued' && other.row.intent === 'download') {
      setState(other, 'paused');
      publishUpdate(other);
      held++;
    }
  });
  settings.update({ downloads: { paused: false } });
  log.info('"pause all" lifted to start ' + d.row.infoHash + ' (' + held + ' others stay paused)');
}

// The admin's Start: the torrent becomes a download and runs to the end
// without a client (queued when downloads.maxActive are running)
function start(hash) {
  return ready.then(function () {
    var d = find(hash);
    liftPauseAllFor(d);
    if (d.row.intent !== 'download') {
      persist(d, { intent: 'download' });
    }
    if (['paused', 'error'].indexOf(d.row.state) !== -1 || (d.row.state === 'completed' && !isDone(d))) {
      setState(d, 'queued');
    }
    publishUpdate(d, true);
    pump();
  });
}

// The player's resume (POST /torrents/{hash}/resume): runs again, intent unchanged
function resume(hash) {
  return ready.then(function () {
    var d = find(hash);
    return d.row.intent === 'download' ? start(hash) : ensureRunning(d);
  });
}

// Forgets the torrent; its data is deleted only with deleteData
function remove(hash, options) {
  return ready.then(function () {
    var d = find(hash), deleteData = !!(options && options.deleteData);
    delete downloads[d.row.infoHash];
    log.info('removing ' + d.row.infoHash + (deleteData ? ' and its data' : ' (data kept)'));
    return serial(d, function () {
      if (d.inEngine && engine) {
        return engine.remove(d.row.infoHash, { deleteData: deleteData }).then(function () {
          d.inEngine = false;
        });
      }
      if (deleteData && d.meta) {
        return files.deleteData(d.row.saveDir, d.meta.files);
      }
    }).catch(function (err) {
      log.warn('removing ' + d.row.infoHash + ': ' + err.message);
      if (deleteData && d.meta) {
        return files.deleteData(d.row.saveDir, d.meta.files);
      }
    }).then(function () {
      if (d.row.torrentFile) {
        fs.rm(d.row.torrentFile, { force: true }, function () {});
      }
      return store ? store.remove(d.row.infoHash) : null;
    }).then(function () {
      events.publish('download.removed', { infoHash: d.row.infoHash });
      pump();
    });
  });
}

/**
 * The last client let go (lib/sessions.js, after its grace period). A stream
 * stops (paused, or completed when its files are done); a download keeps
 * running. "Remove when watched" deletes it when the player reached the end.
 * @param {{ watched?: boolean }} [info]
 */
function released(hash, info) {
  var d = downloads[hash];
  if (!d) {
    return Promise.resolve();
  }
  if (d.row.removeWhenWatched && info && info.watched) {
    log.info(hash + ' was watched: removing it and its data');
    return remove(hash, { deleteData: true });
  }
  if (d.row.intent === 'stream' && isActive(d)) {
    log.info('no client left: ' + (isDone(d) ? 'completed ' : 'pausing ') + hash);
    return deactivate(d, isDone(d) ? 'completed' : 'paused').then(pump);
  }
  return Promise.resolve();
}

// A stream needs the slot of a download nobody watches: back to the queue
function requeue(hash) {
  var d = downloads[hash];
  if (d && isActive(d) && d.row.intent === 'download') {
    log.info('making room for a stream: ' + hash + ' back in the queue');
    return deactivate(d, 'queued');
  }
  return Promise.resolve();
}

// What the player's keepalive says about the torrent: the title, the profile
function describe(hash, info) {
  var d = downloads[hash], fields = {};
  if (!d || !info) {
    return;
  }
  if (info.titleRef && JSON.stringify(info.titleRef) !== JSON.stringify(d.row.titleRef)) {
    fields.titleRef = info.titleRef;
  }
  if (info.profileId && info.profileId !== d.row.profileId) {
    fields.profileId = info.profileId;
  }
  if (Object.keys(fields).length) {
    persist(d, fields);
    publishUpdate(d);
  }
}

// The admin's label (free text, ≤ 40 characters; empty = none)
function setLabel(hash, value) {
  return ready.then(function () {
    var d = find(hash), label = typeof value === 'string' ? value.trim().slice(0, 40) : '';
    persist(d, { label: label || null });
    publishUpdate(d);
  });
}

function setRemoveWhenWatched(hash, value) {
  return ready.then(function () {
    var d = find(hash);
    persist(d, { removeWhenWatched: !!value });
    publishUpdate(d);
  });
}

// Moves a queued download to `position` (1-based; past the end: last). The
// queue's order is then the admin's for every queued one.
function moveInQueue(hash, position) {
  return ready.then(function () {
    var d = find(hash);
    if (d.row.state !== 'queued') {
      throw failure('CONFLICT', 'Only a queued download has a place in the queue');
    }
    if (typeof position !== 'number' || !(position >= 1) || Math.floor(position) !== position) {
      throw failure('INVALID', 'queuePosition must be a whole number from 1');
    }
    var order = queued().filter(function (o) { return o !== d; });
    order.splice(Math.min(position, order.length + 1) - 1, 0, d);
    order.forEach(function (o, i) {
      if (o.row.queueOrder !== i + 1) {
        persist(o, { queueOrder: i + 1 });
        publishUpdate(o);
      }
    });
    log.info(hash + ' moved to #' + (order.indexOf(d) + 1) + ' in the queue');
    pump();
  });
}

// Force start (µTorrent's): a download that runs past downloads.maxActive,
// until it is paused or done; off = the queue's rules again
function setForce(hash, on) {
  return ready.then(function () {
    var d = find(hash);
    if (!on) {
      if (d.row.forced) {
        persist(d, { forced: false });
        publishUpdate(d);
        // a running one keeps going; the queue counts it from now on
      }
      return;
    }
    var fields = { forced: true };
    if (d.row.intent !== 'download') {
      fields.intent = 'download';
    }
    if (d.row.state === 'completed' && isDone(d)) {
      throw failure('CONFLICT', 'It is downloaded: nothing to start');
    }
    persist(d, fields);
    liftPauseAllFor(d);
    log.info('force start of ' + hash);
    if (!isActive(d)) {
      setState(d, 'queued');
    }
    publishUpdate(d, true);
    pump();
  });
}

function goal(value, integer) {
  return value === null || (typeof value === 'number' && value >= 0 && isFinite(value) && (!integer || Math.floor(value) === value));
}

// Its own seeding goals (null: the server's downloads.seedRatio / seedMinutes)
function setSeedGoal(hash, goals) {
  return ready.then(function () {
    var d = find(hash), fields = {};
    if (goals.ratio !== undefined) {
      if (!goal(goals.ratio)) {
        throw failure('INVALID', 'seedRatio must be a number from 0, or null');
      }
      fields.seedRatio = goals.ratio === null ? null : Math.round(goals.ratio * 100) / 100;
    }
    if (goals.minutes !== undefined) {
      if (!goal(goals.minutes, true)) {
        throw failure('INVALID', 'seedMinutes must be a whole number from 0, or null');
      }
      fields.seedMinutes = goals.minutes;
    }
    persist(d, fields);
    publishUpdate(d);
    // a seeding download past its new goal stops at the next poll
  });
}

// Its own speed limits in KB/s (0 / null: none); engines with torrentLimits
function setTorrentLimits(hash, limitsKBps) {
  return ready.then(function () {
    var d = find(hash), fields = {};
    capable('torrentLimits', 'speed limits per torrent');
    ['down', 'up'].forEach(function (way) {
      var v = limitsKBps[way];
      if (v === undefined) {
        return;
      }
      if (!goal(v, true)) {
        throw failure('INVALID', way + 'LimitKBps must be a whole number from 0, or null');
      }
      fields[way + 'LimitKBps'] = v || null;
    });
    persist(d, fields);
    publishUpdate(d);
    return isActive(d) ? serial(d, function () { return applyTorrentLimits(d); }) : null;
  });
}

// The tray's "Pause all downloads" (downloads.paused, kept across restarts):
// downloads go back to the queue and wait; streams still play
function pauseAll() {
  settings.update({ downloads: { paused: true } });
  var count = 0;
  Object.keys(downloads).forEach(function (hash) {
    var d = downloads[hash];
    if (isActive(d) && d.row.intent === 'download') {
      count++;
      deactivate(d, 'queued');
    }
  });
  log.info('downloads paused (' + count + ')');
  return count;
}

function resumeAll() {
  settings.update({ downloads: { paused: false } });
  var queued = Object.keys(downloads).filter(function (h) { return downloads[h].row.state === 'queued'; }).length;
  log.info('downloads resumed');
  pump();
  return queued;
}

// After settings changed (lib/routes/admin.js): limits, seeding rules, pause
// What setLimits gets: upload slots, and the speed limits where the engine can
function limits(capabilities) {
  var out = { uploadSlots: settings.get('downloads.uploadSlots') };
  if ((capabilities || caps).rateLimits) {
    out.downBps = settings.get('downloads.downLimitKBps') * 1024;
    out.upBps = settings.get('downloads.upLimitKBps') * 1024;
  }
  return out;
}

function settingsChanged(keys) {
  if (engine && keys.some(function (k) { return /^downloads\.(uploadSlots|downLimitKBps|upLimitKBps)$/.test(k); })) {
    engine.setLimits(limits()).catch(function () {});
  }
  if (keys.indexOf('downloads.paused') !== -1) {
    if (globalPaused()) {
      pauseAll();
    } else {
      pump();
    }
  } else if (keys.some(function (k) { return /^(downloads|streaming)\./.test(k); })) {
    pump();
  }
}

// ── reading ────────────────────────────────────────────────────────────────

function get(hash) {
  var d = typeof hash === 'string' && downloads[hash.toLowerCase()];
  return d ? view(d) : null;
}

function list() {
  return Object.keys(downloads).map(function (h) { return downloads[h]; })
    .sort(function (a, b) { return a.row.addedAt - b.row.addedAt; }).map(view);
}

// Bytes of a file that are verified, from the engine's pieces (pieces at its
// edges count by their overlap); null when unknown
function fileDone(d, f) {
  var live = isActive(d) ? d.live : null, pl = d.meta.pieceLength;
  if (!live || !live.pieces || !pl || !f.size) {
    return null;
  }
  var done = 0, first = Math.floor(f.offset / pl), last = Math.floor((f.offset + f.size - 1) / pl);
  for (var i = first; i <= last && i < live.pieces.length; i++) {
    if (live.pieces[i]) {
      done += Math.min((i + 1) * pl, f.offset + f.size) - Math.max(i * pl, f.offset);
    }
  }
  return done;
}

// Files with their selection and progress, or null before the metadata arrived
function filesOf(hash) {
  var d = typeof hash === 'string' && downloads[hash.toLowerCase()];
  if (!d || !d.meta) {
    return null;
  }
  return d.meta.files.map(function (f) {
    var selected = !d.row.selectedFiles || d.row.selectedFiles.indexOf(f.path) !== -1;
    return {
      name: path.basename(f.path), path: f.path, ref: refs.torrent(d.row.infoHash, f.path), size: f.size, offset: f.offset,
      selected: selected,
      // a finished download's selected files are whole (edge pieces shared with
      // files not downloaded can't be counted from the pieces)
      doneBytes: selected && (d.row.state === 'completed' || isDone(d)) ? f.size : fileDone(d, f)
    };
  });
}

// The player's Torrent (GET /torrents/{hash}): only infoHash until the metadata arrived
function torrent(hash) {
  var d = find(hash), r = d.row, live = isActive(d) ? d.live : null;
  if (!d.meta) {
    return { infoHash: r.infoHash };
  }
  return {
    infoHash: r.infoHash,
    name: d.meta.name,
    length: d.meta.length,
    state: r.state,
    interested: isActive(d) && r.state !== 'seeding',
    ready: isActive(d) ? !!live && live.metadata && live.state !== 'checking' : r.state === 'completed',
    files: filesOf(hash).map(function (f) {
      return {
        name: f.name,
        path: f.path,
        ref: f.ref,
        link: protocol.API_PREFIX + '/torrents/' + r.infoHash + '/files/' + encodeURIComponent(f.path),
        length: f.size,
        offset: f.offset,
        selected: f.selected
      };
    }),
    progress: live && live.pieces ? progressbar(live.pieces) : r.state === 'completed' ? [100] : []
  };
}

// GET /torrents/{hash}/stats (and the player's buffering screen)
function torrentStats(hash) {
  var d = find(hash), live = isActive(d) ? d.live : null;
  return {
    metadata: !!d.meta || !!(live && live.metadata),
    peers: { total: live ? live.peers : 0, unchocked: live ? live.peersUnchoked : 0 },
    traffic: { down: live ? live.downloadedBytes : 0, up: live ? live.uploadedBytes : 0 },
    speed: { down: live ? live.downBps : 0, up: live ? live.upBps : 0 },
    eta: view(d).eta,
    queue: 0,
    paused: !isActive(d),
    state: d.row.state
  };
}

// ── a download's detail (docs/dashboard-plan.md §4.3, engine port v2) ───────

function capable(capability, what) {
  if (!engine) {
    throw failure('UNAVAILABLE', 'No torrent engine: ' + (engineInfo.error || 'not started'));
  }
  if (!caps[capability]) {
    throw failure('NOT_SUPPORTED', 'The ' + engineInfo.id + ' engine doesn\'t report ' + what);
  }
}

/** The connected peers (none while stopped), their client's name, and the availability */
function peers(hash) {
  return ready.then(function () {
    var d = find(hash);
    capable('peerList', 'its peers');
    if (!isActive(d) || !d.inEngine) {
      return { running: false, peers: [], availability: null };
    }
    return engine.peers(d.row.infoHash).then(function (answer) {
      return {
        running: true,
        availability: answer.availability,
        peers: answer.peers.map(function (p) {
          return {
            address: p.address,
            client: p.client || peerid.clientOf(p.peerId) || null,
            flags: p.flags || '',
            progress: p.progress,
            downloadSpeed: Math.round(p.downBps || 0),
            uploadSpeed: Math.round(p.upBps || 0),
            downloaded: p.downloaded || 0,
            uploaded: p.uploaded || 0
          };
        }).sort(function (a, b) { return b.downloadSpeed - a.downloadSpeed || b.uploadSpeed - a.uploadSpeed; })
      };
    });
  });
}

/**
 * Its trackers: the engine's list (and status where it knows it) with ours
 * and the admin's, less the removed ones; what each answered to the last
 * scrape. A scrape older than 5 minutes starts again (its answer follows).
 */
function trackersOf(hash) {
  return ready.then(function () {
    var d = find(hash);
    capable('trackerList', 'its trackers');
    var listed = isActive(d) && d.inEngine ? engine.trackers(d.row.infoHash) : Promise.resolve([]);
    return listed.then(function (list) {
      var seen = {}, out = [], e = edits(d), oldest = Infinity;
      list.concat(trackerList(d).map(function (url) { return { url: url, status: null }; })).forEach(function (t) {
        if (seen[t.url] || e.removed.indexOf(t.url) !== -1) {
          return;
        }
        seen[t.url] = true;
        var scraped = d.scrape && d.scrape[t.url];
        oldest = Math.min(oldest, scraped ? scraped.at : 0);
        out.push({
          url: t.url,
          status: !isActive(d) ? 'stopped' : t.status || 'unknown',
          seeds: t.seeds === undefined ? null : t.seeds,
          peers: t.peers === undefined ? null : t.peers,
          message: t.message || null,
          ours: trackers.list.indexOf(t.url) !== -1,
          added: e.added.indexOf(t.url) !== -1,
          swarm: scraped ? {
            seeds: scraped.seeds, peers: scraped.peers, downloaded: scraped.downloaded,
            at: new Date(scraped.at).toISOString(), error: scraped.error
          } : null
        });
      });
      if (out.length && Date.now() - oldest > SCRAPE_STALE_MS && !d.scraping) {
        scrapeSome([d]);
      }
      return { running: isActive(d), scraping: !!d.scraping, trackers: out };
    });
  });
}

/**
 * Adds and removes announce URLs, kept with the download (its `trackers`).
 * Added ones are announced to now where the engine can, else from the next
 * start; removed ones are left out from the next start (and now, where the
 * engine can).
 */
function editTrackers(hash, change) {
  return ready.then(function () {
    var d = find(hash), add = change && change.add, remove = change && change.remove;
    if (add !== undefined) {
      capable('trackerEdit', 'adding trackers');
      if (!Array.isArray(add) || !add.length || add.some(function (u) { return typeof u !== 'string' || !/^(https?|udp):\/\/[^\s]+$/i.test(u); })) {
        throw failure('INVALID', 'trackers must be http(s):// or udp:// announce URLs');
      }
    }
    if (remove !== undefined) {
      capable('trackerRemove', 'removing trackers');
      if (!Array.isArray(remove) || !remove.length || remove.some(function (u) { return typeof u !== 'string'; })) {
        throw failure('INVALID', 'remove must be a list of announce URLs');
      }
    }
    if (add === undefined && remove === undefined) {
      throw failure('INVALID', 'nothing to change: add or remove');
    }
    var e = edits(d), added = add || [], removed = remove || [];
    var next = {
      added: unique(e.added.concat(added)).filter(function (u) { return removed.indexOf(u) === -1; }),
      removed: unique(e.removed.filter(function (u) { return added.indexOf(u) === -1; }).concat(removed))
    };
    persist(d, { trackers: next });
    log.info('trackers of ' + hash + ': +' + added.length + ' −' + removed.length);
    if (!d.inEngine) {
      return null;
    }
    return serial(d, function () {
      return (added.length ? engine.addTrackers(d.row.infoHash, added) : Promise.resolve()).then(function () {
        return removed.length ? engine.removeTrackers(d.row.infoHash, removed) : null;
      });
    });
  });
}

/** Announces to its trackers now: a running torrent no player reads (engines restart its traffic for it) */
function reannounce(hash) {
  return ready.then(function () {
    var d = find(hash);
    capable('reannounce', 'announcing again');
    if (!isActive(d) || !d.inEngine) {
      throw failure('CONFLICT', 'Start it first: only a running torrent announces');
    }
    if ((d.reads || []).length) {
      throw failure('CONFLICT', 'A player is reading it: announcing again would restart its stream');
    }
    log.info('announcing ' + hash + ' again (the admin)');
    return serial(d, function () { return engine.reannounce(d.row.infoHash); }).then(function () {
      return applyTorrentLimits(d).catch(function () {});
    });
  });
}

/** Its .torrent with the trackers it announces to: { name, buffer }; CONFLICT before its metadata */
function torrentFile(hash) {
  return ready.then(function () {
    var d = find(hash), buffer = readTorrentFile(d);
    if (!buffer) {
      throw failure('CONFLICT', 'Its metadata hasn\'t arrived yet: no .torrent to give');
    }
    var decoded = bncode.decode(buffer), list = trackerList(d);
    var out = { info: decoded.info, 'announce-list': list.map(function (url) { return [url]; }) };
    if (list.length) {
      out.announce = list[0];
    }
    return { name: d.row.name || d.row.infoHash, buffer: bncode.encode(out) };
  });
}

// ── scrapes (./scrape.js) ───────────────────────────────────────────────────

// Asks every tracker of these downloads (grouped: one request per tracker,
// several hashes in it), a few trackers at once
function scrapeSome(list) {
  if (!discovery) {
    return Promise.resolve();
  }
  var byTracker = {};
  list.forEach(function (d) {
    d.scraping = true;
    trackerList(d).forEach(function (url) {
      (byTracker[url] = byTracker[url] || []).push(d);
    });
  });
  var urls = Object.keys(byTracker), changed = {};
  function one(url) {
    var ds = byTracker[url], hashes = ds.map(function (d) { return d.row.infoHash; }), at = Date.now();
    return scraper.scrape(url, hashes).then(function (answer) {
      ds.forEach(function (d) {
        var a = answer[d.row.infoHash];
        d.scrape = d.scrape || {};
        d.scrape[url] = a ? { seeds: a.seeds, peers: a.peers, downloaded: a.downloaded, at: at, error: null } :
          { seeds: null, peers: null, downloaded: null, at: at, error: 'The tracker doesn\'t know this torrent' };
        changed[d.row.infoHash] = d;
      });
    }, function (err) {
      ds.forEach(function (d) {
        d.scrape = d.scrape || {};
        d.scrape[url] = { seeds: null, peers: null, downloaded: null, at: at, error: err.message };
      });
    });
  }
  var next = 0;
  function worker() {
    if (next >= urls.length) {
      return Promise.resolve();
    }
    return one(urls[next++]).then(worker);
  }
  var workers = [];
  for (var i = 0; i < Math.min(SCRAPE_PARALLEL, urls.length); i++) {
    workers.push(worker());
  }
  return Promise.all(workers).then(function () {
    list.forEach(function (d) { d.scraping = false; });
    Object.keys(changed).forEach(function (h) {
      if (downloads[h]) {
        publishUpdate(downloads[h]);
      }
    });
  });
}

// Every download whose trackers are known, every 30 minutes
function scrapeAll() {
  if (scraping) {
    return scraping;
  }
  var list = Object.keys(downloads).map(function (h) { return downloads[h]; })
    .filter(function (d) { return !d.scraping && trackerList(d).length; });
  scraping = scrapeSome(list).catch(function (err) {
    log.warn('scraping trackers: ' + err.message);
  }).then(function () {
    scraping = null;
  });
  return scraping;
}

/** Every piece verified again (a running torrent) */
function recheck(hash) {
  return ready.then(function () {
    var d = find(hash);
    capable('recheck', 'a recheck');
    if (!isActive(d) || !d.inEngine) {
      throw failure('CONFLICT', 'Start it first: only a running torrent is checked');
    }
    log.info('checking ' + hash + ' again (the admin)');
    // the engine reports `checking` while it verifies (the next polls)
    return serial(d, function () { return engine.recheck(d.row.infoHash); });
  });
}

function bitfield(pieces) {
  var out = Buffer.alloc(Math.ceil(pieces.length / 8));
  for (var i = 0; i < pieces.length; i++) {
    if (pieces[i]) {
      out[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  return out.toString('base64');
}

/**
 * Its pieces (the Pieces tab): the verified ones as a bitfield (base64,
 * first piece = the first byte's high bit), the selected files' piece
 * ranges, and where players read now (their position and the read-ahead)
 */
function piecesOf(hash) {
  return ready.then(function () {
    var d = find(hash);
    if (!d.meta || !d.meta.pieceLength) {
      return { pieceLength: null, count: 0, have: null, files: [], reads: [] };
    }
    var pl = d.meta.pieceLength, count = Math.ceil(d.meta.length / pl), pieces = d.pieces;
    if (!pieces || pieces.length !== count) {
      // stopped without a report: whole pieces of finished files
      pieces = new Uint8Array(count);
      if (isDone(d)) {
        selectedOf(d).forEach(function (f) {
          for (var i = Math.ceil(f.offset / pl); i < Math.floor((f.offset + f.size) / pl); i++) {
            pieces[i] = 1;
          }
        });
      }
    }
    var piece = function (byte) { return Math.min(count - 1, Math.floor(byte / pl)); };
    return {
      pieceLength: pl,
      count: count,
      have: bitfield(pieces),
      files: selectedOf(d).map(function (f) {
        return { path: f.path, first: piece(f.offset), last: piece(f.offset + Math.max(f.size, 1) - 1) };
      }),
      reads: isActive(d) ? (d.reads || []).map(function (r) {
        return {
          path: r.path,
          from: piece(r.offset + r.start),
          position: piece(r.offset + r.position),
          ahead: piece(r.offset + r.position + READ_AHEAD),
          at: new Date(r.at).toISOString()
        };
      }) : []
    };
  });
}

/** The last 10 minutes of its speeds and peers, a sample every 2 s */
function speedOf(hash) {
  return ready.then(function () {
    var d = find(hash);
    return {
      intervalMs: POLL_MS,
      samples: (d.speed || []).map(function (s) {
        return { at: new Date(s[0]).toISOString(), down: Math.round(s[1]), up: Math.round(s[2]), peers: s[3] };
      })
    };
  });
}

// Sum over the active torrents: speeds, peers, the engine's byte counters
function totals() {
  return Object.keys(downloads).reduce(function (sum, hash) {
    var d = downloads[hash], live = isActive(d) ? d.live : null;
    if (live) {
      sum.downloadSpeed += live.downBps;
      sum.uploadSpeed += live.upBps;
      sum.peers += live.peers;
      sum.counters[hash] = { down: live.downloadedBytes, up: live.uploadedBytes };
    }
    return sum;
  }, { downloadSpeed: 0, uploadSpeed: 0, peers: 0, counters: {} });
}

function count(predicate) {
  return Object.keys(downloads).filter(function (h) { return predicate(downloads[h]); }).length;
}

// The engine and the counts (dashboard Overview, the tray)
function info() {
  return {
    engine: engineInfo.id,
    requestedEngine: engineInfo.requested,
    engineError: engineInfo.error,
    capabilities: Object.assign({}, caps),
    total: count(function () { return true; }),
    active: count(isActive),
    queued: count(function (d) { return d.row.state === 'queued'; }),
    paused: globalPaused()
  };
}

// Top-level entries of `dir` that downloads saved there use:
// name → { infoHash, name, active } (the Storage page, lib/storage.js)
function owners(dir) {
  var all = {}, root = path.resolve(dir);
  Object.keys(downloads).forEach(function (hash) {
    var d = downloads[hash];
    if (!d.meta || path.resolve(d.row.saveDir) !== root) {
      return;
    }
    files.topEntries(d.meta.files).forEach(function (top) {
      if (!all[top] || isActive(d)) {
        all[top] = { infoHash: hash, name: d.meta.name, active: isActive(d), done: isDone(d) };
      }
    });
  });
  return all;
}

// Active torrents: [{ infoHash, intent }] (lib/sessions.js#canAdd)
function active() {
  return Object.keys(downloads).filter(function (h) { return isActive(downloads[h]); })
    .map(function (h) { return { infoHash: h, intent: downloads[h].row.intent }; });
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function startEngine(id, options) {
  var candidate = engines.create(id, options.engineOptions);
  return candidate.init({
    dataDir: saveDir,
    stateDir: options.stateDir,
    peerPort: options.peerPort !== undefined ? options.peerPort : settings.get('downloads.peerPort'),
    portForwarding: settings.get('downloads.portForwarding'),
    discovery: options.discovery,
    limits: limits(candidate.capabilities),
    log: log
  }).then(function () {
    return candidate.health();
  }).then(function (health) {
    if (!health.ok) {
      throw new Error(health.detail || 'unhealthy');
    }
    return candidate;
  }, function (err) {
    return candidate.close().catch(function () {}).then(function () { throw err; });
  });
}

function attach(candidate) {
  engine = candidate;
  caps = candidate.capabilities;
  engineInfo.id = candidate.id;
  candidate.on('metadata', onMetadata);
  candidate.on('done', onDone);
  candidate.on('error', onError);
  // speed limits: set after the start (sidecars take them over their API)
  if (caps.rateLimits && (settings.get('downloads.downLimitKBps') || settings.get('downloads.upLimitKBps'))) {
    candidate.setLimits(limits()).catch(function (err) {
      log.warn('cannot set the speed limits: ' + err.message);
    });
  }
}

// torrents.json (the hashes the old store kept) → paused downloads, when
// torrent-stream's metadata cache and their data are still there. Once.
function importLegacy(configDir, stateDir) {
  var legacy = path.join(configDir, 'torrents.json'), hashes;
  try {
    hashes = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  } catch (e) {
    return Promise.resolve();
  }
  var imported = 0;
  return Promise.all((Array.isArray(hashes) ? hashes : []).map(function (hash) {
    hash = String(hash).toLowerCase();
    if (!HASH.test(hash) || downloads[hash]) {
      return null;
    }
    var buffer, parsed;
    try {
      buffer = fs.readFileSync(path.join(stateDir, 'torrent-stream', hash + '.torrent'));
      parsed = parseTorrent(buffer);
    } catch (e) {
      return null;
    }
    var meta = metaOf(parsed),
      hasData = files.topEntries(meta.files).some(function (top) { return fs.existsSync(path.join(saveDir, top)); });
    if (!hasData) {
      return null;
    }
    var largest = meta.files.reduce(function (a, b) { return a.size >= b.size ? a : b; }),
      d = {
        row: {
          infoHash: hash, name: meta.name, magnet: null, torrentFile: null, state: 'paused', intent: 'stream', error: null,
          saveDir: saveDir, selectedFiles: [largest.path], sizeBytes: largest.size, doneBytes: 0, uploadedBytes: 0,
          addedBy: null, profileId: null, titleRef: null, removeWhenWatched: false, addedAt: new Date(),
          completedAt: null, lastActiveAt: null
        },
        meta: meta, live: null, inEngine: false, counters: { up: 0, down: 0 }, seedingSince: null, tails: {},
        op: Promise.resolve(), dirty: false, published: null
      };
    d.row.torrentFile = saveTorrentFile(d, buffer);
    downloads[hash] = d;
    imported++;
    return store ? store.create(d.row) : null;
  })).then(function () {
    fs.renameSync(legacy, legacy + '.imported');
    log.info('torrents.json imported: ' + imported + ' paused download' + (imported === 1 ? '' : 's'));
  }).catch(function (err) {
    log.warn('torrents.json not imported: ' + err.message);
  });
}

// Our table is the truth: torrents the engine has and we don't are dropped
// (data kept); active downloads start again (downloads: queued, then pump();
// streams: paused, nobody watches them yet)
function reconcile() {
  return engine.list().then(function (known) {
    var ours = {};
    Object.keys(downloads).forEach(function (h) { ours[h] = true; });
    return Promise.all(known.map(function (hash) {
      if (!ours[hash]) {
        log.info('the engine had ' + hash + ', not a download: dropped (data kept)');
        return engine.stop(hash).catch(function () {});
      }
      downloads[hash].inEngine = true;
      return null;
    }));
  }).then(function () {
    return Promise.all(Object.keys(downloads).map(function (hash) {
      var d = downloads[hash];
      if (isActive(d)) {
        d.row.state = d.row.intent === 'download' ? 'queued' : isDone(d) ? 'completed' : 'paused';
        persist(d, { state: d.row.state });
      }
      // an engine with its own session may have started it: nothing runs
      // until pump() or a player asks
      if (d.inEngine) {
        return (caps.pause ? engine.pause(hash) : engine.stop(hash).then(function () { d.inEngine = false; }))
          .catch(function (err) { log.warn('reconciling ' + hash + ': ' + err.message); });
      }
    }));
  });
}

function load() {
  return (store ? store.list() : Promise.resolve([])).then(function (rows) {
    rows.forEach(function (row) {
      var d = {
        row: row, meta: null, live: null, inEngine: false, counters: { up: 0, down: 0 }, seedingSince: null, tails: {},
        op: Promise.resolve(), dirty: false, published: null
      };
      var buffer = readTorrentFile(d);
      if (buffer) {
        try {
          d.meta = metaOf(parseTorrent(buffer));
        } catch (e) {
          log.warn('unreadable .torrent of ' + row.infoHash + ': ' + e.message);
        }
      }
      downloads[row.infoHash] = d;
    });
  });
}

/**
 * Loads the downloads, starts the engine (`downloads.engine`, else the
 * default when it fails), imports torrents.json, reconciles and resumes.
 * Never rejects: without an engine, adding / streaming answer UNAVAILABLE.
 * @param {{ dataDir: string, stateDir: string, configDir: string, engine?: string,
 *   engineOptions?: object, peerPort?: number, discovery?: boolean }} options
 */
function init(options) {
  engine = null;
  caps = {};
  downloads = {};
  saveDir = options.dataDir;
  torrentDir = path.join(options.configDir, 'torrents');
  discovery = options.discovery !== false;
  var requested = options.engine || settings.get('downloads.engine');
  engineInfo = { id: null, requested: requested, error: null };
  ready = userData.services().then(function (s) {
    store = s.downloads;
  }, function (err) {
    store = null;
    log.error('downloads are not saved (no database): ' + err.message);
  }).then(function () {
    return startEngine(requested, options).catch(function (err) {
      engineInfo.error = requested + ': ' + err.message;
      if (requested === engines.FALLBACK) {
        throw err;
      }
      log.error('torrent engine ' + requested + ' failed to start (' + err.message + '): using ' + engines.FALLBACK);
      return startEngine(engines.FALLBACK, options);
    });
  }).then(attach).then(load).then(function () {
    return importLegacy(options.configDir, options.stateDir);
  }).then(reconcile).then(function () {
    log.info(Object.keys(downloads).length + ' downloads, engine ' + engine.id + ', in ' + saveDir);
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer.unref();
    if (discovery) {
      scrapeTimer = setTimeout(function again() {
        scrapeAll().then(function () {
          if (scrapeTimer) {
            scrapeTimer = setTimeout(again, SCRAPE_MS);
            scrapeTimer.unref();
          }
        });
      }, SCRAPE_FIRST_MS);
      scrapeTimer.unref();
    }
    pump();
  }).catch(function (err) {
    engineInfo.error = engineInfo.error || err.message;
    log.error('no torrent engine: ' + err.message);
  });
  return ready;
}

// Every torrent stopped (data kept), progress saved
function close() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(scrapeTimer);
  scrapeTimer = null;
  return ready.then(function () {
    var current = engine;
    engine = null;
    Object.keys(downloads).forEach(function (h) { downloads[h].dirty = true; });
    return flush().then(function () {
      return current ? current.close() : null;
    });
  }).catch(function (err) {
    log.warn('closing the torrent engine: ' + err.message);
  });
}

module.exports = {
  init: init,
  close: close,
  ready: function () { return ready; },
  add: add,
  prepareStream: prepareStream,
  diskPath: diskPath,
  stream: stream,
  prefetchTail: prefetchTail,
  select: select,
  pause: pause,
  start: start,
  resume: resume,
  remove: remove,
  released: released,
  requeue: requeue,
  describe: describe,
  setRemoveWhenWatched: setRemoveWhenWatched,
  setLabel: setLabel,
  moveInQueue: moveInQueue,
  setForce: setForce,
  setSeedGoal: setSeedGoal,
  setTorrentLimits: setTorrentLimits,
  editTrackers: editTrackers,
  reannounce: reannounce,
  torrentFile: torrentFile,
  scrape: scrapeAll,
  preview: preview,
  peers: peers,
  trackers: trackersOf,
  recheck: recheck,
  pieces: piecesOf,
  speed: speedOf,
  pauseAll: pauseAll,
  resumeAll: resumeAll,
  settingsChanged: settingsChanged,
  get: get,
  list: list,
  files: filesOf,
  torrent: torrent,
  torrentStats: torrentStats,
  totals: totals,
  info: info,
  active: active,
  owners: owners,
  isActive: function (hash) { var d = downloads[hash]; return !!d && isActive(d); },
  // lib/sessions.js#canAdd: hash → Error | null, asked before a stream starts a torrent
  setAdmission: function (fn) { admission = fn; }
};
