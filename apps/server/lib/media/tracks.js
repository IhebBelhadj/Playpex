'use strict';

// A title's tracks (docs/providers-plan.md §6.1): everything the player can
// switch for a media ref, in one answer (GET /media/{ref}/tracks).
//
//   video      the file itself (current) and, for a torrent, its other videos
//              (an episode of the pack, an extra)
//   audio      the file's own audio streams (ffprobe) and, for a torrent, the
//              audio files that go with the video (lib/media/files#companions)
//   subtitles  the file's own subtitle streams, the torrent's subtitle files
//              of the video, or a disk file's sidecars (the library's scan)
//
// `play` says how each plays here: audio `direct` (Chromium decodes it: the
// player switches it natively), `convert` (the server's ffmpeg → AAC: the
// /transcode stream with ?audio= or ?audioRef=), `none` (no ffmpeg);
// subtitles `text` (served as WebVTT), `image` (PGS / VobSub: listed, not
// shown), `none`. An embedded subtitle of a file still downloading is
// `available: false` (ffmpeg reads the whole file for it: decision G).
// Track ids: `a:<n>` / `s:<n>` (the n-th audio / subtitle stream),
// `a:f<i>` / `s:f<i>` (the i-th file of the torrent, or the i-th sidecar of a
// disk file), `v:f<i>` (another video of the torrent), `v:0` (this one).

var path = require('path'),
  transcode = require('../transcode'),
  torrents = require('../torrents/client'),
  refs = require('./refs'),
  mediaFiles = require('./files'),
  languages = require('../subtitles/languages'),
  log = require('../logger').child('ffmpeg');

// 'eng' / 'en' / 'English' → 'en'; unknown ones as they are ('und': none)
function languageCode(code) {
  if (!code || /^(und|unk|mis|zxx)$/i.test(code)) {
    return null;
  }
  var lang = languages.normalize(code);
  return lang && lang.name !== code ? lang.code : String(code);
}

function languageName(code) {
  if (!code) {
    return null;
  }
  var lang = languages.normalize(code);
  return lang && lang.name !== code ? lang.name : null;
}

// What the file is on this server: on disk (ffmpeg reads its path), or a torrent's file still downloading
function onDisk(media) {
  if (media.kind === 'file') {
    return Promise.resolve(true);
  }
  if (media.kind !== 'torrent') {
    return Promise.resolve(false);
  }
  return torrents.diskPath(media.infoHash, media.path).then(function (p) { return !!p; });
}

function embedded(probe, ffmpeg, disk) {
  var audio = (probe && probe.audio || []).map(function (a) {
    var direct = transcode.PLAYABLE_AUDIO.indexOf(a.codec) !== -1;
    return {
      id: 'a:' + a.index,
      source: 'embedded',
      index: a.index,
      language: languageCode(a.language),
      languageName: languageName(a.language),
      codec: a.codec || null,
      channels: a.channels || null,
      title: a.title || null,
      default: !!a.default,
      play: direct ? 'direct' : ffmpeg ? 'convert' : 'none'
    };
  });
  var subtitles = (probe && probe.subtitles || []).map(function (s) {
    var kind = transcode.subtitleKind(s.codec),
      play = kind === 'text' && !ffmpeg ? 'none' : kind,
      track = {
        id: 's:' + s.index,
        source: 'embedded',
        index: s.index,
        language: languageCode(s.language),
        languageName: languageName(s.language),
        codec: s.codec || null,
        title: s.title || null,
        forced: !!s.forced,
        play: play,
        available: play !== 'text' || disk
      };
    if (play === 'text' && !disk) {
      track.note = 'Ready when the download finishes';
    }
    return track;
  });
  return { audio: audio, subtitles: subtitles };
}

