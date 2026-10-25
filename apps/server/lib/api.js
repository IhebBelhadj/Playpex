'use strict';

const path = require('path');

var _ = require('lodash'),
  express = require('express'),
  multipart = require('connect-multiparty'),
  youtube = require('./youtube'),
  mediaFiles = require('./media/files'),
  releases = require('./releases'),
  searchSources = require('./search/sources'),
  imdb = require('./imdb'),
  subtitles = require('./subtitles'),
  fs = require('fs'),
  torrents = require('./torrents/client'),
  media = require('./routes/media'),
  sessions = require('./sessions'),
  settings = require('./settings'),
  middleware = require('./middleware'),
  authHttp = require('./auth/http'),
  errors = require('./errors'),
  protocol = require('@playpex/protocol'),
  log = require('./logger').child('http'),
  api = express(),
  v1 = express.Router(),
  axios = require('axios').default;


api.disable('x-powered-by');
api.use(middleware.requestLog);
api.use(middleware.hostCheck);
api.use(middleware.cors);
// Better Auth reads its own request bodies: before the parsers
api.use(protocol.API_PREFIX + '/auth', clientVersion, authHttp.betterAuth);
api.use(express.urlencoded({ extended: false }));
api.use(express.json());
api.use(protocol.API_PREFIX, clientVersion, v1);

var fail = errors.fail;

// Every route lives under /api/v1 (docs/server-separation-plan.md §6.1); the
// unversioned aliases the TV app used before were removed with step 9.

// Optional `X-Playpex-Client: <name>/<version>; api=<n>`: refuse API versions
// this server can't serve. Clients that send nothing are served.
function clientVersion(req, res, next) {
  var client = protocol.parseClientHeader(req.get(protocol.CLIENT_HEADER));
  if (client && client.api !== null) {
    if (client.api < protocol.MIN_API_VERSION) {
      return fail(res, 'CLIENT_TOO_OLD', 'This server needs API version ' + protocol.MIN_API_VERSION +
        ' or newer; update ' + (client.name || 'the client'));
    }
    if (client.api > protocol.API_VERSION) {
      return fail(res, 'SERVER_TOO_OLD', 'This server speaks API version ' + protocol.API_VERSION + '; update the server');
    }
  }
  next();
}

// Open to everyone: who this server is (clients probe it before pairing)
v1.use('/server', require('./routes/server'));
// Open to everyone: the API contract, and the client author guide (docs/api,
// rendered by the dashboard at /docs, plan step 10)
v1.get('/openapi.yaml', function (req, res) {
  res.type('application/yaml');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(require.resolve('@playpex/protocol/openapi.yaml'));
});
v1.get('/docs', function (req, res) {
  res.redirect(302, '/docs');
});
// The dashboard's routes: the admin's session (first-run setup excepted)
v1.use('/admin', require('./routes/admin'));
// Recovery mode (the port belonged to another program, index.js#startOrRecover):
// only the dashboard and its routes above are served
v1.use(function (req, res, next) {
  var running = require('../index').info();
  if (running && running.recovery) {
    return fail(res, 'BUSY', 'The server is in recovery mode (port ' + running.recovery.port +
      ' is in use); choose another port in the dashboard');
  }
  next();
});
// Everything below: a paired device, a client on this machine, or the admin
// (lib/auth). Without → 401 PAIRING_REQUIRED.
v1.use(authHttp.requireClient);
v1.use('/devices', require('./routes/devices'));

// Answers a torrent client failure (lib/torrents/client.js err.code)
var failed = errors.failed;

function findTorrent(req, res, next) {
  var download = req.download = torrents.get(req.params.infoHash);
  if (!download) {
    return fail(res, 'NOT_FOUND', 'No such torrent: ' + req.params.infoHash);
  }
  req.infoHash = download.infoHash;
  next();
}

// The calling device holds the torrent (acquires or refreshes its lease, lib/sessions.js)
function lease(req, res, next) {
  req.lease = sessions.acquire(req.infoHash, req);
  next();
}

