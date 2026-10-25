'use strict';

// Fake engine, for the tests (test/engines.test.js, test/downloads.test.js):
// the engine port (../port.js) emulated in-process, no network. A torrent
// added with its .torrent and its complete data in the save path "seeds" (to
// every fake engine of the process); others "download" by copying its bytes,
// RATE bytes per tick, the file being streamed first. While seeding, a fake
// peer takes UPLOAD bytes per tick (so seeding ratios move).
//
//   create({ capabilities: { pause: false, … }, rate, upload })   for tests of the client's fallbacks

var fs = require('fs'),
  path = require('path'),
  events = require('events'),
  stream = require('stream'),
  parseTorrent = require('parse-torrent'),
  bncode = require('bncode'),
  files = require('../files'),
  errors = require('../errors');

var EngineError = errors.EngineError,
  TICK_MS = 20,
  RATE = 256 * 1024,
  UPLOAD = 64 * 1024;

var seeders = {};   // hash → [{ meta, savePath }]: complete copies, of every fake engine in this process

function seed(hash, meta, savePath) {
  unseed(hash, savePath);
  (seeders[hash] = seeders[hash] || []).push({ meta: meta, savePath: savePath });
}

function unseed(hash, savePath) {
  seeders[hash] = (seeders[hash] || []).filter(function (s) { return s.savePath !== savePath; });
}

// a complete copy other than the one in savePath
function sourceFor(hash, savePath) {
  return (seeders[hash] || []).filter(function (s) { return s.savePath !== savePath; })[0] || null;
}

function parse(buffer) {
  var t = parseTorrent(buffer);
  return {
    name: t.name,
    length: t.length,
    pieceLength: t.pieceLength,
    pieceCount: t.pieces.length,
    files: t.files.map(function (f) { return { path: f.path, size: f.length, offset: f.offset }; }),
    torrentFile: bncode.encode({ info: bncode.decode(t.infoBuffer), 'announce-list': [] })
  };
}

