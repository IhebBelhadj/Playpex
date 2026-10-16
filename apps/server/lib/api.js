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
  store = require('./store'),
  progress = require('./progressbar'),
  stats = require('./stats'),
  transcode = require('./transcode'),
  middleware = require('./middleware'),
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
api.use(legacyAliases);
api.use(express.urlencoded({ extended: false }));
api.use(express.json());
api.use(protocol.API_PREFIX, clientVersion, v1);

var fail = errors.fail;

// Every route lives under /api/v1 (docs/server-separation-plan.md §6.1). The
// unversioned paths the TV app used before (/torrents/…, /upload, /youtube/…,
// /api/…) are rewritten onto it until the TV client is separated (step 9).
function legacyAliases(req, res, next) {
  if (/^\/(torrents|upload|youtube)(\/|\?|$)/.test(req.url)) {
    req.url = protocol.API_PREFIX + req.url;
  } else if (/^\/api\/(?!v\d+(\/|\?|$))/.test(req.url)) {
    req.url = protocol.API_PREFIX + req.url.slice(4);
  }
  next();
}

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

v1.use('/server', require('./routes/server'));

function serialize(torrent) {
  if (!torrent.torrent) {
    return { infoHash: torrent.infoHash };
  }
  var pieceLength = torrent.torrent.pieceLength;

  return {
    infoHash: torrent.infoHash,
    name: torrent.torrent.name,
    length: torrent.torrent.length,
    interested: torrent.amInterested,
    ready: torrent.ready,
    files: torrent.files.map(function (f) {
      // jshint -W016
      var start = f.offset / pieceLength | 0;
      var end = (f.offset + f.length - 1) / pieceLength | 0;

      return {
        name: f.name,
        path: f.path,
        link: protocol.API_PREFIX + '/torrents/' + torrent.infoHash + '/files/' + encodeURIComponent(f.path),
        length: f.length,
        offset: f.offset,
        selected: torrent.selection.some(function (s) {
          return s.from <= start && s.to >= end;
        })
      };
    }),
    progress: progress(torrent.bitfield.buffer)
  };
}

function findTorrent(req, res, next) {
  var torrent = req.torrent = store.get(req.params.infoHash);
  if (!torrent) {
    return fail(res, 'NOT_FOUND', 'No such torrent: ' + req.params.infoHash);
  }
  next();
}

v1.get('/torrents', function (req, res) {
  res.send(store.list().map(serialize));
});

v1.post('/torrents', function (req, res) {

  //res.send('ur link ' + req.body.link);

  store.add(req.body.link, function (err, infoHash) {
    if (err) {
      fail(res, 'INVALID', 'Cannot read this torrent: ' + err.message);
    } else {
      res.send({ infoHash: infoHash });
    }
  });

});

v1.post('/upload', multipart(), function (req, res) {
  var file = req.files && req.files.file;
  if (!file) {
    return fail(res, 'INVALID', 'file is missing');
  }
  store.add(file.path, function (err, infoHash) {
    if (err) {
      fail(res, 'INVALID', 'Cannot read this torrent: ' + err.message);
    } else {
      res.send({ infoHash: infoHash });
    }
    fs.unlink(file.path, function (err) {
      if (err) {
        log.warn('cannot delete upload', { err: err });
      }
    });
  });
});

v1.get('/torrents/:infoHash', findTorrent, function (req, res) {
  res.send(serialize(req.torrent));

});


//starts a torrent file download || or all torrent files

v1.post('/torrents/:infoHash/start/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].select();
  } else {
    req.torrent.files.forEach(function (f) {
      f.select();
    });
  }
  res.json({ ok: true });
});

//stops a torrent file download || or all torrent files

v1.post('/torrents/:infoHash/stop/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].deselect();
  } else {
    req.torrent.files.forEach(function (f) {
      f.deselect();
    });
  }
  res.json({ ok: true });
});

//pause a torrent

v1.post('/torrents/:infoHash/pause', findTorrent, function (req, res) {
  req.torrent.swarm.pause();
  res.json({ ok: true });
});

