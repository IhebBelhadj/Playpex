'use strict';

// A torrent client's controls (docs/dashboard-plan.md §12, engine port v3):
// the queue's order, force start, seeding goals and speed limits per
// download, trackers added and removed (kept in the table), announcing
// again, the .torrent export, what /media/{ref}/playback says a file is, and
// tracker scrapes (lib/torrents/scrape.js) against a local tracker. The real
// server with the fake engine and fake seeders in this process.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020'),
  parseTorrent = require('parse-torrent');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-downloads-controls-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  engines = require('../lib/torrents/engines'),
  fake = require('../lib/torrents/engines/fake'),
  scraper = require('../lib/torrents/scrape'),
  media = require('../lib/media'),
  userData = require('../lib/userData'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var seedDir = path.join(tmp, 'seed'),
  seeder = engines.create('fake'),
  engine = null,
  // slow: each of them takes seconds, so they stay running or queued
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false, engineOptions: { rate: 16 * 1024 } } },
  made = ['One', 'Two', 'Three', 'Four'].map(function (name) {
    return helpers.make(seedDir, name, [{ path: name.toLowerCase() + '.mkv', size: 4 * 1024 * 1024 }], { pieceLength: 64 * 1024 });
  }),
  base = null,
  cookie = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

function call(method, apiPath, body, options) {
  options = options || {};
  var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method,
      agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {},
        options.admin === false || !cookie ? {} : { Cookie: cookie })
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw: raw, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(hash) {
  return call('GET', '/downloads/' + hash).then(function (r) { return r.body; });
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return Promise.all(made.map(function (m) { return seeder.add({ infoHash: m.infoHash, torrentFile: m.torrentFile, savePath: seedDir }); }));
  }).then(function () {
    return server.start(OPTIONS);
  }).then(function (info) {
    engine = fake.latest();
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'controls-pass' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'controls-pass' }));
    });
  }).then(function () {
    return call('PUT', '/admin/settings', { downloads: { maxActive: 1, seedRatio: 0, seedMinutes: 0 } });
  });
});

