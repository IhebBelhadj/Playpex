'use strict';

// Plugins' HLS and live streams (docs/providers-plan.md step 8) on a real
// server: a test plugin offers the made-up web of test/helpers/hls-web.js
// (HTTPS on 127.0.0.2, a fake resolver, ffmpeg-made streams, the plugin's
// token on every request).
//
//   an hls source plays as h_… (format hls, group stream) · no URL or token reaches a client
//   the master, its variants (relative, absolute on another host), AES-128 keys, fMP4 maps: every URI rewritten
//   ffmpeg plays the proxied playlist end to end (keys and all) · tokens can't be forged · ranges passed on
//   a live playlist is fetched again (its window moves) · streaming.maxLive · a released slot is free at once
//   a continuous MPEG-TS plays as l_…: Matroska, H.264 copied, audio AAC · live sources stay out of play.collect
//   a segment on a host resolving to loopback, or redirected there, is refused · probe / tracks: 501

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-hls-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  settings = require('../lib/settings'),
  hls = require('../lib/media/hls'),
  hlsWeb = require('./helpers/hls-web');

var web = null,
  base = null,
  MOVIE = { kind: 'movie', tmdbId: 42, title: 'Film', year: 2020 };

var STREAMER = String.raw`
var WEB = 'https://web.playpex-test.dev:PORT', AUTH = { Authorization: 'Bearer hls-token' };
playpex.hooks.on('play.collect', function () {
  return [
    { kind: 'hls', url: WEB + '/vod/master.m3u8', headers: AUTH, label: 'Film (HLS) 1080p', quality: '1080p' },
    { kind: 'live', url: WEB + '/tv/stream.ts', headers: AUTH, label: 'Not for titles' }
  ];
});
function play(source) {
  return { data: null, effects: [{ type: 'play', request: { title: 'Channel', sources: [Object.assign({ headers: AUTH }, source)], tracking: 'none' } }] };
}
playpex.data('live', function () { return play({ kind: 'live', url: WEB + '/tv/stream.ts', label: 'Test TV' }); });
playpex.data('liveHls', function () { return play({ kind: 'live', url: WEB + '/live/index.m3u8', label: 'Test News' }); });
playpex.data('evil', function () { return play({ kind: 'hls', url: WEB + '/evil/index.m3u8', label: 'Evil' }); });
`;

function writePlugin(id, permissions, code) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: id, name: 'Streamer', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: permissions
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  return dir;
}

function call(method, apiPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL(apiPath.indexOf('/api/') === 0 ? apiPath : '/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {}, headers)
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks), json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, raw: raw, text: raw.toString('latin1') });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The first `bytes` of a continuous answer, then the request is dropped
function head(apiPath, bytes, headers) {
  return new Promise(function (resolve, reject) {
    var req = http.get(new URL('/api/v1' + apiPath, base), { agent: false, headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, headers) }, function (res) {
      var chunks = [], size = 0, done = false;
      function finish() {
        if (!done) {
          done = true;
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) });
        }
      }
      res.on('data', function (c) {
        chunks.push(c);
        size += c.length;
        if (size >= bytes) {
          finish();
        }
      });
      res.on('end', finish);
    });
    req.on('error', function (err) {
      if (err.code !== 'ECONNRESET') {
        reject(err);
      }
    });
  });
}

// A URI of a playlist served at `from` (an API path), as an API path
function at(from, uri) {
  return new URL(uri, 'http://x' + (from.indexOf('/api/') === 0 ? '' : '/api/v1') + from).pathname;
}

// The URIs of a playlist (its non-tag lines) and its URI="…" attributes
function uris(text) {
  var out = [];
  text.split('\n').forEach(function (l) {
    if (l && l[0] !== '#') {
      out.push(l);
    }
    l.replace(/URI="([^"]*)"/g, function (all, u) { out.push(u); });
  });
  return out;
}

// A child process (async: the server under test runs in this process)
function run(command, args) {
  return new Promise(function (resolve) {
    var child = childProcess.spawn(command, args), out = '', err = '';
    var timer = setTimeout(function () { child.kill('SIGKILL'); }, 60000);
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { err += d; });
    child.on('close', function (status) {
      clearTimeout(timer);
      resolve({ status: status, stdout: out, stderr: err });
    });
  });
}

function ffmpegAvailable() {
  return childProcess.spawnSync('ffprobe', ['-version']).status === 0;
}

