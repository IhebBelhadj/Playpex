'use strict';

// rqbit adapter (docs/media-server-plan.md §4.6): the engine port (../../port.js)
// over rqbit's HTTP API, rqbit running as a supervised sidecar
// (../supervisor.js). An optional download (../sidecar.js: RQBIT_PATH, else
// <cache>/engines/rqbit, else the PATH), pinned in ./release.json.
//
// Torrents are addressed by info hash in every rqbit URL; files by their
// index, which the adapter maps to our paths through the metainfo (parsed
// here, so paths are the same as with any other engine). rqbit keeps its own
// session (a cache under <stateDir>/rqbit) and resumes without re-checking
// (--fastresume). Data layout: <savePath>/<path inside the torrent>, like
// every engine. rqbit's own default differs for a folder torrent holding one
// file (it drops the folder), so a folder torrent always gets an explicit
// output_folder, and a magnet is first listed (list_only: its name and files,
// nothing written) to know which kind it is.
//
// rqbit can't add a torrent paused: a paused add is only remembered here and
// sent on start(). A magnet's add waits for its metadata on rqbit's side, so
// it runs in the background (aborted by pause / stop / remove).

var path = require('path'),
  events = require('events'),
  parseTorrent = require('parse-torrent'),
  bncode = require('bncode'),
  files = require('../../files'),
  errors = require('../../errors'),
  sidecar = require('../sidecar'),
  release = require('./release.json'),
  Supervisor = require('../supervisor');

var SPEC = {
  id: 'rqbit',
  binary: 'rqbit',
  envVar: 'RQBIT_PATH',
  release: release,
  versionPattern: /rqbit (\S+)/
};

var EngineError = errors.EngineError,
  DEFAULT_PEER_PORT = 6881,
  MIB = 1024 * 1024;

// The metainfo as we need it: our file paths in rqbit's file order
function parseMeta(buffer) {
  var t = parseTorrent(buffer);
  return {
    name: t.name,
    length: t.length,
    pieceLength: t.pieceLength,
    pieceCount: t.pieces.length,
    multi: bncode.decode(t.infoBuffer).files !== undefined,
    infoBuffer: t.infoBuffer,
    files: t.files.map(function (f) { return { path: f.path, size: f.length, offset: f.offset }; })
  };
}

// A .torrent with these trackers (the info dictionary, so the hash, unchanged)
function torrentFileOf(meta, trackers) {
  return bncode.encode({ info: bncode.decode(meta.infoBuffer), 'announce-list': (trackers || []).map(function (t) { return [t]; }) });
}

function bits(buffer, count) {
  var pieces = new Uint8Array(count);
  for (var i = 0; i < count; i++) {
    pieces[i] = buffer[i >> 3] & (0x80 >> (i & 7)) ? 1 : 0;
  }
  return pieces;
}

function failed(res, what) {
  var message = (res.json && res.json.human_readable) || ('HTTP ' + res.status);
  if (res.status === 404) {
    return EngineError('NOT_FOUND', what + ': ' + message);
  }
  if (res.status === 400) {
    return EngineError('BAD_TORRENT', what + ': ' + message);
  }
  return EngineError('UNAVAILABLE', what + ': ' + message);
}

