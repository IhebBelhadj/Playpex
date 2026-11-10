'use strict';

// Casting (docs/cast-plan.md §4): a sender (a paired device, a client on this
// machine, the admin) asks the server to play something on a screen (a device
// whose events socket says `?control=cast`). The server checks the request
// (§4.4), sends the screen `cast.play` and keeps the cast in memory: which
// sender, which screen, the screen's session once its player sends a
// keepalive with `castId`, and what the screen reports. The sender follows it
// with `cast.updated` / `cast.ended` (to its device and the admin) and drives
// it with POST /cast/{castId}/commands. Nothing goes in the DB: what was
// watched is the session's history.
//
//   cast.screens(req)                   → GET /cast/screens
//   cast.play(req, screenId, body)      → { castId, delivered } (rejects with a coded error)
//   cast.get(castId)                    → the cast, presented
//   cast.report(req, castId, body)      the screen's state (embedded videos: no session)
//   cast.link(castId, lease)            a keepalive naming its cast (lib/api.js, lib/routes/media.js)
//   cast.command(req, castId, body)     → { delivered }
//   cast.maySend(req, sessionId)        the sender of the session's cast may command it
//   cast.unlocked(deviceId, profileId)  a device opened that profile (its PIN): it may cast as it

var crypto = require('crypto'),
  protocol = require('@playpex/protocol'),
  events = require('../events'),
  sessions = require('../sessions'),
  settings = require('../settings'),
  userData = require('../userData'),
  log = require('../logger').child('http');

var CAST = protocol.CAST,
  MAX_CASTS = 200,
  UNLOCK_MS = 12 * 60 * 60 * 1000,
  TEXT_MAX = 300,
  YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/,
  LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

var casts = new Map(),      // castId → cast
  bySession = new Map(),    // sessionId → castId
  unlocks = new Map();      // deviceId + '\n' + profileId → when

function failure(code, message) {
  return Object.assign(new Error(message), { code: code });
}

function now() {
  return Date.now();
}

function sweep() {
  var t = now();
  casts.forEach(function (c, id) {
    var idle = c.endedAt ? t - c.endedAt : t - c.updatedAt;
    if (idle > CAST.KEEP_MS) {
      casts.delete(id);
      if (c.sessionId) {
        bySession.delete(c.sessionId);
      }
    }
  });
  unlocks.forEach(function (at, key) {
    if (t - at > UNLOCK_MS) {
      unlocks.delete(key);
    }
  });
}

// ── who ──────────────────────────────────────────────────────────────────────

function isAdmin(req) {
  return !!(req.auth && req.auth.kind === 'admin');
}

function adminName(req) {
  var u = req.auth && req.auth.user;
  return u ? String(u.name || u.username || u.email || 'Admin') : 'Admin';
}

var CLIENT_NAMES = { 'playpex-tv': 'Playpex TV', 'playpex-mobile': 'Playpex Mobile', 'playpex-dashboard': 'the dashboard' };

// The sender: { deviceId, name } (the device's name, the dashboard's, else what its client is)
function senderOf(req) {
  var d = sessions.device(req),
    client = protocol.parseClientHeader(req.get(protocol.CLIENT_HEADER));
  return { deviceId: d.id, name: d.name || (isAdmin(req) ? adminName(req) : null) ||
    (client && CLIENT_NAMES[client.name]) || 'A device' };
}

function kindOf(client) {
  var name = client && client.name || '';
  return /tv/.test(name) ? 'tv' : /mobile/.test(name) ? 'mobile' : /dashboard/.test(name) ? 'web' : 'other';
}

// ── screens ─────────────────────────────────────────────────────────────────

function present(c) {
  return {
    castId: c.id,
    deviceId: c.screenId,
    from: c.from,
    sessionId: c.sessionId || null,
    state: c.state,
    positionS: c.positionS,
    durationS: c.durationS,
    title: c.title,
    profileId: c.profileId,
    error: c.error || null,
    startedAt: new Date(c.createdAt).toISOString()
  };
}

// The cast running on a screen (the newest one that hasn't ended)
function runningOn(deviceId) {
  var found = null;
  casts.forEach(function (c) {
    if (c.screenId === deviceId && !c.endedAt && (!found || c.createdAt > found.createdAt)) {
      found = c;
    }
  });
  return found;
}

