'use strict';

// Test torrents: random files written to a directory, and their .torrent
// (BitTorrent v1 metainfo, made here: no tracker, no network).
//
//   make(dir, 'Sample', [{ path: 'a.mkv', size: 1500000 } or { path, data: Buffer }, …], { pieceLength })
//     → { infoHash, magnet, torrentFile (Buffer), name, files: [{ path, size, data }] }
//   free port: freePort() → Promise<number>

var fs = require('fs'),
  path = require('path'),
  net = require('net'),
  crypto = require('crypto'),
  bncode = require('bncode');

function make(dir, name, specs, options) {
  var pieceLength = (options && options.pieceLength) || 64 * 1024,
    files = specs.map(function (spec) {
      var data = spec.data || crypto.randomBytes(spec.size),
        rel = specs.length === 1 && !(options && options.folder) ? name : path.join(name, spec.path);
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), data);
      return { path: rel, size: data.length, data: data, segments: spec.path.split('/') };
    }),
    all = Buffer.concat(files.map(function (f) { return f.data; })),
    pieces = [];
  for (var i = 0; i < all.length; i += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(all.slice(i, i + pieceLength)).digest());
  }
  var info = { name: Buffer.from(name), 'piece length': pieceLength, pieces: Buffer.concat(pieces) };
  if (specs.length === 1 && !(options && options.folder)) {
    info.length = files[0].size;
  } else {
    info.files = files.map(function (f) {
      return { length: f.size, path: f.segments.map(function (s) { return Buffer.from(s); }) };
    });
  }
  var infoHash = crypto.createHash('sha1').update(bncode.encode(info)).digest('hex');
  return {
    infoHash: infoHash,
    magnet: 'magnet:?xt=urn:btih:' + infoHash + '&dn=' + encodeURIComponent(name),
    torrentFile: bncode.encode({ info: info }),
    name: name,
    files: files.map(function (f) { return { path: f.path, size: f.size, data: f.data }; })
  };
}

function freePort() {
  return new Promise(function (resolve) {
    var s = net.createServer();
    s.listen(0, '127.0.0.1', function () {
      var port = s.address().port;
      s.close(function () { resolve(port); });
    });
  });
}

// Polls `check` (sync or a Promise) until it answers something truthy
function until(check, timeoutMs, what) {
  var deadline = Date.now() + (timeoutMs || 20000);
  return new Promise(function (resolve, reject) {
    function attempt() {
      Promise.resolve().then(check).then(function (value) {
        if (value) {
          return resolve(value);
        }
        if (Date.now() > deadline) {
          return reject(new Error('timed out waiting for ' + (what || 'a condition')));
        }
        setTimeout(attempt, 50);
      }, function (err) {
        if (Date.now() > deadline) {
          return reject(err);
        }
        setTimeout(attempt, 50);
      });
    }
    attempt();
  });
}

function read(stream) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    stream.on('data', function (c) { chunks.push(c); });
    stream.on('end', function () { resolve(Buffer.concat(chunks)); });
    stream.on('error', reject);
  });
}

module.exports = { make: make, freePort: freePort, until: until, read: read };