test.before(function () {
  return hlsWeb.start().then(function (w) {
    web = w;
    if (!web) {
      return;
    }
    var dir = writePlugin('streamer', {
      network: web.hosts.concat('loop.playpex-test.dev'), play: true, sources: ['hls', 'live'], hooks: ['play.collect']
    }, STREAMER.replace(/PORT/g, String(web.port)));
    return server.start({
      port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
      plugins: { dirs: [dir], http: web.http() }
    }).then(function (info) {
      base = 'http://127.0.0.1:' + info.port;
      var until = Date.now() + 20000;
      return new Promise(function (resolve, reject) {
        (function poll() {
          var p = plugins.get('streamer');
          if (p && p.state !== 'loading') {
            return p.state === 'enabled' ? resolve() : reject(new Error('streamer: ' + p.state + ' ' + p.error));
          }
          if (Date.now() > until) {
            return reject(new Error('streamer not loaded'));
          }
          setTimeout(poll, 50);
        })();
      });
    });
  });
});

test.after(function () {
  return (base ? server.stop() : Promise.resolve()).then(function () {
    return web && web.stop();
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function skip(t) {
  if (!web) {
    t.skip('openssl and ffmpeg are needed for the HLS test web');
    return true;
  }
  return false;
}

var vod = null;   // the hls source of play.collect

test('an hls source plays as an h_ ref, format hls, in the stream group; live ones stay out of titles', function (t) {
  if (skip(t)) {
    return;
  }
  return call('POST', '/play/sources', MOVIE).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var found = r.json.sources.filter(function (s) { return s.plugin === 'streamer'; });
    assert.equal(found.length, 1, JSON.stringify(found));
    vod = found[0];
    assert.match(vod.ref, /^h_[0-9a-f]{32}$/);
    assert.equal(vod.id, vod.ref);
    assert.equal(vod.type, 'plugin');
    assert.equal(vod.format, 'hls');
    assert.equal(vod.group, 'stream');
    assert.equal(vod.readiness, 'instant');
    assert.ok(r.json.errors.some(function (e) { return e.handler === 'plugin:streamer' && /live sources/.test(e.message); }), JSON.stringify(r.json.errors));
    assert.doesNotMatch(r.text, /playpex-test|hls-token/);
  });
});

test('GET /media/h_… sends to its playlist; probe and tracks aren\'t for streams', function (t) {
  if (skip(t)) {
    return;
  }
  return call('GET', '/media/' + vod.ref).then(function (r) {
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, vod.ref + '/index.m3u8');
    return Promise.all(['probe', 'tracks', 'transcode', 'subtitles'].map(function (route) {
      return call('GET', '/media/' + vod.ref + '/' + route);
    }));
  }).then(function (answers) {
    answers.forEach(function (r) {
      assert.equal(r.status, 501, r.text);
      assert.equal(r.json.code, 'NOT_SUPPORTED');
    });
  });
});

test('the master and its variants: every URI rewritten, keys and maps through the server', function (t) {
  if (skip(t)) {
    return;
  }
  var root = '/media/' + vod.ref + '/', tsAt, mp4At;
  return call('GET', root + 'index.m3u8').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['content-type'], 'application/vnd.apple.mpegurl');
    assert.match(r.text, /^#EXTM3U/);
    assert.doesNotMatch(r.text, /playpex-test|https?:/);
    var variants = uris(r.text);
    assert.equal(variants.length, 2);
    assert.match(variants[0], /^r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/index\.m3u8$/);
    assert.match(variants[1], /^r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/index\.m3u8$/);
    tsAt = at(root + 'index.m3u8', variants[0]);
    mp4At = at(root + 'index.m3u8', variants[1]);
    return Promise.all([call('GET', tsAt), call('GET', mp4At)]);
  }).then(function (lists) {
    var ts = lists[0], mp4 = lists[1];
    [ts, mp4].forEach(function (r) {
      assert.equal(r.status, 200, r.text);
      assert.doesNotMatch(r.text, /playpex-test|https?:/);
      assert.match(r.text, /#EXT-X-ENDLIST/);
    });
    assert.match(ts.text, /#EXT-X-KEY:METHOD=AES-128,URI="\.\.\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/1"/);
    assert.match(mp4.text, /#EXT-X-MAP:URI="\.\.\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/init\.mp4"/);
    assert.match(ts.text, /\n\.\.\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/seg0\.ts\n/);
    var key = /URI="([^"]+)"/.exec(ts.text)[1],
      first = uris(ts.text).filter(function (u) { return u !== key; })[0],
      init = /URI="([^"]+)"/.exec(mp4.text)[1];
    return Promise.all([
      call('GET', at(tsAt, key)),
      call('GET', at(tsAt, first)),
      call('GET', at(tsAt, first), undefined, { Range: 'bytes=100-299' }),
      call('GET', at(mp4At, init))
    ]);
  }).then(function (parts) {
    assert.deepEqual(parts[0].raw, web.key, 'the AES-128 key, from its own host: ' + parts[0].text + ' ' + tsAt);
    assert.equal(parts[1].status, 200);
    assert.deepEqual(parts[1].raw, fs.readFileSync(path.join(web.dir, 'vod/ts/seg0.ts')));
    assert.equal(parts[1].headers['content-type'], 'video/mp2t');
    assert.equal(parts[2].status, 206);
    assert.deepEqual(parts[2].raw, fs.readFileSync(path.join(web.dir, 'vod/ts/seg0.ts')).subarray(100, 300));
    assert.equal(parts[3].status, 200);
    assert.deepEqual(parts[3].raw, fs.readFileSync(path.join(web.dir, 'vod/mp4/init.mp4')));
  });
});

