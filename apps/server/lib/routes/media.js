'use strict';

// /api/v1/media/{ref}: stream, probe, keyframe, transcode a file by its media
// ref, a torrent's file or a file on disk (lib/media, docs/media-server-plan.md
// §5.4). The torrent routes (/torrents/{infoHash}/files|probe|keyframe|
// transcode/{path}, lib/api.js) are aliases: `torrentFile` resolves their
// params, then the same handlers answer.
//
// Every route takes or refreshes the calling device's lease (lib/sessions.js)
// on the media's key: a torrent's info hash, or a disk file's ref.

var express = require('express'),
  rangeParser = require('range-parser'),
  pump = require('pump'),
  media = require('../media'),
  transcode = require('../transcode'),
  tracks = require('../media/tracks'),
  hls = require('../media/hls'),
  ffmpeg = require('../ffmpeg'),
  subtitles = require('../subtitles'),
  sessions = require('../sessions'),
  settings = require('../settings'),
  languages = require('../subtitles/languages'),
  errors = require('../errors');

var fail = errors.fail,
  router = express.Router();

// req.media from {ref}
function fromRef(req, res, next) {
  media.resolve(req.params.ref).then(function (found) {
    req.media = found;
    next();
  }, function (err) {
    errors.failed(res, err);
  });
}

// req.media from {infoHash} + {path} (the torrent aliases)
function torrentFile(req, res, next) {
  var found = media.torrentFile(req.params.infoHash, req.params.path);
  if (!found) {
    return fail(res, 'NOT_FOUND', 'No such file in this torrent');
  }
  req.media = found;
  next();
}

// Files of an adults-only folder: never for a kids profile (`?profile=`, else
// the one the device's player reported in its keepalive). ffmpeg's own reads
// come from a request that passed already.
function audience(req, res, next) {
  if (req.auth && req.auth.kind === 'internal') {
    return next();
  }
  var held = sessions.current(req.media.key, req),
    profileId = req.query.profile || held && held.playback && held.playback.profileId;
  media.allowed(req.media, profileId).then(function (ok) {
    if (!ok) {
      return fail(res, 'FORBIDDEN', 'This video is not available to this profile');
    }
    next();
  }, function (err) {
    errors.failed(res, err);
  });
}

// The calling device holds the media (acquires or refreshes its lease)
function lease(req, res, next) {
  req.lease = sessions.acquire(req.media.key, req);
  next();
}

// A plugin's HLS or live stream has no file to probe, transcode or read
// tracks from (an HLS player reads its renditions from the playlist)
function bytes(req, res, next) {
  if (req.media.kind === 'hls' || req.media.kind === 'live') {
    return fail(res, 'NOT_SUPPORTED', 'A stream has no file to read this from');
  }
  next();
}

// An h_ ref's playlist (index.m3u8), or a part of it by token (r/<token>/<its file name>, lib/media/hls.js)
function playlist(req, res) {
  if (req.media.kind !== 'hls') {
    return fail(res, 'NOT_FOUND', 'Not an HLS stream');
  }
  sessions.trackStream(req.lease, req, res, req.media, 'hls');
  hls.playlist(req, res, req.media, req.params.token == null ? null : req.params.token, req.lease.deviceId);
}

function input(req) {
  return media.input(req.media, req.socket.localPort, req.lease.deviceId);
}

// The bytes (HTTP ranges). A stopped torrent starts again (BUSY past the
// limit), unless the file is finished on disk; a stream download fetches only
// this file from then on (season packs), with its tail early.
function stream(req, res) {
  var file = req.media;
  if (file.kind === 'hls') {
    return res.redirect(302, file.ref + '/index.m3u8');
  }
  if (file.kind === 'live') {
    sessions.trackStream(req.lease, req, res, file, 'live');
    req.socket.setTimeout(0);
    return hls.live(req, res, file, req.lease.deviceId);
  }
  var range = req.headers.range && rangeParser(file.size, req.headers.range)[0];

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
  media.open(file, range).then(function (body) {
    if (res.destroyed) {
      return body.destroy();
    }
    headers();
    pump(body, res);
  }, function (err) {
    if (!res.headersSent && !res.destroyed) {
      errors.failed(res, err);
    }
  });
}

