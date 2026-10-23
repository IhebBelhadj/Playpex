'use strict';

// Media refs (docs/media-server-plan.md §5.4, step 3): /media/{ref} for a
// torrent's file (fake engine and seeder, offline) and for a file of a library
// folder; the torrent routes as aliases; leases on both; path safety (a row's
// path can't leave its folder, symlinks included); adults-only folders and
// kids profiles; ffprobe / ffmpeg on a disk file with AC-3 audio (skipped
// without ffmpeg), and a finished download read from its path.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  childProcess = require('child_process');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-media-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  sessions = require('../lib/sessions'),
  torrents = require('../lib/torrents/client'),
  media = require('../lib/media'),
  userData = require('../lib/userData'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var seedDir = path.join(tmp, 'seed'),
  libraryDir = path.join(tmp, 'library', 'Movies'),
  adultDir = path.join(tmp, 'library', 'Adults'),
  outside = path.join(tmp, 'outside.mkv'),
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } },
  seeder = engines.create('fake'),
  base = null,
  movie = helpers.make(seedDir, 'Movie.2020', [{ path: 'movie.mkv', size: 2000000 }, { path: 'extra.mkv', size: 300000 }]),
  diskData = Buffer.alloc(500000, 7),
  FFMPEG = childProcess.spawnSync('ffmpeg', ['-version']).status === 0;

function call(method, apiPath, body, headers) {
  var payload = body === undefined ? null : JSON.stringify(body);
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {}, headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw: raw,
          body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The first `bytes` of a response that doesn't end (a live transcode)
function head(apiPath, bytes) {
  return new Promise(function (resolve, reject) {
    var req = http.get(new URL('/api/v1' + apiPath, base), { headers: { 'X-Playpex-Device': 'tv-1' } }, function (res) {
      var chunks = [], got = 0;
      res.on('data', function (c) {
        chunks.push(c);
        got += c.length;
        if (got >= bytes) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) });
        }
      });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }); });
    });
    req.on('error', function (err) { if (err.code !== 'ECONNRESET') { reject(err); } });
  });
}

function library() {
  return userData.services().then(function (s) { return s.library; });
}

function sessionsOf(device) {
  return sessions.list().filter(function (s) { return s.deviceId === device; });
}

test.before(function () {
  fs.mkdirSync(path.join(libraryDir, 'Movie (2020)'), { recursive: true });
  fs.mkdirSync(adultDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'Movie (2020)', 'movie.mkv'), diskData);
  fs.writeFileSync(path.join(adultDir, 'film.mkv'), diskData);
  fs.writeFileSync(outside, diskData);
  fs.symlinkSync(outside, path.join(libraryDir, 'escape.mkv'));

  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return seeder.add({ infoHash: movie.infoHash, torrentFile: movie.torrentFile, savePath: seedDir });
  }).then(function () {
    return server.start(OPTIONS);
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    sessions.configure({ graceMs: 200 });
  });
});

