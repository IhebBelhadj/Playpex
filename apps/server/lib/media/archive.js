'use strict';

// A video inside an archive on the web, streamed with ranges (a Stremio
// add-on's rarUrls / zipUrls / tarUrls, docs/stremio-bridge-plan.md step 8):
// only archives whose video is *stored* (no compression) can be seeked, which
// is how scene releases pack them. The archive's headers are read with a few
// ranges, then the file is a list of byte ranges of the parts:
//
//   rar  RAR 4 and RAR 5, one or several volumes (.rar, .r00 …, .partN.rar), in the order given;
//        a file split across volumes is joined; encrypted or compressed ones refused
//   zip  stored entries (method 0), zip64, the parts joined into one (a split zip)
//   tar  plain tar (ustar, GNU long names, pax paths), the parts joined into one
//
//   index(format, io, choose) → Promise<{ name, size, segments: [{ part, offset, length }], files }>
//     io: { parts: n, read(part, start, end) → Promise<Buffer> (inclusive), size(part) → Promise<number> }
//     choose: { index?, include?: [string] } (Stremio's fileIdx / fileMustInclude), else the largest video
//   stream(index, start, end, open(part, start, end) → Promise<Readable>) → Readable   bytes start…end of the file
//
// Errors: UNSUPPORTED (compressed, encrypted, not that format), NOT_FOUND (no such file), UPSTREAM (a part failed).

var stream = require('stream');

var VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|ogv)$/i,
  READ = 64 * 1024,
  BLOCKS_MAX = 400,
  FILES_MAX = 1000;

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// ── choosing the file ───────────────────────────────────────────────────────

function choose(files, how) {
  how = how || {};
  var usable = files.filter(function (f) { return f.size > 0 && !f.directory; });
  if (how.include && how.include.length) {
    var hit = usable.filter(function (f) {
      return how.include.some(function (s) { return String(f.name).toLowerCase().indexOf(String(s).toLowerCase()) !== -1; });
    })[0];
    if (hit) {
      return hit;
    }
  }
  if (typeof how.index === 'number' && files[how.index] && files[how.index].size > 0) {
    return files[how.index];
  }
  var videos = usable.filter(function (f) { return VIDEO.test(f.name) && !/(^|[\\/._ -])sample([\\/._ -]|$)/i.test(f.name); });
  var pool = videos.length ? videos : usable;
  pool.sort(function (a, b) { return b.size - a.size; });
  if (!pool[0]) {
    throw failure('NOT_FOUND', 'the archive holds no file to play');
  }
  return pool[0];
}

// ── joined parts (zip, tar): one address space over the parts ──────────────

function joined(io) {
  var sizes = null;
  function layout() {
    if (sizes) {
      return Promise.resolve(sizes);
    }
    var all = [];
    for (var i = 0; i < io.parts; i++) {
      all.push(io.size(i));
    }
    return Promise.all(all).then(function (s) {
      sizes = s;
      return s;
    });
  }
  /** joined offsets [start, end] → [{ part, offset, length }] */
  function map(start, end) {
    var out = [], base = 0;
    sizes.forEach(function (size, part) {
      var s = Math.max(start, base), e = Math.min(end, base + size - 1);
      if (s <= e) {
        out.push({ part: part, offset: s - base, length: e - s + 1 });
      }
      base += size;
    });
    return out;
  }
  function read(start, end) {
    var pieces = map(start, end);
    return Promise.all(pieces.map(function (p) { return io.read(p.part, p.offset, p.offset + p.length - 1); })).then(Buffer.concat);
  }
  return {
    layout: layout,
    map: map,
    read: read,
    total: function () { return sizes.reduce(function (a, b) { return a + b; }, 0); }
  };
}

// ── tar ─────────────────────────────────────────────────────────────────────