test('a token can\'t be forged or used for another ref', function (t) {
  if (skip(t)) {
    return;
  }
  var root = '/media/' + vod.ref + '/';
  return call('GET', root + 'index.m3u8').then(function (r) {
    var token = uris(r.text)[0].split('/')[1],
      payload = Buffer.from('shttps://web.playpex-test.dev:' + web.port + '/vod/ts/seg1.ts').toString('base64url');
    return Promise.all([
      call('GET', root + 'r/' + payload + token.slice(token.indexOf('.')) + '/seg1.ts'),
      call('GET', root + 'r/' + token.slice(0, -2) + 'AA/index.m3u8'),
      call('GET', '/media/h_' + '0'.repeat(32) + '/r/' + token + '/index.m3u8')
    ]);
  }).then(function (answers) {
    answers.forEach(function (r) { assert.equal(r.status, 404, r.text); });
  });
});

test('ffmpeg plays the proxied playlist end to end (AES-128 and all)', function (t) {
  if (skip(t)) {
    return;
  }
  var url = base + '/api/v1/media/' + vod.ref + '/index.m3u8';
  return run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', url]).then(function (out) {
    assert.equal(out.status, 0, out.stderr);
    var info = JSON.parse(out.stdout);
    assert.ok(Math.abs(parseFloat(info.format.duration) - 12) < 1.5, out.stdout);
    var codecs = info.streams.map(function (s) { return s.codec_name; });
    assert.ok(codecs.indexOf('h264') !== -1 && codecs.indexOf('aac') !== -1, codecs.join());
    return run('ffmpeg', ['-v', 'error', '-i', url, '-map', '0', '-f', 'null', '-']);
  }).then(function (decoded) {
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(decoded.stderr.trim(), '', 'decoded without an error');
  });
});

test('a play effect\'s live playlist: an h_ ref, fetched again as it moves; maxLive; a released slot frees', function (t) {
  if (skip(t)) {
    return;
  }
  var ref, root, before;
  settings.update({ streaming: { maxLive: 1 } });
  return call('POST', '/plugins/streamer/data/liveHls', { args: {} }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var src = r.json.effects[0].request.sources[0];
    assert.deepEqual(Object.keys(src).sort(), ['format', 'kind', 'label', 'ref']);
    assert.equal(src.kind, 'media');
    assert.equal(src.format, 'hls');
    assert.match(src.ref, /^h_/);
    assert.doesNotMatch(r.text, /playpex-test|hls-token/);
    ref = src.ref;
    root = '/media/' + ref + '/';
    return call('GET', root + 'index.m3u8');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /#EXT-X-ENDLIST/);
    assert.match(r.text, /#EXT-X-KEY:METHOD=AES-128,URI="r\/[^"]+\/1"/);
    before = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(r.text)[1];
    return call('GET', root + 'index.m3u8', undefined, { 'X-Playpex-Device': 'tv-2' });
  }).then(function (r) {
    assert.equal(r.status, 503, 'a second live viewer past maxLive 1');
    assert.equal(r.json.code, 'BUSY');
    return new Promise(function (resolve) { setTimeout(resolve, hlsWeb.SEGMENT_S * 1000 + 300); });
  }).then(function () {
    return call('GET', root + 'index.m3u8');
  }).then(function (r) {
    assert.equal(r.status, 200, 'the same viewer again');
    assert.notEqual(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(r.text)[1], before, 'fetched again: the window moved');
    return call('DELETE', '/media/' + ref);
  }).then(function () {
    return call('GET', root + 'index.m3u8', undefined, { 'X-Playpex-Device': 'tv-2' });
  }).then(function (r) {
    assert.equal(r.status, 200, 'the slot tv-1 let go');
    return call('DELETE', '/media/' + ref, undefined, { 'X-Playpex-Device': 'tv-2' });
  }).finally(function () {
    settings.update({ streaming: { maxLive: 2 } });
  });
});