// Who adds a torrent: the device (lib/sessions.js#device), or the admin
function addedBy(req) {
  return req.auth && req.auth.kind === 'admin' ? 'admin' : sessions.device(req).id;
}

// Adding for a player: a stream download, held by the calling device
function addForStream(req, res, link) {
  return torrents.add(link, { intent: 'stream', by: addedBy(req) }).then(function (infoHash) {
    sessions.acquire(infoHash, req);
    res.send({ infoHash: infoHash });
  }, function (err) {
    failed(res, err);
  });
}

// What runs now (streams and downloads); GET /downloads lists every download
v1.get('/torrents', function (req, res) {
  res.send(torrents.active().map(function (a) { return torrents.torrent(a.infoHash); }));
});

v1.post('/torrents', function (req, res) {
  addForStream(req, res, req.body && req.body.link);
});

// A .torrent file (multipart `file`); read here, never as a path by the client
function readUpload(req) {
  var file = req.files && req.files.file;
  if (!file) {
    return Promise.reject(Object.assign(new Error('file is missing'), { code: 'INVALID' }));
  }
  return fs.promises.readFile(file.path).finally(function () {
    fs.unlink(file.path, function (err) {
      if (err) {
        log.warn('cannot delete upload', { err: err });
      }
    });
  });
}

v1.post('/upload', multipart(), function (req, res) {
  readUpload(req).then(function (buffer) {
    return addForStream(req, res, buffer);
  }, function (err) {
    failed(res, err);
  });
});

// The torrent; with its files, `chosen` = the file to play (lib/media/files#choose:
// ?season=&episode= an episode's, ?fileName= / ?fileIndex= a plugin's, else the film)
v1.get('/torrents/:infoHash', findTorrent, function (req, res) {
  var answer = torrents.torrent(req.infoHash), q = req.query, int = function (v) {
    var n = parseInt(v, 10);
    return /^\d{1,5}$/.test(String(v)) ? n : undefined;
  };
  if (answer.files) {
    var chosen = mediaFiles.choose(answer.files.map(function (f) { return Object.assign({}, f, { size: f.length }); }), {
      season: int(q.season), episode: int(q.episode), fileIndex: int(q.fileIndex),
      fileName: typeof q.fileName === 'string' ? q.fileName.slice(0, 500) : undefined
    });
    answer.chosen = chosen ? chosen.path : null;
  }
  res.send(answer);
});

// Selects a file (by its index in `files`) or, out of range, every file
function selectByIndex(req, selected) {
  var all = torrents.files(req.infoHash) || [], index = parseInt(req.params.index, 10),
    current = all.filter(function (f) { return f.selected; }).map(function (f) { return f.path; });
  if (!(index >= 0 && index < all.length)) {
    return selected ? null : [];
  }
  var target = all[index].path;
  return selected ? current.concat(current.indexOf(target) === -1 ? [target] : []) :
    current.filter(function (p) { return p !== target; });
}