function octal(buf, start, length) {
  // GNU base-256 for large sizes
  if (buf[start] & 0x80) {
    var n = 0;
    for (var i = start + 1; i < start + length; i++) {
      n = n * 256 + buf[i];
    }
    return n;
  }
  var s = buf.toString('ascii', start, start + length).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function cstring(buf, start, length) {
  return buf.toString('utf8', start, start + length).replace(/\0.*$/s, '');
}

function tar(io) {
  var j = joined(io);
  return j.layout().then(function () {
    var total = j.total(), files = [], offset = 0, longName = null, blocks = 0;
    function next() {
      if (offset + 512 > total || blocks++ > FILES_MAX * 2) {
        return Promise.resolve(files);
      }
      return j.read(offset, offset + 511).then(function (h) {
        if (h.every(function (b) { return b === 0; })) {
          return files;
        }
        // its checksum: the header's bytes summed with the checksum field as spaces
        var sum = 0;
        for (var k = 0; k < 512; k++) {
          sum += k >= 148 && k < 156 ? 32 : h[k];
        }
        if (octal(h, 148, 8) !== sum) {
          throw failure('UNSUPPORTED', offset === 0 ? 'not a tar archive' : 'a broken tar archive');
        }
        var size = octal(h, 124, 12), type = String.fromCharCode(h[156] || 48),
          name = cstring(h, 0, 100), prefix = h.toString('ascii', 257, 262) === 'ustar' ? cstring(h, 345, 155) : '',
          data = offset + 512;
        if (!isFinite(size) || size < 0) {
          throw failure('UNSUPPORTED', 'not a tar archive');
        }
        offset = data + Math.ceil(size / 512) * 512;
        if (type === 'L' || type === 'x') {
          // GNU long name / pax header: what the next entry is called
          return j.read(data, data + Math.min(size, 65536) - 1).then(function (b) {
            var text = b.toString('utf8');
            longName = type === 'L' ? text.replace(/\0.*$/s, '') : ((/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text) || [])[1] || longName);
            return next();
          });
        }
        if (type === '0' || type === '\0' || type === '7') {
          files.push({ name: longName || (prefix ? prefix + '/' + name : name), size: size, segments: [{ joined: data, length: size }] });
        }
        longName = null;
        return files.length >= FILES_MAX ? files : next();
      });
    }
    return next().then(function (list) {
      return { files: list, map: function (f) { return j.map(f.segments[0].joined, f.segments[0].joined + f.size - 1); } };
    });
  });
}

// ── zip ─────────────────────────────────────────────────────────────────────

function u64(buf, at) {
  return buf.readUInt32LE(at) + buf.readUInt32LE(at + 4) * 0x100000000;
}

