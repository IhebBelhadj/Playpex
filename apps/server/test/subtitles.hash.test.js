'use strict';

// The OpenSubtitles hash (docs/plugin-layer-plan.md §6, step 5): size + the
// 64-bit little-endian words of the first and last 64 KB, modulo 2^64; and
// the core's Stremio OpenSubtitles provider asking with it.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto'),
  axios = require('axios').default,
  hash = require('../lib/subtitles/hash'),
  stremio = require('../lib/subtitles/providers/stremio-opensubtitles');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-subhash-'));

test.after(function () {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The same algorithm written the long way: two 32-bit halves with carries */
function slow(buf) {
  var lo = buf.length >>> 0, hi = Math.floor(buf.length / 4294967296);
  function add(chunk) {
    for (var i = 0; i + 8 <= chunk.length; i += 8) {
      var l = lo + chunk.readUInt32LE(i);
      lo = l >>> 0;
      hi = (hi + chunk.readUInt32LE(i + 4) + Math.floor(l / 4294967296)) >>> 0;
    }
  }
  add(buf.subarray(0, 65536));
  add(buf.subarray(buf.length - 65536));
  return ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8);
}

test('a file\'s hash: size plus its first and last 64 KB, wrapping at 2^64', function () {
  var zeros = path.join(tmp, 'zeros.bin'), random = path.join(tmp, 'random.bin'), small = path.join(tmp, 'small.bin');
  fs.writeFileSync(zeros, Buffer.alloc(131072));
  var bytes = crypto.randomBytes(300000);
  fs.writeFileSync(random, bytes);
  fs.writeFileSync(small, Buffer.alloc(1000));
  var full = Buffer.alloc(65536, 0xff);
  assert.equal(hash.compute(131072, full.subarray(0, 8), Buffer.alloc(0)), '000000000001ffff', 'wraps');
  return Promise.all([hash.ofFile(zeros), hash.ofFile(random), hash.ofFile(small)]).then(function (r) {
    assert.deepEqual(r[0], { hash: '0000000000020000', size: 131072 });
    assert.deepEqual(r[1], { hash: slow(bytes), size: 300000 });
    assert.equal(r[2], null, 'under 128 KB: none');
  });
});

test('the Stremio OpenSubtitles provider asks with the file\'s hash, size and name', function (t) {
  var asked = [];
  t.mock.method(axios, 'get', function (url) {
    asked.push(url);
    return Promise.resolve({ data: { subtitles: [] } });
  });
  return stremio.search({ imdbId: 'tt0133093' }).then(function () {
    return stremio.search({ imdbId: 'tt0903747', season: 1, episode: 2, hash: '0123456789abcdef', size: 734003200, fileName: 'Show S01E02 720p.mkv' });
  }).then(function () {
    assert.deepEqual(asked, [
      'https://opensubtitles-v3.strem.io/subtitles/movie/tt0133093.json',
      'https://opensubtitles-v3.strem.io/subtitles/series/tt0903747:1:2/videoHash=0123456789abcdef&videoSize=734003200&filename=Show%20S01E02%20720p.mkv.json'
    ]);
  });
});