// Codecs of a file: { duration, video, audio: [...], transcode }
function probe(req, res) {
  input(req).then(function (url) {
    return transcode.probe(url, media.probeKey(req.media));
  }).then(function (info) {
    res.json(info);
  }, function (e) {
    fail(res, e.code === 'ENOENT' ? 'TRANSCODER_UNAVAILABLE' : 'PROBE_FAILED', e.message);
  });
}

// Where a transcoded stream asked to start at ?t= really starts: { time }
function keyframe(req, res) {
  var t = Math.max(0, parseFloat(req.query.t) || 0);
  input(req).then(function (url) {
    return transcode.keyframe(url, t);
  }).then(function (time) {
    res.json({ time: time });
  }, function () {
    res.json({ time: t });
  });
}

// The file with its audio re-encoded to AAC, from ?t=<seconds>, track
// ?audio=<n>, or the torrent's audio file ?audioRef=<ref> (a file of the same
// torrent that goes with this video: GET …/tracks)
function transcoded(req, res) {
  var file = req.media, audioFile = null;
  if (req.query.audioRef) {
    audioFile = tracks.audioFile(file, String(req.query.audioRef));
    if (!audioFile) {
      return fail(res, 'INVALID', 'audioRef must be one of this video\'s audio files (GET …/tracks)');
    }
  }
  if (!sessions.takeTranscodeSlot(req.lease, file, res)) {
    return fail(res, 'BUSY', 'This server already transcodes ' + settings.get('streaming.maxTranscodes') +
      ' videos; try again later');
  }
  sessions.trackStream(req.lease, req, res, file, 'audio-transcode');
  req.socket.setTimeout(3600000);
  var audioInput = audioFile ? media.input(media.torrentFile(file.infoHash, audioFile.path), req.socket.localPort, req.lease.deviceId) :
    Promise.resolve(null);
  Promise.all([input(req), audioInput]).then(function (urls) {
    transcode.stream(urls[0], parseFloat(req.query.t) || 0, parseInt(req.query.audio, 10) || 0, req, res, urls[1]);
  }, function (err) {
    errors.failed(res, err);
  });
}

// The player is still open (paused videos make no requests), with what it
// plays: { positionS?, durationS?, paused?, title?, profileId?, file?, media? }
function keepalive(req, res) {
  sessions.report(req.lease, req.body);
  res.json({ ok: true });
}

// Sidecar subtitle files of a disk file (Movie.en.srt, Subs/…): { subtitles: [{ index, language, languageName, forced, sdh }] }
function subtitleList(req, res) {
  res.json({
    subtitles: (req.media.subtitles || []).map(function (sub, index) {
      var lang = sub.language ? languages.normalize(sub.language) : null;
      return { index: index, language: sub.language || null, languageName: lang ? lang.name : null, forced: !!sub.forced, sdh: !!sub.sdh };
    })
  });
}

// One of them as WebVTT
function subtitleFile(req, res) {
  media.subtitle(req.media, parseInt(req.params.index, 10)).then(function (vtt) {
    res.type('text/vtt').send(vtt);
  }, function (err) {
    errors.failed(res, err);
  });
}

// Everything the player can switch: { video, audio, subtitles, probed } (lib/media/tracks.js)
function trackList(req, res) {
  ffmpeg.available().then(function (available) {
    return (available ? input(req) : Promise.resolve(null)).then(function (url) {
      return tracks.list(req.media, url, available);
    });
  }).then(function (answer) {
    res.json(answer);
  }, function (err) {
    errors.failed(res, err);
  });
}

