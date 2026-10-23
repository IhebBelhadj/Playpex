'use strict';

// Plugins in the play pipeline and the other P3 hooks (docs/plugins-plan.md
// step P3) on a real server: test plugins add sources, hide HEVC, ask before
// playing, resolve a "cached" torrent through a fake debrid, mark an intro,
// add a score, list releases and subtitles, and recognise a library file by
// absolute numbering. A local HTTPS server (openssl certificate, 127.0.0.2)
// is the web; its video answers ranges only with the plugin's token.
//
//   a plugin's source shows with its notes · a hidden one comes back in `hidden` with the reason
//   a throwing plugin changes nothing · the client never sees a URL or a token · /media/r_… streams ranges
//   a redirect to loopback is refused mid-stream · a resolver's torrent plays as http when picked
//   play.before asks, then plays when confirmed · markers, meta, releases, subtitles from plugins
//   a folder set to a matcher maps an absolute-numbered file; the admin's match still wins
//   ffprobe / ffmpeg read an http source through /media/r_…: AC-3 → AAC (with ffmpeg on the PATH)

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  crypto = require('crypto'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-play-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  library = require('../lib/library');

var TEST_HOST = '127.0.0.2',
  HOST = 'api.playpex-test.dev',
  VIDEO = crypto.randomBytes(1024 * 1024),
  C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40), F = 'f'.repeat(40),
  base = null,
  cookie = null,
  remote = null,
  remotePort = 0,
  tls = null,
  animeDir = path.join(tmp, 'anime'),
  FFMPEG = childProcess.spawnSync('ffmpeg', ['-version']).status === 0,
  dolby = null;   // an H.264 + AC-3 file the web serves, made with ffmpeg

// ── fixtures ────────────────────────────────────────────────────────────────

function manifest(id, extra) {
  return Object.assign({
    id: id, name: id[0].toUpperCase() + id.slice(1), version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: {}
  }, extra);
}

function writePlugin(id, extra, code) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(manifest(id, extra)));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  return dir;
}

var SOURCER = String.raw`
var WEB = 'https://${HOST}:PORT/video.mp4';
playpex.hooks.on('play.collect', function (input) {
  return [
    { kind: 'magnet', label: 'Film 2020 1080p WEB x264 AAC', infoHash: '${C}', seeds: 50, notes: ['From Sourcer'] },
    { kind: 'magnet', label: 'Film 2020 1080p WEB x265 HEVC', infoHash: '${D}', seeds: 80 },
    { kind: 'magnet', label: 'Film 2020 720p REFUSE x264 AAC', infoHash: '${F}', seeds: 5 },
    { kind: 'http', url: WEB, headers: { Authorization: 'Bearer secret-token' }, label: 'Film (web) 1080p x264 AAC', container: 'mp4' }
  ];
});
playpex.hooks.on('play.rank', function (input) {
  return { hide: input.sources.filter(function (s) { return s.codec === 'x265' || s.codec === 'hevc'; })
    .map(function (s) { return { id: s.id, reason: 'HEVC' }; }) };
});
playpex.hooks.on('play.before', function (input) {
  if (/REFUSE/.test(input.source.label)) {
    return { action: 'refuse', reason: 'Not this one' };
  }
  if (/\(web\)/.test(input.source.label)) {
    return { action: 'ask', question: 'Stream it from the web?', yes: 'Stream' };
  }
  return { action: 'continue' };
});
playpex.hooks.on('player.markers', function (input) {
  return [{ kind: 'credits', start: input.duration - 100 }, { kind: 'intro', start: 30, end: 90 }, { kind: 'chapter', start: 99999 }];
});
playpex.hooks.on('metadata.title', function () {
  return { meta: [{ kind: 'score', source: 'provider', value: 8.1, label: 'Test' }] };
});
playpex.hooks.on('releases.providers', function (input) {
  return { releases: [{ title: (input.query || 'Latest') + ' 2020 1080p x264', infoHash: '${E}', seeds: 5, size: 1000 }], last: true };
});
playpex.hooks.on('subtitles.providers', function (input) {
  return [{ id: 's1', language: 'en', label: 'English ' + input.title.imdbId, url: 'https://${HOST}:PORT/sub.srt', format: 'srt' }];
});
playpex.data('playWeb', function () {
  return { data: null, effects: [{ type: 'play', request: { title: 'Film', sources: [{ kind: 'http', url: WEB,
    headers: { Authorization: 'Bearer secret-token' }, label: 'Film (web)', container: 'mp4' }] } }] };
});
`;

