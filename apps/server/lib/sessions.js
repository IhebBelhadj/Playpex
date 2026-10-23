'use strict';

// Leases, the reaper, limits and live sessions
// (docs/server-separation-plan.md §5.6).
//
// A lease = one device holding one media: { key, deviceId, lastActivity }.
// The key is a torrent's info hash (every file of a torrent, every route), or
// the media ref of a disk file (lib/media). Adding a torrent, streaming a
// file and the player's keepalive acquire or refresh it; DELETE
// /torrents/:hash and DELETE /media/:ref release the caller's. When no lease
// on a torrent is left, after GRACE_MS (another client may still be about to
// start), the torrent client is told (lib/torrents/client.js#released): a
// stream pauses (data kept), a download keeps going; nothing is deleted here. The
// reaper drops leases idle for longer than streaming.idleTimeoutMinutes (a
// client that crashed or lost the network), except while one of their
// streams is still open.
//
// Sessions (GET /sessions, the dashboard's Activity) are the leases, with
// what the device plays: file, play method, position and title from the
// keepalive, and the torrent's swarm numbers.
//
// Devices: a paired device is the one its token names (lib/auth, req.auth).
// Clients that aren't paired (local ones on loopback, the admin, our own
// ffmpeg) say which device they are: `X-Playpex-Device: <id>` or
// `?device=<id>` (media elements can't set headers), else their address
// (`addr:<ip>`).
//
// Events (lib/events.js): session.started / session.updated / session.ended.

var crypto = require('crypto'),
  _ = require('lodash'),
  protocol = require('@playpex/protocol'),
  torrents = require('./torrents/client'),
  events = require('./events'),
  settings = require('./settings'),
  log = require('./logger').child('torrent');

var GRACE_MS = 30 * 1000,
  REAP_EVERY_MS = 60 * 1000,
  DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/,
  INFO_HASH = /^[0-9a-f]{40}$/;

var held = {},         // key (info hash / disk ref) → { leases: { deviceId → lease }, timer, watched }
  transcodes = [],     // { deviceId, key, path, res }
  reaper = null,
  options = { graceMs: GRACE_MS };

// ── devices ────────────────────────────────────────────────────────────────

// { id, name, paired, client, address } of a request's device
function device(req) {
  var paired = req.auth && req.auth.kind === 'device' ? req.auth.device : null,
    id = paired ? paired.id : req.get(protocol.DEVICE_HEADER) || req.query[protocol.DEVICE_PARAM],
    client = protocol.parseClientHeader(req.get(protocol.CLIENT_HEADER)),
    address = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (typeof id !== 'string' || !DEVICE_ID.test(id)) {
    id = 'addr:' + (address || 'unknown');
  }
  return {
    id: id,
    name: paired ? paired.name || null : null,
    paired: !!paired,
    client: client && client.name ? client.name + (client.version ? '/' + client.version : '') :
      paired ? paired.client || null : null,
    address: address
  };
}

// ── leases ─────────────────────────────────────────────────────────────────

function entry(key) {
  return held[key] || (held[key] = { leases: {}, timer: null, watched: false });
}

// The request's device's lease on `key`, if it has one (nothing acquired)
function current(key, req) {
  var t = held[key];
  return t && t.leases[device(req).id] || null;
}

// Acquires (or refreshes) the lease of the request's device on a torrent (its
// info hash) or a disk file (its media ref)
function acquire(key, req) {
  var infoHash = INFO_HASH.test(key) ? key : null,
    dev = device(req),
    t = entry(key),
    lease = t.leases[dev.id],
    now = Date.now();
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
    log.debug('kept ' + key + ': ' + dev.id + ' came back');
  }
  if (!lease) {
    lease = t.leases[dev.id] = {
      id: crypto.randomBytes(8).toString('hex'),
      key: key,
      infoHash: infoHash,   // null for a disk file
      ref: null,            // the media ref last streamed
      deviceId: dev.id,
      deviceName: dev.name,
      paired: dev.paired,
      client: dev.client,
      address: dev.address,
      since: now,
      lastActivity: now,
      streams: new Set(),   // open responses (files / transcode)
      file: null,
      method: null,
      playback: null
    };
    log.info('lease ' + key + ' → ' + dev.id, { leases: Object.keys(t.leases).length });
    events.publish('session.started', present(lease));
  }
  lease.lastActivity = now;
  if (dev.client) {
    lease.client = dev.client;
  }
  if (dev.name) {
    lease.deviceName = dev.name;
  }
  return lease;
}