function create(opts) {
  opts = opts || {};
  var emitter = new events.EventEmitter(),
    torrents = {},
    timer = null,
    limits = { uploadSlots: 4 },
    rate = opts.rate || RATE,
    upload = opts.upload !== undefined ? opts.upload : UPLOAD,
    log = null;

  function get(hash) {
    var t = torrents[hash];
    if (!t) {
      throw EngineError('NOT_FOUND', 'The engine has no torrent ' + hash);
    }
    return t;
  }

  function selected(t) {
    return t.meta.files.filter(function (f) { return !t.files || t.files.indexOf(f.path) !== -1; });
  }

  function isDone(t) {
    return !!t.meta && selected(t).every(function (f) { return t.done[f.path] >= f.size; });
  }

  // what is on disk already (size of each file: the copy is sequential)
  function scan(t) {
    t.done = {};
    t.meta.files.forEach(function (f) {
      var full = files.location(t.savePath, f.path), size = 0;
      try {
        size = Math.min(fs.statSync(full).size, f.size);
      } catch (e) {
        // not there yet
      }
      t.done[f.path] = size;
    });
    if (t.meta.files.every(function (f) { return t.done[f.path] >= f.size; })) {
      seed(t.hash, t.meta, t.savePath);
    }
  }

  function gotMetadata(t, meta) {
    t.meta = meta;
    if (!t.files && t.onlyLargest) {
      t.files = [meta.files.reduce(function (a, b) { return a.size >= b.size ? a : b; }).path];
    }
    scan(t);
    emitter.emit('metadata', t.hash);
    t.wasDone = isDone(t);
    if (t.running && t.wasDone) {
      emitter.emit('done', t.hash);
    }
  }

  function copy(t, f, max) {
    var source = sourceFor(t.hash, t.savePath), from = files.location(source.savePath, f.path), to = files.location(t.savePath, f.path),
      start = t.done[f.path], length = Math.min(max, f.size - start);
    if (length <= 0) {
      return 0;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    var buffer = Buffer.alloc(length), fdIn = fs.openSync(from, 'r'), fdOut = fs.openSync(to, start ? 'r+' : 'w');
    try {
      fs.readSync(fdIn, buffer, 0, length, start);
      fs.writeSync(fdOut, buffer, 0, length, start);
    } finally {
      fs.closeSync(fdIn);
      fs.closeSync(fdOut);
    }
    t.done[f.path] += length;
    return length;
  }

  function tick() {
    Object.keys(torrents).forEach(function (hash) {
      var t = torrents[hash], source = sourceFor(hash, t.savePath);
      t.down = 0;
      t.up = 0;
      if (!t.running) {
        return;
      }
      if (!t.meta) {
        if (source) {
          gotMetadata(t, source.meta);
        }
        return;
      }
      // the selected files, and the ones being streamed
      var wanted = !source ? [] : t.meta.files.filter(function (f) {
        return (t.priority[f.path] || selected(t).indexOf(f) !== -1) && t.done[f.path] < f.size;
      });
      if (wanted.length) {
        var budget = rate;
        wanted.sort(function (a, b) { return (t.priority[b.path] || 0) - (t.priority[a.path] || 0); });
        wanted.forEach(function (f) {
          budget -= copy(t, f, budget);
        });
        t.down = rate - budget;
        t.downloaded += t.down;
      } else if (isDone(t) && limits.uploadSlots > 0) {
        t.up = upload;
        t.uploaded += upload;
      }
      var done = isDone(t);
      if (done && !t.wasDone) {
        if (t.meta.files.every(function (f) { return t.done[f.path] >= f.size; })) {
          seed(hash, t.meta, t.savePath);
        }
        emitter.emit('done', hash);
      }
      t.wasDone = done;
      t.waiters = t.waiters.filter(function (w) { return !w(); });
    });
  }

  var engine = {
    id: 'fake',
    capabilities: Object.assign({
      fastResume: true,
      pause: true,
      rateLimits: false,
      fileSelection: true,
      streamPriority: true,
      persistentSession: false,
      peerList: true,
      trackerList: true,
      trackerEdit: true,
      recheck: true
    }, opts.capabilities),

    init: function (initOptions) {
      log = initOptions.log;
      if (initOptions.limits && initOptions.limits.uploadSlots !== undefined) {
        limits.uploadSlots = initOptions.limits.uploadSlots;
      }
      timer = setInterval(tick, TICK_MS);   // cleared by close()
      return Promise.resolve();
    },

    close: function () {
      clearInterval(timer);
      Object.keys(torrents).forEach(function (hash) {
        unseed(hash, torrents[hash].savePath);
        torrents[hash].running = false;
        torrents[hash].waiters.forEach(function (w) { w(true); });
      });
      torrents = {};
      return Promise.resolve();
    },

    health: function () {
      return Promise.resolve({ ok: !!timer, detail: null });
    },

    add: function (req) {
      return Promise.resolve().then(function () {
        var hash = req.infoHash;
        if (torrents[hash]) {
          return { infoHash: hash, name: torrents[hash].meta ? torrents[hash].meta.name : null };
        }
        var meta = null;
        if (req.torrentFile) {
          try {
            meta = parse(req.torrentFile);
          } catch (e) {
            throw EngineError('BAD_TORRENT', 'Cannot read this torrent: ' + e.message, e);
          }
          if (parseTorrent(req.torrentFile).infoHash !== hash) {
            throw EngineError('BAD_TORRENT', 'The metainfo is not the one of ' + hash);
          }
        } else if (req.magnet) {
          try {
            if (parseTorrent(req.magnet).infoHash !== hash) {
              throw new Error('another info hash');
            }
          } catch (e) {
            throw EngineError('BAD_TORRENT', 'Cannot read this magnet: ' + e.message, e);
          }
        }
        var t = torrents[hash] = {
          hash: hash, savePath: req.savePath, files: req.files || null, onlyLargest: !!req.onlyLargest, meta: null, done: {},
          running: !req.paused, priority: {}, waiters: [], down: 0, up: 0, downloaded: 0, uploaded: 0, wasDone: false,
          trackerList: (req.trackers || []).slice()
        };
        if (meta) {
          gotMetadata(t, meta);
        }
        return { infoHash: hash, name: meta ? meta.name : null };
      });
    },

    // the fake seeder as one peer while a copy is linked, a leecher while seeding
    peers: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash), linked = t.running && !!sourceFor(hash, t.savePath), list = [];
        if (linked || (t.running && t.up)) {
          list.push({
            address: '127.0.0.1:6881', client: null, peerId: Buffer.from('-qB4630-fakepeer0001').toString('hex'),
            flags: linked ? 'D' : 'U', progress: linked ? 1 : 0, downBps: t.down * 1000 / TICK_MS, upBps: t.up * 1000 / TICK_MS,
            downloaded: t.downloaded, uploaded: t.uploaded
          });
        }
        return { peers: list, availability: linked ? 1 : null };
      });
    },

    trackers: function (hash) {
      return Promise.resolve().then(function () {
        return get(hash).trackerList.map(function (url) { return { url: url, status: 'unknown' }; });
      });
    },

    addTrackers: function (hash, urls) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        urls.forEach(function (url) {
          if (t.trackerList.indexOf(url) === -1) {
            t.trackerList.push(url);
          }
        });
      });
    },

    // pieces verified again: what is on disk counts
    recheck: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (!t.running) {
          throw EngineError('UNSUPPORTED', 'The torrent ' + hash + ' is paused');
        }
        if (t.meta) {
          scan(t);
        }
      });
    },

    metadata: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (!t.meta) {
          throw EngineError('NO_METADATA_YET', 'No metadata yet for ' + hash);
        }
        return {
          name: t.meta.name, length: t.meta.length, pieceLength: t.meta.pieceLength,
          files: t.meta.files.map(function (f) { return Object.assign({}, f); }), torrentFile: t.meta.torrentFile
        };
      });
    },

    start: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (!t.running) {
          t.running = true;
          if (t.meta) {
            scan(t);
            t.wasDone = isDone(t);
            if (t.wasDone) {
              emitter.emit('done', hash);
            }
          }
        }
      });
    },

    pause: function (hash) {
      return Promise.resolve().then(function () {
        if (!engine.capabilities.pause) {
          throw EngineError('UNSUPPORTED', 'This engine cannot pause');
        }
        var t = get(hash);
        t.running = false;
        t.waiters.forEach(function (w) { w(true); });
        t.waiters = [];
      });
    },

    stop: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        t.running = false;
        t.waiters.forEach(function (w) { w(true); });
        delete torrents[hash];
      });
    },

    remove: function (hash, removeOptions) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        return engine.stop(hash).then(function () {
          unseed(hash, t.savePath);
          if (removeOptions && removeOptions.deleteData && t.meta) {
            return files.deleteData(t.savePath, t.meta.files);
          }
        });
      });
    },

    select: function (hash, paths) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        t.files = paths ? paths.slice() : null;
        t.wasDone = t.meta ? isDone(t) : false;
      });
    },

    stats: function () {
      var all = new Map();
      Object.keys(torrents).forEach(function (hash) {
        var t = torrents[hash], meta = t.meta, sel = meta ? selected(t) : [], pieces = null;
        if (meta) {
          pieces = new Uint8Array(meta.pieceCount);
          for (var i = 0; i < meta.pieceCount; i++) {
            var from = i * meta.pieceLength, to = Math.min(from + meta.pieceLength, meta.length);
            pieces[i] = meta.files.every(function (f) {
              var a = Math.max(from, f.offset), b = Math.min(to, f.offset + f.size);
              return a >= b || t.done[f.path] >= b - f.offset;
            }) ? 1 : 0;
          }
        }
        var linked = t.running && !!sourceFor(hash, t.savePath);
        all.set(hash, {
          state: !t.running ? 'paused' : meta && isDone(t) ? 'seeding' : 'downloading',
          metadata: !!meta,
          doneBytes: sel.reduce(function (sum, f) { return sum + Math.min(t.done[f.path] || 0, f.size); }, 0),
          sizeBytes: meta ? sel.reduce(function (sum, f) { return sum + f.size; }, 0) : null,
          downBps: t.down * 1000 / TICK_MS,
          upBps: t.up * 1000 / TICK_MS,
          peers: linked || t.up ? 1 : 0,
          peersUnchoked: linked ? 1 : 0,
          seeds: linked ? 1 : 0,
          downloadedBytes: t.downloaded,
          uploadedBytes: t.uploaded,
          checking: null,
          pieces: pieces
        });
      });
      return Promise.resolve(all);
    },

    stream: function (hash, filePath, range) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (!t.running) {
          throw EngineError('NOT_FOUND', 'The torrent ' + hash + ' is paused');
        }
        var file = t.meta && t.meta.files.filter(function (f) { return f.path === filePath; })[0];
        if (!file) {
          throw EngineError(t.meta ? 'NOT_FOUND' : 'NO_METADATA_YET', 'No file ' + filePath + ' in ' + hash);
        }
        range = range || {};
        var start = range.start || 0,
          end = range.end !== undefined ? Math.min(range.end, file.size - 1) : file.size - 1;
        if (start > end) {
          var empty = new stream.Readable({ read: function () {} });
          empty.push(null);
          return empty;
        }
        t.priority[filePath] = Date.now();
        // like a real engine: the bytes as they arrive (the file is copied from its start)
        var position = start, reading = false, location = files.location(t.savePath, filePath);
        var out = new stream.Readable({
          read: function () {
            if (reading) {
              return;
            }
            reading = true;
            function pull(gone) {
              if (out.destroyed) {
                return true;
              }
              if (gone) {
                reading = false;
                out.destroy(EngineError('UNAVAILABLE', 'The torrent ' + hash + ' stopped'));
                return true;
              }
              var have = Math.min((t.done[filePath] || 0) - 1, end);
              if (have < position) {
                return false;
              }
              var length = Math.min(have - position + 1, 256 * 1024), buffer = Buffer.alloc(length);
              fs.open(location, 'r', function (err, fd) {
                if (err) {
                  return out.destroy(err);
                }
                fs.read(fd, buffer, 0, length, position, function (readErr, n) {
                  fs.close(fd, function () {});
                  reading = false;
                  if (readErr) {
                    return out.destroy(readErr);
                  }
                  position += n;
                  var more = out.push(buffer.slice(0, n));
                  if (position > end) {
                    out.push(null);
                  } else if (more) {
                    out._read();
                  }
                });
              });
              return true;
            }
            if (!pull()) {
              t.waiters.push(pull);
            }
          }
        });
        return out;
      });
    },

    setLimits: function (next) {
      return Promise.resolve().then(function () {
        if (next.downBps || next.upBps) {
          throw EngineError('UNSUPPORTED', 'The fake engine has no speed limits');
        }
        if (next.uploadSlots !== undefined) {
          limits.uploadSlots = next.uploadSlots;
        }
      });
    },

    list: function () {
      return Promise.resolve(Object.keys(torrents));
    },

    on: function (event, fn) {
      emitter.on(event, fn);
    }
  };

  return engine;
}

module.exports = { create: create };
