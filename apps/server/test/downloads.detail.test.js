'use strict';

// A download's detail for the dashboard (docs/dashboard-plan.md steps 2–4,
// engine port v2): peers, trackers (added ones), recheck, pieces with the
// range a player reads, the speed history, the global speed limits; admin
// only; answers against openapi.yaml. The real server with the fake engine
// and a fake seeder in this process.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-downloads-detail-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var seedDir = path.join(tmp, 'seed'),
  seeder = engines.create('fake'),
  // slow enough to read it while it downloads: 64 KB per 20 ms tick
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false, engineOptions: { rate: 64 * 1024 } } },
  film = helpers.make(seedDir, 'Film.2023', [{ path: 'film.mkv', size: 6 * 1024 * 1024 }, { path: 'film.srt', size: 30000 }], { pieceLength: 64 * 1024 }),
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
        options.admin === false || !cookie ? {} : { Cookie: cookie }, options.headers)
    }, function (res) {
      if (options.stream) {
        return resolve(res);
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return seeder.add({ infoHash: film.infoHash, torrentFile: film.torrentFile, savePath: seedDir });
  }).then(function () {
    return server.start(OPTIONS);
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'detail-pass' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'detail-pass' }));
    });
  });
});

test.after(function () {
  return server.stop().then(function () {
    return seeder.close();
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('peers, trackers, pieces with a player reading, the speed history, recheck; admin only', function () {
  var hash = film.infoHash, video = film.files[0], player = null;
  return call('POST', '/downloads', { link: film.magnet }).then(function (res) {
    assert.equal(res.status, 200);
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash).then(function (r) { return r.body.state === 'downloading' && r.body.files && r.body; });
    }, 10000, 'downloading');
  }).then(function () {
    return call('GET', '/downloads/' + hash + '/peers', undefined, { admin: false });
  }).then(function (res) {
    assert.equal(res.status, 401, 'the admin only');
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash + '/peers').then(function (r) { return r.body.peers && r.body.peers.length && r.body; });
    }, 10000, 'the seeder as a peer');
  }).then(function (peers) {
    conforms('DownloadPeers', peers);
    assert.equal(peers.running, true);
    assert.equal(peers.peers[0].client, 'qBittorrent 4.6.3', 'named from its peer id');
    assert.match(peers.peers[0].flags, /D/);
    // a player reads the middle of the film while it downloads
    return call('GET', '/media/' + encodeURIComponent(fileRef(hash)) + '?device=tv-1', undefined,
      { stream: true, headers: { Range: 'bytes=3000000-' } });
  }).then(function (res) {
    player = res;
    assert.equal(res.statusCode, 206);
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash + '/pieces').then(function (r) { return r.body.reads.length && r.body; });
    }, 10000, 'a read');
  }).then(function (pieces) {
    conforms('DownloadPieces', pieces);
    assert.equal(pieces.pieceLength, 64 * 1024);
    assert.equal(pieces.count, Math.ceil((video.size + film.files[1].size) / (64 * 1024)));
    assert.equal(Buffer.from(pieces.have, 'base64').length, Math.ceil(pieces.count / 8));
    assert.deepEqual(pieces.files.map(function (f) { return f.path; }), film.files.map(function (f) { return f.path; }));
    var read = pieces.reads[0];
    assert.equal(read.path, video.path);
    assert.equal(read.from, Math.floor(3000000 / (64 * 1024)));
    assert.ok(read.position >= read.from && read.ahead > read.position);
    player.destroy();
    return call('POST', '/downloads/' + hash + '/trackers', { add: ['ftp://nope'] });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('POST', '/downloads/' + hash + '/trackers', { add: ['udp://tracker.example.invalid:1337/announce'] });
  }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('DownloadTrackers', res.body);
    var added = res.body.trackers.filter(function (t) { return t.url === 'udp://tracker.example.invalid:1337/announce'; })[0];
    assert.ok(added, 'listed');
    assert.equal(added.ours, false);
    assert.ok(res.body.trackers.some(function (t) { return t.ours; }), 'the server\'s own trackers, marked');
    return helpers.until(function () {
      return call('GET', '/downloads/' + hash + '/speed').then(function (r) { return r.body.samples.length >= 2 && r.body; });
    }, 10000, 'speed samples');
  }).then(function (speed) {
    conforms('DownloadSpeed', speed);
    assert.equal(speed.intervalMs, 2000);
    assert.ok(speed.samples.some(function (s) { return s.down > 0; }));
    return call('POST', '/downloads/' + hash + '/recheck');
  }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('Download', res.body);
    return call('POST', '/downloads/' + hash + '/pause');
  }).then(function () {
    return call('POST', '/downloads/' + hash + '/recheck');
  }).then(function (res) {
    assert.equal(res.status, 409, 'only a running torrent is checked');
    return call('GET', '/downloads/' + hash + '/peers');
  }).then(function (res) {
    assert.deepEqual(res.body, { running: false, peers: [], availability: null });
    return call('GET', '/downloads/' + hash + '/trackers');
  }).then(function (res) {
    assert.ok(res.body.trackers.every(function (t) { return t.status === 'stopped'; }));
    return call('GET', '/downloads/' + hash + '/pieces');
  }).then(function (res) {
    conforms('DownloadPieces', res.body);
    assert.deepEqual(res.body.reads, [], 'nobody reads a stopped torrent');
  });
});

test('global speed limits: settings, and only where the engine can', function () {
  return call('PUT', '/admin/settings', { downloads: { downLimitKBps: 500, upLimitKBps: 100 } }).then(function (res) {
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.settings.downloads.downLimitKBps, 500);
    return call('PUT', '/admin/settings', { downloads: { upLimitKBps: -1 } });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('GET', '/admin/overview');
  }).then(function (res) {
    assert.equal(res.body.downloads.capabilities.rateLimits, false, 'the fake engine has none: nothing is applied');
    return call('PUT', '/admin/settings', { downloads: { downLimitKBps: 0, upLimitKBps: 0 } });
  });
});

function fileRef(hash) {
  return require('../lib/media/refs').torrent(hash, film.files[0].path);
}
