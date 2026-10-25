'use strict';

// The torrent client (lib/torrents/client.js, docs/media-server-plan.md §4,
// step 1): the real server with the fake engine (lib/torrents/engines/fake.js)
// and a fake seeder in this process, so torrents really download, offline.
// What step 1 promises: play → leave → paused with its data, kept across a
// restart; Start → downloaded to the end without a client → seeding →
// completed at the ratio; a completed file plays from disk; maxActive queues;
// "pause all" persists; streams make room; remove-when-watched;
// torrents.json is imported.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-downloads-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  sessions = require('../lib/sessions'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var seedDir = path.join(tmp, 'seed'),
  downloads = path.join(tmp, 'cache', 'torrent_data'),
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } },
  seeder = engines.create('fake'),
  base = null,
  // three torrents the seeder has: a movie, a season pack, another movie
  movie = helpers.make(seedDir, 'Movie.2020', [{ path: 'movie.mkv', size: 3000000 }, { path: 'sample.mkv', size: 200000 }]),
  pack = helpers.make(seedDir, 'Show.S01', [{ path: 'Show.S01E01.mkv', size: 900000 }, { path: 'Show.S01E02.mkv', size: 900000 }]),
  other = helpers.make(seedDir, 'Other.2021', [{ path: 'other.mkv', size: 2000000 }], { folder: true }),
  labelled = helpers.make(seedDir, 'Labelled.2022', [{ path: 'a.mkv', size: 600000 }, { path: 'b.mkv', size: 600000 }]),
  legacy = helpers.make(path.join(tmp, 'legacy'), 'Legacy.1999', [{ path: 'legacy.mkv', size: 300000 }], { folder: true });

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
        resolve({ status: res.statusCode, raw: raw, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function download(hash) {
  return call('GET', '/downloads/' + hash).then(function (res) { return res.body; });
}

function stateIs(hash, states) {
  states = [].concat(states);
  return helpers.until(function () {
    return download(hash).then(function (d) { return d && states.indexOf(d.state) !== -1 && d; });
  }, 15000, hash.slice(0, 8) + ' to be ' + states.join(' / '));
}

function start() {
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
  });
}