/** The screens a sender may cast to: online devices that take casts, `self` marked */
function screens(req) {
  sweep();
  var me = sessions.device(req).id,
    ids = events.castScreens();
  return require('../auth').listDevices().catch(function () { return []; }).then(function (devices) {
    var named = {};
    devices.forEach(function (d) { named[d.id] = d; });
    var playing = {};
    sessions.list().forEach(function (s) {
      if (s.playback && (!playing[s.deviceId] || s.playback.updatedAt > playing[s.deviceId].playback.updatedAt)) {
        playing[s.deviceId] = s;
      }
    });
    return ids.map(function (id) {
      var control = events.deviceControl(id), d = named[id], c = runningOn(id), s = playing[id];
      return {
        deviceId: id,
        name: d && d.name || (id.indexOf('dashboard-') === 0 ? 'Dashboard' : 'Playpex on ' + require('os').hostname()),
        kind: kindOf(control.client || (d && d.client ? protocol.parseClientHeader(d.client) || { name: d.client } : null)),
        self: id === me,
        online: true,
        accepts: {
          media: control.accepts.indexOf('media') >= 0,
          magnet: control.accepts.indexOf('magnet') >= 0,
          embed: control.accepts.indexOf('embed') >= 0
        },
        playing: c ? { castId: c.id, sessionId: c.sessionId || null, title: c.title, state: c.state, positionS: c.positionS }
          : s ? { castId: null, sessionId: s.id, title: s.playback.title || null, state: s.playback.paused ? 'paused' : 'playing',
            positionS: typeof s.playback.positionS === 'number' ? s.playback.positionS : null } : null
      };
    });
  });
}

// ── the request ─────────────────────────────────────────────────────────────

function text(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max || TEXT_MAX) : null;
}

function int(v, min, max) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min && v <= max ? v : null;
}

/** The CastRequest, checked and trimmed to what the screen may get; throws INVALID */
function normalize(body) {
  if (!body || typeof body !== 'object') {
    throw failure('INVALID', 'A cast request is a JSON object');
  }
  var title = text(body.title);
  if (!title) {
    throw failure('INVALID', 'title: what plays');
  }
  var src = body.source, source;
  if (!src || typeof src !== 'object') {
    throw failure('INVALID', 'source: { ref } | { magnet } | { embed }');
  }
  if (typeof src.ref === 'string') {
    if (!new RegExp(protocol.MEDIA_REF_PATTERN).test(src.ref)) {
      throw failure('INVALID', 'source.ref: a media ref');
    }
    source = { ref: src.ref };
    if (src.format === 'hls' || src.format === 'live' || src.format === 'file') {
      source.format = src.format;
    }
    if (typeof src.infoHash === 'string' && /^[0-9a-f]{40}$/.test(src.infoHash)) {
      source.infoHash = src.infoHash;
    }
    if (text(src.path, 1000)) {
      source.path = text(src.path, 1000);
    }
  } else if (typeof src.magnet === 'string') {
    var magnet = src.magnet.trim();
    if (!/^magnet:\?/i.test(magnet) && !/^[0-9a-fA-F]{40}$/.test(magnet) || magnet.length > 8192) {
      throw failure('INVALID', 'source.magnet: a magnet link or an info hash');
    }
    source = { magnet: magnet };
    if (src.file && typeof src.file === 'object') {
      var file = {};
      if (text(src.file.name, 500)) { file.name = text(src.file.name, 500); }
      if (int(src.file.index, 0, 100000) !== null) { file.index = src.file.index; }
      source.file = file;
    }
  } else if (src.embed && typeof src.embed === 'object') {
    if (CAST.EMBED_PROVIDERS.indexOf(src.embed.provider) < 0 || !YOUTUBE_ID.test(String(src.embed.id || ''))) {
      throw failure('INVALID', 'source.embed: { provider: youtube, id }');
    }
    source = { embed: { provider: src.embed.provider, id: src.embed.id } };
  } else {
    throw failure('INVALID', 'source: { ref } | { magnet } | { embed }');
  }
  var item = body.item && typeof body.item === 'object' ? body.item : {}, out = {
    title: title,
    subtitle: text(body.subtitle),
    year: text(body.year, 10),
    artwork: body.artwork && typeof body.artwork === 'object' ? {
      title: text(body.artwork.title),
      posterPath: text(body.artwork.posterPath, 500),
      backdropPath: text(body.artwork.backdropPath, 500)
    } : null,
    image: typeof body.image === 'string' && /^https:\/\//.test(body.image) ? body.image.slice(0, 1000) : null,
    item: {
      mediaType: item.mediaType === 'movie' || item.mediaType === 'tv' ? item.mediaType : null,
      tmdbId: int(item.tmdbId, 1, 1e9),
      imdbId: typeof item.imdbId === 'string' && /^tt\d{1,12}$/.test(item.imdbId) ? item.imdbId : null,
      season: int(item.season, 0, 10000),
      episode: int(item.episode, 0, 100000)
    },
    source: source,
    positionS: typeof body.positionS === 'number' && isFinite(body.positionS) && body.positionS >= 0 ? body.positionS : null,
    audio: typeof body.audio === 'string' && LANGUAGE.test(body.audio) ? body.audio : null,
    pluginId: typeof body.pluginId === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(body.pluginId) ? body.pluginId : null,
    tracking: body.tracking === 'none' ? 'none' : 'full'
  };
  if (!out.item.mediaType) {
    out.item = null;
  }
  return compact(out);
}