var DEBRID = String.raw`
playpex.hooks.on('play.resolve', function (input) {
  if (input.mode === 'check') {
    var out = {};
    input.hashes.forEach(function (h) { if (h === '${C}') { out[h] = { cached: true, label: 'TestDebrid' }; } });
    return { hashes: out };
  }
  return { source: { kind: 'http', url: 'https://${HOST}:PORT/video.mp4', headers: { Authorization: 'Bearer d-token' },
    label: input.source.label, size: ${VIDEO.length} } };
});
`;

var THROWER = String.raw`
playpex.hooks.on('play.collect', function () { throw new Error('boom'); });
playpex.hooks.on('play.rank', function () { throw new Error('boom'); });
playpex.hooks.on('play.before', function () { return { action: 'maybe' }; });
`;

var SNEAKY = String.raw`
playpex.hooks.on('play.collect', function () {
  return [{ kind: 'http', url: 'https://${HOST}:PORT/to-loop', label: 'Sneaky 1080p', size: 1000 }];
});
`;

var DOLBY = String.raw`
playpex.hooks.on('play.collect', function () {
  return [{ kind: 'http', url: 'https://${HOST}:PORT/dolby.mkv', label: 'Dolby 2021 AC3', container: 'mkv' }];
});
`;

var MATCHER = String.raw`
playpex.hooks.on('library.match', function (input) {
  var m = /Anime - (\d+)\./.exec(input.file.relPath);
  return { identity: m ? { kind: 'episode', showTmdbId: 100, season: 1, episode: Number(m[1]) } : null };
});
`;

var catalog = {
  search: function () { return Promise.resolve([]); },
  movie: function () { return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } })); },
  tv: function (id) {
    return id === 100 ? Promise.resolve({ id: 100, name: 'Anime', first_air_date: '2020-01-01', external_ids: {} }) :
      Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
  },
  season: function (id, season) {
    return Promise.resolve({ episodes: Array.from({ length: 24 }, function (x, i) {
      return { id: id * 1000 + season * 100 + i + 1, episode_number: i + 1, name: 'Episode ' + (i + 1) };
    }) });
  },
  find: function () { return Promise.resolve({ movie_results: [], tv_results: [] }); }
};

function certificate() {
  var dir = path.join(tmp, 'tls');
  fs.mkdirSync(dir);
  var result = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=playpex-test',
    '-addext', 'subjectAltName=DNS:*.playpex-test.dev'], { stdio: 'ignore' });
  if (result.status !== 0) {
    return null;
  }
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

function lookup(host, options, callback) {
  var map = { 'api.playpex-test.dev': TEST_HOST, 'loop.playpex-test.dev': '127.0.0.1' };
  if (!map[host]) {
    return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  }
  callback(null, [{ address: map[host], family: 4 }]);
}

function ranges(req, res, bytes) {
  var m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.setHeader('Content-Length', bytes.length);
    return res.end(bytes);
  }
  var start = +m[1], end = m[2] ? Math.min(+m[2], bytes.length - 1) : bytes.length - 1;
  res.writeHead(206, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length, 'Content-Length': end - start + 1 });
  res.end(bytes.subarray(start, end + 1));
}

// The web: a video answering ranges to the right tokens, a subtitle, a redirect to loopback
function web(req, res) {
  var url = new URL(req.url, 'https://x');
  if (url.pathname === '/video.mp4') {
    var auth = req.headers.authorization;
    if (auth !== 'Bearer secret-token' && auth !== 'Bearer d-token') {
      res.statusCode = 401;
      return res.end();
    }
    return ranges(req, res, VIDEO);
  }
  if (url.pathname === '/dolby.mkv' && dolby) {
    return ranges(req, res, dolby);
  }
  if (url.pathname === '/sub.srt') {
    return res.end('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n');
  }
  if (url.pathname === '/to-loop') {
    res.writeHead(302, { Location: 'https://loop.playpex-test.dev:' + remotePort + '/video.mp4' });
    return res.end();
  }
  res.statusCode = 404;
  res.end();
}