v1.post('/torrents/:infoHash/start/:index?', findTorrent, function (req, res) {
  torrents.select(req.infoHash, selectByIndex(req, true)).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

v1.post('/torrents/:infoHash/stop/:index?', findTorrent, function (req, res) {
  torrents.select(req.infoHash, selectByIndex(req, false)).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

// Stops the torrent's traffic (kept across restarts); resume starts it again
v1.post('/torrents/:infoHash/pause', findTorrent, function (req, res) {
  torrents.pause(req.infoHash).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

v1.post('/torrents/:infoHash/resume', findTorrent, function (req, res) {
  torrents.resume(req.infoHash).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

// The calling device lets go of the torrent. 30 s after the last device let
// go, a stream pauses (its data stays); nothing is deleted.
v1.delete('/torrents/:infoHash', findTorrent, function (req, res) {
  sessions.release(req.infoHash, sessions.device(req).id);
  res.json({ ok: true });
});

// The player is still open (paused videos make no requests), with what it
// plays: { positionS?, durationS?, paused?, title?, profileId?, file?, media? }
v1.post('/torrents/:infoHash/keepalive', findTorrent, lease, function (req, res) {
  sessions.report(req.lease, req.body);
  res.json({ ok: true });
});

// What every device plays (the dashboard's Activity)
v1.get('/sessions', authHttp.requireAdmin, function (req, res) {
  res.json(sessions.list());
});

// Stops a session: its streams are closed and its lease released
v1.delete('/sessions/:id', authHttp.requireAdmin, function (req, res) {
  if (!sessions.stopSession(req.params.id)) {
    return fail(res, 'NOT_FOUND', 'No such session');
  }
  res.json({ ok: true });
});

v1.get('/torrents/:infoHash/stats', findTorrent, function (req, res) {
  res.send(torrents.torrentStats(req.infoHash));
});

// deselects every file (POST: no state-changing GET)
v1.post('/torrents/:infoHash/deselect', findTorrent, function (req, res) {
  torrents.select(req.infoHash, []).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

// ── downloads (docs/media-server-plan.md §4.4) ──────────────────────────────
// Every torrent the server knows, running or not. Adding, starting, pausing
// and choosing files: any client (decision D: per-device grants come later);
// removing: the admin.

v1.get('/downloads', function (req, res) {
  res.json(torrents.list());
});

// What a link or a .torrent is, before adding it (the dashboard's Add dialog):
// { infoHash, name, sizeBytes, files (null for a new magnet), known }
v1.post('/downloads/preview', multipart(), function (req, res) {
  var link = req.files && req.files.file ? readUpload(req) : Promise.resolve(req.body && req.body.link);
  link.then(function (source) {
    return torrents.preview(source);
  }).then(function (answer) {
    res.json(answer);
  }, function (err) {
    failed(res, err);
  });
});

// { link, files?, media?, title?, profileId?, label?, paused? } as JSON, or a .torrent as
// multipart `file`: a download (runs to the end without a client; queued past
// downloads.maxActive). `media` (the TMDB title) lets clients find it again.
v1.post('/downloads', multipart(), function (req, res) {
  var files = req.body && req.body.files,
    media = sessions.mediaRef(req.body && req.body.media),
    title = req.body && typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : null,
    profileId = req.body && typeof req.body.profileId === 'string' ? req.body.profileId : null;
  var link = req.files && req.files.file ? readUpload(req) : Promise.resolve(req.body && (req.body.link || req.body.infoHash));
  if (typeof files === 'string') {
    // multipart: the paths as a JSON list
    try { files = JSON.parse(files); } catch (e) { return fail(res, 'INVALID', 'files must be a list of paths'); }
  }
  if (files !== undefined && (!Array.isArray(files) || files.some(function (p) { return typeof p !== 'string'; }))) {
    return fail(res, 'INVALID', 'files must be a list of paths');
  }
  var paused = req.body && (req.body.paused === true || req.body.paused === 'true'),
    label = req.body && typeof req.body.label === 'string' ? req.body.label : null;
  link.then(function (source) {
    return torrents.add(source, { intent: 'download', by: addedBy(req), files: files });
  }).then(function (infoHash) {
    if (media || profileId) {
      torrents.describe(infoHash, { titleRef: media ? Object.assign(media, title ? { title: title } : {}) : null, profileId: profileId });
    }
    return Promise.all([
      label ? torrents.setLabel(infoHash, label) : null,
      paused ? torrents.pause(infoHash) : null
    ]).then(function () { return infoHash; });
  }).then(function (infoHash) {
    res.json(torrents.get(infoHash));
  }, function (err) {
    failed(res, err);
  });
});

function findDownload(req, res, next) {
  findTorrent(req, res, next);
}

// Files downloaded over HTTP (lib/downloads/direct.js, docs/search-plan.md decision C), the admin's;
// before /downloads/:infoHash, which would take "direct" for a hash
var direct = require('./downloads/direct');

function directAction(work) {
  return function (req, res) {
    Promise.resolve().then(function () { return work(req); }).then(function (answer) {
      if (answer === undefined) {
        return res.status(204).end();
      }
      res.json(answer);
    }).catch(function (err) {
      errors.failed(res, err);
    });
  };
}

v1.get('/downloads/direct', authHttp.requireAdmin, directAction(function () {
  return direct.list();
}));

v1.post('/downloads/direct', authHttp.requireAdmin, directAction(function (req) {
  var body = req.body || {};
  if (typeof body.ref !== 'string') {
    throw Object.assign(new Error('ref: a media ref (r_… or h_…)'), { code: 'INVALID' });
  }
  return direct.add({ ref: body.ref, name: typeof body.name === 'string' ? body.name : null, paused: body.paused === true });
}));

v1.delete('/downloads/direct/:id', authHttp.requireAdmin, directAction(function (req) {
  return direct.remove(req.params.id, { files: req.query.files === '1' }).then(function () { return undefined; });
}));

v1.post('/downloads/direct/:id/start', authHttp.requireAdmin, directAction(function (req) {
  return direct.startOne(req.params.id);
}));

v1.post('/downloads/direct/:id/pause', authHttp.requireAdmin, directAction(function (req) {
  return direct.pause(req.params.id);
}));

v1.get('/downloads/:infoHash', findDownload, function (req, res) {
  res.json(Object.assign({}, torrents.get(req.infoHash), { files: torrents.files(req.infoHash) }));
});

function downloadAction(action) {
  return function (req, res) {
    action(req).then(function () {
      res.json(torrents.get(req.infoHash));
    }, function (err) { failed(res, err); });
  };
}

// The admin's Start: a download, run to the end without a client
v1.post('/downloads/:infoHash/start', findDownload, downloadAction(function (req) {
  return torrents.start(req.infoHash);
}));

v1.post('/downloads/:infoHash/pause', findDownload, downloadAction(function (req) {
  return torrents.pause(req.infoHash);
}));

// { files: [paths] | null } (null: every file)
v1.put('/downloads/:infoHash/files', findDownload, downloadAction(function (req) {
  var files = req.body ? req.body.files : undefined;
  return files === undefined ? Promise.reject(Object.assign(new Error('files is required'), { code: 'INVALID' })) :
    torrents.select(req.infoHash, files);
}));

// { removeWhenWatched?, label?, queuePosition?, force?, seedRatio?, seedMinutes?, downLimitKBps?, upLimitKBps? }
// (label: a string, null or '' = none; goals and limits: null = the server's / none)
v1.patch('/downloads/:infoHash', findDownload, downloadAction(function (req) {
  var body = req.body || {}, work = [];
  var invalid = function (message) { return Promise.reject(Object.assign(new Error(message), { code: 'INVALID' })); };
  if (body.removeWhenWatched !== undefined) {
    if (typeof body.removeWhenWatched !== 'boolean') {
      return invalid('removeWhenWatched must be true or false');
    }
    work.push(function () { return torrents.setRemoveWhenWatched(req.infoHash, body.removeWhenWatched); });
  }
  if (body.label !== undefined) {
    if (body.label !== null && typeof body.label !== 'string') {
      return invalid('label must be a string or null');
    }
    work.push(function () { return torrents.setLabel(req.infoHash, body.label); });
  }
  if (body.seedRatio !== undefined || body.seedMinutes !== undefined) {
    work.push(function () { return torrents.setSeedGoal(req.infoHash, { ratio: body.seedRatio, minutes: body.seedMinutes }); });
  }
  if (body.downLimitKBps !== undefined || body.upLimitKBps !== undefined) {
    work.push(function () { return torrents.setTorrentLimits(req.infoHash, { down: body.downLimitKBps, up: body.upLimitKBps }); });
  }
  if (body.force !== undefined) {
    if (typeof body.force !== 'boolean') {
      return invalid('force must be true or false');
    }
    work.push(function () { return torrents.setForce(req.infoHash, body.force); });
  }
  if (body.queuePosition !== undefined) {
    work.push(function () { return torrents.moveInQueue(req.infoHash, body.queuePosition); });
  }
  if (!work.length) {
    return invalid('nothing to change: removeWhenWatched, label, queuePosition, force, seedRatio, seedMinutes, downLimitKBps or upLimitKBps');
  }
  return work.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve());
}));

// A download's detail for the dashboard (docs/dashboard-plan.md §4.4, engine
// port v2): the admin only; the pane polls its tab every 2 s while open
function adminRead(work) {
  return function (req, res) {
    work(req).then(function (answer) {
      res.json(answer);
    }, function (err) { failed(res, err); });
  };
}

v1.get('/downloads/:infoHash/peers', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.peers(req.infoHash);
}));

v1.get('/downloads/:infoHash/trackers', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.trackers(req.infoHash);
}));

// { add?: [announce URLs], remove?: [announce URLs] } (kept with the download)
v1.post('/downloads/:infoHash/trackers', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  var body = req.body || {};
  return torrents.editTrackers(req.infoHash, { add: body.add, remove: body.remove }).then(function () {
    return torrents.trackers(req.infoHash);
  });
}));

// announce now (a running torrent no player reads)
v1.post('/downloads/:infoHash/reannounce', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.reannounce(req.infoHash).then(function () { return torrents.get(req.infoHash); });
}));

// its .torrent, with the trackers it announces to
v1.get('/downloads/:infoHash/torrent', authHttp.requireAdmin, findDownload, function (req, res) {
  torrents.torrentFile(req.infoHash).then(function (file) {
    var name = file.name.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || req.infoHash;
    res.set('Content-Type', 'application/x-bittorrent');
    res.set('Content-Disposition', 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_') + '.torrent"; filename*=UTF-8\'\'' +
      encodeURIComponent(name + '.torrent'));
    res.send(file.buffer);
  }, function (err) { failed(res, err); });
});

v1.post('/downloads/:infoHash/recheck', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.recheck(req.infoHash).then(function () { return torrents.get(req.infoHash); });
}));

