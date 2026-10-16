'use strict';

// Torrent leases, the reaper, limits and live sessions
// (docs/server-separation-plan.md §5.6).
//
// A lease = one device holding one torrent: { infoHash, deviceId, lastActivity }.
// Adding a torrent, streaming one of its files and the player's keepalive
// acquire or refresh it; DELETE /torrents/:hash releases the caller's. The
// engine stops only when no lease is left, after GRACE_MS (another client may
// still be about to start), and its data is deleted when
// storage.deleteAfterWatching is on. The reaper drops leases idle for longer
// than streaming.idleTimeoutMinutes (a client that crashed or lost the
// network), except while one of their streams is still open.
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
  store = require('./store'),
  stats = require('./stats'),
  events = require('./events'),
  settings = require('./settings'),
  log = require('./logger').child('torrent');

var GRACE_MS = 30 * 1000,
  REAP_EVERY_MS = 60 * 1000,
  DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

var torrents = {},     // infoHash → { leases: { deviceId → lease }, timer }
  transcodes = [],     // { deviceId, infoHash, path, res }
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

function entry(infoHash) {
  return torrents[infoHash] || (torrents[infoHash] = { leases: {}, timer: null });
}

// Acquires (or refreshes) the lease of the request's device on a torrent
function acquire(infoHash, req) {
  var dev = device(req),
    t = entry(infoHash),
    lease = t.leases[dev.id],
    now = Date.now();
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
    log.debug('kept ' + infoHash + ': ' + dev.id + ' came back');
  }
  if (!lease) {
    lease = t.leases[dev.id] = {
      id: crypto.randomBytes(8).toString('hex'),
      infoHash: infoHash,
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
    log.info('lease ' + infoHash + ' → ' + dev.id, { leases: Object.keys(t.leases).length });
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

// Releases the request's (or `deviceId`'s) lease; true if it had one
function release(infoHash, deviceId) {
  var t = torrents[infoHash],
    lease = t && t.leases[deviceId];
  if (!lease) {
    return false;
  }
  delete t.leases[deviceId];
  log.info('released ' + infoHash + ' by ' + deviceId, { leases: Object.keys(t.leases).length });
  events.publish('session.ended', { id: lease.id, deviceId: deviceId, infoHash: infoHash });
  if (!Object.keys(t.leases).length) {
    scheduleEnd(infoHash);
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
  var t = torrents[infoHash];
  if (t) {
    if (Object.keys(t.leases).length) {
      return;
    }
    clearTimeout(t.timer);
    delete torrents[infoHash];
  }
  if (!store.get(infoHash)) {
    return;
  }
  if (settings.get('storage.deleteAfterWatching')) {
    log.info('no client left: removing ' + infoHash + ' and its data');
    store.remove(infoHash);
  } else {
    log.info('no client left: stopping ' + infoHash + ' (data kept)');
    store.close(infoHash);
  }
}

// ── streams ────────────────────────────────────────────────────────────────

// A media response of `lease` (direct file or transcode): the lease stays
// active while it is open
function trackStream(lease, req, res, file, method) {
  var path = file.path;
  lease.lastActivity = Date.now();
  if (!req.query.internal) {
    lease.file = path;
    lease.method = method;
  }
  lease.streams.add(res);
  res.on('close', function () {
    lease.streams.delete(res);
    lease.lastActivity = Date.now();
  });
}

// Room for a transcode of `file` by `lease`'s device, or false (BUSY). The
// device's previous transcode of the same file is the one being replaced (the
// player restarts the stream on every seek): it is closed instead of counted.
function takeTranscodeSlot(lease, file, res) {
  transcodes = transcodes.filter(function (t) {
    if (t.deviceId === lease.deviceId && t.infoHash === lease.infoHash && t.path === file.path) {
      t.res.destroy();
      return false;
    }
    return !t.res.destroyed && !t.res.writableEnded;
  });
  if (transcodes.length >= settings.get('streaming.maxTranscodes')) {
    return false;
  }
  var slot = { deviceId: lease.deviceId, infoHash: lease.infoHash, path: file.path, res: res };
  transcodes.push(slot);
  res.on('close', function () {
    transcodes = transcodes.filter(function (t) { return t !== slot; });
  });
  return true;
}

// ── limits ─────────────────────────────────────────────────────────────────

// store.add's beforeAdd: a new torrent past streaming.maxTorrents is refused,
// after ending the torrents nobody holds any more (waiting out their grace)
function canAdd() {
  var max = settings.get('streaming.maxTorrents');
  if (store.list().length >= max) {
    store.list().forEach(function (torrent) {
      var t = torrents[torrent.infoHash];
      if (!t || !Object.keys(t.leases).length) {
        end(torrent.infoHash);
      }
    });
  }
  if (store.list().length >= max) {
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

// What the player reports with its keepalive (all optional)
function report(lease, body) {
  var state = {};
  Object.keys(PLAYBACK_FIELDS).forEach(function (k) {
    var v = body && body[k];
    if (typeof v === PLAYBACK_FIELDS[k] && (typeof v !== 'number' || isFinite(v)) &&
      (typeof v !== 'string' || v.length <= 300)) {
      state[k] = v;
    }
  });
  if (Object.keys(state).length) {
    lease.playback = _.extend({}, lease.playback, state, { updatedAt: Date.now() });
    if (state.file) {
      lease.file = state.file;
    }
    events.publish('session.updated', present(lease));
  }
}

// ── reaper ─────────────────────────────────────────────────────────────────

function reap() {
  var idle = options.idleMs || settings.get('streaming.idleTimeoutMinutes') * 60 * 1000,
    now = Date.now();
  Object.keys(torrents).forEach(function (infoHash) {
    var t = torrents[infoHash];
    _.values(t.leases).forEach(function (lease) {
      if (!lease.streams.size && now - lease.lastActivity > idle) {
        log.info('lease of ' + lease.deviceId + ' on ' + infoHash + ' idle for ' +
          Math.round((now - lease.lastActivity) / 1000) + ' s: dropped');
        release(infoHash, lease.deviceId);
      }
    });
  });
  // torrents no lease ever covered (e.g. added before a restart of this module)
  store.list().forEach(function (torrent) {
    if (!torrents[torrent.infoHash]) {
      scheduleEnd(torrent.infoHash);
    }
  });
}

// ── sessions ───────────────────────────────────────────────────────────────

function present(lease) {
  var torrent = store.get(lease.infoHash),
    s = torrent ? stats(torrent) : null,
    name = torrent && torrent.torrent ? torrent.torrent.name : null,
    length = torrent && torrent.torrent ? torrent.torrent.length : null;
  return {
    id: lease.id,
    deviceId: lease.deviceId,
    deviceName: lease.deviceName || null,
    paired: !!lease.paired,
    client: lease.client,
    address: lease.address,
    infoHash: lease.infoHash,
    torrentName: name,
    file: lease.file,
    method: lease.method,
    streaming: lease.streams.size > 0,
    since: new Date(lease.since).toISOString(),
    lastActivity: new Date(lease.lastActivity).toISOString(),
    playback: lease.playback ? _.extend({}, _.omit(lease.playback, 'updatedAt'),
      { updatedAt: new Date(lease.playback.updatedAt).toISOString() }) : null,
    torrent: s ? {
      peers: s.peers.total,
      downloadSpeed: s.speed.down,
      uploadSpeed: s.speed.up,
      downloaded: s.traffic.down,
      length: length
    } : null
  };
}

function list() {
  return _.flatten(_.values(torrents).map(function (t) { return _.values(t.leases); }))
    .sort(function (a, b) { return a.since - b.since; })
    .map(present);
}

function find(id) {
  var found = null;
  _.values(torrents).forEach(function (t) {
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
  release(lease.infoHash, lease.deviceId);
  return true;
}

// A revoked device: its streams are closed and its leases released
function dropDevice(deviceId) {
  _.values(torrents).forEach(function (t) {
    var lease = t.leases[deviceId];
    if (lease) {
      lease.streams.forEach(function (res) { res.destroy(); });
      release(lease.infoHash, deviceId);
    }
  });
  transcodes.filter(function (t) { return t.deviceId === deviceId; }).forEach(function (t) { t.res.destroy(); });
}

// Torrents with at least one lease, for the events' torrent.stats
function activeStats() {
  return Object.keys(torrents).map(function (infoHash) {
    var torrent = store.get(infoHash);
    if (!torrent || !Object.keys(torrents[infoHash].leases).length) {
      return null;
    }
    var st = stats(torrent);
    return {
      infoHash: infoHash,
      peers: st.peers.total,
      downloadSpeed: st.speed.down,
      uploadSpeed: st.speed.up,
      downloaded: st.traffic.down
    };
  }).filter(Boolean);
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function start() {
  if (!reaper) {
    reaper = setInterval(reap, REAP_EVERY_MS);
    reaper.unref();
  }
}

// For stop(): forgets every lease (store.destroyAll stops the engines)
function stop() {
  clearInterval(reaper);
  reaper = null;
  _.values(torrents).forEach(function (t) { clearTimeout(t.timer); });
  torrents = {};
  transcodes = [];
}

module.exports = {
  device: device,
  acquire: acquire,
  release: release,
  trackStream: trackStream,
  takeTranscodeSlot: takeTranscodeSlot,
  canAdd: canAdd,
  report: report,
  reap: reap,
  list: list,
  stopSession: stopSession,
  dropDevice: dropDevice,
  activeStats: activeStats,
  count: function () { return list().length; },
  start: start,
  stop: stop,
  // tests: shorter grace period / idle timeout ({ graceMs, idleMs })
  configure: function (opts) { _.extend(options, opts); }
};