function call(method, apiPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {},
        cookie ? { Cookie: cookie } : {}, headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks), json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, raw: raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

var MOVIE = { kind: 'movie', tmdbId: 42, title: 'Film', year: 2020 };

test.before(function () {
  tls = certificate();
  if (!tls) {
    return;
  }
  if (FFMPEG) {
    var file = path.join(tmp, 'dolby.mkv');
    var made = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-g', '50', '-c:a', 'ac3', '-ac', '6', file]);
    dolby = made.status === 0 ? fs.readFileSync(file) : null;
  }
  return new Promise(function (resolve) {
    remote = https.createServer({ key: tls.key, cert: tls.cert }, web);
    remote.listen(0, TEST_HOST, function () {
      remotePort = remote.address().port;
      resolve();
    });
  }).then(function () {
    function port(code) { return code.replace(/PORT/g, String(remotePort)); }
    var network = [HOST];
    var dirs = [
      writePlugin('sourcer', {
        permissions: {
          network: network, play: true, sources: ['magnet', 'http'],
          hooks: ['play.collect', 'play.rank', 'play.before', 'player.markers', 'metadata.title', 'releases.providers', 'subtitles.providers']
        }
      }, port(SOURCER)),
      writePlugin('debrid', { permissions: { network: network, sources: ['http'], hooks: ['play.resolve'] } }, port(DEBRID)),
      writePlugin('thrower', { permissions: { sources: ['magnet'], hooks: ['play.collect', 'play.rank', 'play.before'] } }, THROWER),
      writePlugin('sneaky', { permissions: { network: [HOST, 'loop.playpex-test.dev'], sources: ['http'], hooks: ['play.collect'] } }, port(SNEAKY)),
      writePlugin('matcher', { permissions: { files: true, hooks: ['library.match'] } }, MATCHER),
      writePlugin('dolby', { permissions: { network: network, sources: ['http'], hooks: ['play.collect'] } }, port(DOLBY))
    ];
    fs.mkdirSync(path.join(animeDir, 'Anime'), { recursive: true });
    fs.writeFileSync(path.join(animeDir, 'Anime', 'Anime - 13.mkv'), Buffer.alloc(2000, 1));
    fs.writeFileSync(path.join(animeDir, 'Anime', 'Anime - 14.mkv'), Buffer.alloc(2000, 2));
    return server.start({
      port: 0, console: false, torrents: { engine: 'fake', discovery: false },
      library: { catalog: catalog, firstScanMs: 3600000, downloadScanMs: 3600000 },
      plugins: { dirs: dirs, http: { lookup: lookup, ports: [remotePort], ca: tls.cert, allowAddresses: [TEST_HOST] } }
    });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 6 && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve();
        }
        if (Date.now() > until) {
          return reject(new Error('plugins not loaded: ' + JSON.stringify(all.map(function (p) { return [p.id, p.state, p.error]; }))));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function () {
    return call('POST', '/admin/setup', { username: 'admin', password: 'plugins-pass' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'plugins-pass' });
  }).then(function (res) {
    cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  return (base ? server.stop() : Promise.resolve()).then(function () {
    if (remote) {
      remote.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function skip(t) {
  if (!tls) {
    t.skip('openssl is needed for the HTTPS test server');
    return true;
  }
  return false;
}

// ── tests ───────────────────────────────────────────────────────────────────

test('every test plugin loaded', function (t) {
  if (skip(t)) {
    return;
  }
  plugins.list().forEach(function (p) {
    assert.equal(p.state, 'enabled', p.id + ': ' + p.error);
  });
});

test('plugin sources: added, hidden with a reason, cached, never a URL or token', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var body = r.json, ids = body.sources.map(function (s) { return s.id; });
    assert.ok(body.request);
    assert.ok(ids.indexOf('torrent:' + C) !== -1);
    assert.ok(ids.indexOf('torrent:' + D) === -1, 'the HEVC one is hidden');
    assert.deepEqual(body.hidden.map(function (h) { return [h.id, h.by, h.reason]; }), [['torrent:' + D, 'Sourcer', 'HEVC']]);

    var cached = body.sources.filter(function (s) { return s.id === 'torrent:' + C; })[0];
    assert.deepEqual(cached.resolver, { plugin: 'debrid', label: 'TestDebrid' });
    assert.ok(cached.badges.indexOf('cached') !== -1);
    assert.ok(cached.notes.indexOf('From Sourcer') !== -1);
    assert.ok(cached.notes.indexOf('Cached on TestDebrid') !== -1);
    assert.match(cached.magnet, /^magnet:\?xt=urn:btih:c{40}/);

    var webSource = body.sources.filter(function (s) { return s.type === 'plugin' && s.provider === 'sourcer'; })[0];
    assert.match(webSource.ref, /^r_[0-9a-f]{32}$/);
    assert.equal(webSource.id, webSource.ref);
    // what plays at once (the web source, the cached torrent) before the other torrents
    assert.ok(ids.indexOf(webSource.id) < ids.indexOf('torrent:' + F));
    assert.ok(ids.indexOf('torrent:' + C) < ids.indexOf('torrent:' + F));

    assert.doesNotMatch(r.text, /playpex-test\.dev|secret-token|d-token/, 'no URL, no token');
    assert.ok(body.errors.some(function (e) { return e.handler === 'plugin:thrower' && /boom/.test(e.message); }));
    assert.equal(body.policy.autoplay, null, 'a plugin\'s source is never autoplayed');
  });
});

test('/media/r_… streams the source\'s ranges through the server', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    var ref = r.json.sources.filter(function (s) { return s.type === 'plugin' && s.provider === 'sourcer'; })[0].ref;
    return Promise.all([
      call('GET', '/media/' + ref, undefined, { Range: 'bytes=100-199' }),
      call('GET', '/media/' + ref, undefined, { Range: 'bytes=1048000-' }),
      call('HEAD', '/media/' + ref)
    ]);
  }).then(function (res) {
    assert.equal(res[0].status, 206);
    assert.equal(res[0].headers['content-range'], 'bytes 100-199/' + VIDEO.length);
    assert.ok(res[0].raw.equals(VIDEO.subarray(100, 200)), 'the exact bytes');
    assert.equal(res[0].headers['content-type'], 'video/mp4');
    assert.equal(res[1].status, 206);
    assert.ok(res[1].raw.equals(VIDEO.subarray(1048000)));
    assert.equal(res[2].status, 200);
    assert.equal(Number(res[2].headers['content-length']), VIDEO.length);
    return call('GET', '/media/r_' + '0'.repeat(32));
  }).then(function (r) {
    assert.equal(r.status, 404, 'an unknown ref');
  });
});

test('a source redirecting to loopback is refused when it streams', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    var sneaky = r.json.sources.filter(function (s) { return s.provider === 'sneaky'; })[0];
    assert.ok(sneaky, 'listed (nothing is fetched until it plays)');
    return call('GET', '/media/' + sneaky.ref, undefined, { Range: 'bytes=0-99' });
  }).then(function (r) {
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'UPSTREAM');
    assert.match(r.json.error, /reach|address/i);
  });
});

