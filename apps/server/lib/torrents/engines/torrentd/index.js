'use strict';

// playpex-torrentd adapter: the engine port (../../port.js) over the HTTP API
// of our Go sidecar (engines/torrentd, built on anacrolix/torrent), run by
// ../supervisor.js. The sidecar was written for this port, so this file is
// mostly a translation: JSON in, JSON out, the .torrent and the piece
// bitfield in base64, the stream as an HTTP range.
//
// An optional download (../sidecar.js: PLAYPEX_TORRENTD_PATH, else
// <cache>/engines/torrentd, else the PATH); `npm run build:torrentd` builds
// it from source there until releases are published (./release.json).

var path = require('path'),
  events = require('events'),
  errors = require('../../errors'),
  sidecar = require('../sidecar'),
  release = require('./release.json'),
  Supervisor = require('../supervisor');

var EngineError = errors.EngineError,
  DEFAULT_PEER_PORT = 6881,
  CODES = ['NOT_FOUND', 'BAD_TORRENT', 'NO_METADATA_YET', 'DISK', 'UNAVAILABLE', 'UNSUPPORTED'];

var SPEC = {
  id: 'torrentd',
  binary: 'playpex-torrentd',
  envVar: 'PLAYPEX_TORRENTD_PATH',
  release: release,
  versionPattern: /playpex-torrentd (\S+)/
};

function failed(res, what) {
  var code = res.json && CODES.indexOf(res.json.code) !== -1 ? res.json.code : res.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE';
  return EngineError(code, what + ': ' + ((res.json && res.json.error) || 'HTTP ' + res.status));
}

function bits(base64, count) {
  var buffer = Buffer.from(base64, 'base64'), pieces = new Uint8Array(count);
  for (var i = 0; i < count; i++) {
    pieces[i] = buffer[i >> 3] & (0x80 >> (i & 7)) ? 1 : 0;
  }
  return pieces;
}

