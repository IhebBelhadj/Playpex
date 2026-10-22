'use strict';

// Conformance suite of the torrent engine port (docs/media-server-plan.md
// §4.3): the same tests against every registered adapter (lib/torrents/engines),
// offline: a second instance of the same engine seeds a generated torrent on
// loopback, and the engine under test is pointed at it (`peers`, no DHT /
// trackers). A new engine is done when it passes here.
//
//   npm test -w apps/server
//   node --test --test-name-pattern=torrent-stream test/engines.test.js   one engine

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');

// Sidecar engines (rqbit, playpex-torrentd) installed in the real cache are
// looked up before the data dirs below change: in a child, so lib/paths is
// loaded here with the throwaway dirs only. Each is then named by its env var.
JSON.parse(require('child_process').execFileSync(process.execPath, ['-e',
  "var e = require('./lib/torrents/engines'), s = require('./lib/torrents/engines/sidecar');" +
  "process.stdout.write(JSON.stringify(e.ids().map(function (id) { var spec = e.spec(id), f = spec && s.find(spec);" +
  " return f ? [spec.envVar, f.path] : null; }).filter(Boolean)))"],
{ cwd: path.join(__dirname, '..') }).toString()).forEach(function (pair) {
  if (!process.env[pair[0]]) {
    process.env[pair[0]] = pair[1];
  }
});

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-engines-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');

var engines = require('../lib/torrents/engines'),
  port = require('../lib/torrents/port'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });

var log = logger.child('torrent'),
  STATS_KEYS = ['state', 'metadata', 'doneBytes', 'sizeBytes', 'downBps', 'upBps', 'peers', 'peersUnchoked', 'seeds',
    'downloadedBytes', 'uploadedBytes', 'checking', 'pieces'];

