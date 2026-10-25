'use strict';

// Direct downloads (docs/search-plan.md decision C): files fetched over HTTP,
// a second kind of download beside torrents. What is downloaded is always a
// media ref the server made (from Search, a pasted link, Play): an `r_` (a
// file) or an `h_` (an HLS stream). The row keeps its URL, its headers and
// whose it is (`by`: `links` for a link the admin gave, else the plugin), so
// it survives a restart; the bytes are fetched as that principal through
// lib/plugins/http.js (its hosts, the address rules on every hop).
//
//   file: HTTP with ranges into <download dir>/<name>.part, resumed where it
//         stopped (after a pause, an error, a restart), renamed when complete
//   hls:  ffmpeg reads the server's own h_ playlist on loopback (its segments
//         fetched as the principal by lib/media/hls.js) and copies the streams
//         into a Matroska file; a pause starts it again from the beginning
//
// Two run at a time (MAX_RUNNING), the rest wait in the order they were added.
// Events (the admin's): direct.updated (a DirectDownload; ≤ 1 per second while
// it runs, at once on a state change), direct.removed { id }. The library scans the
// download folder after one completes (lib/library#onEvent).
//
//   start() / stop() from index.js · list() · add({ ref, name?, paused? }) ·
//   startOne(id) · pause(id) · remove(id, { files })

var fs = require('fs'),
  path = require('path'),
  childProcess = require('child_process'),
  refs = require('../media/refs'),
  settings = require('../settings'),
  paths = require('../paths'),
  events = require('../events'),
  log = require('../logger').child('downloads');

var MAX_RUNNING = 2,
  SAVE_MS = 10000,
  EVENT_MS = 1000,
  SPEED_WINDOW_MS = 5000;

var running = new Map(),     // id → { abort(), received, samples: [[time, bytes]], lastEvent, lastSave }
  rows = new Map(),          // id → the row, kept current in memory
  started = false;

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function services() {
  return require('../userData').services();
}

function downloadDir() {
  return settings.get('storage.downloadDir') || paths.downloads;
}

// ── what clients see ────────────────────────────────────────────────────────

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

function speedOf(run) {
  if (!run || run.samples.length < 2) {
    return 0;
  }
  var first = run.samples[0], last = run.samples[run.samples.length - 1],
    seconds = (last[0] - first[0]) / 1000;
  return seconds > 0 ? Math.max(0, Math.round((last[1] - first[1]) / seconds)) : 0;
}

function view(row) {
  var run = running.get(row.id),
    done = row.state === 'completed';
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    state: row.state,
    size: row.sizeBytes,
    received: run ? run.received : row.doneBytes,
    speed: run ? speedOf(run) : 0,
    path: done ? path.join(row.saveDir, row.name) : null,
    ref: done ? row.ref || null : null,
    error: row.error,
    addedAt: new Date(row.addedAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    source: { by: row.by, host: hostOf(row.url) }
  };
}

function publish(row) {
  // the admin's downloads: their events too
  events.publish('direct.updated', view(row), { admin: true });
}

// A completed file as a library file's ref (f_…), once the library scanned it
function libraryRef(row) {
  var full = path.join(row.saveDir, row.name);
  return services().then(function (s) {
    return s.library.folders().then(function (folders) {
      var folder = folders.filter(function (f) { return full.indexOf(f.path + path.sep) === 0; })[0];
      if (!folder) {
        return null;
      }
      var rel = full.slice(folder.path.length + 1).split(path.sep).join('/');
      return s.library.queryFiles({ folderId: folder.id, q: rel, limit: 20 }).then(function (found) {
        var file = (found.files || found).filter(function (f) { return f.relPath === rel; })[0];
        return file ? refs.file(file.id) : null;
      });
    });
  }).catch(function () { return null; });
}

// ── the rows ────────────────────────────────────────────────────────────────

function save(row, patch) {
  Object.assign(row, patch);
  return services().then(function (s) {
    var fields = Object.assign({}, patch);
    delete fields.ref;
    return s.directDownloads.update(row.id, fields);
  }).catch(function (err) {
    log.warn('direct download ' + row.id + ' not saved: ' + err.message);
  });
}