test.after(function () {
  return server.stop().then(function () {
    return seeder.close();
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('refs: the format, parsed back', function () {
  var hash = movie.infoHash, ref = media.refs.torrent(hash.toUpperCase(), 'a/b.mkv');
  assert.match(ref, /^t_[0-9a-f]{40}_[0-9a-f]{16}$/);
  assert.deepEqual(media.refs.parse(ref), { kind: 'torrent', infoHash: hash, pathHash: media.refs.pathHash('a/b.mkv') });
  assert.deepEqual(media.refs.parse('f_0b9d4f2e-6a3c-4c8e-9f1a-2b3c4d5e6f70'), { kind: 'file', id: '0b9d4f2e-6a3c-4c8e-9f1a-2b3c4d5e6f70' });
  ['', 'x', 't_' + hash, 'f_../../etc/passwd', 'f_' + hash, null].forEach(function (bad) {
    assert.equal(media.refs.parse(bad), null, String(bad));
  });
});

test('a torrent file by its ref: streams, the alias still works, the lease is the torrent\'s', function () {
  var hash = movie.infoHash, file = movie.files[0], ref;
  return call('POST', '/torrents', { link: movie.magnet }).then(function (res) {
    assert.equal(res.status, 200);
    return helpers.until(function () {
      return call('GET', '/torrents/' + hash).then(function (r) { return r.body.files && r.body; });
    }, 10000, 'the files');
  }).then(function (t) {
    var f = t.files.filter(function (x) { return x.path === file.path; })[0];
    ref = f.ref;
    assert.equal(ref, media.refs.torrent(hash, file.path));
    return call('GET', '/media/' + ref, undefined, { Range: 'bytes=100-1099' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 100-1099/' + file.size);
    assert.ok(res.raw.equals(file.data.slice(100, 1100)));
    return call('HEAD', '/media/' + ref);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(file.size));
    return call('GET', '/torrents/' + hash + '/files/' + encodeURIComponent(file.path), undefined, { Range: 'bytes=0-99' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.ok(res.raw.equals(file.data.slice(0, 100)));
    var mine = sessionsOf('tv-1');
    assert.equal(mine.length, 1, 'one lease for the torrent, whatever the route');
    assert.equal(mine[0].infoHash, hash);
    assert.equal(mine[0].ref, ref);
    return call('GET', '/downloads/' + hash);
  }).then(function (res) {
    assert.equal(res.body.files.filter(function (f) { return f.path === file.path; })[0].ref, ref);
    return call('POST', '/media/' + ref + '/keepalive', { positionS: 5, durationS: 100, profileId: 'p1' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return call('DELETE', '/media/' + ref);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(sessionsOf('tv-1').length, 0);
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash).then(function (r) {
        return ['paused', 'completed'].indexOf(r.body.state) !== -1 && r.body;
      });
    }, 10000, 'the torrent paused');
  }).then(function () {
    return Promise.all([
      call('GET', '/media/' + media.refs.torrent(hash, 'nope.mkv')),
      call('GET', '/media/' + media.refs.torrent('f'.repeat(40), file.path)),
      call('GET', '/media/not-a-ref'),
      call('GET', '/media/f_00000000-0000-0000-0000-000000000000')
    ]);
  }).then(function (answers) {
    answers.forEach(function (res) {
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NOT_FOUND');
    });
  });
});

test('a library file by its ref: ranges, whole file, its own lease', function () {
  var ref;
  return library().then(function (lib) {
    return lib.addFolder({ path: libraryDir, kind: 'movies' }).then(function (folder) {
      return lib.addFile(folder.id, { relPath: 'Movie (2020)/movie.mkv', size: diskData.length });
    });
  }).then(function (row) {
    ref = 'f_' + row.id;
    return call('GET', '/media/' + ref, undefined, { Range: 'bytes=1000-1999' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 1000-1999/' + diskData.length);
    assert.equal(res.headers['content-type'], 'video/x-matroska');
    assert.ok(res.raw.equals(diskData.slice(1000, 2000)));
    return call('GET', '/media/' + ref);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.ok(res.raw.equals(diskData));
    var mine = sessionsOf('tv-1');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].infoHash, null);
    assert.equal(mine[0].ref, ref);
    assert.equal(mine[0].file, 'Movie (2020)/movie.mkv');
    return call('DELETE', '/media/' + ref);
  }).then(function () {
    assert.equal(sessionsOf('tv-1').length, 0);
  });
});

test('path safety: no row leaves its folder (.., absolute, symlinks out)', function () {
  return library().then(function (lib) {
    return lib.folders().then(function (folders) {
      var folder = folders[0];
      return Promise.all(['../outside.mkv', '/etc/passwd', 'a/../../outside.mkv', 'a\\..\\b.mkv', ''].map(function (relPath) {
        return lib.addFile(folder.id, { relPath: relPath, size: 1 }).then(function () {
          assert.fail('accepted ' + relPath);
        }, function (err) {
          assert.equal(err.code, 'INVALID', relPath);
        });
      })).then(function () {
        // a symlink inside the folder pointing outside it: listed, never served
        return lib.addFile(folder.id, { relPath: 'escape.mkv', size: diskData.length });
      });
    });
  }).then(function (row) {
    return call('GET', '/media/f_' + row.id, undefined, { Range: 'bytes=0-9' });
  }).then(function (res) {
    assert.equal(res.status, 404);
  });
});

test('adults-only folders: refused to kids profiles', function () {
  var ref, kid, adult;
  return Promise.all([
    call('POST', '/profiles', { name: 'Kid', isKid: true }),
    call('POST', '/profiles', { name: 'Grown-up' })
  ]).then(function (created) {
    kid = created[0].body.id;
    adult = created[1].body.id;
    return library();
  }).then(function (lib) {
    return lib.addFolder({ path: adultDir, kind: 'other', audience: 'adults' }).then(function (folder) {
      return lib.addFile(folder.id, { relPath: 'film.mkv', size: diskData.length });
    });
  }).then(function (row) {
    ref = 'f_' + row.id;
    return call('GET', '/media/' + ref + '?profile=' + kid, undefined, { Range: 'bytes=0-9' });
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(sessionsOf('tv-1').length, 0, 'no lease for a refused request');
    return call('GET', '/media/' + ref + '?profile=' + adult, undefined, { Range: 'bytes=0-9' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    // the profile of the device's keepalive counts too
    return call('POST', '/media/' + ref + '/keepalive', { profileId: kid });
  }).then(function () {
    return call('GET', '/media/' + ref, undefined, { Range: 'bytes=0-9' });
  }).then(function (res) {
    assert.equal(res.status, 403);
    return call('DELETE', '/media/' + ref);
  });
});

test('ffprobe / ffmpeg read a disk file from its path: AC-3 → transcoded', { skip: !FFMPEG && 'no ffmpeg on the PATH' }, function () {
  var file = path.join(libraryDir, 'Dolby (2021).mkv'), ref;
  var made = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-g', '50', '-c:a', 'ac3', '-ac', '6', file]);
  assert.equal(made.status, 0, String(made.stderr));
  return library().then(function (lib) {
    return lib.folders().then(function (folders) {
      return lib.addFile(folders[0].id, { relPath: path.basename(file), size: fs.statSync(file).size });
    });
  }).then(function (row) {
    ref = 'f_' + row.id;
    return call('GET', '/media/' + ref + '/probe');
  }).then(function (res) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.video, 'h264');
    assert.equal(res.body.audio[0].codec, 'ac3');
    assert.equal(res.body.transcode, true);
    assert.ok(Math.abs(res.body.duration - 12) < 0.5);
    return call('GET', '/media/' + ref + '/keyframe?t=5');
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.ok(res.body.time <= 5 && res.body.time >= 2, 'a keyframe at or before 5 s: ' + res.body.time);
    return head('/media/' + ref + '/transcode?t=' + res.body.time, 64 * 1024);
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'video/x-matroska');
    assert.ok(res.raw.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'an EBML (Matroska) header');
    return helpers.until(function () {
      var mine = sessionsOf('tv-1')[0];
      return mine && mine.method === 'audio-transcode' && mine;
    }, 5000, 'the transcode session');
  }).then(function () {
    return call('DELETE', '/media/' + ref);
  });
});

test('a finished download: ffmpeg reads it from its path', function () {
  var hash = movie.infoHash, file = movie.files[0];
  server.settings.update({ downloads: { seedRatio: 0, seedMinutes: 0 } });
  return call('POST', '/downloads/' + hash + '/start').then(function () {
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash).then(function (r) { return r.body.state === 'completed' && r.body; });
    }, 15000, 'completed');
  }).then(function () {
    return media.input(media.torrentFile(hash, file.path), 1, 'tv-1');
  }).then(function (input) {
    assert.equal(input, 'file:' + path.join(tmp, 'cache', 'torrent_data', file.path));
    // the file not downloaded is still read through the route
    return media.input(media.torrentFile(hash, movie.files[1].path), 1, 'tv-1');
  }).then(function (input) {
    assert.match(input, /^http:\/\/127\.0\.0\.1:1\/api\/v1\/media\/t_[0-9a-f]{40}_[0-9a-f]{16}\?device=tv-1&internal=/);
    assert.equal(torrents.get(hash).state, 'completed');
  });
});