// One of the file's own subtitle streams (`index` among them) as WebVTT: a file
// on disk only (409 CONFLICT while a torrent's file downloads: ffmpeg reads
// the whole file for it); image ones (PGS, VobSub) 501 NOT_SUPPORTED
function embeddedSubtitle(req, res) {
  var index = parseInt(req.params.index, 10), file = req.media;
  ffmpeg.available().then(function (available) {
    if (!available) {
      return fail(res, 'TRANSCODER_UNAVAILABLE', 'This server has no ffmpeg to read subtitles inside the video');
    }
    return Promise.all([input(req), file.kind === 'torrent' ? require('../torrents/client').diskPath(file.infoHash, file.path) : Promise.resolve(file.kind === 'file')])
      .then(function (r) {
        if (!r[1]) {
          return fail(res, 'CONFLICT', 'Ready when the download finishes');
        }
        return transcode.probe(r[0], media.probeKey(file)).then(function (probe) {
          var sub = (probe.subtitles || [])[index];
          if (!sub) {
            return fail(res, 'NOT_FOUND', 'No such subtitle track');
          }
          if (transcode.subtitleKind(sub.codec) !== 'text') {
            return fail(res, 'NOT_SUPPORTED', 'This subtitle track is pictures (' + sub.codec + '): it can\'t be shown yet');
          }
          return transcode.subtitle(r[0], index, media.probeKey(file)).then(function (vtt) {
            res.type('text/vtt').send(vtt);
          });
        });
      });
  }).catch(function (err) {
    if (!res.headersSent) {
      fail(res, err.code === 'ENOENT' ? 'TRANSCODER_UNAVAILABLE' : 'PROBE_FAILED', err.message);
    }
  });
}

// A subtitle file of the track list (`f<i>`) as WebVTT: a disk file's sidecar,
// or a torrent's file that goes with the video (fetched now: selected in the
// torrent, ≤ 10 MB)
function subtitleTrackFile(req, res) {
  var file = req.media, id = 's:' + req.params.track;
  if (file.kind === 'file') {
    var i = /^f(\d{1,4})$/.exec(req.params.track);
    if (!i) {
      return fail(res, 'NOT_FOUND', 'No such subtitle track');
    }
    return media.subtitle(file, parseInt(i[1], 10)).then(function (vtt) {
      res.type('text/vtt').send(vtt);
    }, function (err) {
      errors.failed(res, err);
    });
  }
  var track = tracks.fileTrack(file, id, 'subtitles');
  if (!track) {
    return fail(res, 'NOT_FOUND', 'No such subtitle track');
  }
  if (/\.(idx|sub)$/i.test(track.path)) {
    return fail(res, 'NOT_SUPPORTED', 'This subtitle file is pictures (VobSub): it can\'t be shown yet');
  }
  if (track.size > 10 * 1024 * 1024) {
    return fail(res, 'NOT_FOUND', 'This subtitle file is too large');
  }
  var subtitleMedia = media.torrentFile(file.infoHash, track.path);
  media.open(subtitleMedia, null).then(function (body) {
    var chunks = [];
    body.on('data', function (c) { chunks.push(c); });
    body.on('error', function (err) { errors.failed(res, err); });
    body.on('end', function () {
      res.type('text/vtt').send(subtitles.toVtt(Buffer.concat(chunks), track.language));
    });
  }, function (err) {
    errors.failed(res, err);
  });
}

var ref = '/:ref',
  open = [fromRef, audience, lease],
  file = open.concat(bytes);

router.get(ref, open, stream);   // and HEAD
router.get(ref + '/index.m3u8', open, playlist);
router.get(ref + '/r/:token([A-Za-z0-9_.-]{1,4096})/:name([A-Za-z0-9._-]{1,64})', open, playlist);
router.get(ref + '/probe', file, probe);
router.get(ref + '/keyframe', file, keyframe);
router.get(ref + '/transcode', file, transcoded);
router.post(ref + '/keepalive', open, keepalive);
router.get(ref + '/subtitles', fromRef, audience, bytes, subtitleList);
router.get(ref + '/subtitles/:index(\\d+)', fromRef, audience, bytes, subtitleFile);
router.get(ref + '/tracks', file, trackList);
router.get(ref + '/subtitles/embedded/:index(\\d+)', file, embeddedSubtitle);
router.get(ref + '/subtitles/file/:track(f\\d+)', file, subtitleTrackFile);
// The calling device lets go (a torrent pauses 30 s after the last device let
// go; nothing is deleted)
router.delete(ref, fromRef, function (req, res) {
  sessions.release(req.media.key, sessions.device(req).id);
  hls.left(req.media.ref, sessions.device(req).id);
  res.json({ ok: true });
});

module.exports = {
  router: router,
  // the torrent aliases (lib/api.js): [middleware…, handler]
  torrent: {
    stream: [torrentFile, audience, lease, stream],
    probe: [torrentFile, audience, lease, probe],
    keyframe: [torrentFile, audience, lease, keyframe],
    transcode: [torrentFile, audience, lease, transcoded]
  }
};