test.before(function () {
  // what the old store left: torrents.json + torrent-stream's metadata cache + data
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'cache', 'torrent-stream'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'torrents.json'), JSON.stringify([legacy.infoHash, 'f'.repeat(40)]));
  fs.writeFileSync(path.join(tmp, 'cache', 'torrent-stream', legacy.infoHash + '.torrent'), legacy.torrentFile);
  fs.cpSync(path.join(tmp, 'legacy', 'Legacy.1999'), path.join(downloads, 'Legacy.1999'), { recursive: true });

  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return Promise.all([movie, pack, other, labelled].map(function (t) {
      return seeder.add({ infoHash: t.infoHash, torrentFile: t.torrentFile, savePath: seedDir });
    }));
  }).then(start).then(function () {
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

test('torrents.json is imported: paused downloads, with their data', function () {
  return download(legacy.infoHash).then(function (d) {
    assert.equal(d.state, 'paused');
    assert.equal(d.name, 'Legacy.1999');
    assert.deepEqual(d.selectedFiles, [legacy.files[0].path]);
    assert.ok(fs.existsSync(path.join(tmp, 'config', 'torrents.json.imported')));
    return call('GET', '/downloads/' + 'f'.repeat(40));
  }).then(function (res) {
    assert.equal(res.status, 404);   // no metadata, no data: skipped
  });
});

test('play → leave: paused, no peers, data kept, the title known; kept across a restart', function () {
  var hash = movie.infoHash, file = movie.files[0];
  return call('POST', '/torrents', { link: movie.magnet }).then(function (res) {
    assert.equal(res.status, 200);
    return helpers.until(function () {
      return call('GET', '/torrents/' + hash).then(function (r) { return r.body.files && r.body; });
    }, 10000, 'the files');
  }).then(function (t) {
    // a stream fetches its largest file
    assert.deepEqual(t.files.filter(function (f) { return f.selected; }).map(function (f) { return f.path; }), [file.path]);
    return call('GET', '/torrents/' + hash + '/files/' + encodeURIComponent(file.path), undefined, { Range: 'bytes=100-2099' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.ok(res.raw.equals(file.data.slice(100, 2100)));
    return call('POST', '/torrents/' + hash + '/keepalive', {
      positionS: 30, durationS: 6000, title: 'Movie (2020)', profileId: 'p1', media: { mediaType: 'movie', tmdbId: 42 }
    });
  }).then(function () {
    return call('DELETE', '/torrents/' + hash);
  }).then(function () {
    return stateIs(hash, ['paused', 'completed']);
  }).then(function (d) {
    assert.equal(d.peers, 0);
    assert.equal(d.downloadSpeed, 0);
    assert.deepEqual(d.title, { mediaType: 'movie', tmdbId: 42, title: 'Movie (2020)' });
    assert.equal(d.profileId, 'p1');
    assert.ok(fs.existsSync(path.join(downloads, file.path)), 'data kept');
    return server.stop();
  }).then(start).then(function () {
    return download(hash);
  }).then(function (d) {
    assert.ok(['paused', 'completed'].indexOf(d.state) !== -1, 'still known after a restart: ' + d.state);
    assert.equal(d.intent, 'stream');
  });
});

test('Start: downloaded to the end without a client, seeds, completed at the ratio; plays from disk', function () {
  var hash = movie.infoHash, file = movie.files[0], ref;
  server.settings.update({ downloads: { seedRatio: 0.5, seedMinutes: 0 } });
  return call('POST', '/downloads/' + hash + '/start').then(function (res) {
    assert.equal(res.body.intent, 'download');
    return stateIs(hash, 'completed');
  }).then(function (d) {
    assert.equal(d.doneBytes, d.sizeBytes);
    assert.ok(d.ratio >= 0.5, 'seeded to the ratio: ' + d.ratio);
    assert.ok(d.completedAt);
    assert.ok(fs.readFileSync(path.join(downloads, file.path)).equals(file.data));
    // a finished file plays from disk: the download stays completed, no engine
    return call('GET', '/torrents/' + hash + '/files/' + encodeURIComponent(file.path), undefined, { Range: 'bytes=0-999' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.ok(res.raw.equals(file.data.slice(0, 1000)));
    return download(hash);
  }).then(function (d) {
    assert.equal(d.state, 'completed');
    // the play pipeline: the title's finished download is a source on disk, played at once by its ref
    return call('POST', '/play/sources', { kind: 'movie', tmdbId: 42, title: 'Movie', year: 2020 });
  }).then(function (res) {
    assert.equal(res.status, 200);
    var first = res.body.sources[0];
    assert.equal(first.type, 'download');
    assert.equal(first.path, file.path);
    assert.equal(first.progress, 1);
    assert.equal(res.body.policy.autoplay, first.id);
    ref = first.ref;
    return call('GET', '/media/' + ref, undefined, { Range: 'bytes=0-999' });
  }).then(function (res) {
    assert.equal(res.status, 206);
    assert.ok(res.raw.equals(file.data.slice(0, 1000)));
    return download(hash);
  }).then(function (d) {
    assert.equal(d.state, 'completed', 'read from disk, nothing started');
    return call('DELETE', '/media/' + ref);
  });
});

test('downloads.maxActive queues; "pause all" persists across a restart', function () {
  server.settings.update({ downloads: { maxActive: 1, seedRatio: 0, seedMinutes: 0 } });
  var slow = [pack, other];
  return Promise.all(slow.map(function (t) {
    return call('POST', '/downloads', { link: t.magnet });
  })).then(function (res) {
    var states = res.map(function (r) { return r.body.state; }).sort();
    assert.deepEqual(states, ['downloading', 'queued']);
    return Promise.all(slow.map(function (t) { return stateIs(t.infoHash, 'completed'); }));
  }).then(function () {
    // pause all: a download added now waits, and keeps waiting after a restart
    require('../lib/torrents/client').pauseAll();
    return call('DELETE', '/downloads/' + other.infoHash + '?data=delete', undefined, {});
  }).then(function (res) {
    assert.equal(res.status, 401);   // the admin's only
    return call('POST', '/downloads', { link: legacy.infoHash });
  }).then(function (res) {
    assert.equal(res.body.state, 'queued');
    return server.stop();
  }).then(start).then(function () {
    assert.equal(server.settings.get('downloads.paused'), true);
    return new Promise(function (resolve) { setTimeout(resolve, 300); });
  }).then(function () {
    return download(legacy.infoHash);
  }).then(function (d) {
    assert.equal(d.state, 'queued');
    require('../lib/torrents/client').resumeAll();
    return stateIs(legacy.infoHash, ['downloading', 'seeding', 'completed']);
  });
});

test('a stream past streaming.maxTorrents: a download nobody watches goes back to the queue', function () {
  server.settings.update({ streaming: { maxTorrents: 1 }, downloads: { maxActive: 3, seedRatio: 100 } });
  var client = require('../lib/torrents/client');
  // neither finished: a finished one plays from disk and needs no slot
  return Promise.all([client.remove(pack.infoHash, { deleteData: true }), client.remove(other.infoHash, { deleteData: true })]).then(function () {
    return call('POST', '/downloads', { link: pack.magnet });
  }).then(function () {
    return stateIs(pack.infoHash, ['downloading', 'seeding']);
  }).then(function () {
    return call('POST', '/torrents', { link: other.magnet });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return download(pack.infoHash);
  }).then(function (d) {
    assert.equal(d.state, 'queued');
    // playing the queued one too while the first stream is held: BUSY
    return call('POST', '/torrents', { link: pack.magnet }, { 'X-Playpex-Device': 'tv-2' });
  }).then(function (res) {
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'BUSY');
    return call('DELETE', '/torrents/' + other.infoHash);
  }).then(function () {
    return stateIs(other.infoHash, ['paused', 'completed']);
  }).then(function () {
    // the slot is free again: the queued download takes it
    return stateIs(pack.infoHash, ['downloading', 'seeding']);
  }).finally(function () {
    server.settings.update({ streaming: { maxTorrents: 4 }, downloads: { seedRatio: 1 } });
  });
});

test('remove when watched: the player reached the end → removed with its data', function () {
  var hash = other.infoHash, file = other.files[0];
  return call('PATCH', '/downloads/' + hash, { removeWhenWatched: true }).then(function () {
    return call('POST', '/torrents', { link: hash });
  }).then(function () {
    return call('GET', '/torrents/' + hash + '/files/' + encodeURIComponent(file.path), undefined, { Range: 'bytes=0-9' });
  }).then(function (res) {
    assert.equal(res.status, 206, res.raw.toString());
    return call('POST', '/torrents/' + hash + '/keepalive', { positionS: 95, durationS: 100 });
  }).then(function () {
    return call('DELETE', '/torrents/' + hash);
  }).then(function () {
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash).then(function (r) { return r.status === 404; });
    }, 5000, 'the download to go');
  }).then(function () {
    assert.ok(!fs.existsSync(path.join(downloads, 'Other.2021')), 'its data is deleted');
  });
});

// a .torrent as multipart `file` (+ other fields)
function upload(apiPath, torrentFile, fields) {
  var boundary = 'playpex' + Date.now(), parts = [];
  Object.keys(fields || {}).forEach(function (k) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
  });
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="t.torrent"\r\n' +
    'Content-Type: application/x-bittorrent\r\n\r\n'), torrentFile, Buffer.from('\r\n--' + boundary + '--\r\n'));
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: 'POST', headers: { 'X-Playpex-Device': 'tv-1', 'Content-Type': 'multipart/form-data; boundary=' + boundary }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); });
    });
    req.on('error', reject);
    req.end(Buffer.concat(parts));
  });
}