// the verified pieces, the files' ranges, and where players read (with the
// devices playing each file)
v1.get('/downloads/:infoHash/pieces', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.pieces(req.infoHash).then(function (answer) {
    var playing = sessions.list().filter(function (s) { return s.infoHash === req.infoHash; });
    answer.reads.forEach(function (r) {
      r.devices = playing.filter(function (s) { return s.file === r.path || (s.file && r.path.slice(-s.file.length) === s.file); })
        .map(function (s) { return s.deviceName || s.deviceId; })
        .filter(function (name, i, all) { return all.indexOf(name) === i; });
    });
    return answer;
  });
}));

v1.get('/downloads/:infoHash/speed', authHttp.requireAdmin, findDownload, adminRead(function (req) {
  return torrents.speed(req.infoHash);
}));

// ?data=keep|delete (required): the only way a download's data is deleted.
// Its sessions end (streams closed).
v1.delete('/downloads/:infoHash', authHttp.requireAdmin, findDownload, function (req, res) {
  var data = req.query.data;
  if (data !== 'keep' && data !== 'delete') {
    return fail(res, 'INVALID', 'data must be keep or delete');
  }
  sessions.dropTorrent(req.infoHash);
  torrents.remove(req.infoHash, { deleteData: data === 'delete' }).then(function () {
    res.json({ ok: true });
  }, function (err) { failed(res, err); });
});