// A torrent's other files that go with this video
function torrentFiles(media, ffmpeg) {
  var all = torrents.files(media.infoHash) || [],
    indexed = all.map(function (f, i) { return Object.assign({}, f, { index: i }); }),
    video = indexed.filter(function (f) { return f.path === media.path; })[0];
  if (!video) {
    return { video: [], audio: [], subtitles: [] };
  }
  var mates = mediaFiles.companions(indexed, video);
  return {
    video: mates.videos.map(function (f) {
      return { id: 'v:f' + f.index, ref: f.ref, name: f.path, size: f.size, kind: f.kind, current: false };
    }),
    audio: mates.audio.map(function (f) {
      return {
        id: 'a:f' + f.index, source: 'file', ref: f.ref, name: f.path, size: f.size,
        language: f.language, languageName: languageName(f.language), title: f.label,
        codec: path.extname(f.path).slice(1).toLowerCase() || null,
        play: ffmpeg ? 'convert' : 'none'
      };
    }),
    subtitles: mates.subtitles.map(function (f) {
      return {
        id: 's:f' + f.index, source: 'file', ref: f.ref, name: f.path, size: f.size,
        language: f.language, languageName: languageName(f.language), forced: f.forced, sdh: f.sdh,
        codec: path.extname(f.path).slice(1).toLowerCase() || null,
        play: /\.(idx|sub)$/i.test(f.path) ? 'image' : 'text',
        available: true
      };
    })
  };
}

// A disk file's sidecar subtitles (the scanner's list)
function sidecars(media) {
  return (media.subtitles || []).map(function (sub, i) {
    return {
      id: 's:f' + i, source: 'file', name: sub.relPath, language: sub.language || null,
      languageName: languageName(sub.language), forced: !!sub.forced, sdh: !!sub.sdh,
      codec: path.extname(sub.relPath).slice(1).toLowerCase() || null, play: 'text', available: true
    };
  });
}

/**
 * @param {object} media      lib/media#resolve's
 * @param {string|null} url   what ffprobe reads (lib/media#input), null without ffmpeg
 * @param {boolean} ffmpeg    ffmpeg / ffprobe are there
 * @returns {Promise<{ video, audio, subtitles, probed: boolean }>}
 */
function list(media, url, ffmpeg) {
  var probing = ffmpeg && url ? transcode.probe(url, require('./index').probeKey(media)).catch(function (err) {
    log.warn('tracks: probe failed for ' + media.ref + ': ' + err.message);
    return null;
  }) : Promise.resolve(null);
  return Promise.all([probing, onDisk(media)]).then(function (r) {
    var probe = r[0], own = embedded(probe, ffmpeg, r[1]),
      files = media.kind === 'torrent' ? torrentFiles(media, ffmpeg) :
        { video: [], audio: [], subtitles: media.kind === 'file' ? sidecars(media) : [] };
    return {
      video: [{ id: 'v:0', ref: media.ref, name: media.path || media.name, size: media.size || null, current: true }].concat(files.video),
      audio: own.audio.concat(files.audio),
      subtitles: own.subtitles.concat(files.subtitles),
      probed: !!probe
    };
  });
}

/**
 * The file behind a file track of a torrent (`a:f<i>`, `s:f<i>`): its index
 * in the torrent, and it must go with the playing video. null otherwise.
 * @returns {{ ref, path, size, language }|null}
 */
function fileTrack(media, trackId, kind) {
  var m = /^[as]:f(\d{1,6})$/.exec(trackId || '');
  if (!m || media.kind !== 'torrent') {
    return null;
  }
  var found = torrentFiles(media, true)[kind === 'audio' ? 'audio' : 'subtitles'].filter(function (t) { return t.id === trackId; })[0];
  return found ? { ref: found.ref, path: found.name, size: found.size, language: found.language } : null;
}

/** A torrent's audio file by its ref, when it goes with the playing video */
function audioFile(media, ref) {
  var parsed = refs.parse(ref);
  if (!parsed || parsed.kind !== 'torrent' || media.kind !== 'torrent' || parsed.infoHash !== media.infoHash) {
    return null;
  }
  var found = torrentFiles(media, true).audio.filter(function (t) { return t.ref === ref; })[0];
  return found ? { ref: found.ref, path: found.name } : null;
}

module.exports = {
  list: list,
  fileTrack: fileTrack,
  audioFile: audioFile
};
