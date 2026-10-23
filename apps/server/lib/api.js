'use strict';

const path = require('path');

var rangeParser = require('range-parser'),
  pump = require('pump'),
  _ = require('lodash'),
  express = require('express'),
  multipart = require('connect-multiparty'),
  youtube = require('./youtube'),
  episodes = require('./episodes'),
  adult = require('./adult'),
  releases = require('./releases'),
  imdb = require('./imdb'),
  yts = require('./providers/yts'),
  subtitles = require('./subtitles'),
  fs = require('fs'),
  torrents = require('./torrents/client'),
  transcode = require('./transcode'),
  sessions = require('./sessions'),
  settings = require('./settings'),
  middleware = require('./middleware'),
  auth = require('./auth'),
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
function failed(res, err) {
  if (err.code === 'BUSY' || err.code === 'NOT_FOUND' || err.code === 'INVALID' || err.code === 'CONFLICT') {
    return fail(res, err.code, err.message);
  }
  if (err.code === 'UNAVAILABLE') {
    return fail(res, 'BUSY', err.message);
  }
  log.error('torrent: ' + err.message, { err: err });
  fail(res, 'INTERNAL', 'Internal error');
}

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

// A file of the torrent, by its path ({ name, path, size, offset, selected })
function findFile(req, res, next) {
  var file = (torrents.files(req.infoHash) || []).filter(function (f) { return f.path === req.params.path; })[0];
  if (!file) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  req.file = file;
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

v1.get('/torrents/:infoHash', findTorrent, function (req, res) {
  res.send(torrents.torrent(req.infoHash));
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

// { link, files?, media?, title?, profileId? } as JSON, or a .torrent as
// multipart `file`: a download (runs to the end without a client; queued past
// downloads.maxActive). `media` (the TMDB title) lets clients find it again.
v1.post('/downloads', multipart(), function (req, res) {
  var files = req.body && req.body.files,
    media = sessions.mediaRef(req.body && req.body.media),
    title = req.body && typeof req.body.title === 'string' ? req.body.title.slice(0, 300) : null,
    profileId = req.body && typeof req.body.profileId === 'string' ? req.body.profileId : null;
  if (files !== undefined && (!Array.isArray(files) || files.some(function (p) { return typeof p !== 'string'; }))) {
    return fail(res, 'INVALID', 'files must be a list of paths');
  }
  var link = req.files && req.files.file ? readUpload(req) : Promise.resolve(req.body && (req.body.link || req.body.infoHash));
  link.then(function (source) {
    return torrents.add(source, { intent: 'download', by: addedBy(req), files: files });
  }).then(function (infoHash) {
    if (media || profileId) {
      torrents.describe(infoHash, { titleRef: media ? Object.assign(media, title ? { title: title } : {}) : null, profileId: profileId });
    }
    res.json(torrents.get(infoHash));
  }, function (err) {
    failed(res, err);
  });
});

function findDownload(req, res, next) {
  findTorrent(req, res, next);
}

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

// { removeWhenWatched }
v1.patch('/downloads/:infoHash', findDownload, downloadAction(function (req) {
  var value = req.body && req.body.removeWhenWatched;
  return typeof value !== 'boolean' ? Promise.reject(Object.assign(new Error('removeWhenWatched must be true or false'), { code: 'INVALID' })) :
    torrents.setRemoveWhenWatched(req.infoHash, value);
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

/*
    --MOST CRUSIAL PART
*/

// ffmpeg / ffprobe read the file through the byte-range route below, as the
// requesting device. `internal` is a per-process secret (lib/auth): it lets
// them in without a token, and their reads don't change the session's method.
function localFileUrl(req, file) {
  return 'http://127.0.0.1:' + req.socket.localPort + protocol.API_PREFIX + '/torrents/' + req.infoHash +
    '/files/' + encodeURIComponent(file.path) + '?' + protocol.DEVICE_PARAM + '=' +
    encodeURIComponent(req.lease.deviceId) + '&internal=' + auth.internalUrlToken();
}

// Codecs of a file: { duration, video, audio: [...], transcode }
v1.get('/torrents/:infoHash/probe/:path([^"]+)', findTorrent, findFile, lease, function (req, res) {
  transcode.probe(localFileUrl(req, req.file)).then(function (info) {
    res.json(info);
  }, function (e) {
    fail(res, e.code === 'ENOENT' ? 'TRANSCODER_UNAVAILABLE' : 'PROBE_FAILED', e.message);
  });
});

// Where a transcoded stream asked to start at ?t= really starts: { time }
v1.get('/torrents/:infoHash/keyframe/:path([^"]+)', findTorrent, findFile, lease, function (req, res) {
  var t = Math.max(0, parseFloat(req.query.t) || 0);
  transcode.keyframe(localFileUrl(req, req.file), t).then(function (time) {
    res.json({ time: time });
  });
});

// The file with its audio re-encoded to AAC, from ?t=<seconds>, track ?audio=<n>
v1.get('/torrents/:infoHash/transcode/:path([^"]+)', findTorrent, findFile, lease, function (req, res) {
  var file = req.file;
  if (!sessions.takeTranscodeSlot(req.lease, file, res)) {
    return fail(res, 'BUSY', 'This server already transcodes ' + settings.get('streaming.maxTranscodes') +
      ' videos; try again later');
  }
  sessions.trackStream(req.lease, req, res, file, 'audio-transcode');
  req.socket.setTimeout(3600000);
  transcode.stream(localFileUrl(req, file), parseFloat(req.query.t) || 0,
    parseInt(req.query.audio, 10) || 0, req, res);
});

// The bytes of a file (HTTP ranges). A stopped torrent starts again (BUSY past
// the limit), unless the file is finished on disk; a stream download fetches
// only this file from then on (season packs), with its tail early.
v1.all('/torrents/:infoHash/files/:path([^"]+)', findTorrent, findFile, lease, function (req, res) {
  var file = req.file,
    range = req.headers.range && rangeParser(file.size, req.headers.range)[0];

  sessions.trackStream(req.lease, req, res, file, 'direct');
  req.socket.setTimeout(3600000);

  function headers() {
    res.setHeader('Accept-Ranges', 'bytes');
    res.type(file.name);
    if (!range) {
      res.setHeader('Content-Length', file.size);
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Length', range.end - range.start + 1);
    res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.size);
  }

  if (req.method === 'HEAD') {
    headers();
    return res.end();
  }
  torrents.prepareStream(req.infoHash, file.path).then(function () {
    torrents.prefetchTail(req.infoHash, file.path);
    return torrents.stream(req.infoHash, file.path, range ? { start: range.start, end: range.end } : null);
  }).then(function (body) {
    if (res.destroyed) {
      return body.destroy();
    }
    headers();
    pump(body, res);
  }, function (err) {
    if (!res.headersSent && !res.destroyed) {
      failed(res, err);
    }
  });
});



//YTS movie API (torrents, rating, runtime), via lib/providers/yts.js
// (mirror list there: yts.mx stopped answering in 2026)

var ytsGet = yts.get;

v1.get('/movies', function (req, res) {
  ytsGet('list_movies.json', req.query)
  .then(function (response) {
    res.json(response.data)
  })
  .catch(function (err) {
    log.warn('yts list: ' + err.message);
    fail(res, 'UPSTREAM', err.message);
  })
});

v1.get('/movies/:imdb_id', function (req, res) {
  ytsGet('movie_details.json', { imdb_id: req.params.imdb_id })
  .then(function (response) {
    res.json(response.data)
  })
  .catch(function (err) {
    log.warn('yts details: ' + err.message);
    fail(res, 'UPSTREAM', err.message);
  })
});

//TV episode torrents (EZTV + TheRARBG), best match first

v1.get('/shows/:imdb_id/torrents', function (req, res) {
  var season = parseInt(req.query.season, 10),
      episode = parseInt(req.query.episode, 10);

  if (!(season >= 0) || !(episode >= 1)) {
    return fail(res, 'INVALID', 'season and episode are required');
  }

  episodes.findEpisodeTorrents(req.params.imdb_id, req.query.title, season, episode)
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      log.warn('episode torrents: ' + error.message);
      fail(res, 'UPSTREAM', error.message);
    });
});

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

//18+ movie torrents (TheRARBG XXX + The Pirate Bay), best match first.
// ?title=&year= — these movies are matched by name, YTS has none of them

v1.get('/adult/torrents', function (req, res) {
  var title = String(req.query.title || '').trim();
  if (!title) {
    return fail(res, 'INVALID', 'title is required');
  }

  adult.findAdultTorrents(title, parseInt(req.query.year, 10))
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      log.warn('adult torrents: ' + error.message);
      fail(res, 'UPSTREAM', error.message);
    });
});

//18+ section: one provider's list, most seeded first (lib/adult.js#browse)
// ?provider=piratebay|therarbg&q=&quality=2160p|1080p|720p|SD&playable=1&page=

v1.get('/adult/providers', function (req, res) {
  res.json(adult.browseProviders());
});

v1.get('/adult/browse', function (req, res) {
  adult.browse({
    provider: String(req.query.provider || ''),
    q: String(req.query.q || '').slice(0, 100),
    quality: String(req.query.quality || ''),
    playable: req.query.playable === '1' || req.query.playable === 'true',
    page: parseInt(req.query.page, 10) || 1
  })
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      log.warn('adult browse: ' + error.message);
      fail(res, 'UPSTREAM', error.message, { torrents: [] });
    });
});

//"Find releases" lists for movies, TV shows and the 18+ section: one source's
// releases, most seeded first (lib/releases.js)
// GET /api/releases/providers?kind=movie|tv|adult → [{ id, name, paged, default }]
// GET /api/releases/browse?kind=&provider=&q=&quality=2160p|1080p|720p|SD&playable=1&page=&imdb=tt…
//   → { provider, page, hasMore, torrents }; `imdb` is optional context (EZTV lists that show)

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


//youtube streaming api (see lib/youtube.js)

v1.all('/youtube/:videoId/:type', function (req, res) {
  youtube.stream(req, res, req.params.type);
});

v1.all('/youtube/:videoId/', function (req, res) {
  youtube.stream(req, res, req.query.type);
});

// Per-profile user data (lib/services via lib/userData.js)
// 18+ section catalog (lib/adultMeta: TMDB, ThePornDB, …)
v1.use('/adult/meta', require('./routes/adultMeta'));

// User settings, per device and per profile (docs/settings-plan.md)
v1.use(require('./routes/settings'));
v1.use('/profiles', require('./routes/profiles'));
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
