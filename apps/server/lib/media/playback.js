'use strict';

// How a client plays a file (docs/dashboard-plan.md §5.2, decision C; the
// "capabilities + …/playback" item of docs/server-separation-plan.md §6.5):
// the client says what its player decodes, the server probes the file and
// answers
//
//   direct  GET /media/{ref} as it is (byte ranges)
//   hls     an HLS stream ffmpeg makes from the file: video copied, audio to
//           AAC, fMP4 segments in <cache>/hls/<session>/, from the keyframe
//           at or before ?t= (the player restarts it to seek outside it, as
//           Playpex TV does with its audio conversion)
//   none    it can't play there; `notes` say why, in words
//
// Sessions: one per device and file (a new one replaces it), counted in
// streaming.maxTranscodes; gone when the device releases the file, or after
// IDLE_MS without a request for its playlist or segments.

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  spawn = require('child_process').spawn,
  ffmpeg = require('../ffmpeg'),
  transcode = require('../transcode'),
  settings = require('../settings'),
  paths = require('../paths'),
  protocol = require('@playpex/protocol'),
  log = require('../logger').child('ffmpeg');

var IDLE_MS = 90 * 1000,
  SEGMENT_SECONDS = 4,
  WAIT_MS = 45 * 1000,
  ROOT = path.join(paths.cache, 'hls');

var sessions = {};   // id → { id, ref, deviceId, dir, child, start, last, ended, error }