// Releases `deviceId`'s lease on `key`; true if it had one
function release(key, deviceId) {
  var t = held[key],
    lease = t && t.leases[deviceId];
  if (!lease) {
    return false;
  }
  delete t.leases[deviceId];
  // the player got to the end ("remove when watched", lib/torrents)
  var p = lease.playback;
  if (p && p.durationS > 0 && p.positionS >= p.durationS * 0.9) {
    t.watched = true;
  }
  log.info('released ' + key + ' by ' + deviceId, { leases: Object.keys(t.leases).length });
  events.publish('session.ended', { id: lease.id, deviceId: deviceId, infoHash: lease.infoHash, ref: lease.ref });
  if (lease.started) {
    playbackEvent('playback.ended', lease);
  }
  if (!Object.keys(t.leases).length) {
    if (lease.infoHash) {
      scheduleEnd(key);
    } else {
      delete held[key];   // a disk file: nothing to stop
    }
  }
  return true;
}

// No lease left: stop the torrent after the grace period, unless a device
// acquires it again before
function scheduleEnd(infoHash) {
  var t = entry(infoHash);
  if (t.timer) {
    return;
  }
  t.timer = setTimeout(function () {
    end(infoHash);
  }, options.graceMs);
  if (t.timer.unref) {
    t.timer.unref();
  }
}

function end(infoHash) {
  var t = held[infoHash], watched = false;
  if (t) {
    if (Object.keys(t.leases).length) {
      return;
    }
    clearTimeout(t.timer);
    watched = t.watched;
    delete held[infoHash];
  }
  torrents.released(infoHash, { watched: watched });
}

// ── streams ────────────────────────────────────────────────────────────────

// A media response of `lease` (direct file or transcode) for `media`
// (lib/media): the lease stays active while it is open
function trackStream(lease, req, res, media, method) {
  lease.lastActivity = Date.now();
  if (!req.query.internal) {
    lease.file = media.path;
    lease.ref = media.ref;
    lease.method = method;
  }
  lease.streams.add(res);
  res.on('close', function () {
    lease.streams.delete(res);
    lease.lastActivity = Date.now();
  });
}

// Room for a transcode of `media` by `lease`'s device, or false (BUSY). The
// device's previous transcode of the same file is the one being replaced (the
// player restarts the stream on every seek): it is closed instead of counted.
function takeTranscodeSlot(lease, media, res) {
  transcodes = transcodes.filter(function (t) {
    if (t.deviceId === lease.deviceId && t.key === lease.key && t.path === media.path) {
      t.res.destroy();
      return false;
    }
    return !t.res.destroyed && !t.res.writableEnded;
  });
  if (transcodes.length >= settings.get('streaming.maxTranscodes')) {
    return false;
  }
  var slot = { deviceId: lease.deviceId, key: lease.key, path: media.path, res: res };
  transcodes.push(slot);
  res.on('close', function () {
    transcodes = transcodes.filter(function (t) { return t !== slot; });
  });
  return true;
}

// ── limits ─────────────────────────────────────────────────────────────────

// The torrent client's admission (asked before a stream starts a torrent):
// past streaming.maxTorrents active torrents, room is made by stopping the
// streams nobody holds any more (waiting out their grace), then by sending a
// download nobody watches back to the queue; else BUSY.
function canAdd(infoHash) {
  var max = settings.get('streaming.maxTorrents');
  function others() {
    return torrents.active().filter(function (a) { return a.infoHash !== infoHash; });
  }
  function unheld(a) {
    var t = held[a.infoHash];
    return !t || !Object.keys(t.leases).length;
  }
  if (others().length >= max) {
    others().filter(function (a) { return a.intent === 'stream' && unheld(a); }).forEach(function (a) {
      end(a.infoHash);
    });
  }
  var downloads = others().filter(function (a) { return a.intent === 'download' && unheld(a); });
  while (others().length >= max && downloads.length) {
    torrents.requeue(downloads.pop().infoHash);
  }
  if (others().length >= max) {
    var err = new Error('This server already streams ' + max + ' torrents; stop one or try again later');
    err.code = 'BUSY';
    return err;
  }
  return null;
}

// ── keepalive / playback state ─────────────────────────────────────────────

var PLAYBACK_FIELDS = {
  positionS: 'number', durationS: 'number', paused: 'boolean', title: 'string', profileId: 'string', file: 'string'
};

// `media` of a keepalive: { mediaType: 'movie' | 'tv', tmdbId, season?, episode? }, or null
function mediaRef(media) {
  if (!media || typeof media !== 'object' || ['movie', 'tv'].indexOf(media.mediaType) === -1 ||
    !(Number.isInteger(media.tmdbId) && media.tmdbId > 0)) {
    return null;
  }
  var ref = { mediaType: media.mediaType, tmdbId: media.tmdbId };
  ['season', 'episode'].forEach(function (k) {
    if (Number.isInteger(media[k]) && media[k] >= 0) {
      ref[k] = media[k];
    }
  });
  return ref;
}