test('start: a cached torrent plays through its resolver', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    return call('POST', '/play/start', { request: r.json.request, source: 'torrent:' + C });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.action, 'play');
    var s = r.json.source;
    assert.equal(s.type, 'plugin');
    assert.match(s.ref, /^r_/);
    assert.equal(s.infoHash, C);
    assert.deepEqual(s.notes, ['Through TestDebrid']);
    assert.doesNotMatch(r.text, /d-token|playpex-test/);
    return call('GET', '/media/' + s.ref, undefined, { Range: 'bytes=0-9' });
  }).then(function (r) {
    assert.equal(r.status, 206);
    assert.ok(r.raw.equals(VIDEO.subarray(0, 10)));
  });
});

test('start: play.before asks, then plays when confirmed; refuses; continues', function (t) {
  if (skip(t)) {
    return;
  }
  var request, webId;
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    request = r.json.request;
    webId = r.json.sources.filter(function (s) { return s.type === 'plugin' && s.provider === 'sourcer'; })[0].id;
    return call('POST', '/play/start', { request: request, source: webId });
  }).then(function (r) {
    assert.deepEqual(r.json, { action: 'ask', question: 'Stream it from the web?', yes: 'Stream', no: 'Cancel', by: 'Sourcer' });
    return call('POST', '/play/start', { request: request, source: webId, confirmed: true });
  }).then(function (r) {
    assert.equal(r.json.action, 'play');
    assert.equal(r.json.source.id, webId);
    return call('POST', '/play/start', { request: request, source: 'torrent:' + F });
  }).then(function (r) {
    assert.deepEqual(r.json, { action: 'refuse', reason: 'Not this one', by: 'Sourcer' });
    return Promise.all([
      call('POST', '/play/start', { request: 'nope', source: webId }),
      call('POST', '/play/start', { request: request, source: 'torrent:' + D }),
      call('POST', '/play/start', {})
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 404, 'an unknown request');
    assert.equal(r[1].status, 404, 'a hidden source can\'t be played');
    assert.equal(r[2].status, 400);
  });
});