function zip(io) {
  var j = joined(io);
  return j.layout().then(function () {
    var total = j.total(), tail = Math.min(total, 65557 + 20);
    return j.read(total - tail, total - 1).then(function (end) {
      var at = -1;
      for (var i = end.length - 22; i >= 0; i--) {
        if (end.readUInt32LE(i) === 0x06054b50) {
          at = i;
          break;
        }
      }
      if (at < 0) {
        throw failure('UNSUPPORTED', 'not a zip archive');
      }
      var count = end.readUInt16LE(at + 10), cdSize = end.readUInt32LE(at + 12), cdOffset = end.readUInt32LE(at + 16);
      var zip64 = at >= 20 && end.readUInt32LE(at - 20) === 0x07064b50 ? u64(end, at - 20 + 8) : null;
      var eocd = zip64 !== null ? j.read(zip64, zip64 + 55).then(function (z) {
        if (z.readUInt32LE(0) !== 0x06064b50) {
          throw failure('UNSUPPORTED', 'a broken zip64 archive');
        }
        return { count: u64(z, 32), size: u64(z, 40), offset: u64(z, 48) };
      }) : Promise.resolve({ count: count, size: cdSize, offset: cdOffset });
      return eocd;
    }).then(function (cd) {
      if (cd.size > 16 * 1024 * 1024) {
        throw failure('UNSUPPORTED', 'a zip archive with too many files');
      }
      return j.read(cd.offset, cd.offset + cd.size - 1).then(function (dir) {
        var files = [], p = 0;
        while (p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50 && files.length < FILES_MAX) {
          var flags = dir.readUInt16LE(p + 8), method = dir.readUInt16LE(p + 10),
            csize = dir.readUInt32LE(p + 20), usize = dir.readUInt32LE(p + 24),
            nameLen = dir.readUInt16LE(p + 28), extraLen = dir.readUInt16LE(p + 30), commentLen = dir.readUInt16LE(p + 32),
            local = dir.readUInt32LE(p + 42),
            name = dir.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
            extra = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
          // zip64 sizes and offset, in that order, for the fields that overflowed
          for (var e = 0; e + 4 <= extra.length;) {
            var id = extra.readUInt16LE(e), len = extra.readUInt16LE(e + 2), q = e + 4;
            if (id === 0x0001) {
              if (usize === 0xffffffff) { usize = u64(extra, q); q += 8; }
              if (csize === 0xffffffff) { csize = u64(extra, q); q += 8; }
              if (local === 0xffffffff) { local = u64(extra, q); q += 8; }
            }
            e += 4 + len;
          }
          files.push({ name: name, size: usize, packed: csize, method: method, encrypted: !!(flags & 1), local: local, directory: /\/$/.test(name) });
          p += 46 + nameLen + extraLen + commentLen;
        }
        return {
          files: files,
          resolve: function (f) {
            if (f.encrypted) {
              throw failure('UNSUPPORTED', f.name + ' is encrypted');
            }
            if (f.method !== 0 || f.packed !== f.size) {
              throw failure('UNSUPPORTED', f.name + ' is compressed in the zip: only stored files can be streamed');
            }
            return j.read(f.local, f.local + 29).then(function (h) {
              if (h.readUInt32LE(0) !== 0x04034b50) {
                throw failure('UNSUPPORTED', 'a broken zip archive');
              }
              var data = f.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
              return j.map(data, data + f.size - 1);
            });
          }
        };
      });
    });
  });
}

// ── rar ─────────────────────────────────────────────────────────────────────

var RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
  RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/** A reader of one volume that reads ahead in windows */
function windowed(io, part) {
  var cache = null;
  return function (start, length) {
    if (cache && start >= cache.start && start + length <= cache.start + cache.bytes.length) {
      return Promise.resolve(cache.bytes.subarray(start - cache.start, start - cache.start + length));
    }
    return io.read(part, start, start + Math.max(length, READ) - 1).then(function (b) {
      cache = { start: start, bytes: b };
      if (b.length < length) {
        throw failure('UNSUPPORTED', 'a rar volume ends inside a header');
      }
      return b.subarray(0, length);
    });
  };
}

function vint(buf, at) {
  var value = 0, mul = 1, i = at;
  for (; i < buf.length && i < at + 10; i++) {
    value += (buf[i] & 0x7f) * mul;
    mul *= 128;
    if (!(buf[i] & 0x80)) {
      return { value: value, length: i - at + 1 };
    }
  }
  throw failure('UNSUPPORTED', 'a broken rar header');
}

/** One RAR 4 volume's file blocks: [{ name, size (unpacked), offset, length, before, after }] */
function rar4Volume(read, volume) {
  var at = RAR4.length, out = [], blocks = 0;
  function block() {
    if (blocks++ > BLOCKS_MAX) {
      return Promise.resolve(out);
    }
    return read(at, 7).then(function (h) {
      var type = h[2], flags = h.readUInt16LE(3), size = h.readUInt16LE(5);
      if (size < 7) {
        throw failure('UNSUPPORTED', 'a broken rar header');
      }
      if (type === 0x7b) {
        return out;   // end of archive
      }
      return read(at, size).then(function (full) {
        var add = flags & 0x8000 ? full.readUInt32LE(7) : 0, start = at;
        if (type === 0x73 && flags & 0x0080) {
          throw failure('UNSUPPORTED', 'the rar archive is encrypted');
        }
        if (type === 0x74) {
          var high = flags & 0x100, pack = full.readUInt32LE(7) + (high ? full.readUInt32LE(32) * 0x100000000 : 0),
            unp = full.readUInt32LE(11) + (high ? full.readUInt32LE(36) * 0x100000000 : 0),
            method = full[25], nameLen = full.readUInt16LE(26), nameAt = 32 + (high ? 8 : 0),
            raw = full.subarray(nameAt, nameAt + nameLen),
            zero = raw.indexOf(0);
          var name = (zero >= 0 ? raw.subarray(0, zero) : raw).toString(flags & 0x200 ? 'utf8' : 'latin1');
          out.push({
            name: name, size: unp, offset: start + size, length: pack, before: !!(flags & 0x01), after: !!(flags & 0x02),
            stored: method === 0x30, encrypted: !!(flags & 0x04), directory: (flags & 0xe0) === 0xe0, volume: volume
          });
          at = start + size + pack;
        } else {
          at = start + size + add;
        }
        return block();
      });
    }, function (err) {
      // a volume cut short after its last file (no end block): what was read is what it has
      if (out.length && err.code === 'UNSUPPORTED' && /inside a header/.test(err.message)) {
        return out;
      }
      throw err;
    });
  }
  return block();
}