// What plays, for plugins' playback events: never the magnet, path or ref
function sourceKind(lease) {
  if (lease.ref && lease.ref.indexOf('f_') === 0) {
    return 'file';
  }
  if (lease.ref && lease.ref.indexOf('r_') === 0) {
    return 'plugin';
  }
  var d = lease.infoHash && torrents.get(lease.infoHash);
  return d && d.intent === 'download' ? 'download' : 'torrent';
}

// playback.* for the plugins' event bus (docs/plugins-plan.md §4.4; internal
// events, lib/plugins/bus.js): only a title the player named (`media`: never
// with tracking none, the TV doesn't name those) and a profile
function playbackEvent(name, lease) {
  var p = lease.playback || {};
  if (!lease.media || !p.profileId) {
    return;
  }
  var m = lease.media,
    episode = m.mediaType === 'tv' && m.season > 0 && m.episode > 0,
    title = { kind: m.mediaType === 'movie' ? 'movie' : episode ? 'episode' : 'show', tmdbId: m.tmdbId };
  if (episode) {
    title.season = m.season;
    title.episode = m.episode;
  }
  events.publish(name, {
    profileId: p.profileId,
    device: { id: lease.deviceId, name: lease.deviceName || '' },
    title: title,
    position: p.positionS || 0,
    duration: p.durationS > 0 ? p.durationS : null,
    source: sourceKind(lease)
  }, { internal: true });
}

// The playback.* event a report means: started (the first), paused (play → pause),
// finished (≥ 90 % the first time), else progress
function playbackEvents(lease, before) {
  var p = lease.playback || {};
  if (!lease.media || !p.profileId) {
    return;
  }
  if (!lease.started) {
    lease.started = true;
    playbackEvent('playback.started', lease);
  } else if (p.paused && !(before && before.paused)) {
    playbackEvent('playback.paused', lease);
  } else {
    playbackEvent('playback.progress', lease);
  }
  if (!lease.finished && p.durationS > 0 && p.positionS >= p.durationS * 0.9) {
    lease.finished = true;
    playbackEvent('playback.finished', lease);
  }
}

// What the player reports with its keepalive (all optional)
function report(lease, body) {
  var state = {}, media = mediaRef(body && body.media);
  if (media) {
    lease.media = { mediaType: media.mediaType, tmdbId: media.tmdbId, season: media.season, episode: media.episode };
  }
  Object.keys(PLAYBACK_FIELDS).forEach(function (k) {
    var v = body && body[k];
    if (typeof v === PLAYBACK_FIELDS[k] && (typeof v !== 'number' || isFinite(v)) &&
      (typeof v !== 'string' || v.length <= 300)) {
      state[k] = v;
    }
  });
  // which title the download is ("Inception (2010), started on Living room TV")
  if (lease.infoHash && (media || state.profileId)) {
    torrents.describe(lease.infoHash, {
      titleRef: media ? Object.assign(media, state.title ? { title: state.title } : {}) : null,
      profileId: state.profileId
    });
  }
  if (Object.keys(state).length) {
    var before = lease.playback;
    lease.playback = _.extend({}, lease.playback, state, { updatedAt: Date.now() });
    if (state.file) {
      lease.file = state.file;
    }
    events.publish('session.updated', present(lease));
    playbackEvents(lease, before);
  }
}

// ── reaper ─────────────────────────────────────────────────────────────────

function reap() {
  var idle = options.idleMs || settings.get('streaming.idleTimeoutMinutes') * 60 * 1000,
    now = Date.now();
  Object.keys(held).forEach(function (key) {
    var t = held[key];
    _.values(t.leases).forEach(function (lease) {
      if (!lease.streams.size && now - lease.lastActivity > idle) {
        log.info('lease of ' + lease.deviceId + ' on ' + key + ' idle for ' +
          Math.round((now - lease.lastActivity) / 1000) + ' s: dropped');
        release(key, lease.deviceId);
      }
    });
  });
  // running streams no lease covers (e.g. started before a restart of this module)
  torrents.active().forEach(function (a) {
    if (a.intent === 'stream' && !held[a.infoHash]) {
      scheduleEnd(a.infoHash);
    }
  });
}

// ── sessions ───────────────────────────────────────────────────────────────

