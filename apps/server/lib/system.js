'use strict';

// What the dashboard's Overview shows (docs/server-separation-plan.md §7):
// the running server, its process (CPU, memory), the machine, BitTorrent
// traffic, the torrent engine and downloads, free disk space and ffmpeg /
// provider health.
//
//   system.start(info) / system.stop()   from index.js (info = start()'s answer)
//   system.overview() → Promise<Overview> (GET /admin/overview)
//   system.disk(dir)  → Promise<{ path, free, total } | null>
//
// A sampler runs every SAMPLE_MS while the server runs: process CPU % since
// the last sample, and the traffic totals (sum of every torrent's
// downloaded / uploaded bytes; a torrent that stopped keeps what it added).

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  settings = require('./settings'),
  paths = require('./paths'),
  torrents = require('./torrents/client'),
  sessions = require('./sessions'),
  events = require('./events'),
  ffmpeg = require('./ffmpeg'),
  discovery = require('./discovery'),
  health = require('./health');

var SAMPLE_MS = 5000;

var info = null,
  timer = null,
  cpu = { last: null, at: 0, percent: 0 },
  traffic = { downloaded: 0, uploaded: 0, seen: {} };   // seen: infoHash → { down, up }

function sample() {
  var now = Date.now(), usage = process.cpuUsage();
  if (cpu.last) {
    var used = (usage.user - cpu.last.user) + (usage.system - cpu.last.system);   // µs
    cpu.percent = Math.round(used / ((now - cpu.at) * 1000) * 1000) / 10;      // of one core
  }
  cpu.last = usage;
  cpu.at = now;

  // the engine's counters per torrent restart at 0 when a torrent starts again
  var counters = torrents.totals().counters;
  Object.keys(counters).forEach(function (hash) {
    var now = counters[hash], before = traffic.seen[hash] || { down: 0, up: 0 };
    traffic.downloaded += now.down >= before.down ? now.down - before.down : now.down;
    traffic.uploaded += now.up >= before.up ? now.up - before.up : now.up;
  });
  traffic.seen = counters;
}

function start(runningInfo) {
  info = runningInfo;
  cpu = { last: null, at: 0, percent: 0 };
  traffic = { downloaded: 0, uploaded: 0, seen: {} };
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
  info = null;
}

// Free / total bytes of the file system holding `dir` (the closest existing
// parent when it doesn't exist yet)
function disk(dir) {
  var target = path.resolve(dir);
  while (!fs.existsSync(target) && path.dirname(target) !== target) {
    target = path.dirname(target);
  }
  return fs.promises.statfs(target).then(function (s) {
    return { path: path.resolve(dir), free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }, function () {
    return null;
  });
}

function downloadDir() {
  return settings.get('storage.downloadDir') || paths.downloads;
}

function overview() {
  var mem = process.memoryUsage(),
    net = torrents.totals(),
    downloads = torrents.info(),
    dirs = [
      { id: 'downloads', path: downloadDir() },
      { id: 'config', path: paths.config },
      { id: 'logs', path: paths.logs }
    ];
  return Promise.all([
    ffmpeg.info(),
    Promise.all(dirs.map(function (d) {
      return disk(d.path).then(function (s) {
        return { id: d.id, path: path.resolve(d.path), free: s ? s.free : null, total: s ? s.total : null };
      });
    }))
  ]).then(function (results) {
    var ff = results[0];
    return {
      server: {
        id: info ? info.id : null,
        name: settings.get('general.serverName'),
        version: require('../package.json').version,
        startedAt: info ? new Date(info.startedAt).toISOString() : null,
        uptimeS: info ? Math.round((Date.now() - info.startedAt) / 1000) : 0,
        port: info ? info.port : null,
        host: info ? info.host : null,
        urls: info ? info.urls : [],
        lanSharing: settings.get('network.lanSharing'),
        recovery: info && info.recovery ? info.recovery : null,
        discovery: discovery.status()
      },
      process: {
        pid: process.pid,
        node: process.versions.node,
        electron: process.versions.electron || null,
        cpuPercent: cpu.percent,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed
      },
      system: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem()
      },
      network: {
        downloadSpeed: net.downloadSpeed,
        uploadSpeed: net.uploadSpeed,
        peers: net.peers,
        downloaded: traffic.downloaded,
        uploaded: traffic.uploaded
      },
      activity: {
        torrents: downloads.active,
        sessions: sessions.count(),
        eventClients: events.clientCount()
      },
      downloads: {
        engine: downloads.engine,
        requestedEngine: downloads.requestedEngine,
        engineError: downloads.engineError,
        total: downloads.total,
        active: downloads.active,
        queued: downloads.queued,
        paused: downloads.paused
      },
      disks: results[1],
      ffmpeg: {
        available: ff.available,
        version: ff.version || null,
        source: ff.source || null,
        path: ff.ffmpeg || null
      },
      providers: health.list(),
      // where torrents and streams come from: plugins only (docs/providers-plan.md §4.4)
      sources: sourcesView()
    };
  });
}

// The enabled plugins answering Play or Find releases, and whether the
// Overview shows its "add a source" notice (none, not dismissed)
function sourcesView() {
  var plugins = require('./plugins'),
    seen = {};
  plugins.withHook('play.collect', null).concat(plugins.withHook('releases.providers', null)).forEach(function (p) {
    seen[p.id] = p;
  });
  var list = Object.keys(seen).sort().map(function (id) { return seen[id]; });
  return { plugins: list, notice: !list.length && settings.get('plugins.sourcesNotice') !== false };
}

module.exports = {
  start: start,
  stop: stop,
  overview: overview,
  disk: disk,
  downloadDir: downloadDir
};