test('a continuous MPEG-TS plays as l_…: Matroska, H.264 copied, its MP2 audio as AAC', function (t) {
  if (skip(t) || !ffmpegAvailable()) {
    return;
  }
  var ref;
  return call('POST', '/plugins/streamer/data/live', { args: {} }).then(function (r) {
    var src = r.json.effects[0].request.sources[0];
    assert.equal(src.format, 'live');
    assert.match(src.ref, /^l_[0-9a-f]{32}$/);
    ref = src.ref;
    return head('/media/' + ref, 400 * 1024);
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/x-matroska');
    assert.equal(r.headers['content-length'], undefined, 'no size');
    assert.deepEqual(r.raw.subarray(0, 4), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'an EBML (Matroska) header');
    var file = path.join(tmp, 'live.mkv');
    fs.writeFileSync(file, r.raw);
    var probe = childProcess.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    assert.deepEqual(probe.stdout.trim().split('\n').sort(), ['aac', 'h264']);
    return call('GET', '/media/' + ref + '/probe');
  }).then(function (r) {
    assert.equal(r.status, 501);
  });
});

test('a segment on a host resolving to loopback, or redirected there, is refused', function (t) {
  if (skip(t)) {
    return;
  }
  var root;
  return call('POST', '/plugins/streamer/data/evil', { args: {} }).then(function (r) {
    root = '/media/' + r.json.effects[0].request.sources[0].ref + '/';
    return call('GET', root + 'index.m3u8');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var parts = uris(r.text);
    assert.equal(parts.length, 2);
    return Promise.all(parts.map(function (u) { return call('GET', at(root + 'index.m3u8', u)); }));
  }).then(function (answers) {
    answers.forEach(function (r) {
      assert.equal(r.status, 502, r.text);
      assert.equal(r.json.code, 'UPSTREAM');
    });
  });
});

test('rewrite: renditions are playlists, keys files, data: URIs kept, relative and absolute resolved', function () {
  var entry = hls.register({ id: 'unit' }, { kind: 'hls', url: 'https://a.example/x/master.m3u8', label: 'Unit' });
  var done = hls.rewrite(entry, [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="https://b.example/subs.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
    '../v1/index.m3u8',
    ''
  ].join('\r\n'), 'https://a.example/x/master.m3u8', 'r/');
  assert.equal(done.master, true);
  assert.equal(done.live, false);
  var lines = done.text.split('\n');
  function target(token) {
    var payload = token.replace(/^(r|\.\.)\//, '').split('.')[0];
    return Buffer.from(payload, 'base64url').toString('utf8');
  }
  assert.equal(target(/URI="([^"]+)"/.exec(lines[1])[1]), 'phttps://a.example/x/audio/en.m3u8');
  assert.equal(target(/URI="([^"]+)"/.exec(lines[2])[1]), 'phttps://b.example/subs.m3u8');
  assert.equal(target(/URI="([^"]+)"/.exec(lines[3])[1]), 'phttps://a.example/x/iframes.m3u8');
  assert.match(lines[4], /URI="data:text\/plain;base64,AAAA"/);
  assert.equal(target(lines[6]), 'phttps://a.example/v1/index.m3u8');
  var media = hls.rewrite(entry, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg1.m4s\n', 'https://a.example/x/v.m3u8', '');
  assert.equal(media.live, true, 'no #EXT-X-ENDLIST');
  assert.equal(target(/URI="([^"]+)"/.exec(media.text)[1]), 'shttps://a.example/x/init.mp4');
  assert.equal(target(media.text.split('\n')[3]), 'shttps://a.example/x/seg1.m4s');
});