function create() {
  var emitter = new events.EventEmitter(),
    entries = {},        // hash → entry (below)
    options = null,
    sup = null,
    log = null;

  // entry: { hash, savePath, files (paths | null), magnet, trackers, peers, meta (parseMeta | null),
  //   wanted: 'running' | 'paused', inRqbit, pending ({ promise, controller } | null) }

  function api(method, urlPath, opts) {
    if (!sup) {
      return Promise.reject(EngineError('UNAVAILABLE', 'rqbit is not started'));
    }
    return sup.request(method, urlPath, opts);
  }

  function url(hash, rest) {
    return '/torrents/' + hash + (rest || '');
  }

  function indexes(entry) {
    return entry.meta.files.reduce(function (all, f, i) {
      return !entry.files || entry.files.indexOf(f.path) !== -1 ? all.concat(i) : all;
    }, []);
  }

  // Where rqbit must write: <savePath>/<name> for a folder torrent (even with
  // one file), <savePath> for a single file (nothing to say in its own folder)
  function folderOf(savePath, name, multi) {
    if (multi) {
      return path.join(savePath, name);
    }
    return path.resolve(savePath) === path.resolve(options.dataDir) ? undefined : savePath;
  }

  function outputFolder(entry) {
    return folderOf(entry.savePath, entry.meta.name, entry.meta.multi);
  }

  function magnetOf(entry) {
    var magnet = entry.magnet || 'magnet:?xt=urn:btih:' + entry.hash;
    return magnet + (entry.trackers || []).filter(function (t) { return magnet.indexOf(encodeURIComponent(t)) === -1; })
      .map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('');
  }

  // The metainfo rqbit has (persisted torrents, magnets once resolved)
  function fetchMeta(entry) {
    return api('GET', url(entry.hash, '/metadata')).then(function (res) {
      if (res.status !== 200) {
        throw failed(res, 'metadata of ' + entry.hash);
      }
      entry.meta = parseMeta(res.raw);
      emitter.emit('metadata', entry.hash);
    });
  }

  // A magnet's files before adding it (rqbit's list_only: nothing is
  // added or written) → { name, paths (ours, in rqbit's order), multi }
  function preview(entry, signal) {
    return api('POST', '/torrents', {
      query: { list_only: 'true', initial_peers: entry.peers.length ? entry.peers.join(',') : undefined },
      body: magnetOf(entry), headers: { 'Content-Type': 'text/plain' }, timeoutMs: 0, signal: signal
    }).then(function (res) {
      if (res.status !== 200 || !res.json || !res.json.details) {
        throw failed(res, 'resolving ' + entry.hash);
      }
      var d = res.json.details,
        // a folder torrent: several files, or one whose path isn't the torrent's name
        multi = d.files.length > 1 || (d.files[0] && d.files[0].components.join('/') !== d.name);
      return {
        name: d.name,
        multi: multi,
        paths: d.files.map(function (f) { return multi ? path.join.apply(path, [d.name].concat(f.components)) : f.components.join(path.sep); }),
        sizes: d.files.map(function (f) { return f.length; }),
        peers: res.json.seen_peers || []
      };
    });
  }

  // POST /torrents: the .torrent when we have it, else the magnet, listed
  // first (layout, selection; its peers then answer the add at once). rqbit
  // answers once it has the metadata: in the background.
  function send(entry) {
    if (entry.pending) {
      return entry.pending.promise;
    }
    var controller = new AbortController(),
      listing = entry.meta ? Promise.resolve(null) : preview(entry, controller.signal);
    var promise = listing.then(function (listed) {
      var query = { overwrite: 'true' }, peers = entry.peers.slice();
      if (entry.meta) {
        if (!entry.files && entry.onlyLargest) {
          entry.files = [entry.meta.files.reduce(function (a, b) { return a.size >= b.size ? a : b; }).path];
        }
        query.only_files = entry.files ? indexes(entry).join(',') : undefined;
        query.output_folder = outputFolder(entry);
      } else if (listed) {
        if (!entry.files && entry.onlyLargest) {
          // rqbit's piece picking never recovers from all files at first: choose before adding
          var sizes = listed.sizes, largest = sizes.indexOf(Math.max.apply(Math, sizes));
          entry.files = [listed.paths[largest]];
        }
        query.only_files = entry.files ? listed.paths.reduce(function (all, p, i) {
          return entry.files.indexOf(p) !== -1 ? all.concat(i) : all;
        }, []).join(',') : undefined;
        query.output_folder = folderOf(entry.savePath, listed.name, listed.multi);
        peers = peers.concat(listed.peers.filter(function (p) { return peers.indexOf(p) === -1; }));
      }
      query.initial_peers = peers.length ? peers.join(',') : undefined;
      return api('POST', '/torrents', {
        query: query,
        body: entry.meta ? torrentFileOf(entry.meta, entry.trackers) : magnetOf(entry),
        headers: entry.meta ? { 'Content-Type': 'application/x-bittorrent' } : { 'Content-Type': 'text/plain' },
        timeoutMs: entry.meta ? 60000 : 0,
        signal: controller.signal
      });
    }).then(function (res) {
      if (res.status !== 200) {
        throw failed(res, 'adding ' + entry.hash);
      }
      entry.inRqbit = true;
      var after = entry.meta ? Promise.resolve() : fetchMeta(entry).then(function () {
        // chosen while rqbit was resolving it
        return entry.files ? api('POST', url(entry.hash, '/update_only_files'), { body: { only_files: indexes(entry) } }) : null;
      });
      return after.then(function () {
        // paused while rqbit was resolving it
        return entry.wanted === 'paused' ? api('POST', url(entry.hash, '/pause')) : null;
      });
    }).then(function () {
      entry.pending = null;
    }, function (err) {
      entry.pending = null;
      if (controller.signal.aborted) {
        return;
      }
      log.warn('rqbit: ' + err.message);
      emitter.emit('error', entry.hash, errors.isEngineError(err) ? err : EngineError('UNAVAILABLE', err.message, err));
      throw err;
    });
    entry.pending = { promise: promise, controller: controller };
    promise.catch(function () {});
    return promise;
  }

  function abort(entry) {
    if (entry.pending) {
      entry.pending.controller.abort();
      entry.pending = null;
    }
  }

  // Our entry, or one for a torrent rqbit kept from an earlier run
  function entryFor(hash) {
    if (entries[hash]) {
      return Promise.resolve(entries[hash]);
    }
    return api('GET', url(hash)).then(function (res) {
      if (res.status !== 200) {
        throw EngineError('NOT_FOUND', 'The engine has no torrent ' + hash);
      }
      var entry = entries[hash] = {
        hash: hash,
        savePath: options.dataDir,
        files: null,
        magnet: null, trackers: [], peers: [], meta: null,
        wanted: res.json && res.json.stats && res.json.stats.state === 'paused' ? 'paused' : 'running',
        inRqbit: true, pending: null
      };
      if (res.json && Array.isArray(res.json.files) && res.json.files.some(function (f) { return !f.included; })) {
        entry.files = [];   // filled with paths once the metadata is in
      }
      return fetchMeta(entry).then(function () {
        if (entry.files && res.json.files) {
          entry.files = entry.meta.files.filter(function (f, i) { return res.json.files[i] && res.json.files[i].included; })
            .map(function (f) { return f.path; });
        }
        return entry;
      });
    });
  }

  function known(hash) {
    return entryFor(hash);
  }

  function onRestarted() {
    // rqbit restored its session; what it hadn't taken yet is sent again
    Object.keys(entries).forEach(function (hash) {
      var entry = entries[hash];
      if (entry.wanted === 'running' && !entry.inRqbit) {
        send(entry).catch(function () {});
      } else if (entry.wanted === 'paused' && entry.inRqbit) {
        api('POST', url(hash, '/pause')).catch(function () {});
      }
    });
  }

  var engine = {
    id: 'rqbit',
    capabilities: {
      fastResume: true,
      pause: true,
      rateLimits: false,       // rqbit sets them per torrent when adding, or for the whole process at start
      fileSelection: true,
      streamPriority: true,
      persistentSession: true
    },

    init: function (opts) {
      options = opts;
      log = opts.log;
      var found = sidecar.find(SPEC);
      if (!found) {
        return Promise.reject(EngineError('UNAVAILABLE', 'rqbit is not installed (Settings › Downloads, or npm run install:engine -- rqbit)'));
      }
      return sidecar.version(found.path, ['--version'], SPEC.versionPattern).then(function (version) {
        if (!version) {
          throw EngineError('UNAVAILABLE', 'rqbit at ' + found.path + ' does not run');
        }
        if (version !== release.version) {
          log.warn('rqbit ' + version + ' (' + found.source + '), this server is tested with ' + release.version);
        }
        var stateDir = path.join(opts.stateDir, 'rqbit');
        // its API on loopback with basic auth (a fresh password at each start),
        // fast resume on, UPnP port forwarding only when asked; its UPnP media
        // server and mDNS stay off (their defaults), its web UI behind the password
        sup = new Supervisor({
          name: 'rqbit',
          bin: found.path,
          version: version,
          log: log,
          peerPort: opts.peerPort !== undefined ? opts.peerPort : DEFAULT_PEER_PORT,
          readyPath: '/',
          args: function (apiPort, peerPort) {
            var args = ['--http-api-listen-addr', '127.0.0.1:' + apiPort, '--listen-port', String(peerPort)];
            if (!opts.portForwarding) {
              args.push('--disable-upnp-port-forward');
            }
            if (opts.discovery === false) {
              args.push('--disable-dht', '--disable-dht-persistence', '--disable-trackers', '--disable-lsd');
            }
            return args.concat(['server', 'start', '--persistence-location', stateDir, '--fastresume', opts.dataDir]);
          },
          env: function (secret) {
            return { RQBIT_HTTP_BASIC_AUTH_USERPASS: 'playpex:' + secret, RQBIT_LOG_LEVEL_CONSOLE: 'info' };
          },
          auth: function (secret) {
            return 'Basic ' + Buffer.from('playpex:' + secret).toString('base64');
          }
        });
        sup.on('restarted', onRestarted);
        sup.on('failed', function (err) {
          Object.keys(entries).forEach(function (hash) {
            emitter.emit('error', hash, EngineError('UNAVAILABLE', err.message, err));
          });
        });
        return sup.start();
      });
    },

    close: function () {
      Object.keys(entries).forEach(function (hash) { abort(entries[hash]); });
      entries = {};
      var current = sup;
      sup = null;
      return current ? current.stop() : Promise.resolve();
    },

    health: function () {
      if (!sup) {
        return Promise.resolve({ ok: false, detail: 'not started' });
      }
      if (sup.status().failed) {
        return Promise.resolve({ ok: false, detail: sup.status().failed });
      }
      return api('GET', '/', { timeoutMs: 5000 }).then(function (res) {
        return { ok: res.status === 200, detail: res.status === 200 ? null : 'HTTP ' + res.status };
      }, function (err) {
        return { ok: false, detail: err.message };
      });
    },

    add: function (req) {
      return Promise.resolve().then(function () {
        var hash = req.infoHash;
        if (entries[hash]) {
          return { infoHash: hash, name: entries[hash].meta ? entries[hash].meta.name : null };
        }
        var meta = null;
        if (req.torrentFile) {
          try {
            meta = parseMeta(req.torrentFile);
          } catch (e) {
            throw EngineError('BAD_TORRENT', 'Cannot read this torrent: ' + e.message, e);
          }
          if (parseTorrent(req.torrentFile).infoHash !== hash) {
            throw EngineError('BAD_TORRENT', 'The metainfo is not the one of ' + hash);
          }
        } else {
          try {
            if (parseTorrent(req.magnet || 'magnet:?xt=urn:btih:' + hash).infoHash !== hash) {
              throw new Error('another info hash');
            }
          } catch (e) {
            throw EngineError('BAD_TORRENT', 'Cannot read this magnet: ' + e.message, e);
          }
        }
        var entry = entries[hash] = {
          hash: hash,
          savePath: req.savePath,
          files: req.files || null,
          onlyLargest: !!req.onlyLargest,
          magnet: req.magnet || null,
          trackers: req.trackers || [],
          peers: req.peers || [],
          meta: meta,
          wanted: req.paused ? 'paused' : 'running',
          inRqbit: false,
          pending: null
        };
        log.info('adding ' + hash + (req.paused ? ' (paused)' : ''));
        // rqbit may still have it from an earlier run (its session is a cache)
        return api('GET', url(hash)).then(function (res) {
          if (res.status === 200) {
            entry.inRqbit = true;
            var steps = [];
            if (!entry.meta) {
              steps.push(fetchMeta(entry).catch(function () {}));
            }
            return Promise.all(steps).then(function () {
              return entry.meta ? api('POST', url(hash, '/update_only_files'), { body: { only_files: indexes(entry) } }) : null;
            }).then(function () {
              return api('POST', url(hash, req.paused ? '/pause' : '/start'));
            });
          }
          if (req.paused) {
            return null;
          }
          // a .torrent is added at once; a magnet waits for its metadata, in the background
          var sending = send(entry);
          return meta ? sending : null;
        }).then(function () {
          return { infoHash: hash, name: meta ? meta.name : null };
        });
      });
    },

    metadata: function (hash) {
      return Promise.resolve().then(function () {
        var entry = entries[hash];
        if (!entry) {
          return known(hash).then(function (e) { return e.meta; });
        }
        if (!entry.meta) {
          throw EngineError('NO_METADATA_YET', 'No metadata yet for ' + hash);
        }
        return entry.meta;
      }).then(function (meta) {
        return {
          name: meta.name, length: meta.length, pieceLength: meta.pieceLength,
          files: meta.files.map(function (f) { return Object.assign({}, f); }),
          torrentFile: torrentFileOf(meta, [])
        };
      });
    },

    start: function (hash) {
      return known(hash).then(function (entry) {
        entry.wanted = 'running';
        if (entry.inRqbit) {
          return api('POST', url(hash, '/start')).then(function (res) {
            if (res.status === 404) {
              // rqbit lost it (its session is a cache): add it again
              entry.inRqbit = false;
              return send(entry);
            }
          });
        }
        var sending = send(entry);
        return entry.meta ? sending : null;
      });
    },

    pause: function (hash) {
      return known(hash).then(function (entry) {
        entry.wanted = 'paused';
        abort(entry);
        if (entry.inRqbit) {
          log.info('paused ' + hash);
          return api('POST', url(hash, '/pause')).then(function () {});
        }
      });
    },

    stop: function (hash) {
      return known(hash).then(function (entry) {
        abort(entry);
        delete entries[hash];
        log.info('stopped ' + hash);
        if (entry.inRqbit) {
          return api('POST', url(hash, '/forget')).then(function () {});
        }
      });
    },

    remove: function (hash, removeOptions) {
      var deleteData = !!(removeOptions && removeOptions.deleteData);
      return known(hash).then(function (entry) {
        abort(entry);
        delete entries[hash];
        var forgetting = entry.inRqbit ? api('POST', url(hash, deleteData ? '/delete' : '/forget')) : Promise.resolve();
        return forgetting.then(function () {
          // rqbit deletes the files; we also take the folders they leave empty
          if (deleteData && entry.meta) {
            log.info('deleting the data of ' + hash);
            return files.deleteData(entry.savePath, entry.meta.files);
          }
        });
      });
    },

    select: function (hash, paths) {
      return known(hash).then(function (entry) {
        entry.files = paths ? paths.slice() : null;
        if (entry.inRqbit && entry.meta) {
          return api('POST', url(hash, '/update_only_files'), { body: { only_files: indexes(entry) } }).then(function (res) {
            if (res.status !== 200) {
              throw failed(res, 'selecting files of ' + hash);
            }
          });
        }
      });
    },

    stats: function () {
      return api('GET', '/torrents', { query: { with_stats: 'true' } }).then(function (res) {
        if (res.status !== 200 || !res.json) {
          throw failed(res, 'stats');
        }
        var all = new Map(), live = [];
        (res.json.torrents || []).forEach(function (t) {
          var hash = t.info_hash, s = t.stats || {}, snap = s.live && s.live.snapshot,
            entry = entries[hash];
          // rqbit counts whole pieces; ours are the selected files' own bytes
          var sizeBytes = s.total_bytes || 0, doneBytes = s.progress_bytes || 0;
          if (entry && entry.meta && Array.isArray(s.file_progress)) {
            sizeBytes = 0;
            doneBytes = 0;
            entry.meta.files.forEach(function (f, i) {
              if (!entry.files || entry.files.indexOf(f.path) !== -1) {
                sizeBytes += f.size;
                doneBytes += Math.min(s.file_progress[i] || 0, f.size);
              }
            });
          }
          var stat = {
            state: s.state === 'initializing' ? 'checking' : s.state === 'paused' ? 'paused' : s.state === 'error' ? 'error' :
              s.finished ? 'seeding' : 'downloading',
            metadata: true,
            doneBytes: doneBytes,
            sizeBytes: sizeBytes,
            downBps: s.live ? Math.round(s.live.download_speed.mbps * MIB) : 0,
            upBps: s.live ? Math.round(s.live.upload_speed.mbps * MIB) : 0,
            peers: snap ? snap.peer_stats.live : 0,
            peersUnchoked: snap ? snap.peer_stats.live : 0,
            seeds: 0,
            downloadedBytes: snap ? snap.fetched_bytes : 0,
            uploadedBytes: s.uploaded_bytes || 0,
            checking: null,
            pieces: null,
            error: s.error || null
          };
          all.set(hash, stat);
          if (s.live && entry && entry.meta) {
            live.push({ hash: hash, stat: stat, count: entry.meta.pieceCount });
          }
        });
        // ours that rqbit doesn't hold (yet): a magnet resolving, a paused add
        Object.keys(entries).forEach(function (hash) {
          var entry = entries[hash];
          if (!all.has(hash)) {
            all.set(hash, {
              state: entry.wanted === 'paused' ? 'paused' : 'downloading', metadata: !!entry.meta, doneBytes: 0,
              sizeBytes: null, downBps: 0, upBps: 0, peers: 0, peersUnchoked: 0, seeds: 0, downloadedBytes: 0,
              uploadedBytes: 0, checking: null, pieces: null, error: null
            });
          }
        });
        return Promise.all(live.map(function (l) {
          return api('GET', url(l.hash, '/haves'), { headers: { Accept: 'application/octet-stream' } }).then(function (r) {
            if (r.status === 200) {
              l.stat.pieces = bits(r.raw, l.count);
            }
          }, function () {});
        })).then(function () { return all; });
      });
    },

    stream: function (hash, filePath, range) {
      return known(hash).then(function (entry) {
        return (entry.pending ? entry.pending.promise : Promise.resolve()).then(function () {
          if (!entry.inRqbit || !entry.meta) {
            throw EngineError('NOT_FOUND', 'The torrent ' + hash + ' is not running');
          }
          var index = entry.meta.files.map(function (f) { return f.path; }).indexOf(filePath);
          if (index === -1) {
            throw EngineError('NOT_FOUND', 'No file ' + filePath + ' in ' + hash);
          }
          var file = entry.meta.files[index];
          range = range || {};
          var start = range.start || 0,
            end = range.end !== undefined ? Math.min(range.end, file.size - 1) : file.size - 1;
          return api('GET', url(hash, '/stream/' + index), {
            headers: { Range: 'bytes=' + start + '-' + end },
            stream: true,
            timeoutMs: 0
          });
        });
      }).then(function (res) {
        if (res.statusCode === undefined) {
          throw failed(res, 'streaming ' + hash);
        }
        return res;
      });
    },

    setLimits: function (next) {
      return Promise.resolve().then(function () {
        if (next.downBps || next.upBps) {
          throw EngineError('UNSUPPORTED', 'Speed limits are not supported with rqbit yet');
        }
        // uploadSlots: rqbit has no upload slots; it uploads to the peers it serves
      });
    },

    list: function () {
      return api('GET', '/torrents').then(function (res) {
        var hashes = res.json && res.json.torrents ? res.json.torrents.map(function (t) { return t.info_hash; }) : [];
        Object.keys(entries).forEach(function (hash) {
          if (hashes.indexOf(hash) === -1) {
            hashes.push(hash);
          }
        });
        return hashes;
      });
    },

    on: function (event, fn) {
      emitter.on(event, fn);
    }
  };

  return engine;
}

module.exports = { create: create, spec: SPEC };