function setState(row, state, extra) {
  var patch = Object.assign({ state: state }, extra || {});
  return save(row, patch).then(function () {
    publish(row);
  });
}

/** A free name in the folder: "Film.mp4", else "Film (2).mp4" */
function freeName(dir, wanted) {
  var ext = path.extname(wanted), stem = wanted.slice(0, wanted.length - ext.length),
    taken = function (name) {
      return fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, name + '.part')) ||
        Array.from(rows.values()).some(function (r) { return r.saveDir === dir && r.name === name; });
    };
  for (var i = 1, name = wanted; i < 1000; name = stem + ' (' + (++i) + ')' + ext) {
    if (!taken(name)) {
      return name;
    }
  }
  throw failure('CONFLICT', 'No free name for ' + wanted);
}

function cleanName(text, fallback) {
  var name = String(text || '').replace(/[\\/\0\r\n\t:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 200);
  return name || fallback;
}

// ── the work ────────────────────────────────────────────────────────────────

/** The principal a row's bytes are fetched as, or null (its plugin is gone or off) */
function principalOf(row) {
  if (row.by === 'links') {
    return require('../links/inspect').LINKS;
  }
  var plugin = require('../plugins').get(row.by);
  return plugin && plugin.state === 'enabled' ? plugin : null;
}

function progress(row, run, bytes) {
  run.received = bytes;
  var now = Date.now();
  run.samples.push([now, bytes]);
  while (run.samples.length > 2 && now - run.samples[0][0] > SPEED_WINDOW_MS) {
    run.samples.shift();
  }
  if (now - run.lastEvent >= EVENT_MS) {
    run.lastEvent = now;
    row.doneBytes = bytes;
    publish(row);
  }
  if (now - run.lastSave >= SAVE_MS) {
    run.lastSave = now;
    save(row, { doneBytes: bytes });
  }
}

function runFile(row, run, principal) {
  var http = require('../plugins/http'),
    part = path.join(row.saveDir, row.name + '.part'),
    offset = 0;
  try {
    offset = fs.statSync(part).size;
  } catch (e) {
    offset = 0;
  }
  return http.stream(principal, { url: row.url, headers: row.headers || {}, range: offset > 0 ? { start: offset } : null }).then(function (r) {
    if (run.stopped) {
      r.abort();
      return null;
    }
    run.abort = r.abort;
    if (r.status === 416 && offset > 0) {
      // nothing after what we have: it was complete
      r.abort();
      return { offset: offset, size: offset };
    }
    if (r.status !== 200 && r.status !== 206) {
      r.abort();
      throw new Error('HTTP ' + r.status);
    }
    var resumed = r.status === 206 && offset > 0,
      total = /\/(\d+)\s*$/.exec(String(r.headers['content-range'] || '')),
      length = parseInt(r.headers['content-length'], 10),
      size = total ? parseInt(total[1], 10) : length > 0 ? (resumed ? offset + length : length) : null;
    if (!resumed) {
      offset = 0;   // a server without ranges: from the start
    }
    if (size && size !== row.sizeBytes) {
      save(row, { sizeBytes: size });
    }
    return new Promise(function (resolve, reject) {
      var out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
        bytes = offset;
      r.body.on('data', function (chunk) {
        bytes += chunk.length;
        progress(row, run, bytes);
      });
      r.body.on('error', function (err) { out.destroy(err); });
      out.on('error', reject);
      out.on('finish', function () { resolve({ offset: bytes, size: size }); });
      r.body.pipe(out);
    });
  }).then(function (done) {
    if (!done || run.stopped) {
      return null;
    }
    if (done.size && done.offset < done.size) {
      throw new Error('the source stopped at ' + done.offset + ' of ' + done.size + ' bytes');
    }
    return fs.promises.rename(part, path.join(row.saveDir, row.name)).then(function () {
      return done.offset;
    });
  });
}

function runHls(row, run, principal) {
  var hls = require('../media/hls'),
    auth = require('../auth'),
    protocol = require('@playpex/protocol'),
    info = require('../../index').info(),
    ffmpeg = require('../ffmpeg').paths().ffmpeg,
    part = path.join(row.saveDir, row.name + '.part');
  if (!info) {
    return Promise.reject(new Error('the server isn\'t listening'));
  }
  if (!ffmpeg) {
    return Promise.reject(new Error('ffmpeg isn\'t installed: streams are saved with it'));
  }
  // made again here: refs live in memory (a restart forgets them)
  var entry = hls.register(principal, { kind: 'hls', url: row.url, headers: row.headers || undefined, label: row.name }),
    input = 'http://127.0.0.1:' + info.port + protocol.API_PREFIX + '/media/' + entry.ref + '/index.m3u8?' +
      protocol.DEVICE_PARAM + '=direct-' + row.id + '&internal=' + auth.internalUrlToken();
  return new Promise(function (resolve, reject) {
    var child = childProcess.spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
      '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-f', 'matroska', part], { stdio: ['ignore', 'ignore', 'pipe'] });
    var errors = '';
    child.stderr.on('data', function (d) { errors = (errors + d).slice(-2000); });
    run.abort = function () { child.kill('SIGKILL'); };
    var timer = setInterval(function () {
      fs.stat(part, function (err, st) {
        if (!err) {
          progress(row, run, st.size);
        }
      });
    }, EVENT_MS);
    child.on('error', function (err) {
      clearInterval(timer);
      reject(err);
    });
    child.on('close', function (code) {
      clearInterval(timer);
      if (run.stopped) {
        return resolve(null);
      }
      if (code !== 0) {
        return reject(new Error('ffmpeg: ' + (errors.split('\n').filter(Boolean).pop() || 'exit ' + code).replace(/internal=[^&\s]+/g, 'internal=…')));
      }
      var size = fs.statSync(part).size;
      fs.promises.rename(part, path.join(row.saveDir, row.name)).then(function () { resolve(size); }, reject);
    });
  });
}