function present(lease) {
  var d = torrents.get(lease.infoHash),
    s = d && torrents.isActive(lease.infoHash) ? d : null;
  return {
    id: lease.id,
    deviceId: lease.deviceId,
    deviceName: lease.deviceName || null,
    paired: !!lease.paired,
    client: lease.client,
    address: lease.address,
    infoHash: lease.infoHash,
    ref: lease.ref,
    torrentName: d ? d.name : null,
    file: lease.file,
    method: lease.method,
    streaming: lease.streams.size > 0,
    since: new Date(lease.since).toISOString(),
    lastActivity: new Date(lease.lastActivity).toISOString(),
    playback: lease.playback ? _.extend({}, _.omit(lease.playback, 'updatedAt'),
      { updatedAt: new Date(lease.playback.updatedAt).toISOString() }) : null,
    torrent: s ? {
      peers: s.peers,
      downloadSpeed: s.downloadSpeed,
      uploadSpeed: s.uploadSpeed,
      downloaded: s.doneBytes,
      length: s.sizeBytes
    } : null
  };
}

function list() {
  return _.flatten(_.values(held).map(function (t) { return _.values(t.leases); }))
    .sort(function (a, b) { return a.since - b.since; })
    .map(present);
}

function find(id) {
  var found = null;
  _.values(held).forEach(function (t) {
    _.values(t.leases).forEach(function (lease) {
      if (lease.id === id) {
        found = lease;
      }
    });
  });
  return found;
}

// Ends a session: closes its streams and releases its lease
function stopSession(id) {
  var lease = find(id);
  if (!lease) {
    return false;
  }
  log.info('session ' + id + ' of ' + lease.deviceId + ' stopped');
  lease.streams.forEach(function (res) { res.destroy(); });
  release(lease.key, lease.deviceId);
  return true;
}

// A revoked device: its streams are closed and its leases released
function dropDevice(deviceId) {
  _.values(held).forEach(function (t) {
    var lease = t.leases[deviceId];
    if (lease) {
      lease.streams.forEach(function (res) { res.destroy(); });
      release(lease.key, deviceId);
    }
  });
  transcodes.filter(function (t) { return t.deviceId === deviceId; }).forEach(function (t) { t.res.destroy(); });
}

// A torrent the admin removes: its sessions end (streams closed, leases
// released without telling the torrent client: it forgets the torrent itself)
function dropTorrent(infoHash) {
  var t = held[infoHash];
  if (!t) {
    return;
  }
  clearTimeout(t.timer);
  delete held[infoHash];
  _.values(t.leases).forEach(function (lease) {
    lease.streams.forEach(function (res) { res.destroy(); });
    events.publish('session.ended', { id: lease.id, deviceId: lease.deviceId, infoHash: infoHash, ref: lease.ref });
    if (lease.started) {
      playbackEvent('playback.ended', lease);
    }
  });
  transcodes.filter(function (x) { return x.key === infoHash; }).forEach(function (x) { x.res.destroy(); });
}

// Torrents with at least one lease, for the events' torrent.stats
function activeStats() {
  return Object.keys(held).filter(function (key) { return INFO_HASH.test(key); }).map(function (infoHash) {
    var d = torrents.get(infoHash);
    if (!d || !torrents.isActive(infoHash) || !Object.keys(held[infoHash].leases).length) {
      return null;
    }
    var st = torrents.torrentStats(infoHash);
    return {
      infoHash: infoHash,
      peers: st.peers.total,
      downloadSpeed: st.speed.down,
      uploadSpeed: st.speed.up,
      downloaded: st.traffic.down
    };
  }).filter(Boolean);
}

// Whether a device holds the torrent (removing it from the dashboard: ask first)
function holders(infoHash) {
  var t = held[infoHash];
  return t ? Object.keys(t.leases).length : 0;
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function start() {
  torrents.setAdmission(canAdd);
  if (!reaper) {
    reaper = setInterval(reap, REAP_EVERY_MS);
    reaper.unref();
  }
}

// For stop(): forgets every lease (the torrent client stops the engine)
function stop() {
  clearInterval(reaper);
  reaper = null;
  _.values(held).forEach(function (t) { clearTimeout(t.timer); });
  held = {};
  transcodes = [];
}

module.exports = {
  device: device,
  acquire: acquire,
  current: current,
  release: release,
  trackStream: trackStream,
  takeTranscodeSlot: takeTranscodeSlot,
  canAdd: canAdd,
  report: report,
  mediaRef: mediaRef,
  reap: reap,
  list: list,
  stopSession: stopSession,
  dropDevice: dropDevice,
  dropTorrent: dropTorrent,
  holders: holders,
  activeStats: activeStats,
  count: function () { return list().length; },
  start: start,
  stop: stop,
  // tests: shorter grace period / idle timeout ({ graceMs, idleMs })
  configure: function (opts) { _.extend(options, opts); }
};
