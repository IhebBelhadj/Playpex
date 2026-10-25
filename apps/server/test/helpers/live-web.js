'use strict';

// A made-up IPTV provider for tests (docs/providers-plan.md step 9), on
// 127.0.0.2 (a fake resolver points *.playpex-test.dev there):
//
//   http://iptv.playpex-test.dev:<httpPort>   plain http, as IPTV providers often are (the admin's address: granted)
//     /get.php                 an M3U of `channels` channels (default 300) in 5 groups, url-tvg = the guide below;
//                              even channels have a tvg-id, odd ones are matched by name ("Channel 7" ↔ "Channel 7 HD")
//     /live/<n>.ts             a continuous MPEG-TS (channels not divisible by 3)
//     /live/<n>.m3u8           a live HLS playlist whose segments are on cdn. (a host the playlist doesn't list)
//     /logos/<n>.png           a logo (even channels)
//   https://{epg,cdn,logos}.playpex-test.dev:<httpsPort>
//     /guide.xml.gz            XMLTV, 30-min programmes from 12 h ago over `days` days (default 8: > 50 MB unpacked)
//     /seg/<k>.ts              the live playlists' segments
//     /<n>.png                 a logo (odd channels)
//   the last channel streams from evil.playpex-test.dev, which resolves to loopback
//
//   start({ channels?, days? }) → Promise<{ playlist, guide, http(), stats, stop() } | null>   null without openssl
//   streams need ffmpeg (made once): `streams` false without it

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  zlib = require('zlib'),
  childProcess = require('child_process');

var ADDRESS = '127.0.0.2',
  GROUPS = ['News', 'Sport', 'Kids', 'Films', 'Music'],
  SEGMENT_S = 2,
  PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function certificate(dir) {
  var made = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=playpex-test',
    '-addext', 'subjectAltName=DNS:*.playpex-test.dev'], { stdio: 'ignore' });
  return made.status === 0 ? { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) } : null;
}

function streams(dir) {
  var ok = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=24',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50',
    '-sc_threshold', '0', '-c:a', 'aac', '-ac', '2', '-f', 'hls', '-hls_time', String(SEGMENT_S), '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'seg%d.ts'), path.join(dir, 'vod.m3u8')], { stdio: 'ignore' }).status === 0 &&
    childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'mp2',
      '-f', 'mpegts', path.join(dir, 'stream.ts')], { stdio: 'ignore' }).status === 0;
  if (!ok) {
    return null;
  }
  return fs.readdirSync(dir).filter(function (f) { return /^seg\d+\.ts$/.test(f); }).length;
}

function name(n) {
  return 'Channel ' + n;
}

function playlist(o) {
  var lines = ['#EXTM3U url-tvg="https://epg.playpex-test.dev:' + o.httpsPort + '/guide.xml.gz"'];
  for (var n = 1; n <= o.channels; n++) {
    var attrs = (n % 2 === 0 ? 'tvg-id="ch' + n + '.test" ' : '') + 'tvg-name="' + name(n) + '" ' +
      'tvg-logo="' + (n % 2 === 0 ? 'http://iptv.playpex-test.dev:' + o.httpPort + '/logos/' + n + '.png' : 'https://logos.playpex-test.dev:' + o.httpsPort + '/' + n + '.png') + '" ' +
      'group-title="' + GROUPS[n % GROUPS.length] + '"' + (n <= 10 ? ' tvg-chno="' + (100 + n) + '"' : '');
    lines.push('#EXTINF:-1 ' + attrs + ',' + name(n));
    if (n === 1) {
      lines.push('#EXTVLCOPT:http-user-agent=PlaypexTestBox/1.0');
    }
    lines.push(n === o.channels ? 'http://evil.playpex-test.dev:' + o.httpPort + '/live/' + n + '.ts'
      : 'http://iptv.playpex-test.dev:' + o.httpPort + '/live/' + n + (n % 3 === 0 ? '.m3u8' : '.ts'));
  }
  return lines.join('\n') + '\n';
}

function stamp(ms) {
  var d = new Date(ms), p = function (x) { return ('0' + x).slice(-2); };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + '00 +0000';
}

// A big XMLTV guide, gzipped: { gz, size (unpacked), programmes, first (ms) }
function guide(o) {
  var first = Math.floor((Date.now() - 12 * 3600000) / 1800000) * 1800000,
    slots = o.days * 48,
    filler = ' A long description of what happens, with enough words to weigh like a real guide\'s text does in the wild.',
    gzip = zlib.createGzip({ level: 1 }), chunks = [], size = 0, count = 0;
  gzip.on('data', function (c) { chunks.push(c); });
  function write(text) {
    size += Buffer.byteLength(text);
    gzip.write(text);
  }
  write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="playpex-test">\n');
  for (var n = 1; n <= o.channels; n++) {
    write('  <channel id="' + (n % 2 === 0 ? 'ch' + n + '.test' : 'x' + n) + '"><display-name>' + name(n) + (n % 2 ? ' HD' : '') + '</display-name></channel>\n');
  }
  for (n = 1; n <= o.channels; n++) {
    var id = n % 2 === 0 ? 'ch' + n + '.test' : 'x' + n, out = '';
    for (var k = 0; k < slots; k++) {
      var start = first + k * 1800000;
      out += '  <programme start="' + stamp(start) + '" stop="' + stamp(start + 1800000) + '" channel="' + id + '">' +
        '<title lang="en">Show ' + k + ' on ' + name(n) + '</title><sub-title>Part ' + (k % 7 + 1) + '</sub-title>' +
        '<desc lang="en">Episode ' + k + ' of the show on ' + name(n) + '.' + filler + filler + '</desc>' +
        '<category lang="en">' + GROUPS[n % GROUPS.length] + '</category>' +
        '<episode-num system="xmltv_ns">' + (k % 3) + '.' + (k % 10) + '.</episode-num></programme>\n';
      count++;
    }
    write(out);
  }
  write('</tv>\n');
  return new Promise(function (resolve) {
    gzip.on('end', function () { resolve({ gz: Buffer.concat(chunks), size: size, programmes: count, first: first }); });
    gzip.end();
  });
}