// Without its empty fields (what the screen gets matches CastRequest)
function compact(o) {
  Object.keys(o).forEach(function (k) {
    if (o[k] === null) {
      delete o[k];
    } else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && k !== 'source') {
      compact(o[k]);
    }
  });
  return o;
}

function sourceKind(source) {
  return source.ref ? 'media' : source.magnet ? 'magnet' : 'embed';
}

// Whether the source is an adults plugin's: its ref's plugin (r_ / h_ / l_), a
// library file of an adults-only folder, or the plugin the sender says it came from
function adultsSource(request) {
  var plugins = require('../plugins'),
    isAdults = function (id) {
      var p = id && plugins.get(id);
      return !!(p && p.manifest && p.manifest.audience === 'adults');
    };
  if (isAdults(request.pluginId)) {
    return Promise.resolve(true);
  }
  var ref = request.source.ref;
  if (!ref) {
    return Promise.resolve(false);
  }
  var media = require('../media'), parsed = media.refs.parse(ref);
  if (parsed.kind === 'remote' || parsed.kind === 'hls' || parsed.kind === 'live') {
    var owner = parsed.kind === 'remote' ? require('../plugins/remote').owner(ref) : require('../media/hls').owner(ref);
    if (!owner) {
      return Promise.reject(failure('NOT_FOUND', 'This source has expired: find it again'));
    }
    return Promise.resolve(!owner.core && isAdults(owner.pluginId));
  }
  if (parsed.kind === 'file') {
    return media.resolve(ref).then(function (m) {
      return !!(m.folder && m.folder.audience === 'adults');
    });
  }
  return Promise.resolve(false);
}

// The profile the cast plays as: it must exist, and a locked one needs the
// admin, the device that opened it, or its PIN
function checkProfile(req, request, profileId, pin) {
  if (profileId == null) {
    return Promise.resolve(null);
  }
  if (typeof profileId !== 'string' || !profileId) {
    return Promise.reject(failure('INVALID', 'profileId: a profile id'));
  }
  return userData.services().then(function (s) {
    return s.profiles.get(profileId).catch(function () {
      throw failure('NOT_FOUND', 'No such profile');
    }).then(function (profile) {
      if (!profile.hasPin || isAdmin(req) || unlocks.has(sessions.device(req).id + '\n' + profileId)) {
        return profile;
      }
      if (pin == null) {
        throw failure('CAST_REFUSED', profile.name + '’s profile is locked: its PIN is needed to cast as it');
      }
      return s.profiles.unlock(profileId, String(pin)).then(function () {
        unlocks.set(sessions.device(req).id + '\n' + profileId, now());
        return profile;
      });
    });
  });
}

// The profiles a screen plays as now (its sessions' latest keepalives)
function screenProfiles(deviceId) {
  return sessions.list().filter(function (s) { return s.deviceId === deviceId && s.playback && s.playback.profileId; })
    .map(function (s) { return s.playback.profileId; });
}

function anyKid(ids) {
  if (!ids.length) {
    return Promise.resolve(false);
  }
  return userData.services().then(function (s) {
    return Promise.all(ids.map(function (id) {
      return s.profiles.get(id).then(function (p) { return !!p.isKid; }, function () { return false; });
    }));
  }).then(function (kids) {
    return kids.some(Boolean);
  });
}

// ── casting ─────────────────────────────────────────────────────────────────

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function updated(c) {
  c.updatedAt = now();
  var data = present(c);
  if (c.from.deviceId && c.from.deviceId !== c.screenId) {
    events.publishTo(c.from.deviceId, c.endedAt ? 'cast.ended' : 'cast.updated', data);
  }
  events.publish(c.endedAt ? 'cast.ended' : 'cast.updated', data, { admin: true });
}

