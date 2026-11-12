'use strict';

// The OpenSubtitles hash of a video file (docs/plugin-layer-plan.md §6): its
// size plus the 64-bit little-endian words of its first and last 64 KB,
// added modulo 2^64, as 16 hex digits. Subtitle providers match the exact
// release by it (OpenSubtitles' `moviehash`, Stremio add-ons' `videoHash`).
//
//   ofFile(path) → Promise<{ hash, size }>   (a file on disk; files under 128 KB: null)
//   compute(size, head, tail) → hex          (the first and last 64 KB as Buffers)

var fs = require('fs');

var CHUNK = 65536,
  MASK = (1n << 64n) - 1n;

function sum(buf) {
  var total = 0n;
  for (var i = 0; i + 8 <= buf.length; i += 8) {
    total = (total + buf.readBigUInt64LE(i)) & MASK;
  }
  return total;
}

function compute(size, head, tail) {
  var total = (BigInt(size) + sum(head) + sum(tail)) & MASK;
  return total.toString(16).padStart(16, '0');
}

function ofFile(file) {
  return fs.promises.open(file, 'r').then(function (fd) {
    return fd.stat().then(function (st) {
      if (st.size < CHUNK * 2) {
        return null;
      }
      var head = Buffer.alloc(CHUNK), tail = Buffer.alloc(CHUNK);
      return Promise.all([fd.read(head, 0, CHUNK, 0), fd.read(tail, 0, CHUNK, st.size - CHUNK)]).then(function () {
        return { hash: compute(st.size, head, tail), size: st.size };
      });
    }).finally(function () { return fd.close(); });
  });
}

module.exports = {
  ofFile: ofFile,
  compute: compute
};