// The media routes of a torrent's file: aliases of /media/{ref}
// (lib/routes/media.js), kept for API v1 clients
v1.get('/torrents/:infoHash/probe/:path([^"]+)', media.torrent.probe);
v1.get('/torrents/:infoHash/keyframe/:path([^"]+)', media.torrent.keyframe);
v1.get('/torrents/:infoHash/transcode/:path([^"]+)', media.torrent.transcode);
v1.all('/torrents/:infoHash/files/:path([^"]+)', media.torrent.stream);

// Any file by its media ref: a torrent's, or one on disk (the library)
v1.use('/media', media.router);



//Removed in API 2 (docs/providers-plan.md §4.1, decision C): the core reads no
// torrent site; a title's torrents are POST /play/sources (plugins'
// play.collect), its runtime and rating TMDB's and /imdb/{id}. API 1 clients
// get 410 GONE here and everything else as before.

function gone(req, res) {
  fail(res, 'GONE', 'Removed in API 2: torrents come from the server\'s source plugins (POST /play/sources)');
}

v1.get('/movies', gone);
v1.get('/movies/:imdb_id', gone);
v1.get('/shows/:imdb_id/torrents', gone);

//IMDb ratings (lib/imdb.js): a title's, and a series' seasons and episodes
// GET /api/imdb/:id → { id, rating, votes }
// GET /api/imdb/:id/episodes → { id, rating, votes, seasons: [{ season, rating, rated, episodes: [{ episode, id, rating, votes }] }] }

