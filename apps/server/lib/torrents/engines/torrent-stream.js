'use strict';

// torrent-stream adapter (docs/media-server-plan.md §4.3): the engine port
// (../port.js) over torrent-stream 1.2, one torrent-stream "engine" per
// torrent. torrent-stream keeps nothing between runs and re-checks a
// torrent's data every time it starts (state `checking`); pausing destroys
// the torrent's engine (no peers, no traffic, nothing in memory, data kept)
// and starting creates it again.
//
// Data: <savePath>/<path inside the torrent> (fs-chunk-store). Its own
// metadata cache: <stateDir>/torrent-stream/<hash>.torrent. Optional engine
// options (e.g. `connections`) from <config>/config.json, read at init.

var fs = require('fs'),
  path = require('path'),
  net = require('net'),
  events = require('events'),
  stream = require('stream'),
  torrentStream = require('torrent-stream'),
  parseTorrent = require('parse-torrent'),
  bncode = require('bncode'),
  paths = require('../../paths'),
  files = require('../files'),
  errors = require('../errors');

var EngineError = errors.EngineError,
  DEFAULT_PEER_PORT = 6881,
  DEFAULT_UPLOAD_SLOTS = 10;

function freePort(port) {
  return new Promise(function (resolve) {
    function tryPort(p) {
      var s = net.createServer();
      s.on('error', function () { tryPort(0); });
      s.listen(p, function () {
        var found = s.address().port;
        s.close(function () { resolve(found); });
      });
    }
    tryPort(port);
  });
}

// A .torrent from an info dictionary (what torrent-stream itself caches)
function torrentFileOf(infoBuffer) {
  return bncode.encode({ info: bncode.decode(infoBuffer), 'announce-list': [] });
}