//resume a torrent

v1.post('/torrents/:infoHash/resume', findTorrent, function (req, res) {
  req.torrent.swarm.resume();
  res.json({ ok: true });
});

//delete a torrent

v1.delete('/torrents/:infoHash', findTorrent, function (req, res) {
  store.remove(req.torrent.infoHash);
  res.json({ ok: true });
});

// get a torrent stats

v1.get('/torrents/:infoHash/stats', findTorrent, function (req, res) {
  res.send(stats(req.torrent));
});

// deselects every file (POST: no state-changing GET)
v1.post('/torrents/:infoHash/deselect', findTorrent, function (req, res) {
  req.torrent.files.forEach(function (f) {
    f.deselect();
  });
  res.json({ ok: true });
});



// Players read a video's index before starting: MKV keeps it (Cues) at the end
// of the file, which would otherwise download last. Fetch the tail alongside the
// start the first time a file is streamed.
var TAIL_BYTES = 2 * 1024 * 1024;

function prefetchTail(file) {
  if (file.tailPrefetched || file.length <= TAIL_BYTES * 2) {
    return;
  }
  file.tailPrefetched = true;
  var tail = file.createReadStream({ start: file.length - TAIL_BYTES, end: file.length - 1 });
  tail.on('error', function () {});
  tail.resume();
}

/*
    --MOST CRUSIAL PART
*/

// ffmpeg / ffprobe read the file through the byte-range route below
function localFileUrl(req, file) {
  return 'http://127.0.0.1:' + req.socket.localPort + protocol.API_PREFIX + '/torrents/' + req.torrent.infoHash +
    '/files/' + encodeURIComponent(file.path);
}

// Codecs of a file: { duration, video, audio: [...], transcode }
v1.get('/torrents/:infoHash/probe/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  transcode.probe(localFileUrl(req, file)).then(function (info) {
    res.json(info);
  }, function (e) {
    fail(res, e.code === 'ENOENT' ? 'TRANSCODER_UNAVAILABLE' : 'PROBE_FAILED', e.message);
  });
});

// Where a transcoded stream asked to start at ?t= really starts: { time }
v1.get('/torrents/:infoHash/keyframe/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  var t = Math.max(0, parseFloat(req.query.t) || 0);
  transcode.keyframe(localFileUrl(req, file), t).then(function (time) {
    res.json({ time: time });
  });
});

// The file with its audio re-encoded to AAC, from ?t=<seconds>, track ?audio=<n>
v1.get('/torrents/:infoHash/transcode/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  req.socket.setTimeout(3600000);
  transcode.stream(localFileUrl(req, file), parseFloat(req.query.t) || 0,
    parseInt(req.query.audio, 10) || 0, req, res);
});

v1.all('/torrents/:infoHash/files/:path([^"]+)', findTorrent, function (req, res) {
  var torrent = req.torrent,
      file = _.find(torrent.files, { path: req.params.path });

  if (!file) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  // Download only the file being watched (season packs hold many episodes)
  torrent.files.forEach(function (f) {
    if (f === file) {
      f.select();
    } else {
      f.deselect();
    }
  });
  prefetchTail(file);

  var range = req.headers.range;

  range = range && rangeParser(file.length, range)[0];


  res.setHeader('Accept-Ranges', 'bytes');
  res.type(file.name);
  req.socket.setTimeout(3600000);

  if (!range) {
    res.setHeader('Content-Length', file.length);
    if (req.method === 'HEAD') {
      return res.end();
    }
    return pump(file.createReadStream(), res);
  }

  res.statusCode = 206;
  res.setHeader('Content-Length', range.end - range.start + 1);
  res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length);

  if (req.method === 'HEAD') {
    return res.end();
  }
  pump(file.createReadStream(range), res);
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

v1.use('/profiles', require('./routes/profiles'));
v1.use('/profiles/:profileId', require('./routes/library'));

v1.use(function (req, res) {
  fail(res, 'NOT_FOUND', 'No route ' + req.method + ' ' + protocol.API_PREFIX + req.path);
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