function imdbRoute(read) {
  return function (req, res) {
    var id = String(req.params.id || '');
    if (!imdb.isImdbId(id)) {
      return fail(res, 'INVALID', 'not an IMDb id: ' + id);
    }
    read(id)
      .then(function (result) {
        res.json(result);
      })
      .catch(function (error) {
        log.warn('imdb ' + id + ': ' + error.message);
        fail(res, 'UPSTREAM', error.message);
      });
  };
}

v1.get('/imdb/:id', imdbRoute(imdb.title));
v1.get('/imdb/:id/episodes', imdbRoute(imdb.episodes));

//"Find releases" lists for movies and TV shows: one source's releases, most
// seeded first (lib/releases.js)
// GET /api/releases/providers?kind=movie|tv → [{ id, name, paged, default }]
// GET /api/releases/browse?kind=&provider=&q=&quality=2160p|1080p|720p|SD&playable=1&page=&imdb=tt…
//   → { provider, page, hasMore, torrents }; `imdb` is optional context (a source may list that show)

v1.get('/releases/providers', function (req, res) {
  var kind = String(req.query.kind || '');
  if (!releases.isKind(kind)) {
    return fail(res, 'INVALID', 'kind must be one of: ' + releases.KINDS.join(', '));
  }
  res.json(releases.providers(kind));
});

v1.get('/releases/browse', function (req, res) {
  var kind = String(req.query.kind || '');
  if (!releases.isKind(kind)) {
    return fail(res, 'INVALID', 'kind must be one of: ' + releases.KINDS.join(', '), { torrents: [] });
  }

  releases.browse({
    kind: kind,
    provider: String(req.query.provider || ''),
    q: String(req.query.q || '').slice(0, 100),
    quality: String(req.query.quality || ''),
    playable: req.query.playable === '1' || req.query.playable === 'true',
    page: parseInt(req.query.page, 10) || 1,
    imdb: String(req.query.imdb || '')
  })
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      log.warn(kind + ' releases: ' + error.message);
      fail(res, 'UPSTREAM', error.message, { torrents: [] });
    });
});

// Streams and files by keywords: plugins with sources.search (lib/search/sources.js, docs/search-plan.md §3)
// GET /search/providers → [{ id, name, kinds }]
// GET /search/sources?provider=&q=&kind=movie|show|any&page= → { provider, page, hasMore, items }

v1.get('/search/providers', function (req, res) {
  res.json(searchSources.providers());
});

v1.get('/search/sources', function (req, res) {
  searchSources.search({
    provider: String(req.query.provider || ''),
    q: String(req.query.q || '').slice(0, 100),
    kind: String(req.query.kind || 'any'),
    page: req.query.page
  }).then(function (result) {
    res.json(result);
  }).catch(function (err) {
    errors.failed(res, err);
  });
});

//Subtitles (see lib/subtitles: several providers, chosen by the player)

v1.get('/subtitles/providers', function (req, res) {
  res.json(subtitles.list());
});

// ?provider=&imdb_id=tt…&season=&episode=&languages=en,ar
v1.get('/subtitles/search', function (req, res) {
  var imdbId = String(req.query.imdb_id || '');
  if (!/^tt\d+$/.test(imdbId)) {
    return fail(res, 'INVALID', 'imdb_id (tt…) is required');
  }
  var query = { imdbId: imdbId };
  if (req.query.season && req.query.episode) {
    query.season = parseInt(req.query.season, 10);
    query.episode = parseInt(req.query.episode, 10);
  }

  subtitles.search(req.query.provider, query, req.query.languages)
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      log.warn('subtitles search: ' + error.message);
      fail(res, 'UPSTREAM', error.message, { subtitles: [] });
    });
});

