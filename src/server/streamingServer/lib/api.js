'use strict';

const path = require('path');

var rangeParser = require('range-parser'),
  pump = require('pump'),
  _ = require('lodash'),
  express = require('express'),
  logger = require('morgan'),
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
  api = express(),
  axios = require('axios').default;


api.use(express.urlencoded({ extended: false }));
api.use(express.json());
api.use(logger('dev'));
api.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'OPTIONS, POST, GET, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

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
        link: '/torrents/' + torrent.infoHash + '/files/' + encodeURIComponent(f.path),
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
    return res.sendStatus(404);
  }
  next();
}

api.get('/torrents', function (req, res) {
  res.send(store.list().map(serialize));
});

api.post('/torrents', function (req, res) {

  //res.send('ur link ' + req.body.link);

  store.add(req.body.link, function (err, infoHash) {
    if (err) {
      console.error(err);
      res.status(500).send(err);
    } else {
      res.send({ infoHash: infoHash });
    }
  });

});

api.post('/upload', multipart(), function (req, res) {
  var file = req.files && req.files.file;
  if (!file) {
    return res.status(500).send('file is missing');
  }
  store.add(file.path, function (err, infoHash) {
    if (err) {
      console.error(err);
      res.status(500).send(err);
    } else {
      res.send({ infoHash: infoHash });
    }
    fs.unlink(file.path, function (err) {
      if (err) {
        console.error(err);
      }
    });
  });
});

api.get('/torrents/:infoHash', findTorrent, function (req, res) {
  res.send(serialize(req.torrent));

});


//starts a torrent file download || or all torrent files

api.post('/torrents/:infoHash/start/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].select();
  } else {
    req.torrent.files.forEach(function (f) {
      f.select();
    });
  }
  res.sendStatus(200);
});

//stops a torrent file download || or all torrent files

api.post('/torrents/:infoHash/stop/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].deselect();
  } else {
    req.torrent.files.forEach(function (f) {
      f.deselect();
    });
  }
  res.sendStatus(200);
});

//pause a torrent

api.post('/torrents/:infoHash/pause', findTorrent, function (req, res) {
  req.torrent.swarm.pause();
  res.sendStatus(200);
});

//resume a torrent

api.post('/torrents/:infoHash/resume', findTorrent, function (req, res) {
  req.torrent.swarm.resume();
  res.sendStatus(200);
});

//delete a torrent

api.delete('/torrents/:infoHash', findTorrent, function (req, res) {
  store.remove(req.torrent.infoHash);
  res.sendStatus(200);
});

// get a torrent stats

api.get('/torrents/:infoHash/stats', findTorrent, function (req, res) {
  res.send(stats(req.torrent));
});

// deselects torrent
api.get('/torrents/:infoHash/deselect', findTorrent, function (req, res) {
  req.torrent.files.forEach(function (f) {
    f.deselect();
  });
  res.sendStatus(200)
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
  return 'http://127.0.0.1:' + req.socket.localPort + '/torrents/' + req.torrent.infoHash +
    '/files/' + encodeURIComponent(file.path);
}

// Codecs of a file: { duration, video, audio: [...], transcode }
api.get('/torrents/:infoHash/probe/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return res.sendStatus(404);
  }
  transcode.probe(localFileUrl(req, file)).then(function (info) {
    res.json(info);
  }, function (e) {
    res.status(502).json({ error: e.message });
  });
});

// Where a transcoded stream asked to start at ?t= really starts: { time }
api.get('/torrents/:infoHash/keyframe/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return res.sendStatus(404);
  }
  var t = Math.max(0, parseFloat(req.query.t) || 0);
  transcode.keyframe(localFileUrl(req, file), t).then(function (time) {
    res.json({ time: time });
  });
});

// The file with its audio re-encoded to AAC, from ?t=<seconds>, track ?audio=<n>
api.get('/torrents/:infoHash/transcode/:path([^"]+)', findTorrent, function (req, res) {
  var file = _.find(req.torrent.files, { path: req.params.path });
  if (!file) {
    return res.sendStatus(404);
  }
  req.socket.setTimeout(3600000);
  transcode.stream(localFileUrl(req, file), parseFloat(req.query.t) || 0,
    parseInt(req.query.audio, 10) || 0, req, res);
});