test.after(function () {
  return server.stop().then(function () {
    return seeder.close();
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('the queue: moved by the admin; force start past maxActive; a pause ends it', function () {
  var h = made.map(function (m) { return m.infoHash; });
  return made.reduce(function (p, m) {
    return p.then(function () { return call('POST', '/downloads', { link: m.magnet }); });
  }, Promise.resolve()).then(function () {
    return helpers.until(function () {
      return get(h[0]).then(function (d) { return d.state === 'downloading' && d; });
    }, 10000, 'the first one running');
  }).then(function () {
    return Promise.all(h.map(get));
  }).then(function (all) {
    all.forEach(function (d) { conforms('Download', d); });
    assert.deepEqual(all.map(function (d) { return d.queuePosition; }), [null, 1, 2, 3], 'oldest first');
    return call('PATCH', '/downloads/' + h[3], { queuePosition: 1 });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.queuePosition, 1);
    return Promise.all(h.map(get));
  }).then(function (all) {
    assert.deepEqual(all.map(function (d) { return d.queuePosition; }), [null, 2, 3, 1], 'Four first, the others after it');
    return call('PATCH', '/downloads/' + h[1], { queuePosition: 99 });
  }).then(function (res) {
    assert.equal(res.body.queuePosition, 3, 'past the end: last');
    return call('PATCH', '/downloads/' + h[0], { queuePosition: 1 });
  }).then(function (res) {
    assert.equal(res.status, 409, 'a running one has no place in the queue');
    return call('PATCH', '/downloads/' + h[2], { force: true });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.forced, true);
    return helpers.until(function () {
      return get(h[2]).then(function (d) { return d.state === 'downloading' && d; });
    }, 10000, 'the forced one running past maxActive');
  }).then(function () {
    return get(h[0]);
  }).then(function (first) {
    assert.equal(first.state, 'downloading', 'the first one still runs: the force start took no slot');
    return call('POST', '/downloads/' + h[2] + '/pause');
  }).then(function (res) {
    assert.equal(res.body.state, 'paused');
    assert.equal(res.body.forced, false, 'a pause ends a force start');
    return call('POST', '/downloads/' + h[2] + '/start');
  }).then(function (res) {
    assert.equal(res.body.queuePosition, 3, 'started again: at the back of the queue');
    return call('PATCH', '/downloads/' + h[0], { force: 'yes' });
  }).then(function (res) {
    assert.equal(res.status, 400);
  });
});

test('seeding goals and speed limits of one download', function () {
  var hash = made[0].infoHash;
  return call('PATCH', '/downloads/' + hash, { seedRatio: 1.5, seedMinutes: 30 }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.seedRatio, 1.5);
    assert.equal(res.body.seedMinutes, 30);
    return call('PATCH', '/downloads/' + hash, { seedMinutes: null, seedRatio: -1 });
  }).then(function (res) {
    assert.equal(res.status, 400, 'a ratio below 0');
    return call('PATCH', '/downloads/' + hash, { seedRatio: null });
  }).then(function (res) {
    assert.equal(res.body.seedRatio, null, 'the server\'s again');
    return call('PATCH', '/downloads/' + hash, { downLimitKBps: 100, upLimitKBps: 20 });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.downLimitKBps, 100);
    assert.equal(res.body.upLimitKBps, 20);
    return helpers.until(function () { return engine.inspect(hash).limits; }, 5000, 'the engine told');
  }).then(function (limits) {
    assert.deepEqual(limits, { downBps: 100 * 1024, upBps: 20 * 1024 });
    return call('PATCH', '/downloads/' + hash, { downLimitKBps: 0, upLimitKBps: null });
  }).then(function (res) {
    assert.equal(res.body.downLimitKBps, null, '0 is none');
    assert.deepEqual(engine.inspect(hash).limits, { downBps: 0, upBps: 0 });
  });
});

test('trackers: added and removed, kept in the table, in the .torrent; announcing again', function () {
  var hash = made[0].infoHash, added = 'udp://added.example.invalid:1337/announce', removed = 'http://removed.example.invalid/announce';
  return call('POST', '/downloads/' + hash + '/trackers', { add: [added, removed] }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('DownloadTrackers', res.body);
    assert.equal(res.body.trackers.filter(function (t) { return t.url === added; })[0].added, true);
    return call('POST', '/downloads/' + hash + '/trackers', { remove: [removed] });
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.ok(!res.body.trackers.some(function (t) { return t.url === removed; }), 'gone from the list');
    assert.ok(engine.inspect(hash).trackers.indexOf(removed) === -1, 'and from the engine');
    return call('POST', '/downloads/' + hash + '/trackers', { remove: 'all' });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return userData.services().then(function (s) { return s.downloads.get(hash); });
  }).then(function (row) {
    assert.deepEqual(row.trackers, { added: [added], removed: [removed] }, 'kept with the download');
    return call('GET', '/downloads/' + hash + '/torrent', undefined, { admin: false });
  }).then(function (res) {
    assert.equal(res.status, 401, 'the admin only');
    return call('GET', '/downloads/' + hash + '/torrent');
  }).then(function (res) {
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/x-bittorrent/);
    assert.match(res.headers['content-disposition'], /attachment; filename="One\.torrent"/);
    var parsed = parseTorrent(res.raw);
    assert.equal(parsed.infoHash, hash);
    assert.ok(parsed.announce.indexOf(added) !== -1, 'with the added tracker');
    assert.ok(parsed.announce.indexOf(removed) === -1, 'without the removed one');
    return call('POST', '/downloads/' + hash + '/reannounce');
  }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('Download', res.body);
    assert.equal(engine.inspect(hash).announces, 1);
    return call('POST', '/downloads/' + made[2].infoHash + '/pause');
  }).then(function () {
    return call('POST', '/downloads/' + made[2].infoHash + '/reannounce');
  }).then(function (res) {
    assert.equal(res.status, 409, 'only a running torrent announces');
  });
});