test.after(function () {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stat(engine, hash) {
  return engine.stats().then(function (all) { return all.get(hash); });
}

function rejectsWith(promise, code) {
  return promise.then(function () {
    assert.fail('expected an EngineError ' + code);
  }, function (err) {
    assert.equal(err.name, 'EngineError', err.message);
    assert.equal(err.code, code, err.message);
  });
}

engines.ids().forEach(function (id) {
  var available = engines.available(id);
  test('engine ' + id, { timeout: 120000, skip: !available.ok && available.detail + ' (npm run install:engine -- ' + id + ')' }, function (t) {
    var dir = path.join(tmp, id),
      seedDir = path.join(dir, 'seed'),
      leechDir = path.join(dir, 'leech'),
      torrent = helpers.make(seedDir, 'Sample', [
        { path: 'a.mkv', size: 1500000 },
        { path: 'b.srt', size: 20000 },
        { path: 'c.mkv', size: 600000 }
      ]),
      hash = torrent.infoHash,
      A = torrent.files[0], B = torrent.files[1],
      seeder = engines.create(id),
      engine = engines.create(id),
      peers = null;

    function init(e, data, peerPort) {
      return e.init({ dataDir: data, stateDir: path.join(data, '.state'), peerPort: peerPort, discovery: false, log: log });
    }

    function addLeech(extra) {
      return engine.add(Object.assign({ infoHash: hash, magnet: torrent.magnet, savePath: leechDir, peers: peers }, extra));
    }

    t.after(function () {
      return Promise.all([seeder.close(), engine.close()]);
    });

    return Promise.all([helpers.freePort(), helpers.freePort()]).then(function (ports) {
      peers = ['127.0.0.1:' + ports[0]];
      return Promise.all([init(seeder, seedDir, ports[0]), init(engine, leechDir, ports[1])]);
    }).then(function () {
      return seeder.add({ infoHash: hash, torrentFile: torrent.torrentFile, savePath: seedDir });
    }).then(function () {
      return helpers.until(function () {
        return stat(seeder, hash).then(function (s) { return s && s.state === 'seeding'; });
      }, 20000, 'the seeder to check its data');
    }).then(function () {
      return t.test('capabilities and health', function () {
        assert.equal(engine.id, id);
        Object.keys(port.CAPABILITIES).forEach(function (cap) {
          assert.equal(typeof engine.capabilities[cap], 'boolean', id + ' declares ' + cap);
        });
        return engine.health().then(function (h) { assert.equal(h.ok, true); });
      });
    }).then(function () {
      return t.test('add by magnet: metadata from a peer; add is idempotent', function () {
        return addLeech({ files: [B.path] }).then(function (added) {
          assert.equal(added.infoHash, hash);
          return rejectsWith(engine.metadata('0'.repeat(40)), 'NOT_FOUND');
        }).then(function () {
          return helpers.until(function () { return engine.metadata(hash); }, 30000, 'the metadata');
        }).then(function (meta) {
          assert.equal(meta.name, 'Sample');
          assert.deepEqual(meta.files.map(function (f) { return [f.path, f.size]; }),
            torrent.files.map(function (f) { return [f.path, f.size]; }));
          assert.ok(Buffer.isBuffer(meta.torrentFile));
          return addLeech({ files: [B.path] });
        }).then(function () {
          return engine.list();
        }).then(function (list) {
          assert.deepEqual(list, [hash]);
        });
      });
    }).then(function () {
      return t.test('select by path: only that file is downloaded', function () {
        return helpers.until(function () {
          return stat(engine, hash).then(function (s) { return s.state === 'seeding' && s; });
        }, 40000, 'the selected file').then(function (s) {
          assert.equal(s.sizeBytes, B.size);
          assert.equal(s.doneBytes, B.size);
          assert.ok(fs.readFileSync(path.join(leechDir, B.path)).equals(B.data));
          var a = path.join(leechDir, A.path);
          assert.ok(!fs.existsSync(a) || fs.statSync(a).blocks * 512 < A.size, 'a.mkv was not downloaded');
        });
      });
    }).then(function () {
      return t.test('stats: every field, for every torrent', function () {
        return engine.stats().then(function (all) {
          assert.ok(all instanceof Map);
          var s = all.get(hash);
          STATS_KEYS.forEach(function (k) { assert.ok(k in s, 'stats has ' + k); });
          assert.ok(port.ENGINE_STATES.indexOf(s.state) !== -1);
          assert.ok(s.pieces && s.pieces.length > 0);
        });
      });
    }).then(function () {
      return t.test('stream a range of a file not selected: the exact bytes', function () {
        return engine.stream(hash, A.path, { start: 1000, end: 70000 }).then(helpers.read).then(function (bytes) {
          assert.ok(bytes.equals(A.data.slice(1000, 70001)), 'bytes 1000-70000');
          return rejectsWith(engine.stream(hash, 'Sample/nope.mkv', {}), 'NOT_FOUND');
        });
      });
    }).then(function () {
      return t.test('pause: no traffic, no peers; start: streams again', function () {
        var pausing = engine.capabilities.pause ? engine.pause(hash) :
          rejectsWith(engine.pause(hash), 'UNSUPPORTED').then(function () { return engine.stop(hash); });
        return pausing.then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 300); });
        }).then(function () {
          return stat(engine, hash);
        }).then(function (s) {
          if (s) {
            assert.equal(s.state, 'paused');
            assert.equal(s.downBps, 0);
            assert.equal(s.upBps, 0);
            assert.equal(s.peers, 0);
          }
          return engine.capabilities.pause ? engine.start(hash) : addLeech({ files: [B.path] });
        }).then(function () {
          return engine.stream(hash, A.path, { start: 0, end: 99999 });
        }).then(helpers.read).then(function (bytes) {
          assert.ok(bytes.equals(A.data.slice(0, 100000)));
        });
      });
    }).then(function () {
      return t.test('stop + add again with the .torrent: the data is still there', function () {
        var meta;
        return engine.metadata(hash).then(function (m) {
          meta = m;
          return engine.stop(hash);
        }).then(function () {
          return engine.list();
        }).then(function (list) {
          assert.deepEqual(list, []);
          return rejectsWith(engine.metadata(hash), 'NOT_FOUND');
        }).then(function () {
          // alone: no peer to fetch from
          return engine.add({ infoHash: hash, torrentFile: meta.torrentFile, savePath: leechDir, files: [B.path] });
        }).then(function () {
          return helpers.until(function () {
            return stat(engine, hash).then(function (s) { return s && s.state === 'seeding' && s; });
          }, 20000, 'the data to be found again');
        }).then(function (s) {
          assert.equal(s.doneBytes, B.size);
        });
      });
    }).then(function () {
      return t.test('remove keeps the data, or deletes it', function () {
        return engine.remove(hash, { deleteData: false }).then(function () {
          assert.ok(fs.existsSync(path.join(leechDir, B.path)), 'kept');
          return engine.add({ infoHash: hash, torrentFile: torrent.torrentFile, savePath: leechDir, files: [B.path] });
        }).then(function () {
          return engine.remove(hash, { deleteData: true });
        }).then(function () {
          assert.ok(!fs.existsSync(path.join(leechDir, B.path)), 'deleted');
          assert.ok(!fs.existsSync(path.join(leechDir, 'Sample')), 'its folder too');
          return rejectsWith(engine.remove(hash, { deleteData: true }), 'NOT_FOUND');
        });
      });
    }).then(function () {
      return t.test('errors are EngineErrors', function () {
        return rejectsWith(engine.add({ infoHash: hash, torrentFile: Buffer.from('not bencode'), savePath: leechDir }), 'BAD_TORRENT')
          .then(function () {
            return rejectsWith(engine.add({ infoHash: '1'.repeat(40), torrentFile: torrent.torrentFile, savePath: leechDir }), 'BAD_TORRENT');
          })
          .then(function () { return rejectsWith(engine.start('2'.repeat(40)), 'NOT_FOUND'); })
          .then(function () { return rejectsWith(engine.select('2'.repeat(40), null), 'NOT_FOUND'); });
      });
    }).then(function () {
      return t.test('list() after the engine restarts', function () {
        return engine.add({ infoHash: hash, torrentFile: torrent.torrentFile, savePath: leechDir, files: [B.path] }).then(function () {
          return engine.close();
        }).then(function () {
          engine = engines.create(id);
          return helpers.freePort();
        }).then(function (p) {
          return init(engine, leechDir, p);
        }).then(function () {
          return engine.list();
        }).then(function (list) {
          assert.deepEqual(list, engine.capabilities.persistentSession ? [hash] : []);
        });
      });
    });
  });
});