// ?provider=&ref=&lang= -> WebVTT for <track>
v1.get('/subtitles/file', function (req, res) {
  subtitles.file(req.query.provider, String(req.query.ref || ''), req.query.lang)
    .then(function (vtt) {
      res.setHeader('content-type', 'text/vtt; charset=utf-8');
      res.send(vtt);
    })
    .catch(function (error) {
      log.warn('subtitles file: ' + error.message);
      fail(res, 'UPSTREAM', error.message);
    });
});

// A subtitle file the client has (SRT, ASS / SSA, WebVTT; ≤ 10 MB) in the body
// → WebVTT for <track>; ?lang= helps with old code pages
v1.post('/subtitles/convert', express.raw({ type: function () { return true; }, limit: '10mb' }), function (req, res) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return fail(res, 'INVALID', 'Send the subtitle file as the request body');
  }
  if (req.body.indexOf(0) !== -1) {
    return fail(res, 'NOT_SUPPORTED', 'This isn\'t a text subtitle (SRT, ASS, SSA or WebVTT)');
  }
  res.setHeader('content-type', 'text/vtt; charset=utf-8');
  res.send(subtitles.toVtt(req.body, typeof req.query.lang === 'string' ? req.query.lang : undefined));
});


//youtube streaming api (see lib/youtube.js)

v1.all('/youtube/:videoId/:type', function (req, res) {
  youtube.stream(req, res, req.params.type);
});

v1.all('/youtube/:videoId/', function (req, res) {
  youtube.stream(req, res, req.query.type);
});

// Per-profile user data (lib/services via lib/userData.js)
// User settings, per device and per profile (docs/settings-plan.md)
v1.use(require('./routes/settings'));
v1.use('/profiles', require('./routes/profiles'));
// What can play a title: files on this server, downloads, torrents (lib/play)
v1.use('/play', require('./routes/play'));
v1.use('/plugins', require('./routes/plugins'));
// Live TV: plugins' channels, guide, streams (lib/live)
v1.use('/live', require('./routes/live'));
// Movies, shows and people from TMDB, in our shapes (lib/catalog.js)
v1.use('/catalog', require('./routes/catalog'));
// The media library as clients browse it (lib/library/view.js)
v1.use('/library', require('./routes/mediaLibrary'));
v1.use('/profiles/:profileId', require('./routes/library'));

v1.use(function (req, res) {
  fail(res, 'NOT_FOUND', 'No route ' + req.method + ' ' + protocol.API_PREFIX + req.path);
});

// The dashboard (apps/dashboard, built into apps/server/public): hashed
// assets cached for a year, every other GET page answers index.html (SPA
// routes such as /link?user_code=…, the verification_uri of pairing)
var DASHBOARD = path.join(__dirname, '..', 'public');
api.use('/assets', express.static(path.join(DASHBOARD, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
api.use(express.static(DASHBOARD, { index: false, maxAge: '1h' }));
api.get(/^\/(?!api\/)[^.]*$/, function (req, res) {
  var index = path.join(DASHBOARD, 'index.html');
  if (!fs.existsSync(index)) {
    return res.status(404).type('text/plain').send('The dashboard is not built: run `npm run build -w apps/dashboard`');
  }
  res.set('Cache-Control', 'no-cache');
  res.sendFile(index);
});

api.use(function (req, res) {
  fail(res, 'NOT_FOUND', 'No route ' + req.method + ' ' + req.path + ' (the API is under ' + protocol.API_PREFIX + ')');
});

// Malformed JSON bodies and anything a route threw
api.use(function (err, req, res, next) {   // jshint ignore:line
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return fail(res, 'INVALID', 'Malformed request body');
  }
  log.error(req.method + ' ' + req.path + ' failed', { err: err });
  fail(res, 'INTERNAL', 'Internal error');
});

module.exports = api;