api.all('/torrents/:infoHash/files/:path([^"]+)', findTorrent, function (req, res) {
  var torrent = req.torrent,
      file = _.find(torrent.files, { path: req.params.path });

  if (!file) {
    return res.sendStatus(404);
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



api.get('/subtitles/:imdb_id', function (req, res) {
  var imdb_id = req.params.imdb_id;

  res.send({
    body : imdb_id
  })

})

//YTS movie API (torrents, rating, runtime), via lib/providers/yts.js
// (mirror list there: yts.mx stopped answering in 2026)

var ytsGet = yts.get;

api.get('/api/movies', function (req, res) {
  ytsGet('list_movies.json', req.query)
  .then(function (response) {
    res.json(response.data)
  })
  .catch(function (err) {
    console.log('yts list: ' + err.message);
    res.status(502).json({ error: err.message });
  })
});

api.get('/api/movies/:imdb_id', function (req, res) {
  ytsGet('movie_details.json', { imdb_id: req.params.imdb_id })
  .then(function (response) {
    res.json(response.data)
  })
  .catch(function (err) {
    console.log('yts details: ' + err.message);
    res.status(502).json({ error: err.message });
  })
});

//TV episode torrents (EZTV + TheRARBG), best match first

api.get('/api/shows/:imdb_id/torrents', function (req, res) {
  var season = parseInt(req.query.season, 10),
      episode = parseInt(req.query.episode, 10);

  if (!(season >= 0) || !(episode >= 1)) {
    return res.status(400).send({ error: 'season and episode are required' });
  }

  episodes.findEpisodeTorrents(req.params.imdb_id, req.query.title, season, episode)
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      console.error(error);
      res.status(502).send({ error: error.message });
    });
});

//IMDb ratings (lib/imdb.js): a title's, and a series' seasons and episodes
// GET /api/imdb/:id → { id, rating, votes }
// GET /api/imdb/:id/episodes → { id, rating, votes, seasons: [{ season, rating, rated, episodes: [{ episode, id, rating, votes }] }] }

function imdbRoute(read) {
  return function (req, res) {
    var id = String(req.params.id || '');
    if (!imdb.isImdbId(id)) {
      return res.status(400).json({ error: 'not an IMDb id: ' + id });
    }
    read(id)
      .then(function (result) {
        res.json(result);
      })
      .catch(function (error) {
        console.error('imdb ' + id + ': ' + error.message);
        res.status(502).json({ error: error.message });
      });
  };
}

api.get('/api/imdb/:id', imdbRoute(imdb.title));
api.get('/api/imdb/:id/episodes', imdbRoute(imdb.episodes));

//18+ movie torrents (TheRARBG XXX + The Pirate Bay), best match first.
// ?title=&year= — these movies are matched by name, YTS has none of them

api.get('/api/adult/torrents', function (req, res) {
  var title = String(req.query.title || '').trim();
  if (!title) {
    return res.status(400).send({ error: 'title is required' });
  }

  adult.findAdultTorrents(title, parseInt(req.query.year, 10))
    .then(function (result) {
      res.json(result);
    })
    .catch(function (error) {
      console.error(error);
      res.status(502).send({ error: error.message });
    });
});

//18+ section: one provider's list, most seeded first (lib/adult.js#browse)
// ?provider=piratebay|therarbg&q=&quality=2160p|1080p|720p|SD&playable=1&page=

api.get('/api/adult/providers', function (req, res) {
  res.json(adult.browseProviders());
});

api.get('/api/adult/browse', function (req, res) {
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
      console.error('adult browse: ' + error.message);
      res.status(502).send({ error: error.message, torrents: [] });
    });
});

//"Find releases" lists for movies, TV shows and the 18+ section: one source's
// releases, most seeded first (lib/releases.js)
// GET /api/releases/providers?kind=movie|tv|adult → [{ id, name, paged, default }]
// GET /api/releases/browse?kind=&provider=&q=&quality=2160p|1080p|720p|SD&playable=1&page=&imdb=tt…
//   → { provider, page, hasMore, torrents }; `imdb` is optional context (EZTV lists that show)

api.get('/api/releases/providers', function (req, res) {
  var kind = String(req.query.kind || '');
  if (!releases.isKind(kind)) {
    return res.status(400).json({ error: 'kind must be one of: ' + releases.KINDS.join(', ') });
  }
  res.json(releases.providers(kind));
});

api.get('/api/releases/browse', function (req, res) {
  var kind = String(req.query.kind || '');
  if (!releases.isKind(kind)) {
    return res.status(400).json({ error: 'kind must be one of: ' + releases.KINDS.join(', '), torrents: [] });
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
      console.error(kind + ' releases: ' + error.message);
      res.status(502).send({ error: error.message, torrents: [] });
    });
});

//Subtitles (see lib/subtitles: several providers, chosen by the player)

api.get('/api/subtitles/providers', function (req, res) {
  res.json(subtitles.list());
});

// ?provider=&imdb_id=tt…&season=&episode=&languages=en,ar
api.get('/api/subtitles/search', function (req, res) {
  var imdbId = String(req.query.imdb_id || '');
  if (!/^tt\d+$/.test(imdbId)) {
    return res.status(400).json({ error: 'imdb_id (tt…) is required' });
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
      console.error('subtitles search: ' + error.message);
      res.status(502).json({ error: error.message, subtitles: [] });
    });
});

// ?provider=&ref=&lang= -> WebVTT for <track>
api.get('/api/subtitles/file', function (req, res) {
  subtitles.file(req.query.provider, String(req.query.ref || ''), req.query.lang)
    .then(function (vtt) {
      res.setHeader('content-type', 'text/vtt; charset=utf-8');
      res.send(vtt);
    })
    .catch(function (error) {
      console.error('subtitles file: ' + error.message);
      res.sendStatus(502);
    });
});


//youtube streaming api (see lib/youtube.js)

api.all('/youtube/:videoId/:type', function (req, res) {
  youtube.stream(req, res, req.params.type);
});

api.all('/youtube/:videoId/', function (req, res) {
  youtube.stream(req, res, req.query.type);
});

// Per-profile user data (lib/services via lib/userData.js)
// 18+ section catalog (lib/adultMeta: TMDB, ThePornDB, …)
api.use('/api/adult/meta', require('./routes/adultMeta'));

api.use('/api/profiles', require('./routes/profiles'));
api.use('/api/profiles/:profileId', require('./routes/library'));

module.exports = api;