// What every browser decodes; the client adds the rest (?mkv=1&hevc=1&ac3=1 …)
var ALWAYS = { containers: ['mp4', 'webm', 'mov'], video: ['h264', 'vp8', 'vp9', 'av1'], audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'] };
var OPTIONAL = {
  containers: { mkv: 'matroska' },
  video: { hevc: 'hevc' },
  audio: { ac3: 'ac3', eac3: 'eac3', dts: 'dts', truehd: 'truehd' }
};
var NAMES = { hevc: 'HEVC', h264: 'H.264', mpeg4: 'MPEG-4 Part 2 (XviD)', mpeg2video: 'MPEG-2', vc1: 'VC-1', ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)', dts: 'DTS', truehd: 'Dolby TrueHD', matroska: 'MKV', avi: 'AVI' };

/** The client's capabilities from the query: { containers, video, audio } it decodes */
function capabilities(query) {
  var caps = { containers: ALWAYS.containers.slice(), video: ALWAYS.video.slice(), audio: ALWAYS.audio.slice() };
  Object.keys(OPTIONAL).forEach(function (kind) {
    Object.keys(OPTIONAL[kind]).forEach(function (flag) {
      if (query[flag] === '1' || query[flag] === 'true') {
        caps[kind].push(OPTIONAL[kind][flag]);
      }
    });
  });
  return caps;
}

function containerOf(name) {
  var ext = (/\.([a-z0-9]{2,4})$/i.exec(name || '') || [])[1];
  ext = ext ? ext.toLowerCase() : '';
  return { mkv: 'matroska', webm: 'webm', mp4: 'mp4', m4v: 'mp4', mov: 'mov', avi: 'avi', ts: 'mpegts', m2ts: 'mpegts', wmv: 'asf' }[ext] || ext;
}

function name(codec) {
  return NAMES[codec] || (codec || 'unknown').toUpperCase();
}

/**
 * The way to play `media` for a client with `caps`, from its probe
 * @returns {{ method: 'direct'|'hls'|'none', notes: string[], audio: number }}
 */
function decide(media, probe, caps, audioIndex) {
  var container = containerOf(media.name),
    audio = probe.audio[audioIndex] || probe.audio[0] || null,
    videoOk = !probe.video || caps.video.indexOf(probe.video) !== -1,
    audioOk = !audio || caps.audio.indexOf(audio.codec) !== -1,
    containerOk = caps.containers.indexOf(container) !== -1,
    notes = [];
  if (!videoOk) {
    notes.push('This video is ' + name(probe.video) + ', which this browser doesn’t decode. It plays on Playpex TV' +
      (probe.video === 'hevc' ? ', and in browsers with HEVC support (Safari, Chrome / Edge on most hardware).' : '.'));
    return { method: 'none', notes: notes, audio: audio ? audio.index : 0 };
  }
  if (containerOk && audioOk && audioIndex === 0) {
    return { method: 'direct', notes: notes, audio: audio ? audio.index : 0 };
  }
  if (containerOk && audioOk) {
    // browsers can't switch a file's sound tracks themselves
    notes.push('The server plays this sound track (' + (audio.language || 'track ' + (audio.index + 1)) + ') as it streams.');
  }
  if (!containerOk) {
    notes.push('This browser doesn’t open ' + name(container) + ' files: the server repackages it as it plays.');
  }
  if (!audioOk) {
    notes.push('Its sound is ' + name(audio.codec) + ': the server converts it to AAC.');
  }
  return { method: 'hls', notes: notes, audio: audio ? audio.index : 0 };
}

// ── HLS sessions ───────────────────────────────────────────────────────────

function stop(id, why) {
  var s = sessions[id];
  if (!s) {
    return;
  }
  delete sessions[id];
  if (s.child && s.child.exitCode === null) {
    s.child.kill('SIGKILL');
  }
  if (s.res && !s.res.destroyed) {
    s.res.destroy();
  }
  fs.rm(s.dir, { recursive: true, force: true }, function () {});
  log.debug('hls ' + id + ' stopped (' + why + ')');
}

var sweeper = setInterval(function () {
  Object.keys(sessions).forEach(function (id) {
    if (Date.now() - sessions[id].last > IDLE_MS) {
      stop(id, 'idle');
    }
  });
}, 15 * 1000);
sweeper.unref();

/**
 * Starts an HLS session of `media` at `start` seconds (a keyframe) for a device:
 * ffmpeg reads `input` and writes index.m3u8 + fMP4 segments.
 * @param {object} slot  { res } a stand-in response for lib/sessions#takeTranscodeSlot (destroyed when the session ends)
 */
function startSession(media, input, start, audioIndex, deviceId, slot) {
  Object.keys(sessions).forEach(function (id) {
    if (sessions[id].ref === media.ref && sessions[id].deviceId === deviceId) {
      stop(id, 'replaced');
    }
  });
  var id = crypto.randomBytes(12).toString('hex'),
    dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  var args = ['-v', 'error', '-nostdin'];
  if (start > 0) {
    args.push('-noaccurate_seek', '-ss', String(start));
  }
  args.push('-i', input,
    '-map', '0:v:0', '-map', '0:a:' + audioIndex + '?',
    '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-sn', '-dn',
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_filename', path.join(dir, 's%05d.m4s'), path.join(dir, 'index.m3u8'));
  var child = spawn(ffmpeg.paths().ffmpeg, args),
    s = sessions[id] = { id: id, ref: media.ref, deviceId: deviceId, dir: dir, child: child, start: start, last: Date.now(),
      ended: false, error: null, res: slot.res };
  child.stderr.on('data', function (d) {
    var text = String(d).trim().replace(/([?&]internal=)[^&\s]+/g, '$1…');
    s.error = text.slice(-300);
    log.warn('hls ' + id + ': ' + text);
  });
  child.on('error', function (e) {
    s.error = e.message;
    s.ended = true;
  });
  child.on('close', function (code) {
    s.ended = true;
    if (code && !s.error) {
      s.error = 'ffmpeg stopped (' + code + ')';
    }
  });
  slot.res.on('close', function () {
    stop(id, 'its slot was taken');
  });
  log.info('hls ' + id + ' for ' + deviceId + ': ' + media.name + ' from ' + start.toFixed(1) + ' s');
  return s;
}

// Waits for a file of the session (ffmpeg writes it with a .tmp name first)
function waitFor(s, file) {
  var full = path.join(s.dir, file), deadline = Date.now() + WAIT_MS;
  return new Promise(function (resolve, reject) {
    (function check() {
      if (!sessions[s.id]) {
        return reject(Object.assign(new Error('This stream ended'), { code: 'NOT_FOUND' }));
      }
      fs.stat(full, function (err) {
        if (!err) {
          return resolve(full);
        }
        if (s.ended) {
          return reject(Object.assign(new Error(s.error || 'This stream ended before ' + file), { code: s.error ? 'UPSTREAM' : 'NOT_FOUND' }));
        }
        if (Date.now() > deadline) {
          return reject(Object.assign(new Error('The stream is slow to start (is the torrent getting peers?)'), { code: 'UPSTREAM' }));
        }
        setTimeout(check, 250);
      });
    })();
  });
}

/** Serves index.m3u8 / init.mp4 / sNNNNN.m4s of a session (the device's own) */
function serve(req, res, ref, id, file, deviceId) {
  var s = sessions[id];
  if (!s || s.ref !== ref || s.deviceId !== deviceId || !/^(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/.test(file)) {
    return Promise.reject(Object.assign(new Error('No such stream (it ended, or another one replaced it)'), { code: 'NOT_FOUND' }));
  }
  s.last = Date.now();
  return waitFor(s, file).then(function (full) {
    s.last = Date.now();
    res.setHeader('Cache-Control', file === 'index.m3u8' ? 'no-store' : 'private, max-age=3600');
    res.type(file === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4');
    if (file !== 'index.m3u8') {
      return new Promise(function (resolve, reject) {
        fs.createReadStream(full).on('error', reject).on('end', resolve).pipe(res);
      });
    }
    // ffmpeg writes ENDLIST only when it finishes: an event playlist hls.js keeps reloading
    // every part asked as the same device (a native HLS player sends no header of ours)
    var query = '?' + protocol.DEVICE_PARAM + '=' + encodeURIComponent(deviceId);
    return fs.promises.readFile(full, 'utf8').then(function (text) {
      res.send(text.split('\n').map(function (line) {
        if (/^#EXT-X-MAP:URI="([^"]+)"/.test(line)) {
          return line.replace(/URI="([^"]+)"/, function (m, uri) { return 'URI="' + uri + query + '"'; });
        }
        return line && line[0] !== '#' ? line + query : line;
      }).join('\n'));
    });
  });
}

/** The device let go of the file (DELETE /media/{ref}): its sessions end */
function left(ref, deviceId) {
  Object.keys(sessions).forEach(function (id) {
    if (sessions[id].ref === ref && sessions[id].deviceId === deviceId) {
      stop(id, 'released');
    }
  });
}

function stopAll() {
  Object.keys(sessions).forEach(function (id) { stop(id, 'server stopping'); });
}

/**
 * GET /media/{ref}/playback: the answer for this client
 * @param {object} ctx { media, input (Promise of ffmpeg's input), query, deviceId, takeSlot(res) → bool }
 */
function playback(ctx) {
  var media = ctx.media, caps = capabilities(ctx.query), t = Math.max(0, parseFloat(ctx.query.t) || 0),
    audioIndex = Math.max(0, parseInt(ctx.query.audio, 10) || 0),
    direct = protocol.API_PREFIX + '/media/' + media.ref;
  return ffmpeg.available().then(function (available) {
    if (!available) {
      return {
        method: 'direct', url: direct, start: 0, duration: null, audio: 0,
        notes: ['This server has no ffmpeg: the file plays as it is, if this browser can.']
      };
    }
    return ctx.input.then(function (input) {
      return transcode.probe(input, ctx.probeKey).then(function (probe) {
        var choice = decide(media, probe, caps, audioIndex), answer = {
          method: choice.method, url: null, start: 0, duration: probe.duration, audio: choice.audio, notes: choice.notes
        };
        if (choice.method === 'direct') {
          answer.url = direct;
          return answer;
        }
        if (choice.method === 'none') {
          return answer;
        }
        return (t > 0 ? transcode.keyframe(input, t) : Promise.resolve(0)).then(function (start) {
          var slot = { res: new (require('events').EventEmitter)() };
          slot.res.destroyed = false;
          slot.res.writableEnded = false;
          slot.res.destroy = function () {
            if (!slot.res.destroyed) {
              slot.res.destroyed = true;
              slot.res.emit('close');
            }
          };
          if (!ctx.takeSlot(slot.res, media)) {
            throw Object.assign(new Error('This server already converts ' + settings.get('streaming.maxTranscodes') +
              ' videos; try again later'), { code: 'BUSY' });
          }
          var s = startSession(media, input, start, choice.audio, ctx.deviceId, slot);
          answer.start = start;
          answer.url = direct + '/hls/' + s.id + '/index.m3u8';
          return answer;
        });
      });
    });
  });
}

module.exports = {
  capabilities: capabilities,
  decide: decide,
  playback: playback,
  serve: serve,
  left: left,
  stopAll: stopAll
};
