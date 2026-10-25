'use strict';

// Links the admin pastes, and direct downloads (docs/search-plan.md steps 3–4),
// on a real server with a made-up web on 127.0.0.1 (let in as "public" with
// lib/plugins/http.js#configure): a page linking to every kind of thing, files
// with and without ranges, a slow one (paused, resumed: the same bytes), a
// .torrent, an HLS stream made by ffmpeg (saved with it; skipped without).
// Private addresses refused. Answers against openapi.yaml.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  crypto = require('crypto'),
  childProcess = require('child_process'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-links-')));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  pluginHttp = require('../lib/plugins/http'),
  helpers = require('./helpers/torrent');

var FILM = crypto.randomBytes(300 * 1024),
  SLOW = crypto.randomBytes(1536 * 1024),
  web = null,
  webBase = null,
  base = null,
  cookie = null,
  torrentFile = null,
  hlsDir = path.join(tmp, 'web-hls'),
  hasFfmpeg = childProcess.spawnSync('ffmpeg', ['-version']).status === 0;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

// a file with ranges (or without), optionally slow: 64 KB every `delayMs`
function serveBytes(req, res, bytes, type, options) {
  var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''),
    ranged = m && !(options && options.noRanges),
    start = ranged ? parseInt(m[1], 10) : 0,
    end = ranged && m[2] ? parseInt(m[2], 10) : bytes.length - 1;
  if (ranged && start >= bytes.length) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length });
    return res.end();
  }
  var headers = { 'Content-Type': type, 'Content-Length': end - start + 1 };
  if (ranged) {
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + bytes.length;
  }
  res.writeHead(ranged ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    return res.end();
  }
  var at = start, delay = (options && options.delayMs) || 0;
  (function next() {
    if (res.destroyed) {
      return;
    }
    if (at > end) {
      return res.end();
    }
    var chunk = bytes.subarray(at, Math.min(at + 64 * 1024, end + 1));
    at += chunk.length;
    res.write(chunk);
    delay ? setTimeout(next, delay) : setImmediate(next);
  })();
}

function page() {
  return '<!doctype html><html><head><title>Old films</title>' +
    '<meta property="og:video" content="' + webBase + '/files/Film.One.mp4"></head><body>' +
    '<a href="/files/Film.One.mp4">Film One (1931)</a>' +
    '<a href="magnet:?xt=urn:btih:' + 'c'.repeat(40) + '&amp;dn=Film.Two.1932">magnet</a>' +
    '<a href="files/film.torrent">Download</a>' +
    '<pre>Index of /files\n<a href="/files/norange.mp4">norange.mp4</a>  2026-10-25  300K</pre>' +
    '<video><source src="/files/clip.webm" type="video/webm"></video>' +
    '<script>var player = { src: "' + webBase.replace(/\//g, '\\/') + '\\/hls\\/index.m3u8" };</script>' +
    '<a href="/about">About</a></body></html>';
}

function startWeb() {
  web = http.createServer(function (req, res) {
    var u = new URL(req.url, 'http://x');
    if (u.pathname === '/hang') {
      return;   // never answers
    }
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page());
    }
    if (u.pathname === '/files/Film.One.mp4') {
      return serveBytes(req, res, FILM, 'video/mp4');
    }
    if (u.pathname === '/files/norange.mp4') {
      return serveBytes(req, res, FILM, 'video/mp4', { noRanges: true });
    }
    if (u.pathname === '/files/slow.mkv') {
      return serveBytes(req, res, SLOW, 'application/octet-stream', { delayMs: 60 });
    }
    if (u.pathname === '/files/film.torrent') {
      res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' });
      return res.end(torrentFile);
    }
    if (u.pathname.indexOf('/hls/') === 0 && hasFfmpeg) {
      var file = path.join(hlsDir, path.basename(u.pathname));
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': /\.m3u8$/.test(file) ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not here');
  });
  return new Promise(function (resolve) {
    web.listen(0, '127.0.0.1', function () {
      webBase = 'http://127.0.0.1:' + web.address().port;
      resolve();
    });
  });
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
        resolve({ status: res.statusCode, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null, bytes: raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function directOne(id) {
  return call('GET', '/downloads/direct').then(function (r) {
    return r.body.filter(function (d) { return d.id === id; })[0];
  });
}

function downloadDir() {
  return path.join(tmp, 'cache', 'torrent_data');
}

test.before(function () {
  torrentFile = helpers.make(path.join(tmp, 'seed'), 'Film.Three.1933', [{ path: 'film.mkv', size: 70000 }]).torrentFile;
  if (hasFfmpeg) {
    fs.mkdirSync(hlsDir, { recursive: true });
    childProcess.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-g', '10', '-c:a', 'aac', '-f', 'hls',
      '-hls_time', '1', '-hls_playlist_type', 'vod', path.join(hlsDir, 'index.m3u8')]);
  }
  return startWeb().then(function () {
    pluginHttp.configure({ allowAddresses: ['127.0.0.1'] });
    return server.start({ port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false }, plugins: false });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'links-pass' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'links-pass' }));
    });
  });
});

