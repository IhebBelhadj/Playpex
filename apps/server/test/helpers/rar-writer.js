'use strict';

// Stored (uncompressed) RAR archives for tests of lib/media/archive.js, in
// RAR 4 or RAR 5, split into volumes of about `volumeBytes` (there is no free
// rar maker to call; `unrar t` checks what this writes, CRCs included).
//
//   write(files: [{ name, bytes }], { version: 4 | 5, volumeBytes, compressed }) → [Buffer] (the volumes, in order)
//     compressed: the headers say "compressed" (the bytes stay as they are: for refusals only)

var zlib = require('zlib');

function crc(buf) {
  return zlib.crc32(buf) >>> 0;
}

function u16(n) { var b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function vint(n) {
  var out = [];
  do {
    var byte = n % 128;
    n = Math.floor(n / 128);
    out.push(n ? byte | 0x80 : byte);
  } while (n);
  return Buffer.from(out);
}

// ── RAR 4 ───────────────────────────────────────────────────────────────────

var SIG4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

function block4(type, flags, body) {
  var rest = Buffer.concat([Buffer.from([type]), u16(flags), u16(7 + body.length), body]);
  return Buffer.concat([u16(crc(rest) & 0xffff), rest]);
}

function file4(name, total, part, crc32, before, after, compressed) {
  var nameBytes = Buffer.from(name, 'latin1'),
    flags = 0x8000 | (before ? 0x01 : 0) | (after ? 0x02 : 0),
    body = Buffer.concat([
      u32(part.length), u32(total), Buffer.from([2]), u32(crc32), u32(0x5a210000),
      Buffer.from([29, compressed ? 0x33 : 0x30]), u16(nameBytes.length), u32(0x20), nameBytes
    ]);
  return Buffer.concat([block4(0x74, flags, body), part]);
}

// ── RAR 5 ───────────────────────────────────────────────────────────────────

var SIG5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

function header5(fields) {
  var data = Buffer.concat(fields), size = vint(data.length);
  return Buffer.concat([u32(crc(Buffer.concat([size, data]))), size, data]);
}

function file5(name, total, part, crc32, before, after, compressed) {
  var nameBytes = Buffer.from(name, 'utf8'),
    flags = 0x02 | (before ? 0x08 : 0) | (after ? 0x10 : 0);
  return Buffer.concat([header5([
    vint(2), vint(flags), vint(part.length),
    vint(0x04), vint(total), vint(0x20), u32(crc32),   // file flags: CRC32 present; size; attributes
    vint(compressed ? 3 << 7 : 0), vint(0), vint(nameBytes.length), nameBytes   // stored (or method 3), Windows, the name
  ]), part]);
}

/**
 * Each file's data is cut so a volume holds about volumeBytes; a split part's
 * CRC is of its own bytes, the last part's of the whole file (as rar does)
 */
function write(files, options) {
  options = options || {};
  var v5 = options.version === 5, size = options.volumeBytes || 1e12,
    volumes = [], current = [], room = size;
  var pieces = [];
  files.forEach(function (f) {
    for (var at = 0; at < f.bytes.length || (at === 0 && !f.bytes.length);) {
      var take = Math.max(1, Math.min(f.bytes.length - at, room));
      pieces.push({ file: f, start: at, end: at + take, volume: volumes.length + (current.length ? 0 : 0) });
      at += take;
      room -= take;
      if (room <= 0 && (at < f.bytes.length)) {
        volumes.push(current = { pieces: pieces.splice(0) });
        current = [];
        room = size;
      }
      if (!f.bytes.length) {
        break;
      }
    }
  });
  volumes.push({ pieces: pieces.splice(0) });
  return volumes.map(function (vol, i) {
    var last = i === volumes.length - 1, parts = [];
    if (v5) {
      var archiveFlags = (volumes.length > 1 ? 0x01 : 0) | (i > 0 ? 0x02 : 0);
      parts.push(SIG5, header5([vint(1), vint(0), vint(archiveFlags)].concat(i > 0 ? [vint(i)] : [])));
    } else {
      var mainFlags = volumes.length > 1 ? 0x0001 | 0x0010 | (i === 0 ? 0x0100 : 0) : 0;
      parts.push(SIG4, block4(0x73, mainFlags, Buffer.concat([u16(0), u32(0)])));
    }
    vol.pieces.forEach(function (p) {
      var bytes = p.file.bytes.subarray(p.start, p.end),
        before = p.start > 0, after = p.end < p.file.bytes.length,
        sum = after ? crc(bytes) : crc(p.file.bytes);
      parts.push((v5 ? file5 : file4)(p.file.name, p.file.bytes.length, bytes, sum, before, after, !!options.compressed));
    });
    if (v5) {
      parts.push(header5([vint(5), vint(0), vint(last ? 0 : 0x01)]));
    } else {
      parts.push(block4(0x7b, last ? 0x4000 : 0x4001, Buffer.alloc(0)));
    }
    return Buffer.concat(parts);
  });
}

module.exports = { write: write };
