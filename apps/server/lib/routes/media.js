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

function input(req) {
  return media.input(req.media, req.socket.localPort, req.lease.deviceId);
}

// The bytes (HTTP ranges). A stopped torrent starts again (BUSY past the
// limit), unless the file is finished on disk; a stream download fetches only
// this file from then on (season packs), with its tail early.
function stream(req, res) {
  var file = req.media,
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

// The file with its audio re-encoded to AAC, from ?t=<seconds>, track ?audio=<n>
function transcoded(req, res) {
  var file = req.media;
  if (!sessions.takeTranscodeSlot(req.lease, file, res)) {
    return fail(res, 'BUSY', 'This server already transcodes ' + settings.get('streaming.maxTranscodes') +
      ' videos; try again later');
  }
  sessions.trackStream(req.lease, req, res, file, 'audio-transcode');
  req.socket.setTimeout(3600000);
  input(req).then(function (url) {
    transcode.stream(url, parseFloat(req.query.t) || 0, parseInt(req.query.audio, 10) || 0, req, res);
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

var ref = '/:ref',
  open = [fromRef, audience, lease];

router.get(ref, open, stream);   // and HEAD
router.get(ref + '/probe', open, probe);
router.get(ref + '/keyframe', open, keyframe);
router.get(ref + '/transcode', open, transcoded);
router.post(ref + '/keepalive', open, keepalive);
router.get(ref + '/subtitles', fromRef, audience, subtitleList);
router.get(ref + '/subtitles/:index(\\d+)', fromRef, audience, subtitleFile);
// The calling device lets go (a torrent pauses 30 s after the last device let
// go; nothing is deleted)
router.delete(ref, fromRef, function (req, res) {
  sessions.release(req.media.key, sessions.device(req).id);
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