test('a play effect\'s http source reaches the client as a media ref', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/plugins/sourcer/data/playWeb', { args: {} }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var src = r.json.effects[0].request.sources[0];
    assert.equal(src.kind, 'media');
    assert.match(src.ref, /^r_[0-9a-f]{32}$/);
    assert.doesNotMatch(r.text, /playpex-test|secret-token/);
  });
});

test('markers: by start, within the duration', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/markers', Object.assign({ duration: 1400, fileName: 'Film.mp4' }, MOVIE)).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.markers, [
      { plugin: 'sourcer', kind: 'intro', start: 30, end: 90 },
      { plugin: 'sourcer', kind: 'credits', start: 1300 }
    ]);
    return call('POST', '/play/markers', MOVIE);
  }).then(function (r) {
    assert.equal(r.status, 400, 'no duration');
  });
});

test('title meta from metadata.title', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/plugins/meta', { title: { kind: 'movie', tmdbId: 42 } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.meta, [{ plugin: 'sourcer', name: 'Sourcer', items: [{ kind: 'score', source: 'provider', value: 8.1, label: 'Test' }] }]);
    return call('POST', '/plugins/meta', { title: { kind: 'book' } });
  }).then(function (r) {
    assert.equal(r.status, 400);
  });
});

test('release lists from releases.providers', function (t) {
  if (skip(t)) {
    return;
  }
  return call('GET', '/releases/providers?kind=movie').then(function (r) {
    var mine = r.json.filter(function (p) { return p.id === 'plugin:sourcer'; })[0];
    assert.deepEqual(mine, { id: 'plugin:sourcer', name: 'Sourcer', paged: true, default: false });
    return call('GET', '/releases/browse?kind=movie&provider=plugin:sourcer&q=Film');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.provider, 'plugin:sourcer');
    assert.equal(r.json.torrents.length, 1);
    var tor = r.json.torrents[0];
    assert.equal(tor.hash, E);
    assert.equal(tor.name, 'Film 2020 1080p x264');
    assert.equal(tor.quality, '1080p');
    assert.equal(r.json.hasMore, false);
  });
});

test('subtitles from subtitles.providers, fetched by the server', function (t) {
  if (skip(t)) {
    return;
  }
  return call('GET', '/subtitles/providers').then(function (r) {
    assert.ok(r.json.some(function (p) { return p.id === 'plugin:sourcer' && p.enabled; }));
    return call('GET', '/subtitles/search?provider=plugin:sourcer&imdb_id=tt0000042&languages=en');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var sub = r.json.subtitles[0];
    assert.equal(sub.language, 'en');
    assert.equal(sub.name, 'English tt0000042');
    assert.doesNotMatch(r.text, /playpex-test/);
    return call('GET', '/subtitles/file?provider=plugin:sourcer&ref=' + sub.ref + '&lang=en');
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.match(r.text, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.500\nHello/);
    return call('GET', '/subtitles/file?provider=plugin:sourcer&ref=0000&lang=en');
  }).then(function (r) {
    assert.equal(r.status, 502, 'a ref the server didn\'t give');
  });
});