test.after(function () {
  pluginHttp.configure({});
  return server.stop().then(function () {
    web.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('a page: every kind of link it holds, each once, videos as refs', function () {
  return call('POST', '/admin/links/inspect', { url: webBase + '/page' }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    conforms('LinkInspection', r.body);
    assert.equal(r.body.kind, 'page');
    assert.equal(r.body.title, 'Old films');
    var byKind = {};
    r.body.items.forEach(function (i) { (byKind[i.kind] = byKind[i.kind] || []).push(i); });
    assert.deepEqual(byKind.video.map(function (i) { return i.label; }), ['Film One (1931)', 'norange.mp4', 'clip.webm'],
      'a directory listing\'s <pre> read too; og:video is the same file: once');
    assert.match(byKind.video[0].ref, /^r_[0-9a-f]{32}$/);
    assert.equal(byKind.magnet[0].infoHash, 'c'.repeat(40));
    assert.equal(byKind.magnet[0].label, 'Film.Two.1932');
    assert.equal(byKind.torrent[0].label, 'film.torrent', 'a generic link text gives way to the file name');
    assert.equal(byKind.torrent[0].url, webBase + '/files/film.torrent');
    assert.equal(byKind.hls[0].url, webBase + '/hls/index.m3u8');
    assert.match(byKind.hls[0].ref, /^h_[0-9a-f]{32}$/);
  });
});

test('a video file, a .torrent, a magnet: what each is', function () {
  return Promise.all([
    call('POST', '/admin/links/inspect', { url: webBase + '/files/Film.One.mp4' }),
    call('POST', '/admin/links/inspect', { url: webBase + '/files/film.torrent' }),
    call('POST', '/admin/links/inspect', { url: 'magnet:?xt=urn:btih:' + 'd'.repeat(40) })
  ]).then(function (r) {
    r.forEach(function (x) { assert.equal(x.status, 200, JSON.stringify(x.body)); conforms('LinkInspection', x.body); });
    assert.equal(r[0].body.kind, 'video');
    assert.equal(r[0].body.items[0].size, FILM.length);
    assert.equal(r[1].body.kind, 'torrent');
    assert.equal(r[1].body.items[0].label, 'Film.Three.1933');
    assert.match(r[1].body.items[0].infoHash, /^[0-9a-f]{40}$/);
    assert.equal(r[2].body.kind, 'magnet');
    assert.equal(r[2].body.items[0].infoHash, 'd'.repeat(40));
  });
});

test('refused: addresses on this network, not links, the admin only', function () {
  var saved = cookie;
  return Promise.all([
    call('POST', '/admin/links/inspect', { url: 'http://10.0.0.1/router' }),
    call('POST', '/admin/links/inspect', { url: 'ftp://example.org/x' }),
    call('POST', '/admin/links/inspect', {})
  ]).then(function (r) {
    assert.equal(r[0].status, 400);
    assert.match(r[0].body.error, /internet/);
    assert.equal(r[1].status, 400);
    assert.equal(r[2].status, 400);
    cookie = null;
    return Promise.all([call('POST', '/admin/links/inspect', { url: webBase + '/page' }), call('GET', '/downloads/direct')]);
  }).then(function (r) {
    cookie = saved;
    assert.equal(r[0].status, 401);
    assert.equal(r[1].status, 401);
  });
});

test('a direct download: the file\'s bytes in the download folder, the same name twice kept apart', function () {
  var first, second;
  return call('POST', '/admin/links/inspect', { url: webBase + '/files/Film.One.mp4' }).then(function (r) {
    var ref = r.body.items[0].ref;
    return Promise.all([call('POST', '/downloads/direct', { ref: ref }), call('POST', '/downloads/direct', { ref: ref })]);
  }).then(function (r) {
    assert.equal(r[0].status, 200, JSON.stringify(r[0].body));
    conforms('DirectDownload', r[0].body);
    first = r[0].body;
    second = r[1].body;
    assert.equal(first.source.by, 'links');
    assert.equal(first.source.host, webBase.replace('http://', ''));
    // the ref's name: the page's link text when the page was read first (one ref per URL)
    var stem = first.name.replace(/\.mp4$/, '');
    assert.equal(second.name, stem + ' (2).mp4');
    return helpers.until(function () {
      return Promise.all([directOne(first.id), directOne(second.id)]).then(function (d) {
        return d.every(function (x) { return x.state === 'completed'; }) && d;
      });
    }, 20000, 'both complete');
  }).then(function (d) {
    conforms('DirectDownload', d[0]);
    assert.equal(d[0].size, FILM.length);
    assert.equal(d[0].received, FILM.length);
    assert.equal(d[0].path, path.join(downloadDir(), d[0].name));
    assert.ok(fs.readFileSync(path.join(downloadDir(), first.name)).equals(FILM));
    assert.ok(fs.readFileSync(path.join(downloadDir(), second.name)).equals(FILM));
    assert.ok(!fs.existsSync(path.join(downloadDir(), first.name + '.part')));
    return call('DELETE', '/downloads/direct/' + second.id + '?files=1');
  }).then(function (r) {
    assert.equal(r.status, 204);
    assert.ok(!fs.existsSync(path.join(downloadDir(), second.name)), 'files=1 deletes the file');
    assert.ok(fs.existsSync(path.join(downloadDir(), first.name)));
  });
});

test('paused and started again: it resumes where it stopped, the same bytes; a server without ranges starts over', function () {
  var id, pausedAt;
  return call('POST', '/admin/links/inspect', { url: webBase + '/files/slow.mkv' }).then(function (r) {
    return call('POST', '/downloads/direct', { ref: r.body.items[0].ref, name: 'Slow film.mkv' });
  }).then(function (r) {
    id = r.body.id;
    return helpers.until(function () {
      return directOne(id).then(function (d) { return d.received > 300 * 1024 && d; });
    }, 20000, 'a few chunks');
  }).then(function () {
    return call('POST', '/downloads/direct/' + id + '/pause');
  }).then(function (r) {
    assert.equal(r.body.state, 'paused');
    pausedAt = fs.statSync(path.join(downloadDir(), 'Slow film.mkv.part')).size;
    assert.ok(pausedAt > 0 && pausedAt < SLOW.length, 'a partial file kept: ' + pausedAt);
    return call('POST', '/downloads/direct/' + id + '/start');
  }).then(function () {
    return helpers.until(function () {
      return directOne(id).then(function (d) { return d.state === 'completed' && d; });
    }, 30000, 'complete after the resume');
  }).then(function () {
    assert.ok(fs.readFileSync(path.join(downloadDir(), 'Slow film.mkv')).equals(SLOW), 'the same bytes as the source');
    return call('POST', '/admin/links/inspect', { url: webBase + '/files/norange.mp4' });
  }).then(function (r) {
    return call('POST', '/downloads/direct', { ref: r.body.items[0].ref });
  }).then(function (r) {
    return helpers.until(function () {
      return directOne(r.body.id).then(function (d) { return d.state === 'completed' && d; });
    }, 20000, 'the file without ranges');
  }).then(function (d) {
    assert.ok(fs.readFileSync(path.join(downloadDir(), d.name)).equals(FILM));
  });
});

test('refused downloads: a torrent\'s ref, an unknown ref', function () {
  return Promise.all([
    call('POST', '/downloads/direct', { ref: 't_' + 'a'.repeat(40) + '_' + 'b'.repeat(16) }),
    call('POST', '/downloads/direct', { ref: 'r_' + 'e'.repeat(32) }),
    call('POST', '/downloads/direct/nope/start')
  ]).then(function (r) {
    assert.equal(r[0].status, 400);
    assert.equal(r[1].status, 404);
    assert.equal(r[2].status, 404);
  });
});

test('an HLS stream: saved by ffmpeg into one file', { skip: !hasFfmpeg && 'no ffmpeg' }, function () {
  return call('POST', '/admin/links/inspect', { url: webBase + '/hls/index.m3u8' }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'hls');
    return call('POST', '/downloads/direct', { ref: r.body.items[0].ref, name: 'Test stream' });
  }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'hls');
    assert.equal(r.body.name, 'Test stream.mkv');
    return helpers.until(function () {
      return directOne(r.body.id).then(function (d) { return (d.state === 'completed' || d.state === 'error') && d; });
    }, 30000, 'the stream saved');
  }).then(function (d) {
    assert.equal(d.state, 'completed', d.error);
    var probe = childProcess.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0',
      path.join(downloadDir(), 'Test stream.mkv')]).stdout.toString().trim().split('\n').sort();
    assert.deepEqual(probe, ['audio', 'video']);
  });
});

test('http.request timeoutMs: a shorter wait for a site that never answers; under 1 s refused', function () {
  var who = { id: 'wait-test', anyHost: true, openStream: true, permissions: {} },
    started = Date.now();
  return pluginHttp.request(who, { url: webBase + '/hang', timeoutMs: 1000 }).then(function () {
    assert.fail('answered');
  }, function (err) {
    assert.equal(err.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 3000, 'gave up after about a second: ' + (Date.now() - started) + ' ms');
    return pluginHttp.request(who, { url: webBase + '/page', timeoutMs: 500 });
  }).then(function () {
    assert.fail('accepted');
  }, function (err) {
    assert.equal(err.code, 'INVALID');
  });
});
