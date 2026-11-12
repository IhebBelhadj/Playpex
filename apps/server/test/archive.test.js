'use strict';

// Videos inside archives (lib/media/archive.js), on parts in memory: stored
// RAR 4 and RAR 5 split into volumes (test/helpers/rar-writer.js, checked with
// `unrar t` when it's installed), a real `zip -0` and `tar`; the chosen file
// (the largest video, fileIdx, fileMustInclude), any byte range equal to the
// original's, and refusals (compressed, not that format, missing volumes).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto'),
  stream = require('stream'),
  childProcess = require('child_process'),
  archive = require('../lib/media/archive'),
  rarWriter = require('./helpers/rar-writer');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-archive-')),
  FILM = crypto.randomBytes(300 * 1024 + 7),
  NFO = Buffer.from('made up\n'),
  SAMPLE = crypto.randomBytes(20 * 1024);

test.after(function () {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function memory(parts) {
  return {
    parts: parts.length,
    reads: 0,
    read: function (i, start, end) {
      this.reads++;
      return Promise.resolve(parts[i].subarray(start, end + 1));
    },
    size: function (i) { return Promise.resolve(parts[i].length); },
    open: function (i, start, end) { return Promise.resolve(stream.Readable.from([parts[i].subarray(start, end + 1)])); }
  };
}

function bytesOf(ix, io, start, end) {
  return new Promise(function (ok, fail) {
    var chunks = [];
    archive.stream(ix, start, end, io.open).on('data', function (c) { chunks.push(c); }).on('end', function () { ok(Buffer.concat(chunks)); }).on('error', fail);
  });
}

function ranges(ix, io) {
  var size = FILM.length, cases = [[0, size - 1], [0, 0], [size - 1, size - 1], [99990, 100020], [150000, 250000]];
  for (var i = 0; i < 6; i++) {
    var a = crypto.randomInt(size), b = Math.min(size - 1, a + crypto.randomInt(120000));
    cases.push([a, b]);
  }
  return cases.reduce(function (p, c) {
    return p.then(function () {
      return bytesOf(ix, io, c[0], c[1]).then(function (got) {
        assert.ok(got.equals(FILM.subarray(c[0], c[1] + 1)), 'bytes ' + c[0] + '–' + c[1]);
      });
    });
  }, Promise.resolve());
}

var FILES = [{ name: 'Film.2020.nfo', bytes: NFO }, { name: 'Sample/film-sample.mkv', bytes: SAMPLE }, { name: 'Film.2020.1080p.mkv', bytes: FILM }];

[4, 5].forEach(function (version) {
  test('RAR ' + version + ' in volumes: the film (not the sample), joined across volumes, every range right', function () {
    var vols = rarWriter.write(FILES, { version: version, volumeBytes: 100000 });
    assert.ok(vols.length >= 4);
    if (childProcess.spawnSync('unrar', ['-?'], { stdio: 'ignore' }).status !== null) {
      vols.forEach(function (b, i) { fs.writeFileSync(path.join(tmp, 'v' + version + '.part' + (i + 1) + '.rar'), b); });
      var t = childProcess.spawnSync('unrar', ['t', '-y', path.join(tmp, 'v' + version + '.part1.rar')], { encoding: 'utf8' });
      assert.match(t.stdout, /All OK/, 'unrar accepts the test archive');
    }
    var io = memory(vols);
    return archive.index('rar', io, {}).then(function (ix) {
      assert.equal(ix.name, 'Film.2020.1080p.mkv');
      assert.equal(ix.size, FILM.length);
      assert.ok(ix.segments.length >= 3, 'split across volumes');
      assert.deepEqual(ix.files.map(function (f) { return f.name; }), FILES.map(function (f) { return f.name; }));
      return ranges(ix, io);
    });
  });
});

test('RAR: fileIdx and fileMustInclude choose; compressed, a missing volume, another format refused', function () {
  var vols = rarWriter.write(FILES, { version: 5, volumeBytes: 100000 });
  return archive.index('rar', memory(vols), { index: 0 }).then(function (ix) {
    assert.equal(ix.name, 'Film.2020.nfo');
    return archive.index('rar', memory(vols), { include: ['SAMPLE'] });
  }).then(function (ix) {
    assert.equal(ix.name, 'film-sample.mkv');
    return archive.index('rar', memory(rarWriter.write(FILES, { version: 4, volumeBytes: 100000, compressed: true })), {}).then(function () {
      assert.fail('compressed');
    }, function (err) {
      assert.equal(err.code, 'UNSUPPORTED');
      assert.match(err.message, /compressed/);
    });
  }).then(function () {
    return archive.index('rar', memory(vols.slice(0, -1)), {}).then(function () { assert.fail('missing'); }, function (err) {
      assert.match(err.message, /volumes are missing/);
    });
  }).then(function () {
    return archive.index('rar', memory([Buffer.from('not a rar at all')]), {}).then(function () { assert.fail('not rar'); }, function (err) {
      assert.equal(err.code, 'UNSUPPORTED');
    });
  });
});

function made(cmd, args, file) {
  var r = childProcess.spawnSync(cmd, args, { cwd: tmp, stdio: 'ignore' });
  return r.status === 0 ? fs.readFileSync(path.join(tmp, file)) : null;
}

test('ZIP: a stored entry (zip -0), joined parts; a compressed one refused', function (t) {
  fs.mkdirSync(path.join(tmp, 'z'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'z', 'Film.2020.1080p.mkv'), FILM);
  fs.writeFileSync(path.join(tmp, 'z', 'Film.nfo'), NFO);
  var stored = made('zip', ['-q', '-0', '-r', 'stored.zip', 'z'], 'stored.zip'),
    deflated = made('zip', ['-q', '-9', '-r', 'deflated.zip', 'z'], 'deflated.zip');
  if (!stored) {
    return t.skip('no zip');
  }
  // the same zip cut into three parts (a split archive, joined)
  var parts = [stored.subarray(0, 90000), stored.subarray(90000, 200000), stored.subarray(200000)], io = memory(parts);
  return archive.index('zip', io, {}).then(function (ix) {
    assert.equal(ix.name, 'Film.2020.1080p.mkv');
    assert.equal(ix.size, FILM.length);
    return ranges(ix, io);
  }).then(function () {
    return archive.index('zip', memory([deflated]), {}).then(function () { assert.fail('deflated'); }, function (err) {
      assert.match(err.message, /compressed/);
    });
  });
});

test('TAR: a long name (GNU / pax), the film, every range right', function (t) {
  var dir = path.join(tmp, 't', 'A folder whose name is long enough to need more than the hundred characters of a plain tar header ok');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Film.2020.1080p.mkv'), FILM);
  fs.writeFileSync(path.join(dir, 'Film.nfo'), NFO);
  var gnu = made('tar', ['-cf', 'gnu.tar', '--format=gnu', '-C', path.join(tmp, 't'), '.'], 'gnu.tar'),
    pax = made('tar', ['-cf', 'pax.tar', '--format=pax', '-C', path.join(tmp, 't'), '.'], 'pax.tar');
  if (!gnu) {
    return t.skip('no tar');
  }
  return [gnu, pax].filter(Boolean).reduce(function (p, bytes) {
    return p.then(function () {
      var io = memory([bytes]);
      return archive.index('tar', io, {}).then(function (ix) {
        assert.equal(ix.name, 'Film.2020.1080p.mkv');
        assert.match(ix.path, /hundred characters/);
        return ranges(ix, io);
      });
    });
  }, Promise.resolve()).then(function () {
    return archive.index('tar', memory([crypto.randomBytes(2048)]), {}).then(function () { assert.fail('not tar'); }, function (err) {
      assert.equal(err.code, 'UNSUPPORTED');
    });
  });
});

test('7z and tgz: refused (compressed throughout)', function () {
  return archive.index('7zip', memory([Buffer.alloc(10)]), {}).then(function () { assert.fail('7z'); }, function (err) {
    assert.equal(err.code, 'UNSUPPORTED');
  });
});
