'use strict';

// A made-up web of HLS streams for tests (docs/providers-plan.md step 8):
// an HTTPS server on 127.0.0.2 (a throwaway openssl certificate for
// *.playpex-test.dev) serving what ffmpeg made, every answer only with the
// plugin's token (`Authorization: Bearer hls-token`):
//
//   /vod/master.m3u8      a master playlist: a relative TS variant and an
//                         absolute fMP4 one on another host (cdn.)
//   /vod/ts/index.m3u8    VOD, AES-128: its key on a third host (keys.), segments relative
//   /vod/mp4/index.m3u8   VOD, fMP4: #EXT-X-MAP, segments relative
//   /live/index.m3u8      live: a window of 3 of the TS segments moving every 2 s, no #EXT-X-ENDLIST
//   /evil/index.m3u8      a segment on a host resolving to loopback, one redirected there
//   /tv/stream.ts         a continuous MPEG-TS (H.264 + MP2 audio), sent at about its own pace
//
//   start() → Promise<{ port, ca, lookup, hosts, stop() }>   null without openssl or ffmpeg
//   lookup: the fake resolver for lib/plugins/http.js (start option plugins.http)

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  https = require('https'),
  crypto = require('crypto'),
  childProcess = require('child_process');

var ADDRESS = '127.0.0.2',
  HOSTS = ['web.playpex-test.dev', 'cdn.playpex-test.dev', 'keys.playpex-test.dev'],
  TOKEN = 'Bearer hls-token',
  SEGMENT_S = 2;

function run(args, cwd) {
  return childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { cwd: cwd, stdio: 'ignore' }).status === 0;
}

function certificate(dir) {
  var made = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=playpex-test',
    '-addext', 'subjectAltName=DNS:*.playpex-test.dev'], { stdio: 'ignore' });
  return made.status === 0 ? { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) } : null;
}

// The streams, made once per run in `dir`
function make(dir, port) {
  var src = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12'],
    h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac', '-ac', '2'];
  ['vod/ts', 'vod/mp4', 'tv'].forEach(function (d) { fs.mkdirSync(path.join(dir, d), { recursive: true }); });
  var key = crypto.randomBytes(16);
  fs.writeFileSync(path.join(dir, 'enc.key'), key);
  fs.writeFileSync(path.join(dir, 'keyinfo'), 'https://keys.playpex-test.dev:' + port + '/keys/1\n' + path.join(dir, 'enc.key') + '\n');
  var ok = run(src.concat(h264, ['-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_playlist_type', 'vod',
      '-hls_key_info_file', path.join(dir, 'keyinfo'), '-hls_segment_filename', 'seg%d.ts', 'index.m3u8']), path.join(dir, 'vod/ts')) &&
    run(src.concat(h264, ['-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%d.m4s', 'index.m3u8']), path.join(dir, 'vod/mp4')) &&
    run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'mp2', '-f', 'mpegts', 'stream.ts'], path.join(dir, 'tv'));
  if (!ok) {
    return null;
  }
  fs.writeFileSync(path.join(dir, 'vod/master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x240,CODECS="avc1.42c00d,mp4a.40.2"',
    'ts/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x240,CODECS="avc1.42c00d,mp4a.40.2"',
    'https://cdn.playpex-test.dev:' + port + '/vod/mp4/index.m3u8',
    ''
  ].join('\n'));
  var segments = fs.readFileSync(path.join(dir, 'vod/ts/index.m3u8'), 'utf8').split('\n').filter(function (l) { return /^seg\d+\.ts$/.test(l); });
  return { key: key, segments: segments };
}

// A live window: 3 segments, moving one every SEGMENT_S seconds, round the VOD's
function livePlaylist(made, startedAt) {
  var n = made.segments.length,
    first = Math.floor((Date.now() - startedAt) / 1000 / SEGMENT_S),
    lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + SEGMENT_S, '#EXT-X-MEDIA-SEQUENCE:' + first,
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.playpex-test.dev/keys/1"'.replace('.dev/', '.dev:PORT/')];
  for (var i = first; i < first + 3; i++) {
    if (i > first && i % n === 0) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push('#EXTINF:' + SEGMENT_S.toFixed(3) + ',', '/vod/ts/' + made.segments[i % n]);
  }
  return lines.join('\n') + '\n';
}

