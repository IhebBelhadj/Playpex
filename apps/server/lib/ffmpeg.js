'use strict';

// Which ffmpeg / ffprobe the server runs (lib/transcode.js), first match wins
// (docs/server-separation-plan.md §5.5):
//   1. FFMPEG_PATH / FFPROBE_PATH environment variables
//   2. the transcoding settings (ffmpegPath / ffprobePath)
//   3. the copy bundled with the server: PLAYPEX_FFMPEG_DIR, start({ffmpegDir}),
//      or <server>/vendor/ffmpeg (installers put it there, plan step 6)
//   4. ffmpeg / ffprobe from the PATH
// 1 and 2 both arrive through lib/settings (the environment wins there).

var fs = require('fs'),
  path = require('path'),
  spawn = require('child_process').spawn,
  settings = require('./settings');

var EXE = process.platform === 'win32' ? '.exe' : '',
  bundledDirOption = null,
  versionCache = {};

function bundledDirs() {
  return [process.env.PLAYPEX_FFMPEG_DIR, bundledDirOption, path.join(__dirname, '..', 'vendor', 'ffmpeg')]
    .filter(Boolean);
}

function findBundled(name) {
  var dirs = bundledDirs();
  for (var i = 0; i < dirs.length; i++) {
    var file = path.join(dirs[i], name + EXE);
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return null;
}

function resolveOne(name, key) {
  var configured = settings.get(key);
  if (configured) {
    return { path: configured, source: settings.sources()[key] === 'env' ? 'env' : 'settings' };
  }
  var bundled = findBundled(name);
  if (bundled) {
    return { path: bundled, source: 'bundled' };
  }
  return { path: name, source: 'path' };
}

function setBundledDir(dir) {
  bundledDirOption = dir || null;
}

// { ffmpeg, ffprobe, source }: paths to spawn, resolved on every call (settings may change)
function paths() {
  var ffmpeg = resolveOne('ffmpeg', 'transcoding.ffmpegPath'),
    ffprobe = resolveOne('ffprobe', 'transcoding.ffprobePath');
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, source: ffmpeg.source, ffprobeSource: ffprobe.source };
}

// "ffmpeg version 7.1.1 Copyright …" → '7.1.1'; null when it can't run
function version(bin) {
  if (versionCache[bin] === undefined) {
    versionCache[bin] = new Promise(function (resolve) {
      var out = '', child;
      try {
        child = spawn(bin, ['-version']);
      } catch (e) {
        return resolve(null);
      }
      child.stdout.on('data', function (d) { out += d; });
      child.on('error', function () { resolve(null); });
      child.on('close', function (code) {
        var m = /version (\S+)/.exec(out);
        resolve(code === 0 && m ? m[1] : null);
      });
    });
    versionCache[bin].then(function (v) {
      if (v === null) {
        delete versionCache[bin];   // installed later → found on the next check
      }
    });
  }
  return versionCache[bin];
}

// For the dashboard and GET /api/v1/server: { available, ffmpeg, ffprobe, source, version }
function info() {
  var p = paths();
  return Promise.all([version(p.ffmpeg), version(p.ffprobe)]).then(function (v) {
    return {
      available: !!(v[0] && v[1]),
      ffmpeg: p.ffmpeg,
      ffprobe: p.ffprobe,
      source: p.source,
      version: v[0]
    };
  });
}

module.exports = {
  paths: paths,
  info: info,
  setBundledDir: setBundledDir
};
