'use strict';

// Audio transcoding for codecs Chromium can't decode (AC-3, E-AC-3, DTS,
// TrueHD...). ffmpeg reads the file from our own byte-range route (so the
// torrent still downloads on demand), copies the video and re-encodes only
// the audio to AAC, as live Matroska (it keeps each stream's own timestamps;
// fragmented MP4 lost the audio/video gap after a seek). The output can't be
// seeked by bytes: the player restarts it at ?t=<seconds> instead, where
// <seconds> is a keyframe (keyframe()): copied video can only start on one,
// and the audio is started there too (-noaccurate_seek) so both line up.
// Binaries: lib/ffmpeg.js (environment → settings → bundled → PATH).

var spawn = require('child_process').spawn,
  ffmpeg = require('./ffmpeg'),
  log = require('./logger').child('ffmpeg');

var PLAYABLE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  PROBE_TIMEOUT_MS = 90000;

var probes = {};

// { duration, video, audio: [{ index, codec, language, channels, title }], transcode }
// `transcode`: the default audio track can't be played by Chromium.
function probe(url) {
  if (probes[url]) {
    return probes[url];
  }
  probes[url] = new Promise(function (resolve, reject) {
    var out = '',
      child = spawn(ffmpeg.paths().ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', url]),
      timer = setTimeout(function () { child.kill('SIGKILL'); }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    child.on('close', function (code) {
      clearTimeout(timer);
      var data;
      try {
        data = JSON.parse(out);
      } catch (e) {
        return reject(new Error('ffprobe failed (' + code + ')'));
      }
      var streams = data.streams || [],
        video = streams.filter(function (s) { return s.codec_type === 'video'; })[0],
        audio = streams.filter(function (s) { return s.codec_type === 'audio'; }).map(function (s, i) {
          var tags = s.tags || {};
          return {
            index: i,
            codec: s.codec_name,
            language: tags.language || null,
            title: tags.title || null,
            channels: s.channels,
            default: !!(s.disposition && s.disposition['default']),
          };
        }),
        main = audio.filter(function (a) { return a['default']; })[0] || audio[0];

      resolve({
        duration: parseFloat(data.format && data.format.duration) || null,
        video: video ? video.codec_name : null,
        audio: audio,
        transcode: !!main && PLAYABLE_AUDIO.indexOf(main.codec) === -1,
      });
    });
  });
  probes[url].catch(function () { delete probes[url]; });
  return probes[url];
}

// Time of the last video keyframe at or before `t` (falls back to `t`)
function keyframe(url, t) {
  return new Promise(function (resolve) {
    var out = '',
      child = spawn(ffmpeg.paths().ffprobe, ['-v', 'error', '-read_intervals', t + '%+#1', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', url]),
      timer = setTimeout(function () { child.kill('SIGKILL'); }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function () { clearTimeout(timer); resolve(t); });
    child.on('close', function () {
      clearTimeout(timer);
      var time = parseFloat(out);
      resolve(isFinite(time) && time <= t ? time : t);
    });
  });
}

// Pipes the transcoded stream from `start` seconds into res; stops ffmpeg
// when the player drops the connection (seek, leave).
function stream(url, start, audioIndex, req, res) {
  var args = ['-v', 'error'];
  if (start > 0) {
    args.push('-noaccurate_seek', '-ss', String(start));
  }
  args.push(
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:' + audioIndex,
    '-c:v', 'copy',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-sn', '-dn',
    '-f', 'matroska', 'pipe:1'
  );

  var child = spawn(ffmpeg.paths().ffmpeg, args);
  child.on('error', function (e) {
    if (!res.headersSent) {
      res.status(503).json({ error: 'ffmpeg unavailable: ' + e.message, code: 'TRANSCODER_UNAVAILABLE' });
    }
  });
  child.stderr.on('data', function (d) { log.warn(String(d).trim()); });

  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Cache-Control', 'no-store');
  child.stdout.pipe(res);
  child.on('close', function () { res.end(); });

  req.on('close', function () { child.kill('SIGKILL'); });
}

module.exports = { probe: probe, keyframe: keyframe, stream: stream };