function start() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-hls-web-'));
  var tls = certificate(dir);
  if (!tls || childProcess.spawnSync('ffmpeg', ['-version']).status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve(null);
  }
  var made = null, port = 0, startedAt = Date.now(), counts = {};
  var server = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
    var url = new URL(req.url, 'https://x'), host = String(req.headers.host || '').split(':')[0];
    counts[url.pathname] = (counts[url.pathname] || 0) + 1;
    if (req.headers.authorization !== TOKEN) {
      res.statusCode = 401;
      return res.end();
    }
    if (url.pathname === '/keys/1') {
      if (host !== 'keys.playpex-test.dev') {
        res.statusCode = 404;
        return res.end();
      }
      return res.end(made.key);
    }
    if (url.pathname === '/live/index.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(livePlaylist(made, startedAt).replace('PORT', String(port)));
    }
    if (url.pathname === '/evil/index.m3u8') {
      return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', 'https://loop.playpex-test.dev:' + port + '/vod/ts/seg0.ts',
        '#EXTINF:2,', '/evil/redirect', '#EXT-X-ENDLIST', ''].join('\n'));
    }
    if (url.pathname === '/evil/redirect') {
      res.writeHead(302, { Location: 'https://loop.playpex-test.dev:' + port + '/vod/ts/seg1.ts' });
      return res.end();
    }
    if (url.pathname === '/tv/stream.ts') {
      // about real time: 30 s of stream in 30 s
      var file = fs.readFileSync(path.join(dir, 'tv/stream.ts')), sent = 0, step = Math.ceil(file.length / 60);
      res.setHeader('Content-Type', 'video/mp2t');
      var timer = setInterval(function () {
        if (sent >= file.length || res.destroyed) {
          clearInterval(timer);
          return res.end();
        }
        res.write(file.subarray(sent, sent + step));
        sent += step;
      }, 500);
      res.write(file.subarray(0, step * 4));
      sent = step * 4;
      res.on('close', function () { clearInterval(timer); });
      return;
    }
    var file = path.join(dir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (url.pathname.indexOf('/vod/') !== 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    var bytes = fs.readFileSync(file), m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    res.setHeader('Content-Type', /\.m3u8$/.test(file) ? 'application/vnd.apple.mpegurl' : 'application/octet-stream');
    if (!m) {
      return res.end(bytes);
    }
    var from = +m[1], to = m[2] ? Math.min(+m[2], bytes.length - 1) : bytes.length - 1;
    res.writeHead(206, { 'Content-Range': 'bytes ' + from + '-' + to + '/' + bytes.length, 'Content-Length': to - from + 1 });
    res.end(bytes.subarray(from, to + 1));
  });
  return new Promise(function (resolve) {
    server.listen(0, ADDRESS, function () {
      port = server.address().port;
      made = make(dir, port);
      if (!made) {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        return resolve(null);
      }
      resolve({
        port: port,
        ca: tls.cert,
        dir: dir,
        key: made.key,
        hosts: HOSTS,
        token: TOKEN,
        counts: counts,
        base: 'https://web.playpex-test.dev:' + port,
        lookup: function (host, options, callback) {
          var to = HOSTS.indexOf(host) !== -1 ? ADDRESS : host === 'loop.playpex-test.dev' ? '127.0.0.1' : null;
          if (!to) {
            return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
          }
          callback(null, [{ address: to, family: 4 }]);
        },
        http: function () {
          return { lookup: this.lookup, ports: [port], ca: tls.cert, allowAddresses: [ADDRESS] };
        },
        stop: function () {
          return new Promise(function (done) {
            server.closeAllConnections();
            server.close(function () {
              fs.rmSync(dir, { recursive: true, force: true });
              done();
            });
          });
        }
      });
    });
  });
}

module.exports = { start: start, SEGMENT_S: SEGMENT_S };