function end(c, state, error) {
  if (c.endedAt) {
    return;
  }
  c.state = state || 'ended';
  if (error) {
    c.error = error;
  }
  c.endedAt = now();
  updated(c);
}

/**
 * Sends a CastRequest to a screen.
 * @returns {Promise<{ castId: string, delivered: number }>}
 */
function play(req, screenId, body) {
  sweep();
  var request, from = senderOf(req);
  try {
    request = normalize(body);
  } catch (err) {
    return Promise.reject(err);
  }
  if (!settings.get('cast.enabled')) {
    return Promise.reject(failure('CAST_REFUSED', 'Casting is turned off on this server'));
  }
  var control = events.deviceControl(screenId);
  if (!control.online || !control.cast) {
    return Promise.reject(failure('DEVICE_OFFLINE', 'That screen isn’t on, or doesn’t take casts'));
  }
  if (control.accepts.indexOf(sourceKind(request.source)) < 0) {
    return Promise.reject(failure('UNSUPPORTED', 'That screen can’t play this kind of source'));
  }
  var profileId = body.profileId == null ? null : body.profileId;
  return Promise.all([checkProfile(req, request, profileId, body.pin), adultsSource(request)]).then(function (r) {
    var profile = r[0], adults = r[1];
    if (!adults) {
      return { profile: profile, adults: false };
    }
    if (profile && profile.isKid) {
      throw failure('CAST_REFUSED', 'This can’t be played on a kids profile');
    }
    return anyKid(screenProfiles(screenId)).then(function (kid) {
      if (kid) {
        throw failure('CAST_REFUSED', 'That screen is showing a kids profile');
      }
      return { profile: profile, adults: true };
    });
  }).then(function (checked) {
    if (checked.adults) {
      request.tracking = 'none';
    }
    delete request.pluginId;
    // what ran on that screen is replaced
    var before = runningOn(screenId);
    if (before) {
      end(before, 'ended');
    }
    if (casts.size >= MAX_CASTS) {
      var oldest = null;
      casts.forEach(function (x) { if (!oldest || x.updatedAt < oldest.updatedAt) { oldest = x; } });
      casts.delete(oldest.id);
    }
    var c = {
      id: newId(),
      screenId: screenId,
      from: from,
      profileId: checked.profile ? checked.profile.id : null,
      request: request,
      adults: checked.adults,
      sessionId: null,
      state: 'opening',
      positionS: request.positionS,
      durationS: null,
      title: request.subtitle ? request.title + ' · ' + request.subtitle : request.title,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      endedAt: null
    };
    casts.set(c.id, c);
    var delivered = events.publishTo(screenId, 'cast.play', {
      castId: c.id,
      from: from,
      profileId: c.profileId,
      adults: c.adults,
      request: request
    });
    if (!delivered) {
      casts.delete(c.id);
      throw failure('DEVICE_OFFLINE', 'That screen isn’t on, or doesn’t take casts');
    }
    log.info('cast ' + c.id + ' from ' + from.name + ' to ' + screenId + (checked.adults ? '' : ': ' + c.title));
    updated(c);
    return { castId: c.id, delivered: delivered };
  });
}

function find(castId) {
  return typeof castId === 'string' ? casts.get(castId) || null : null;
}

/** The screen reports its state: { state, positionS?, durationS?, error? } */
function report(req, castId, body) {
  var c = find(castId);
  if (!c) {
    throw failure('NOT_FOUND', 'No such cast');
  }
  if (sessions.device(req).id !== c.screenId) {
    throw failure('FORBIDDEN', 'Only the screen reports its cast');
  }
  body = body || {};
  if (CAST.STATES.indexOf(body.state) < 0) {
    throw failure('INVALID', 'state must be one of ' + CAST.STATES.join(', '));
  }
  if (typeof body.positionS === 'number' && isFinite(body.positionS) && body.positionS >= 0) {
    c.positionS = body.positionS;
  }
  if (typeof body.durationS === 'number' && isFinite(body.durationS) && body.durationS > 0) {
    c.durationS = body.durationS;
  }
  if (body.state === 'ended' || body.state === 'failed') {
    end(c, body.state, text(body.error));
  } else if (!c.endedAt) {
    c.state = body.state;
    updated(c);
  }
  return present(c);
}

/** A keepalive naming its cast: the screen's session is that cast's */
function link(castId, lease) {
  var c = find(castId);
  if (!c || !lease || lease.deviceId !== c.screenId || c.endedAt) {
    return;
  }
  if (c.sessionId !== lease.id) {
    if (c.sessionId) {
      bySession.delete(c.sessionId);
    }
    c.sessionId = lease.id;
    bySession.set(lease.id, c.id);
    updated(c);
  }
}

