'use strict';

// The Storage page's file browser (docs/dashboard-plan.md step 6) on a real
// server with temp folders and the fake engine: places (the download folder,
// a library folder, an offline one), sizes measured in the background, what
// each file is (matched, unmatched, ignored, subtitles, a download in
// progress), path safety, search, a folder of 3 000 files answered quickly,
// delete rules (a running torrent's data refused, rows forgotten), the
// largest folders; answers against openapi.yaml.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-storage-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  userData = require('../lib/userData'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var movies = path.join(tmp, 'Movies'),
  gone = path.join(tmp, 'Unplugged'),
  seedDir = path.join(tmp, 'seed'),
  seeder = engines.create('fake'),
  // slow: still downloading while the tests look at it
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false, engineOptions: { rate: 1024 } } },
  film = helpers.make(seedDir, 'Running.2024', [{ path: 'running.mkv', size: 4 * 1024 * 1024 }], { folder: true }),
  base = null,
  cookie = null,
  folder = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

function call(method, apiPath, body) {
  var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign(cookie ? { Cookie: cookie } : {}, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function write(rel, bytes) {
  var full = path.join(movies, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 1));
}

test.before(function () {
  write('Heat (1995)/Heat.1995.1080p.mkv', 300000);
  write('Heat (1995)/Heat.1995.en.srt', 2000);
  write('Odd (2001)/odd.mkv', 100000);
  write('Odd (2001)/notes.txt', 50);
  write('Ignored/clip.mkv', 1000);
  write('.hidden/secret.mkv', 1000);
  for (var i = 0; i < 3000; i++) {
    write('Many/file-' + i + '.mkv', 10);
  }
  fs.mkdirSync(gone, { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(movies, 'escape'));
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return seeder.add({ infoHash: film.infoHash, torrentFile: film.torrentFile, savePath: seedDir });
  }).then(function () {
    return server.start(OPTIONS);
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'storage-pass' });
  }).then(function () {
    return new Promise(function (resolve, reject) {
      var req = http.request(new URL('/api/v1/auth/sign-in/username', base), {
        method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' }
      }, function (res) {
        cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'admin', password: 'storage-pass' }));
    });
  }).then(function () {
    return userData.services();
  }).then(function (s) {
    return Promise.all([
      s.library.addFolder({ path: movies, kind: 'movies' }),
      s.library.addFolder({ path: gone, kind: 'shows' })
    ]).then(function (folders) {
      folder = folders[0];
      return Promise.all([
        s.library.addFile(folder.id, { relPath: 'Heat (1995)/Heat.1995.1080p.mkv', size: 300000 }),
        s.library.addFile(folder.id, { relPath: 'Odd (2001)/odd.mkv', size: 100000 }),
        s.library.addFile(folder.id, { relPath: 'Ignored/clip.mkv', size: 1000 })
      ]);
    }).then(function (rows) {
      return Promise.all([
        s.library.match(rows[0].id, { kind: 'movie', tmdbId: 949 }, { title: 'Heat', year: 1995 }, 'admin'),
        s.library.ignore(rows[2].id, true)
      ]);
    });
  }).then(function () {
    fs.rmSync(gone, { recursive: true });
    // a download running in the download folder
    return call('POST', '/downloads', { link: film.magnet });
  });
});