/** One RAR 5 volume's file blocks */
function rar5Volume(read, volume) {
  var at = RAR5.length, out = [], blocks = 0;
  function block() {
    if (blocks++ > BLOCKS_MAX) {
      return Promise.resolve(out);
    }
    return read(at, 4 + 3).then(function (head) {
      var hs = vint(head, 4), headerStart = at + 4 + hs.length, headerSize = hs.value;
      if (headerSize < 2 || headerSize > 2 * 1024 * 1024) {
        throw failure('UNSUPPORTED', 'a broken rar header');
      }
      return read(headerStart, headerSize).then(function (h) {
        var p = 0, type = vint(h, p); p += type.length;
        var flags = vint(h, p); p += flags.length;
        var extraSize = 0, dataSize = 0;
        if (flags.value & 0x01) { var x = vint(h, p); extraSize = x.value; p += x.length; }
        if (flags.value & 0x02) { var d = vint(h, p); dataSize = d.value; p += d.length; }
        var dataAt = headerStart + headerSize;
        if (type.value === 4) {
          throw failure('UNSUPPORTED', 'the rar archive is encrypted');
        }
        if (type.value === 5) {
          return out;   // end of archive
        }
        if (type.value === 2) {
          var ff = vint(h, p); p += ff.length;
          var unp = vint(h, p); p += unp.length;
          var attr = vint(h, p); p += attr.length;
          if (ff.value & 0x02) { p += 4; }   // mtime
          if (ff.value & 0x04) { p += 4; }   // CRC32
          var comp = vint(h, p); p += comp.length;
          var os = vint(h, p); p += os.length;
          var nl = vint(h, p); p += nl.length;
          var name = h.toString('utf8', p, p + nl.value);
          p += nl.value;
          // extra records: encryption (type 1) refused
          var encrypted = false, e = p, endExtra = p + extraSize;
          while (e < endExtra) {
            var rs = vint(h, e), rt = vint(h, e + rs.length);
            if (rt.value === 1) {
              encrypted = true;
            }
            e += rs.length + rs.value;
          }
          out.push({
            name: name, size: unp.value, offset: dataAt, length: dataSize, before: !!(flags.value & 0x08), after: !!(flags.value & 0x10),
            stored: ((comp.value >> 7) & 0x0f) === 0, encrypted: encrypted, directory: !!(ff.value & 0x01), volume: volume
          });
          void attr;
          void os;
        }
        at = dataAt + dataSize;
        return block();
      });
    }).catch(function (err) {
      if (out.length && err.code === 'UNSUPPORTED' && /inside a header/.test(err.message)) {
        return out;
      }
      throw err;
    });
  }
  return block();
}