// The screen's session changed: its state for the sender
events.onPublish(function (topic, data) {
  if ((topic !== 'session.updated' && topic !== 'session.ended') || !data || !bySession.has(data.id)) {
    return;
  }
  var c = find(bySession.get(data.id));
  if (!c) {
    bySession.delete(data.id);
    return;
  }
  if (topic === 'session.ended') {
    bySession.delete(data.id);
    end(c, 'ended');
    return;
  }
  var p = data.playback || {};
  if (typeof p.positionS === 'number') { c.positionS = p.positionS; }
  if (typeof p.durationS === 'number') { c.durationS = p.durationS; }
  if (typeof p.paused === 'boolean' && !c.endedAt) { c.state = p.paused ? 'paused' : 'playing'; }
  updated(c);
});

// A screen that left: its casts end
events.onScreen(function (deviceId, online) {
  if (!online) {
    var c = runningOn(deviceId);
    if (c && !c.sessionId) {
      end(c, 'ended');
    }
  }
});

function mayDrive(req, c) {
  var me = sessions.device(req).id;
  return isAdmin(req) || me === c.from.deviceId || me === c.screenId;
}

/** Pause, resume, toggle, seek, seekBy or stop a cast: the sender, its screen or the admin */
function command(req, castId, body) {
  var c = find(castId);
  if (!c) {
    throw failure('NOT_FOUND', 'No such cast');
  }
  if (!mayDrive(req, c)) {
    throw failure('FORBIDDEN', 'Only who cast it drives it');
  }
  body = body || {};
  var action = body.action, cmd = { action: action }, by = senderOf(req).name;
  if (protocol.REMOTE.SESSION_COMMANDS.indexOf(action) < 0) {
    throw failure('INVALID', 'action must be one of ' + protocol.REMOTE.SESSION_COMMANDS.join(', '));
  }
  if (action === 'seek') {
    if (typeof body.positionS !== 'number' || !isFinite(body.positionS) || body.positionS < 0) {
      throw failure('INVALID', 'seek needs positionS (seconds, ≥ 0)');
    }
    cmd.positionS = body.positionS;
  }
  if (action === 'seekBy') {
    if (typeof body.deltaS !== 'number' || !isFinite(body.deltaS) || Math.abs(body.deltaS) > 24 * 3600) {
      throw failure('INVALID', 'seekBy needs deltaS (seconds)');
    }
    cmd.deltaS = body.deltaS;
  }
  if (c.endedAt) {
    throw failure('NOT_FOUND', 'This cast has ended');
  }
  var lease = c.sessionId ? sessions.find(c.sessionId) : null;
  if (lease && action === 'stop') {
    sessions.stopSession(lease.id, by);
    end(c, 'ended');
    return { delivered: 1 };
  }
  var delivered = lease ? sessions.command(lease, cmd, by) :
    // no session (an embedded video, a player still opening): straight to the screen, by castId
    events.publishTo(c.screenId, 'session.command', Object.assign({ sessionId: null, castId: c.id, infoHash: null, ref: null, by: by }, cmd));
  if (!delivered) {
    throw failure('DEVICE_OFFLINE', 'That screen isn’t connected');
  }
  if (action === 'stop') {
    end(c, 'ended');
  }
  return { delivered: delivered };
}

/** The sender of a session's cast (and its screen) may command it through /sessions/{id}/commands too */
function maySend(req, sessionId) {
  var c = bySession.has(sessionId) ? find(bySession.get(sessionId)) : null;
  return !!(c && mayDrive(req, c));
}

module.exports = {
  screens: screens,
  play: play,
  get: function (castId) {
    var c = find(castId);
    return c ? present(c) : null;
  },
  mayView: function (req, castId) {
    var c = find(castId);
    return !!(c && mayDrive(req, c));
  },
  // the cast a session plays (Activity's "cast from"): { castId, from } or null
  ofSession: function (sessionId) {
    var c = find(bySession.get(sessionId));
    return c && !c.endedAt ? { castId: c.id, from: c.from } : null;
  },
  report: report,
  link: link,
  command: command,
  maySend: maySend,
  unlocked: function (deviceId, profileId) {
    if (deviceId && profileId) {
      unlocks.set(deviceId + '\n' + profileId, now());
    }
  },
  // tests
  reset: function () {
    casts.clear();
    bySession.clear();
    unlocks.clear();
  }
};