test.after(function () {
  return server.stop().then(function () { return seeder.close(); }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function place(id) {
  return 'folder:' + id;
}

test('places: the download folder first, the library\'s folders, an offline one; sizes once measured', function () {
  return call('GET', '/admin/storage/places').then(function (res) {
    assert.equal(res.status, 200);
    conforms('StoragePlaces', res.body);
    var names = res.body.places.map(function (p) { return p.name + ':' + p.status; });
    assert.deepEqual(names, ['Downloads:online', 'Movies:online', 'Unplugged:offline']);
    return helpers.until(function () {
      return call('GET', '/admin/storage/places').then(function (r) {
        var m = r.body.places[1];
        return !m.measuring && m.bytes !== null && m;
      });
    }, 15000, 'the library folder measured');
  }).then(function (movies) {
    assert.ok(movies.bytes >= 300000 + 100000, 'on disk: ' + movies.bytes);
    assert.ok(movies.disk && movies.disk.total > 0);
    return call('GET', '/admin/storage/browse?place=' + place('nope'));
  }).then(function (res) {
    assert.equal(res.status, 404);
    return call('GET', '/admin/storage/places');
  }).then(function (res) {
    return call('GET', '/admin/storage/browse?place=' + encodeURIComponent(res.body.places[2].id));
  }).then(function (res) {
    assert.equal(res.status, 409, 'offline');
  });
});

test('browse: folders first, what each file is, sizes, a folder of 3 000 files quickly', function () {
  var p = encodeURIComponent(place(folder.id));
  return call('GET', '/admin/storage/browse?place=' + p).then(function (res) {
    assert.equal(res.status, 200);
    conforms('StorageListing', res.body);
    assert.equal(res.body.parent, null);
    assert.deepEqual(res.body.entries.map(function (e) { return e.name; }), ['escape', 'Heat (1995)', 'Ignored', 'Many', 'Odd (2001)'],
      'folders (no hidden ones), by name');
    var heat = res.body.entries[1];
    assert.equal(heat.type, 'folder');
    assert.equal(heat.items, 2);
    assert.ok(heat.bytes >= 300000);
    return call('GET', '/admin/storage/browse?place=' + p + '&path=' + encodeURIComponent('Heat (1995)'));
  }).then(function (res) {
    var byName = {};
    res.body.entries.forEach(function (e) { byName[e.name] = e; });
    assert.equal(res.body.parent, '');
    assert.deepEqual(byName['Heat.1995.1080p.mkv'].what, { kind: 'matched', text: 'Heat (1995)' });
    assert.match(byName['Heat.1995.1080p.mkv'].ref, /^f_/);
    assert.equal(byName['Heat.1995.en.srt'].what.kind, 'subtitles');
    return call('GET', '/admin/storage/browse?place=' + p + '&path=' + encodeURIComponent('Odd (2001)') + '&sort=size');
  }).then(function (res) {
    assert.deepEqual(res.body.entries.map(function (e) { return e.name + ':' + e.what.kind; }), ['odd.mkv:unmatched', 'notes.txt:other']);
    return call('GET', '/admin/storage/browse?place=' + p + '&path=Ignored');
  }).then(function (res) {
    assert.equal(res.body.entries[0].what.kind, 'ignored');
    var started = Date.now();
    return call('GET', '/admin/storage/browse?place=' + p + '&path=Many').then(function (r) {
      return { res: r, ms: Date.now() - started };
    });
  }).then(function (timed) {
    assert.equal(timed.res.body.entries.length, 3000);
    assert.ok(timed.ms < 1000, 'a folder of 3 000 files in ' + timed.ms + ' ms');
  });
});

test('path safety: no .., no symlink out of the place', function () {
  var p = encodeURIComponent(place(folder.id));
  return call('GET', '/admin/storage/browse?place=' + p + '&path=..').then(function (res) {
    assert.equal(res.status, 400);
    return call('GET', '/admin/storage/browse?place=' + p + '&path=escape');
  }).then(function (res) {
    assert.equal(res.status, 404, 'a symlink leaving the place');
    return call('DELETE', '/admin/storage/entries', { place: place(folder.id), path: 'Heat (1995)/../../x' });
  }).then(function (res) {
    assert.equal(res.status, 400);
  });
});

test('search: names with every word, anywhere in the place', function () {
  return call('GET', '/admin/storage/browse?place=' + encodeURIComponent(place(folder.id)) + '&q=' + encodeURIComponent('heat srt')).then(function (res) {
    assert.equal(res.body.search, 'heat srt');
    assert.deepEqual(res.body.entries.map(function (e) { return e.path; }), ['Heat (1995)/Heat.1995.en.srt']);
  });
});

test('the download folder: a running download\'s data can\'t be deleted', function () {
  return helpers.until(function () {
    return call('GET', '/admin/storage/browse?place=downloads').then(function (r) {
      return r.body.entries && r.body.entries.length && r.body;
    });
  }, 10000, 'the download\'s data').then(function (listing) {
    var entry = listing.entries.filter(function (e) { return e.name === 'Running.2024'; })[0];
    assert.equal(entry.type, 'folder');
    assert.equal(entry.download.infoHash, film.infoHash);
    assert.equal(entry.download.active, true);
    return call('GET', '/admin/storage/browse?place=downloads&path=Running.2024');
  }).then(function (res) {
    var file = res.body.entries[0];
    assert.equal(file.what.kind, 'downloading');
    assert.match(file.what.text, /^Download in progress \d+ %$/);
    assert.match(file.ref, /^t_[0-9a-f]{40}_/, 'played by its torrent ref');
    assert.equal(typeof file.onDisk, 'number');
    return call('DELETE', '/admin/storage/entries', { place: 'downloads', path: 'Running.2024' });
  }).then(function (res) {
    assert.equal(res.status, 409);
    return call('POST', '/downloads/' + film.infoHash + '/pause');
  }).then(function () {
    return call('DELETE', '/admin/storage/entries', { place: 'downloads', path: 'Running.2024' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return call('GET', '/downloads/' + film.infoHash);
  }).then(function (res) {
    assert.equal(res.status, 404, 'its data gone: the download is forgotten too');
  });
});

test('delete a library file: gone from the disk and from the library; the largest folders', function () {
  return call('DELETE', '/admin/storage/entries', { place: place(folder.id), path: '' }).then(function (res) {
    assert.equal(res.status, 400, 'not the place itself');
    return call('DELETE', '/admin/storage/entries', { place: place(folder.id), path: 'Odd (2001)/odd.mkv' });
  }).then(function (res) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.freedBytes > 0);
    assert.ok(!fs.existsSync(path.join(movies, 'Odd (2001)', 'odd.mkv')));
    return userData.services();
  }).then(function (s) {
    return s.library.files(folder.id);
  }).then(function (rows) {
    assert.ok(!rows.some(function (r) { return r.relPath === 'Odd (2001)/odd.mkv'; }), 'its row forgotten');
    return helpers.until(function () {
      return call('GET', '/admin/storage/largest?place=' + encodeURIComponent(place(folder.id))).then(function (r) {
        return !r.body.measuring && r.body;
      });
    }, 10000, 'measured again');
  }).then(function (largest) {
    // on disk: 3 000 small files take a block each, more than Heat's one film
    assert.deepEqual(largest.folders.slice(0, 2).map(function (f) { return f.path; }), ['Many', 'Heat (1995)']);
    assert.ok(!largest.folders.some(function (f) { return f.path === ''; }));
  });
});
