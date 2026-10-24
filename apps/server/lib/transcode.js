'use strict';

// Audio transcoding for codecs Chromium can't decode (AC-3, E-AC-3, DTS,
// TrueHD...). ffmpeg reads the file from its path on disk, or from our own
// byte-range route while a torrent downloads it (so the torrent still
// downloads on demand; lib/media#input), copies the video and re-encodes only
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

// { duration, video, width, height, hdr, audio: [{ index, codec, language, channels, title }],
//   subtitles: [{ index, codec, language, title, forced }], transcode }
// `transcode`: the default audio track can't be played by Chromium. Cached
// by `key` (lib/media#probeKey), else by the input; not at all with
// { cache: false } (the library's scanner keeps its answers in the DB).
function probe(url, key, options) {
  key = key || url;
  if (probes[key]) {
    return probes[key];
  }
  probes[key] = new Promise(function (resolve, reject) {
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
        subtitles = streams.filter(function (s) { return s.codec_type === 'subtitle'; }).map(function (s, i) {
          var tags = s.tags || {};
          return {
            index: i,
            codec: s.codec_name || null,
            language: tags.language || null,
            title: tags.title || null,
            forced: !!(s.disposition && s.disposition.forced)
          };
        }),
        main = audio.filter(function (a) { return a['default']; })[0] || audio[0];

      resolve({
        duration: parseFloat(data.format && data.format.duration) || null,
        video: video ? video.codec_name : null,
        width: video && video.width || null,
        height: video && video.height || null,
        hdr: !!video && ['smpte2084', 'arib-std-b67'].indexOf(video.color_transfer) !== -1,
        audio: audio,
        subtitles: subtitles,
        transcode: !!main && PLAYABLE_AUDIO.indexOf(main.codec) === -1,
      });
    });
  });
  var result = probes[key];
  if (options && options.cache === false) {
    delete probes[key];
  } else {
    result.catch(function () { delete probes[key]; });
  }
  return result;
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
// when the player drops the connection (seek, leave). `audioUrl`: the audio
// comes from that file instead (a torrent's separate audio track: a second
// input, its first audio stream, started at the same time; releases make
// such tracks on the video's timeline).
function stream(url, start, audioIndex, req, res, audioUrl) {
  var args = ['-v', 'error'];
  function input(from) {
    if (start > 0) {
      args.push('-noaccurate_seek', '-ss', String(start));
    }
    args.push('-i', from);
  }
  input(url);
  if (audioUrl) {
    input(audioUrl);
  }
  args.push(
    '-map', '0:v:0', '-map', audioUrl ? '1:a:0' : '0:a:' + audioIndex,
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
  // ffmpeg names its input URL in errors: keep the internal secret (lib/auth) out of the logs
  child.stderr.on('data', function (d) { log.warn(String(d).trim().replace(/([?&]internal=)[^&\s]+/g, '$1…')); });

  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Cache-Control', 'no-store');
  child.stdout.pipe(res);
  child.on('close', function () { res.end(); });

  req.on('close', function () { child.kill('SIGKILL'); });
}

// Text subtitle streams ffmpeg can turn into WebVTT; image ones (PGS,
// VobSub, DVB) can't be (docs/providers-plan.md decision F)
var TEXT_SUBTITLES = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'eia_608'],
  IMAGE_SUBTITLES = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext'],
  SUBTITLE_TIMEOUT_MS = 5 * 60 * 1000,
  SUBTITLE_MAX_BYTES = 10 * 1024 * 1024,
  extracted = new Map(),
  EXTRACTED_MAX = 50;

function subtitleKind(codec) {
  return TEXT_SUBTITLES.indexOf(codec) !== -1 ? 'text' : IMAGE_SUBTITLES.indexOf(codec) !== -1 ? 'image' : 'none';
}

/**
 * The file's subtitle stream `index` (among its subtitle streams) as WebVTT.
 * ffmpeg reads the whole file for it (subtitle packets are spread through
 * it): only for files on disk (lib/media). Kept by `key` (the probe's).
 * @returns {Promise<string>}
 */
function subtitle(url, index, key) {
  var cacheKey = (key || url) + '#' + index;
  if (extracted.has(cacheKey)) {
    return extracted.get(cacheKey);
  }
  var work = new Promise(function (resolve, reject) {
    var chunks = [], size = 0, errors = '',
      child = spawn(ffmpeg.paths().ffmpeg, ['-v', 'error', '-nostdin', '-i', url, '-map', '0:s:' + index, '-f', 'webvtt', 'pipe:1']),
      timer = setTimeout(function () { child.kill('SIGKILL'); }, SUBTITLE_TIMEOUT_MS);
    child.stdout.on('data', function (d) {
      size += d.length;
      if (size > SUBTITLE_MAX_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', function (d) { errors = (errors + d).slice(-500); });
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    child.on('close', function (code) {
      clearTimeout(timer);
      var text = Buffer.concat(chunks).toString('utf8');
      if (code !== 0 || !/^WEBVTT/.test(text)) {
        log.warn('subtitle extraction failed (' + code + '): ' + errors.trim().replace(/([?&]internal=)[^&\s]+/g, '$1…'));
        return reject(new Error('ffmpeg couldn\'t read this subtitle track'));
      }
      resolve(text);
    });
  });
  extracted.set(cacheKey, work);
  while (extracted.size > EXTRACTED_MAX) {
    extracted.delete(extracted.keys().next().value);
  }
  work.catch(function () { extracted.delete(cacheKey); });
  return work;
}

module.exports = {
  probe: probe,
  keyframe: keyframe,
  stream: stream,
  subtitle: subtitle,
  subtitleKind: subtitleKind,
  PLAYABLE_AUDIO: PLAYABLE_AUDIO
};