test('the Add dialog: preview, then add paused with a label and some files; labels; the piece map', function () {
  var hash = labelled.infoHash;
  return upload('/downloads/preview', labelled.torrentFile).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.infoHash, hash);
    assert.equal(res.body.name, 'Labelled.2022');
    assert.deepEqual(res.body.files.map(function (f) { return f.size; }), [600000, 600000]);
    assert.equal(res.body.known, null);
    return call('POST', '/downloads/preview', { link: labelled.magnet });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.files, null, 'a new magnet: its files come from the swarm');
    return call('POST', '/downloads/preview', { link: 'not a torrent' });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return upload('/downloads', labelled.torrentFile, { files: JSON.stringify([labelled.files[0].path]), label: 'Weekend', paused: 'true' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'paused');
    assert.equal(res.body.label, 'Weekend');
    assert.deepEqual(res.body.selectedFiles, [labelled.files[0].path]);
    assert.equal(res.body.queuePosition, null);
    assert.ok(res.body.savePath.endsWith('Labelled.2022'));
    return call('POST', '/downloads/preview', { link: labelled.magnet });
  }).then(function (res) {
    assert.equal(res.body.known.infoHash, hash, 'known now');
    assert.equal(res.body.files.length, 2, 'and its files with it');
    return call('PATCH', '/downloads/' + hash, { label: '  Movies  ' });
  }).then(function (res) {
    assert.equal(res.body.label, 'Movies');
    return call('PATCH', '/downloads/' + hash, {});
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('PATCH', '/downloads/' + hash, { label: 3 });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('POST', '/downloads/' + hash + '/start');
  }).then(function () {
    return stateIs(hash, ['seeding', 'completed']);
  }).then(function (d) {
    // the first file's pieces only: the strip's first half is full, the second empty
    var map = Buffer.from(d.pieceMap, 'base64');
    assert.ok(map.length > 2 && map.length <= 100);
    assert.equal(map[0], 255);
    assert.equal(map[map.length - 1], 0);
    return call('PATCH', '/downloads/' + hash, { label: null });
  }).then(function (res) {
    assert.equal(res.body.label, null);
  });
});