function rar(io) {
  return io.read(0, 0, 7).then(function (sig) {
    var five = sig.length >= 8 && sig.equals(RAR5), four = !five && sig.subarray(0, 7).equals(RAR4);
    if (!five && !four) {
      throw failure('UNSUPPORTED', 'not a rar archive');
    }
    var volumes = [];
    for (var v = 0; v < io.parts; v++) {
      volumes.push(v);
    }
    // a few volumes at a time: each needs a range or two
    var results = new Array(volumes.length), next = 0;
    function worker() {
      var v = next++;
      if (v >= volumes.length) {
        return Promise.resolve();
      }
      var read = windowed(io, v);
      return (v === 0 ? Promise.resolve(sig) : read(0, 8)).then(function (s) {
        if (!(five ? s.subarray(0, 8).equals(RAR5) : s.subarray(0, 7).equals(RAR4))) {
          throw failure('UNSUPPORTED', 'part ' + (v + 1) + ' isn\'t a volume of this rar archive');
        }
        return five ? rar5Volume(read, v) : rar4Volume(read, v);
      }).then(function (blocks) {
        results[v] = blocks;
        return worker();
      });
    }
    return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
      // each file: its first block (not continued from before) and the blocks that continue it
      var files = [], open = {};
      results.forEach(function (blocks) {
        blocks.forEach(function (b) {
          var f = open[b.name];
          if (b.before && f) {
            f.segments.push({ part: b.volume, offset: b.offset, length: b.length });
          } else if (!b.before) {
            f = { name: b.name, size: b.size, stored: b.stored, encrypted: b.encrypted, directory: b.directory, segments: [{ part: b.volume, offset: b.offset, length: b.length }] };
            files.push(f);
            open[b.name] = f;
          }
          if (!b.after) {
            delete open[b.name];
          }
        });
      });
      return {
        files: files.slice(0, FILES_MAX),
        resolve: function (f) {
          if (f.encrypted) {
            throw failure('UNSUPPORTED', f.name + ' is encrypted');
          }
          if (!f.stored) {
            throw failure('UNSUPPORTED', f.name + ' is compressed in the rar: only stored files can be streamed');
          }
          var have = f.segments.reduce(function (n, s) { return n + s.length; }, 0);
          if (have !== f.size) {
            throw failure('UNSUPPORTED', f.name + ': ' + (have < f.size ? 'volumes are missing' : 'its parts don\'t add up'));
          }
          return f.segments;
        }
      };
    });
  });
}

// ── index and stream ────────────────────────────────────────────────────────

function index(format, io, how) {
  var reader = format === 'rar' ? rar(io) : format === 'zip' ? zip(io) : format === 'tar' ? tar(io) :
    Promise.reject(failure('UNSUPPORTED', 'archives of type ' + format + ' can\'t be streamed'));
  return reader.then(function (r) {
    var listed = r.files.map(function (f) { return { name: f.name, size: f.size, directory: !!f.directory }; }),
      chosen = choose(r.files, how);
    return Promise.resolve(r.resolve ? r.resolve(chosen) : r.map(chosen)).then(function (segments) {
      return { name: chosen.name.split(/[\\/]/).pop(), path: chosen.name, size: chosen.size, segments: segments, files: listed };
    });
  });
}

/** Bytes start…end (inclusive) of the indexed file, part after part */
function streamRange(ix, start, end, open) {
  var pieces = [], base = 0;
  ix.segments.forEach(function (s) {
    var a = Math.max(start, base), b = Math.min(end, base + s.length - 1);
    if (a <= b) {
      pieces.push({ part: s.part, start: s.offset + (a - base), end: s.offset + (b - base) });
    }
    base += s.length;
  });
  var out = new stream.PassThrough(), current = null, stopped = false;
  out.on('close', function () {
    stopped = true;
    if (current) {
      current.destroy();
    }
  });
  (function next(i) {
    if (stopped) {
      return;
    }
    if (i >= pieces.length) {
      out.end();
      return;
    }
    open(pieces[i].part, pieces[i].start, pieces[i].end).then(function (body) {
      current = body;
      body.on('error', function (err) { out.destroy(err); });
      body.on('end', function () {
        current = null;
        next(i + 1);
      });
      body.pipe(out, { end: false });
    }, function (err) {
      out.destroy(err);
    });
  })(0);
  return out;
}

module.exports = {
  index: index,
  stream: streamRange,
  FORMATS: ['rar', 'zip', 'tar']
};