function begin(row) {
  var principal = principalOf(row);
  if (!principal) {
    return setState(row, 'error', { error: 'The plugin ' + row.by + ' is off or gone: its downloads can\'t run' });
  }
  var run = { abort: function () {}, received: row.doneBytes || 0, samples: [], lastEvent: 0, lastSave: Date.now(), stopped: false };
  running.set(row.id, run);
  setState(row, 'downloading', { error: null });
  fs.promises.mkdir(row.saveDir, { recursive: true }).then(function () {
    return row.kind === 'hls' ? runHls(row, run, principal) : runFile(row, run, principal);
  }).then(function (size) {
    running.delete(row.id);
    if (size === null || run.stopped) {
      return null;
    }
    log.info('direct download done: ' + row.name, { id: row.id });
    return setState(row, 'completed', { doneBytes: size, sizeBytes: size, completedAt: new Date(), error: null });
  }, function (err) {
    running.delete(row.id);
    if (run.stopped) {
      return null;
    }
    log.warn('direct download ' + row.name + ' failed: ' + err.message, { id: row.id, code: err.code });
    return setState(row, 'error', { error: err.message, doneBytes: run.received });
  }).then(pump, pump);
}

/** Starts what waits, oldest first, while slots are free */
function pump() {
  if (!started) {
    return;
  }
  var waiting = Array.from(rows.values()).filter(function (r) { return r.state === 'queued' && !running.has(r.id); })
    .sort(function (a, b) { return new Date(a.addedAt) - new Date(b.addedAt); });
  while (running.size < MAX_RUNNING && waiting.length) {
    begin(waiting.shift());
  }
}

function halt(id) {
  var run = running.get(id);
  if (run) {
    run.stopped = true;
    run.abort();
    running.delete(id);
  }
  return run;
}

// ── the API ─────────────────────────────────────────────────────────────────

function start() {
  return services().then(function (s) {
    return s.directDownloads.list();
  }).then(function (list) {
    rows.clear();
    started = true;
    list.forEach(function (row) {
      rows.set(row.id, row);
      // running when the server stopped: in the queue again
      if (row.state === 'downloading') {
        row.state = 'queued';
        save(row, { state: 'queued' });
      }
    });
    pump();
  }).catch(function (err) {
    log.warn('direct downloads not loaded: ' + err.message);
  });
}