function start(options) {
  options = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-live-web-')),
    tls = certificate(dir);
  if (!tls) {
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve(null);
  }
  var o = { channels: options.channels || 300, days: options.days || 8, httpPort: 0, httpsPort: 0 },
    segments = childProcess.spawnSync('ffmpeg', ['-version']).status === 0 ? streams(dir) : null,
    stats = { requests: {}, userAgents: {} },
    startedAt = Date.now(),
    made = null;

  function count(key) {
    stats.requests[key] = (stats.requests[key] || 0) + 1;
  }

  function livePlaylist() {
    var first = Math.floor((Date.now() - startedAt) / 1000 / SEGMENT_S),
      lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + SEGMENT_S, '#EXT-X-MEDIA-SEQUENCE:' + first];
    for (var i = first; i < first + 3; i++) {
      if (i > first && i % segments === 0) {
        lines.push('#EXT-X-DISCONTINUITY');
      }
      lines.push('#EXTINF:' + SEGMENT_S + '.000,', 'https://cdn.playpex-test.dev:' + o.httpsPort + '/seg/' + (i % segments) + '.ts');
    }
    return lines.join('\n') + '\n';
  }

  function continuous(res) {
    var file = fs.readFileSync(path.join(dir, 'stream.ts')), sent = 0, step = Math.ceil(file.length / 60);
    res.setHeader('Content-Type', 'video/mp2t');
    res.write(file.subarray(0, step * 4));
    sent = step * 4;
    var timer = setInterval(function () {
      if (sent >= file.length || res.destroyed) {
        clearInterval(timer);
        return res.end();
      }
      res.write(file.subarray(sent, sent + step));
      sent += step;
    }, 500);
    res.on('close', function () { clearInterval(timer); });
  }

  var plain = http.createServer(function (req, res) {
    var url = new URL(req.url, 'http://x'), m;
    count('http ' + url.pathname.replace(/\d+/g, 'N'));
    stats.userAgents[url.pathname] = req.headers['user-agent'];
    if (url.pathname === '/get.php') {
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      return res.end(playlist(o));
    }
    if ((m = /^\/logos\/(\d+)\.png$/.exec(url.pathname))) {
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    if (segments && (m = /^\/live\/(\d+)\.ts$/.exec(url.pathname))) {
      return continuous(res);
    }
    if (segments && (m = /^\/live\/(\d+)\.m3u8$/.exec(url.pathname))) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(livePlaylist());
    }
    res.statusCode = 404;
    res.end();
  });

  var secure = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
    var url = new URL(req.url, 'https://x'), host = String(req.headers.host || '').split(':')[0], m;
    count('https ' + host.split('.')[0] + ' ' + url.pathname.replace(/\d+/g, 'N'));
    if (url.pathname === '/guide.xml.gz' && host === 'epg.playpex-test.dev') {
      res.setHeader('Content-Type', 'application/gzip');
      return res.end(made.gz);
    }
    if (segments && (m = /^\/seg\/(\d+)\.ts$/.exec(url.pathname)) && host === 'cdn.playpex-test.dev') {
      res.setHeader('Content-Type', 'video/mp2t');
      return res.end(fs.readFileSync(path.join(dir, 'seg' + m[1] + '.ts')));
    }
    if (/^\/\d+\.png$/.test(url.pathname) && host === 'logos.playpex-test.dev') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    res.statusCode = 404;
    res.end();
  });

  function listen(s) {
    return new Promise(function (resolve) {
      s.listen(0, ADDRESS, function () { resolve(s.address().port); });
    });
  }

  return Promise.all([listen(plain), listen(secure)]).then(function (ports) {
    o.httpPort = ports[0];
    o.httpsPort = ports[1];
    return guide(o);
  }).then(function (g) {
    made = g;
    return {
      channels: o.channels,
      streams: !!segments,
      playlist: 'http://iptv.playpex-test.dev:' + o.httpPort + '/get.php?username=test&password=test&type=m3u_plus',
      guide: 'https://epg.playpex-test.dev:' + o.httpsPort + '/guide.xml.gz',
      guideSize: g.size,
      guideGz: g.gz.length,
      programmes: g.programmes,
      first: g.first,
      ports: o,
      stats: stats,
      lookup: function (host, opts, callback) {
        var to = /\.playpex-test\.dev$/.test(host) ? (host === 'evil.playpex-test.dev' ? '127.0.0.1' : ADDRESS) : null;
        if (!to) {
          return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        }
        callback(null, [{ address: to, family: 4 }]);
      },
      http: function () {
        return { lookup: this.lookup, ports: [], ca: tls.cert, allowAddresses: [ADDRESS] };
      },
      stop: function () {
        return Promise.all([plain, secure].map(function (s) {
          return new Promise(function (done) {
            s.closeAllConnections();
            s.close(function () { done(); });
          });
        })).then(function () {
          fs.rmSync(dir, { recursive: true, force: true });
        });
      }
    };
  });
}

module.exports = { start: start, GROUPS: GROUPS, name: name };