test('library.match: a folder set to a plugin recognises absolute numbering; the admin\'s match wins', function (t) {
  if (skip(t)) {
    return;
  }
  var folderId;
  function files() {
    return call('GET', '/admin/library/files?folder=' + folderId).then(function (r) {
      var out = {};
      r.json.files.forEach(function (f) { out[path.basename(f.relPath)] = f; });
      return out;
    });
  }
  function scanned() {
    return new Promise(function (resolve) {
      (function poll() {
        var s = library.status();
        return s.current || s.queued.length ? setTimeout(poll, 50) : resolve();
      })();
    });
  }
  return call('POST', '/admin/library/folders', { path: animeDir, kind: 'shows' }).then(function (r) {
    assert.equal(r.status, 201, r.text);
    folderId = r.json.id;
    assert.equal(r.json.matcher, null);
    return scanned();
  }).then(files).then(function (f) {
    assert.equal(f['Anime - 13.mkv'].item, null, 'Playpex\'s own rules can\'t read absolute numbering');
    return call('GET', '/admin/library');
  }).then(function (r) {
    assert.deepEqual(r.json.matchers, [{ id: 'matcher', name: 'Matcher' }]);
    return call('PATCH', '/admin/library/folders/' + folderId, { matcher: 'sourcer' });
  }).then(function (r) {
    assert.equal(r.status, 400, 'a plugin without library.match');
    return files();
  }).then(function (f) {
    // the admin matches 14 by hand to episode 2 first
    return call('PUT', '/admin/library/files/' + f['Anime - 14.mkv'].id + '/match', { kind: 'episode', showTmdbId: 100, season: 1, episode: 2 });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return call('PATCH', '/admin/library/folders/' + folderId, { matcher: 'matcher' });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.matcher, 'matcher');
    return new Promise(function (resolve) { setTimeout(resolve, 100); }).then(scanned);
  }).then(files).then(function (f) {
    var item = f['Anime - 13.mkv'].item;
    assert.ok(item, 'matched by the plugin');
    assert.deepEqual([item.kind, item.showTmdbId, item.season, item.episode], ['episode', 100, 1, 13]);
    var mine = f['Anime - 14.mkv'];
    assert.equal(mine.matchedBy, 'admin');
    assert.equal(mine.item.episode, 2, 'the admin\'s match wins');
    return call('PATCH', '/admin/library/folders/' + folderId, { matcher: null });
  }).then(function (r) {
    assert.equal(r.json.matcher, null);
    return scanned();
  });
});

test('ffprobe and the AC-3 → AAC transcode read an http source through /media/r_…', function (t) {
  if (skip(t)) {
    return;
  }
  if (!dolby) {
    return t.skip('ffmpeg is needed to make an AC-3 file');
  }
  var ref;
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    ref = r.json.sources.filter(function (s) { return s.provider === 'dolby'; })[0].ref;
    return call('GET', '/media/' + ref + '/probe');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.video, 'h264');
    assert.equal(r.json.audio[0].codec, 'ac3');
    assert.equal(r.json.transcode, true);
    return new Promise(function (resolve, reject) {
      var req = http.get(new URL('/api/v1/media/' + ref + '/transcode?t=0', base), { headers: { 'X-Playpex-Device': 'tv-1' } }, function (res) {
        var got = [], size = 0;
        res.on('data', function (c) {
          got.push(c);
          size += c.length;
          if (size >= 64 * 1024) {
            req.destroy();
            resolve({ status: res.statusCode, type: res.headers['content-type'], raw: Buffer.concat(got) });
          }
        });
        res.on('end', function () { resolve({ status: res.statusCode, type: res.headers['content-type'], raw: Buffer.concat(got) }); });
      });
      req.on('error', function (err) { if (err.code !== 'ECONNRESET') { reject(err); } });
    });
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.type, 'video/x-matroska');
    assert.ok(r.raw.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'an EBML (Matroska) header');
    return call('DELETE', '/media/' + ref);
  });
});
