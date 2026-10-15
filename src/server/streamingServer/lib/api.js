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
  subtitles = require('./subtitles'),
  fs = require('fs'),
  store = require('./store'),
  progress = require('./progressbar'),
  stats = require('./stats'),
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

//YTS movie API (torrents, rating, runtime). yts.mx stopped answering in 2026;
//the API itself announces movies-api.accel.li as its new base URL.

var YTS_MIRRORS = ['https://movies-api.accel.li', 'https://yts.lt', 'https://yts.ag'];

function ytsGet(endpoint, params) {
  var mirrors = YTS_MIRRORS.slice();

  function attempt() {
    var base = mirrors.shift();
    return axios.get(base + '/api/v2/' + endpoint, { params: params, timeout: 15000 })
      .catch(function (err) {
        if (mirrors.length) {
          return attempt();
        }
        throw err;
      });
  }

  return attempt();
}

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