test('/media/{ref}/playback\'s title: the one the download was played as', function () {
  var m = made[0];
  return call('POST', '/downloads', { link: m.magnet, media: { mediaType: 'tv', tmdbId: 1396, season: 2, episode: 5 }, title: 'Breaking Bad · S02E05' })
    .then(function () {
      return helpers.until(function () { return get(m.infoHash).then(function (d) { return d.files && d; }); }, 10000, 'its files');
    }).then(function (d) {
      return media.describe(media.torrentFile(m.infoHash, d.files[0].path));
    }).then(function (what) {
      assert.deepEqual(what.title, { mediaType: 'tv', tmdbId: 1396, season: 2, episode: 5, title: 'Breaking Bad', posterPath: null });
      assert.deepEqual(what.download, { infoHash: m.infoHash, path: 'One' });
      assert.equal(what.fileId, null);
    });
});

// a tracker in this process (bittorrent-tracker's server, HTTP and UDP) with
// two leechers of a torrent (its 7.7 client can't announce a seed)
test('scrapes over HTTP and UDP', function (t) {
  var Tracker, Client;
  try {
    Tracker = require('bittorrent-tracker/server');
    Client = require('bittorrent-tracker/client');
  } catch (e) {
    return t.skip('bittorrent-tracker is not installed');
  }
  var tracker = new Tracker({ http: true, udp: true, ws: false }), hash = made[3].infoHash, unknown = 'ab'.repeat(20), port, clients = [];
  tracker.on('warning', function () {});
  function announce(url, peerId, peerPort) {
    return new Promise(function (resolve) {
      var c = new Client(Buffer.from(peerId), peerPort, { infoHash: hash, announce: [url] });
      clients.push(c);
      c.on('warning', function () {});
      c.on('error', function () {});
      c.once('update', resolve);
      c.start();
    });
  }
  return helpers.freePort().then(function (p) {
    port = p;
    // every interface: its UDP6 socket can't bind an IPv4 address
    return new Promise(function (resolve) { tracker.listen(port, resolve); });
  }).then(function () {
    var url = 'http://127.0.0.1:' + port + '/announce';
    return announce(url, '-PP0001-leechleech01', 6881).then(function () { return announce(url, '-PP0001-leechleech02', 6882); });
  }).then(function () {
    return scraper.scrape('http://127.0.0.1:' + port + '/announce', [hash], { timeoutMs: 5000 });
  }).then(function (answer) {
    assert.equal(answer[hash].peers, 2, 'HTTP: two leechers');
    assert.equal(answer[hash].seeds, 0);
    return scraper.scrape('udp://127.0.0.1:' + port, [hash, unknown], { timeoutMs: 5000 });
  }).then(function (answer) {
    assert.equal(answer[hash].peers, 2, 'UDP: two leechers');
    assert.equal(answer[unknown].peers, 0, 'a torrent it doesn\'t know: nobody');
    return scraper.scrape('http://127.0.0.1:' + port + '/tracker', [hash]).then(function () {
      assert.fail('no scrape URL');
    }, function (err) {
      assert.match(err.message, /no scrape/);
    });
  }).then(function () {
    assert.equal(scraper.scrapeUrl('http://t.example/x/announce.php?passkey=1').toString(), 'http://t.example/x/scrape.php?passkey=1');
    return scraper.scrape('udp://127.0.0.1:1', [hash], { timeoutMs: 300 }).then(function () {
      assert.fail('nobody there');
    }, function (err) {
      assert.ok(err.message);
    });
  }).then(function () {
    clients.forEach(function (c) { c.destroy(); });
    return new Promise(function (resolve) { tracker.close(resolve); });
  });
});