function create() {
  var emitter = new events.EventEmitter(),
    torrents = {},       // hash → entry (below)
    options = null,      // init()'s, + config.json
    peerPort = null,
    limits = { uploadSlots: DEFAULT_UPLOAD_SLOTS },
    log = null;

  // entry: { hash, source (parsed magnet / torrent), savePath, files (paths | null),
  //   trackers, peers, engine (null while paused), ready, checking, missing, done }

  function get(hash) {
    var t = torrents[hash];
    if (!t) {
      throw EngineError('NOT_FOUND', 'The engine has no torrent ' + hash);
    }
    return t;
  }

  // Pieces of the selected files: [{ from, to }] (inclusive)
  function ranges(t) {
    var e = t.engine, torrent = e && e.torrent;
    if (!torrent) {
      return [];
    }
    return e.files.filter(function (f) {
      return !t.files || t.files.indexOf(f.path) !== -1;
    }).map(function (f) {
      return {
        from: (f.offset / torrent.pieceLength) | 0,
        to: ((f.offset + Math.max(f.length, 1) - 1) / torrent.pieceLength) | 0
      };
    });
  }

  function countMissing(t) {
    var e = t.engine, missing = 0, seen = {};
    ranges(t).forEach(function (r) {
      for (var i = r.from; i <= r.to; i++) {
        if (!seen[i] && !e.bitfield.get(i)) {
          missing++;
        }
        seen[i] = true;
      }
    });
    return missing;
  }

  // Selects the chosen files (all when null) on a ready engine
  function applySelection(t) {
    var e = t.engine;
    if (!t.files && t.onlyLargest) {
      t.files = [e.files.reduce(function (a, b) { return a.length >= b.length ? a : b; }).path];
    }
    e.files.forEach(function (f) {
      f.deselect();
      if (!t.files || t.files.indexOf(f.path) !== -1) {
        f.select();
      }
    });
    t.missing = countMissing(t);
    checkDone(t);
  }

  function checkDone(t) {
    if (t.ready && !t.missing && !t.done) {
      t.done = true;
      emitter.emit('done', t.hash);
    } else if (t.missing) {
      t.done = false;
    }
  }

  function inRanges(t, index) {
    return ranges(t).some(function (r) { return index >= r.from && index <= r.to; });
  }

  function spawn(t) {
    var e = torrentStream(t.source, Object.assign({}, options.engineOptions, {
      path: t.savePath,
      tmp: options.stateDir,
      trackers: t.trackers,
      uploads: limits.uploadSlots,
      dht: options.discovery !== false,
      tracker: options.discovery !== false
    }));
    t.engine = e;
    t.ready = false;
    t.done = false;
    t.checking = null;
    t.missing = null;

    e.once('verifying', function () {
      t.meta = e.torrent;
      t.checking = { done: 0, total: e.torrent.pieces.length };
      emitter.emit('metadata', t.hash);
    });
    e.on('verify', function (index) {
      if (!t.ready) {
        if (t.checking) {
          t.checking.done = index + 1;
        }
        return;
      }
      if (t.missing && inRanges(t, index)) {
        t.missing--;
        checkDone(t);
      }
    });
    e.once('ready', function () {
      if (t.engine !== e) {
        return;
      }
      t.ready = true;
      t.checking = null;
      t.meta = e.torrent;
      log.info('ready ' + t.hash);
      applySelection(t);
      emitter.emit('metadata', t.hash);
    });
    e.on('error', function (err) {
      log.warn('error ' + t.hash + ': ' + err.message);
      emitter.emit('error', t.hash, EngineError('DISK', err.message, err));
    });
    e.listen(peerPort, function () {
      log.debug('listening ' + t.hash + ' on port ' + e.port);
    });
    (t.peers || []).forEach(function (addr) { e.connect(addr); });
    return e;
  }

  function destroy(t) {
    var e = t.engine;
    t.engine = null;
    t.ready = false;
    t.checking = null;
    if (!e) {
      return Promise.resolve();
    }
    e.emit('destroyed-by-adapter');   // streams waiting for it to be ready give up
    return new Promise(function (resolve) {
      e.destroy(function () {
        e.removeAllListeners();
        resolve();
      });
    });
  }

  function waitReady(t) {
    if (t.ready) {
      return Promise.resolve(t.engine);
    }
    if (!t.engine) {
      return Promise.reject(EngineError('NOT_FOUND', 'The torrent ' + t.hash + ' is paused'));
    }
    var e = t.engine;
    return new Promise(function (resolve, reject) {
      function onReady() {
        e.removeListener('destroyed-by-adapter', onGone);
        resolve(e);
      }
      function onGone() {
        e.removeListener('ready', onReady);
        reject(EngineError('UNAVAILABLE', 'The torrent ' + t.hash + ' stopped'));
      }
      e.once('ready', onReady);
      e.once('destroyed-by-adapter', onGone);
    });
  }

  var engine = {
    id: 'torrent-stream',
    capabilities: {
      fastResume: false,
      pause: true,             // destroys the torrent's engine; starting again re-checks the data
      rateLimits: false,
      fileSelection: true,
      streamPriority: true,
      persistentSession: false
    },

    init: function (opts) {
      options = Object.assign({}, opts, { engineOptions: {} });
      log = opts.log;
      if (opts.limits && opts.limits.uploadSlots !== undefined) {
        limits.uploadSlots = opts.limits.uploadSlots;
      }
      try {
        options.engineOptions = JSON.parse(fs.readFileSync(path.join(paths.config, 'config.json'), 'utf8'));
        log.info('torrent-stream options from config.json', { options: options.engineOptions });
      } catch (e) {
        if (e.code !== 'ENOENT') {
          log.warn('config.json ignored', { err: e });
        }
      }
      return freePort(opts.peerPort !== undefined ? opts.peerPort : DEFAULT_PEER_PORT).then(function (port) {
        peerPort = port;
        log.info('torrent-stream engine, peer port ' + port);
      });
    },

    close: function () {
      var all = Object.keys(torrents).map(function (hash) { return torrents[hash]; });
      torrents = {};
      return Promise.all(all.map(destroy)).then(function () {});
    },

    health: function () {
      return Promise.resolve({ ok: !!options, detail: options ? null : 'not initialised' });
    },

    add: function (req) {
      return Promise.resolve().then(function () {
        var hash = req.infoHash, existing = torrents[hash];
        if (existing) {
          return { infoHash: hash, name: existing.engine && existing.engine.torrent ? existing.engine.torrent.name : null };
        }
        var source;
        try {
          source = req.torrentFile ? parseTorrent(req.torrentFile) : parseTorrent(req.magnet || 'magnet:?xt=urn:btih:' + hash);
        } catch (e) {
          throw EngineError('BAD_TORRENT', 'Cannot read this torrent: ' + e.message, e);
        }
        if (source.infoHash !== hash) {
          throw EngineError('BAD_TORRENT', 'The metainfo is not the one of ' + hash);
        }
        var t = torrents[hash] = {
          hash: hash,
          source: source,
          savePath: req.savePath,
          files: req.files || null,
          onlyLargest: !!req.onlyLargest,
          trackers: (source.announce || []).concat(req.trackers || []).filter(function (url, i, all) {
            return all.indexOf(url) === i;
          }),
          peers: req.peers || [],
          meta: source.files ? source : null,   // parsed metainfo, once known
          engine: null
        };
        log.info('adding ' + hash + (req.paused ? ' (paused)' : ''));
        if (!req.paused) {
          spawn(t);
        }
        return { infoHash: hash, name: source.name || null };
      });
    },

    metadata: function (hash) {
      return Promise.resolve().then(function () {
        var torrent = get(hash).meta;
        if (!torrent) {
          throw EngineError('NO_METADATA_YET', 'No metadata yet for ' + hash);
        }
        return {
          name: torrent.name,
          length: torrent.length,
          pieceLength: torrent.pieceLength,
          files: torrent.files.map(function (f) { return { path: f.path, size: f.length, offset: f.offset }; }),
          torrentFile: torrentFileOf(torrent.infoBuffer)
        };
      });
    },

    start: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (!t.engine) {
          // what the last run learnt: the metadata, so no exchange is needed
          if (!t.source.files && t.meta) {
            t.source = parseTorrent(torrentFileOf(t.meta.infoBuffer));
          }
          spawn(t);
        }
      });
    },

    pause: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        if (t.engine) {
          log.info('paused ' + hash);
        }
        return destroy(t);
      });
    },

    stop: function (hash) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        delete torrents[hash];
        log.info('stopped ' + hash);
        return destroy(t);
      });
    },

    remove: function (hash, opts) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        return engine.metadata(hash).catch(function () { return null; }).then(function (meta) {
          return engine.stop(hash).then(function () {
            if (opts && opts.deleteData && meta) {
              log.info('deleting the data of ' + hash);
              return files.deleteData(t.savePath, meta.files);
            }
          });
        });
      });
    },

    select: function (hash, paths) {
      return Promise.resolve().then(function () {
        var t = get(hash);
        t.files = paths ? paths.slice() : null;
        if (t.ready) {
          applySelection(t);
        }
      });
    },

    stats: function () {
      var all = new Map();
      Object.keys(torrents).forEach(function (hash) {
        var t = torrents[hash], e = t.engine, torrent = e && e.torrent;
        if (!e) {
          all.set(hash, {
            state: 'paused', metadata: !!t.meta, doneBytes: 0, sizeBytes: null,
            downBps: 0, upBps: 0, peers: 0, peersUnchoked: 0, seeds: 0, downloadedBytes: 0, uploadedBytes: 0,
            checking: null, pieces: null
          });
          return;
        }
        var swarm = e.swarm, selected = 0, done = 0, pieces = null;
        if (torrent) {
          var count = torrent.pieces.length, last = (torrent.length % torrent.pieceLength) || torrent.pieceLength;
          pieces = new Uint8Array(count);
          for (var i = 0; i < count; i++) {
            pieces[i] = e.bitfield.get(i) ? 1 : 0;
          }
          var seen = {};
          ranges(t).forEach(function (r) {
            for (var p = r.from; p <= r.to; p++) {
              if (seen[p]) {
                continue;
              }
              seen[p] = true;
              var size = p === count - 1 ? last : torrent.pieceLength;
              selected += size;
              if (pieces[p]) {
                done += size;
              }
            }
          });
          // piece edges overlap other files: report the files' own size
          var exact = e.files.filter(function (f) { return !t.files || t.files.indexOf(f.path) !== -1; })
            .reduce(function (sum, f) { return sum + f.length; }, 0);
          done = selected ? Math.round(done * exact / selected) : 0;
          selected = exact;
        }
        all.set(hash, {
          state: !torrent || !t.ready ? (t.checking ? 'checking' : 'downloading') : t.done ? 'seeding' : 'downloading',
          metadata: !!torrent,
          doneBytes: done,
          sizeBytes: torrent ? selected : null,
          downBps: swarm.downloadSpeed(),
          upBps: swarm.uploadSpeed(),
          peers: swarm.wires.length,
          peersUnchoked: swarm.wires.reduce(function (n, w) { return n + (w.peerChoking ? 0 : 1); }, 0),
          seeds: swarm.wires.reduce(function (n, w) { return n + (w.isSeeder ? 1 : 0); }, 0),
          downloadedBytes: swarm.downloaded,
          uploadedBytes: swarm.uploaded,
          checking: t.checking ? { done: t.checking.done, total: t.checking.total } : null,
          pieces: pieces
        });
      });
      return Promise.resolve(all);
    },

    stream: function (hash, filePath, range) {
      return Promise.resolve().then(function () {
        return waitReady(get(hash));
      }).then(function (e) {
        var file = e.files.filter(function (f) { return f.path === filePath; })[0];
        if (!file) {
          throw EngineError('NOT_FOUND', 'No file ' + filePath + ' in ' + hash);
        }
        range = range || {};
        var start = range.start || 0,
          end = range.end !== undefined ? Math.min(range.end, file.length - 1) : file.length - 1;
        if (file.length === 0 || start > end) {
          var empty = new stream.Readable({ read: function () {} });
          empty.push(null);
          return empty;
        }
        return file.createReadStream({ start: start, end: end });
      });
    },

    setLimits: function (next) {
      return Promise.resolve().then(function () {
        if (next.downBps || next.upBps) {
          throw EngineError('UNSUPPORTED', 'torrent-stream has no speed limits');
        }
        if (next.uploadSlots !== undefined) {
          // applies to torrents started from now on
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