function create() {
  var emitter = new events.EventEmitter(),
    sup = null,
    log = null;

  function api(method, urlPath, opts) {
    if (!sup) {
      return Promise.reject(EngineError('UNAVAILABLE', 'playpex-torrentd is not started'));
    }
    return sup.request(method, urlPath, opts);
  }

  // A JSON call that must answer 200
  function call(method, urlPath, body, what) {
    return api(method, urlPath, body === undefined ? {} : { body: body }).then(function (res) {
      if (res.status !== 200) {
        throw failed(res, what);
      }
      return res.json;
    });
  }

  // engine port v2 routes (torrentd 0.2): an older build answers a plain 404
  function v2(method, urlPath, body, what) {
    return api(method, urlPath, body === undefined ? {} : { body: body }).then(function (res) {
      if (res.status === 404 && !res.json) {
        throw EngineError('UNSUPPORTED', 'This playpex-torrentd is too old for ' + what + ': build or install it again');
      }
      if (res.status !== 200) {
        throw failed(res, what);
      }
      return res.json;
    });
  }

  function url(hash, rest) {
    return '/torrents/' + hash + (rest || '');
  }

  var engine = {
    id: 'torrentd',
    capabilities: {
      fastResume: true,        // verified pieces are kept in a database (no re-check)
      pause: true,             // the torrent leaves the client; start adds it back from its info
      rateLimits: true,
      fileSelection: true,
      streamPriority: true,    // responsive readers with read-ahead: a seek is served first
      persistentSession: false,
      peerList: true,
      trackerList: true,       // the list: anacrolix keeps the announce state to itself
      trackerEdit: true,
      recheck: true
    },

    init: function (opts) {
      log = opts.log;
      var found = sidecar.find(SPEC);
      if (!found) {
        return Promise.reject(EngineError('UNAVAILABLE',
          'playpex-torrentd is not installed (Settings › Downloads, or npm run build:torrentd)'));
      }
      return sidecar.version(found.path, ['--version'], SPEC.versionPattern).then(function (version) {
        if (!version) {
          throw EngineError('UNAVAILABLE', 'playpex-torrentd at ' + found.path + ' does not run');
        }
        if (version !== release.version) {
          log.warn('playpex-torrentd ' + version + ' (' + found.source + '), this server expects ' + release.version);
        }
        sup = new Supervisor({
          name: 'playpex-torrentd',
          bin: found.path,
          version: version,
          log: log,
          peerPort: opts.peerPort !== undefined ? opts.peerPort : DEFAULT_PEER_PORT,
          readyPath: '/health',
          args: function (apiPort, peerPort) {
            var args = ['--listen', '127.0.0.1:' + apiPort, '--data-dir', opts.dataDir,
              '--state-dir', path.join(opts.stateDir, 'torrentd'), '--peer-port', String(peerPort)];
            if (opts.discovery === false) {
              args.push('--no-discovery');
            }
            if (opts.portForwarding) {
              args.push('--port-forwarding');
            }
            if (opts.limits && opts.limits.uploadSlots === 0) {
              args.push('--no-upload');
            }
            return args;
          },
          env: function (secret) {
            return { PLAYPEX_TORRENTD_TOKEN: secret };
          },
          auth: function (secret) {
            return 'Bearer ' + secret;
          }
        });
        sup.on('failed', function (err) {
          engine.list().catch(function () { return []; }).then(function (hashes) {
            hashes.forEach(function (hash) { emitter.emit('error', hash, EngineError('UNAVAILABLE', err.message, err)); });
          });
        });
        return sup.start();
      });
    },

    close: function () {
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
      return api('GET', '/health', { timeoutMs: 5000 }).then(function (res) {
        return { ok: res.status === 200, detail: res.status === 200 ? null : 'HTTP ' + res.status };
      }, function (err) {
        return { ok: false, detail: err.message };
      });
    },

    add: function (req) {
      return call('POST', '/torrents', {
        infoHash: req.infoHash,
        magnet: req.magnet || '',
        torrentFile: req.torrentFile ? req.torrentFile.toString('base64') : '',
        savePath: req.savePath,
        files: req.files || null,
        onlyLargest: !!req.onlyLargest,
        paused: !!req.paused,
        trackers: req.trackers || [],
        peers: req.peers || []
      }, 'adding ' + req.infoHash).then(function (res) {
        return { infoHash: res.infoHash, name: res.name || null };
      });
    },

    metadata: function (hash) {
      return call('GET', url(hash, '/metadata'), undefined, 'metadata of ' + hash).then(function (md) {
        return {
          name: md.name, length: md.length, pieceLength: md.pieceLength, files: md.files,
          torrentFile: Buffer.from(md.torrentFile, 'base64')
        };
      });
    },

    start: function (hash) {
      return call('POST', url(hash, '/start'), undefined, 'starting ' + hash).then(function () {});
    },

    pause: function (hash) {
      return call('POST', url(hash, '/pause'), undefined, 'pausing ' + hash).then(function () {});
    },

    stop: function (hash) {
      return call('POST', url(hash, '/stop'), undefined, 'stopping ' + hash).then(function () {});
    },

    remove: function (hash, options) {
      return call('POST', url(hash, '/remove'), { deleteData: !!(options && options.deleteData) }, 'removing ' + hash)
        .then(function () {});
    },

    select: function (hash, paths) {
      return call('PUT', url(hash, '/files'), { files: paths ? paths : null }, 'selecting files of ' + hash).then(function () {});
    },

    stats: function () {
      return api('GET', '/torrents', { query: { pieces: '1' } }).then(function (res) {
        if (res.status !== 200 || !res.json) {
          throw failed(res, 'stats');
        }
        var all = new Map();
        res.json.torrents.forEach(function (t) {
          all.set(t.infoHash, {
            state: t.state,
            metadata: t.metadata,
            doneBytes: t.doneBytes,
            sizeBytes: t.sizeBytes,
            downBps: t.downBps,
            upBps: t.upBps,
            peers: t.peers,
            peersUnchoked: t.peersUnchoked,
            seeds: t.seeds,
            downloadedBytes: t.downloadedBytes,
            uploadedBytes: t.uploadedBytes,
            checking: t.checking,
            pieces: t.pieces && t.pieceCount ? bits(t.pieces, t.pieceCount) : null,
            error: t.error
          });
        });
        return all;
      });
    },

    stream: function (hash, filePath, range) {
      range = range || {};
      var start = range.start || 0;
      return api('GET', url(hash, '/stream'), {
        query: { path: filePath },
        headers: { Range: 'bytes=' + start + '-' + (range.end !== undefined ? range.end : '') },
        stream: true,
        timeoutMs: 0
      }).then(function (res) {
        if (res.statusCode === undefined) {
          throw failed(res, 'streaming ' + hash);
        }
        return res;
      });
    },

    setLimits: function (next) {
      // uploadSlots: only 0 (never upload) means something here, at start
      return call('PUT', '/limits', { downBps: next.downBps || 0, upBps: next.upBps || 0 }, 'limits').then(function () {});
    },

    peers: function (hash) {
      return v2('GET', url(hash, '/peers'), undefined, 'the peers of ' + hash);
    },

    trackers: function (hash) {
      return v2('GET', url(hash, '/trackers'), undefined, 'the trackers of ' + hash).then(function (res) { return res.trackers; });
    },

    addTrackers: function (hash, urls) {
      return v2('POST', url(hash, '/trackers'), { add: urls }, 'adding trackers to ' + hash).then(function () {});
    },

    recheck: function (hash) {
      return v2('POST', url(hash, '/recheck'), {}, 'checking ' + hash).then(function () {});
    },

    list: function () {
      return call('GET', '/torrents', undefined, 'list').then(function (res) {
        return res.torrents.map(function (t) { return t.infoHash; });
      });
    },

    on: function (event, fn) {
      emitter.on(event, fn);
    }
  };

  return engine;
}

module.exports = { create: create, spec: SPEC };
