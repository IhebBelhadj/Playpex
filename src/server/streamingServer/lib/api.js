'use strict';

const path = require('path');

var rangeParser = require('range-parser'),
  pump = require('pump'),
  _ = require('lodash'),
  express = require('express'),
  logger = require('morgan'),
  multipart = require('connect-multiparty'),
  ytdl = require('ytdl-core'),
  fs = require('fs'),
  store = require('./store'),
  progress = require('./progressbar'),
  stats = require('./stats'),
  request = require('request'),
  api = express(),
  srt2vtt = require('srt-to-vtt'),
  ytdl = require('ytdl-core'),
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



/*
    --MOST CRUSIAL PART
*/

api.all('/torrents/:infoHash/files/:path([^"]+)', findTorrent, function (req, res) {
  var torrent = req.torrent,
      file = _.find(torrent.files, { path: req.params.path });

  if (!file) {
    return res.sendStatus(404);
  }
  torrent.files.forEach(function (f) {
    f.select();
  });

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

//yts api with cors setup


api.get('/api/movies', function (req, res) {
  console.log(req.query)
  axios.get('https://yts.mx/api/v2/list_movies.json' , {params : req.query})
  .then(function (response) {
    // handle success
    res.json(response.data)
  })
  .catch((err)=>{
    console.log(err);
  })
});

api.get('/api/movies/:imdb_id', function (req, res) {
  console.log(req.params.imdb_id)
  axios.get('https://yts.mx/api/v2/movie_details.json' , {params : {imdb_id : req.params.imdb_id} })
  .then(function (response) {
    // handle success
    res.json(response.data)
  })
  .catch((err)=>{
    console.log(err);
  })
});

//Subtitles api

api.get('/api/subtitles/:tmdb_id' , function(req , res) {

  var options = {
    method: 'GET',
    url: 'https://api.opensubtitles.com/api/v1/subtitles',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': 'co8umXm6v33k9nrkvwRvMKbdQMkhRdiB'
    },
    params : {
      tmdb_id : req.params.tmdb_id,
      languages : req.query.languages,
    }
  };

  axios.request(options).then(function (response) {
    res.json(response.data)
  }).catch(function (error) {
    console.error(error);
  });

})



api.get("/api/subtitles/download/:file_id" , function(req , res){

  const options = {
    method: 'POST',
    url: 'https://api.opensubtitles.com/api/v1/download',
    headers: {
      'Accept' : "*/*",
      'Content-Type': 'application/json',
      'Api-Key': 'co8umXm6v33k9nrkvwRvMKbdQMkhRdiB'
    },
    data: {file_id: Number(req.params.file_id)}
  };

  axios.request(options).then(function (response) {
    var link = response.data.link;

    try {

     res.setHeader("content-type", "text/vtt");

      request(link)
        .pipe(srt2vtt())
        .pipe(res)

    } catch (error) {
      console.log(error);
    }

  }).catch(function (error) {
    console.error(error);
  });
})


//youtube streaming api

var base_url = "http://www.youtube.com/watch?v=";

function validateYTLink(req, res, next){
  if (!ytdl.validateID(req.params.videoId)) {
    res.sendStatus(404)
  }
  next();
}


api.all('/youtube/:videoId/:type',validateYTLink , async (req, res) => {


  var
    id = req.params.videoId,
    type = req.params.type,
    link = base_url+id,
    params = {};


  var info = await ytdl.getInfo(link);
  var format;
  var title = info.videoDetails.videoId;

  if (type) {
    if (type == 'video') {
      params.quality = req.query.quality || "highestvideo";
    }
    else if (type == 'audio'){
      params.quality = '140';
      params.dlChunkSize = 0;
      params.highWaterMark = 1024 * 1024 * 512;
    }

    try {

      format = ytdl.chooseFormat(info.formats, params);
      if (!format.contentLength) {
        quality = "highestvideo";
        format = ytdl.chooseFormat(info.formats, params);
      }

    } catch (error) {
      res.sendStatus(404)
    }
  }

  else {
    try {

      format = ytdl.chooseFormat(info.formats, params);
      if (!format.contentLength) {
        quality = "highest";
        format = ytdl.chooseFormat(info.formats, params);
      }

    } catch (error) {
      res.sendStatus(404)
    }
  }



  var totalSize = format.contentLength;
  console.log(id);

  var range = req.headers.range;
  range = range && rangeParser(totalSize, range)[0];
  res.setHeader('Accept-Ranges', 'bytes');
  res.type(format.mimeType);
  req.socket.setTimeout(3600000);

  if (!range) {
      res.setHeader('Content-Length', totalSize);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(ytdl(link , params), res);
    }
  res.statusCode = 206;
  res.setHeader('Content-Length', range.end - range.start + 1);
  res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + totalSize);
  if (req.method === 'HEAD') {
      return res.end();
  }
  params.range = {start : range.start , end : range.end}
  pump(ytdl(link ,  params), res);


});

api.all('/youtube/:videoId/',validateYTLink , async (req, res) => {


  var
    id = req.params.videoId,
    type = req.query.type,
    link = base_url+id,
    params = {};


  var info = await ytdl.getInfo(link);
  var format;
  var title = info.videoDetails.videoId;

  if (type == 'video') {
    params.quality = req.query.quality || "highestvideo";
  }
  else if (type == 'audio'){
    params.quality = '140';
    params.dlChunkSize = 0;
    params.highWaterMark || 1024 * 512;
  }
  else {

  }

  try {

    format = ytdl.chooseFormat(info.formats, params);
    if (!format.contentLength) {
      quality = "highestvideo";
      format = ytdl.chooseFormat(info.formats, params);
    }

  } catch (error) {
    res.sendStatus(404)
  }

  var totalSize = format.contentLength;
  console.log(id);

  var range = req.headers.range;
  range = range && rangeParser(totalSize, range)[0];
  res.setHeader('Accept-Ranges', 'bytes');
  res.type(format.mimeType);
  req.socket.setTimeout(3600000);

  if (!range) {
      res.setHeader('Content-Length', totalSize);
      if (req.method === 'HEAD') {
        return res.end();
      }
      return pump(ytdl(link , params), res);
    }
  res.statusCode = 206;
  res.setHeader('Content-Length', range.end - range.start + 1);
  res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + totalSize);
  if (req.method === 'HEAD') {
      return res.end();
  }
  params.range = {start : range.start , end : range.end}
  pump(ytdl(link ,  params), res);


});


module.exports = api;