function stop() {
  started = false;
  running.forEach(function (run, id) {
    halt(id);
    var row = rows.get(id);
    if (row) {
      save(row, { doneBytes: run.received });
    }
  });
  return Promise.resolve();
}

function list() {
  var all = Array.from(rows.values()).sort(function (a, b) { return new Date(b.addedAt) - new Date(a.addedAt); });
  return Promise.all(all.map(function (row) {
    if (row.state !== 'completed' || row.ref) {
      return view(row);
    }
    return libraryRef(row).then(function (ref) {
      row.ref = ref;
      return view(row);
    });
  }));
}

function find(id) {
  var row = rows.get(id);
  if (!row) {
    throw failure('NOT_FOUND', 'No such direct download');
  }
  return row;
}

/** A media ref's source (r_ or h_) as a new download */
function add(options) {
  return Promise.resolve().then(function () {
    var parsed = refs.parse(options.ref),
      entry = parsed && parsed.kind === 'remote' ? require('../plugins/remote').source(options.ref) :
        parsed && parsed.kind === 'hls' ? require('../media/hls').source(options.ref) : null;
    if (!parsed || (parsed.kind !== 'remote' && parsed.kind !== 'hls')) {
      throw failure('INVALID', 'ref: a file (r_…) or a stream (h_…) the server proxies; torrents are POST /downloads');
    }
    if (!entry) {
      throw failure('NOT_FOUND', 'That media is gone (refs live an hour): search or read the link again');
    }
    if (parsed.kind === 'hls' && entry.live) {
      throw failure('INVALID', 'A live stream has no end: it can\'t be downloaded');
    }
    var kind = parsed.kind === 'hls' ? 'hls' : 'file',
      base = cleanName(options.name || entry.name || entry.label, kind === 'hls' ? 'stream' : 'download');
    if (kind === 'hls') {
      base = base.replace(/\.(m3u8|ts|mp4|mkv)$/i, '') + '.mkv';
    }
    var dir = downloadDir(),
      name = freeName(dir, base);
    return services().then(function (s) {
      return s.directDownloads.create({
        name: name, kind: kind, url: entry.url, headers: entry.headers && Object.keys(entry.headers).length ? entry.headers : null,
        by: entry.by, saveDir: dir, sizeBytes: entry.size || null, state: options.paused ? 'paused' : 'queued'
      });
    }).then(function (row) {
      rows.set(row.id, row);
      log.info('direct download added: ' + row.name + ' (' + hostOf(row.url) + ', ' + row.by + ')', { id: row.id });
      publish(row);
      pump();
      return view(row);
    });
  });
}

function startOne(id) {
  return Promise.resolve().then(function () {
    var row = find(id);
    if (row.state === 'paused' || row.state === 'error') {
      return setState(row, 'queued', { error: null }).then(function () {
        pump();
        return view(row);
      });
    }
    return view(row);
  });
}

function pause(id) {
  return Promise.resolve().then(function () {
    var row = find(id);
    if (row.state !== 'queued' && row.state !== 'downloading') {
      return view(row);
    }
    var run = halt(id);
    if (run && row.kind === 'hls') {
      // a stream starts again from the beginning: its partial file is useless
      fs.rm(path.join(row.saveDir, row.name + '.part'), { force: true }, function () {});
    }
    return setState(row, 'paused', { doneBytes: run && row.kind === 'file' ? run.received : row.kind === 'hls' ? 0 : row.doneBytes })
      .then(function () {
        pump();
        return view(row);
      });
  });
}

function remove(id, options) {
  return Promise.resolve().then(function () {
    var row = find(id);
    halt(id);
    rows.delete(id);
    var gone = [path.join(row.saveDir, row.name + '.part')];
    if (options && options.files) {
      gone.push(path.join(row.saveDir, row.name));
    }
    return Promise.all(gone.map(function (f) { return fs.promises.rm(f, { force: true }); })).then(function () {
      return services();
    }).then(function (s) {
      return s.directDownloads.remove(id);
    }).then(function () {
      events.publish('direct.removed', { id: id }, { admin: true });
      pump();
    });
  });
}

module.exports = {
  start: start,
  stop: stop,
  list: list,
  add: add,
  startOne: startOne,
  pause: pause,
  remove: remove
};
