'use strict';

// A made-up Stremio add-on and the web around it, for the bridge's tests
// (docs/stremio-bridge-plan.md §9: the core names no add-on; the shapes are
// the spike's, §12.1, the content invented). One HTTPS server on 127.0.0.2
// (a throwaway openssl certificate for *.playpex-test.dev) answering as:
//
//   addon.playpex-test.dev   the add-on: /manifest.json, /subs-only/manifest.json (another, subtitles only), and configured /cfg=<key>/manifest.json (another id hash),
//                            catalogs (paged by skip, genre, search), meta of its own fk: ids, streams, subtitles;
//                            /stream/movie/tt0000009.json answers 3 MB (refused)
//   debrid.playpex-test.dev  a debrid service: /dl/<n> redirects (302) to the CDN (a host no answer named)
//   cdn.playpex-test.dev     the files: /film.mp4 with byte ranges; /v.m3u8 a tiny HLS playlist and its segment
//   subs.playpex-test.dev    /<n>.srt
//   img.playpex-test.dev     /logo.png, /poster.png
//   api.playpex-test.dev     Stremio's account API: /api/login (stremio@example.test / right-pass), /api/addonCollectionGet,
//                            /api/logout (counted in `loggedOut`)
//   loop.playpex-test.dev    resolves to 127.0.0.1 (never reachable by plugins); debrid's /dl/evil redirects there
//
//   start() → Promise<{ port, url(path), http (the start option plugins.http), counts, asked, stop() }> | null without openssl

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  https = require('https'),
  childProcess = require('child_process');

var ADDRESS = '127.0.0.2',
  FILM = Buffer.alloc(256 * 1024, 0),
  // a 1×1 PNG
  PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

for (var i = 0; i < FILM.length; i++) {
  FILM[i] = i % 251;
}

function certificate(dir) {
  var made = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=playpex-test',
    '-addext', 'subjectAltName=DNS:*.playpex-test.dev'], { stdio: 'ignore' });
  return made.status === 0 ? { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) } : null;
}

function start() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-stremio-web-'));
  var tls = certificate(dir);
  if (!tls) {
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve(null);
  }
  var port = 0, counts = {}, asked = [], version = { value: '1.2' };

  function at(host, p) {
    return 'https://' + host + '.playpex-test.dev:' + port + p;
  }

  function manifest(configured) {
    return {
      id: 'org.test.fakeaddon',
      name: 'Fake Add-on',
      version: version.value,
      description: 'An add-on made up for tests',
      logo: at('img', '/logo.png'),
      types: ['movie', 'series', 'channel', 'music'],
      idPrefixes: ['tt', 'fk:'],
      resources: ['catalog', 'stream', { name: 'meta', types: ['series', 'channel'], idPrefixes: ['fk:'] }, 'subtitles', 'addon_catalog'],
      catalogs: [
        { type: 'movie', id: 'top', name: 'Top films', extra: [{ name: 'skip' }, { name: 'genre', options: ['Drama', 'Comedy'] }, { name: 'search' }] },
        { type: 'channel', id: 'chans', name: 'Channels' },
        { type: 'series', id: 'needs', name: 'Needs a thing', extra: [{ name: 'token', isRequired: true }] },
        { type: 'music', id: 'songs', name: 'Songs' }
      ],
      addonCatalogs: [{ type: 'all', id: 'community', name: 'Community add-ons' }],
      behaviorHints: { configurable: true, configurationRequired: false, extra: configured ? 'yes' : 'no' }
    };
  }

  function metas(n, from, genre) {
    var out = [];
    for (var k = from; k < from + n; k++) {
      out.push({ id: 'tt' + String(1000000 + k), type: 'movie', name: (genre || 'Film') + ' ' + k, poster: at('img', '/poster.png'),
        releaseInfo: String(2000 + (k % 20)), imdbRating: '7.' + (k % 10), moviedb_id: 5000 + k, description: 'Made up', genres: ['Drama'] });
    }
    return out;
  }

  var STREAMS = function () {
    return [
      { name: 'Fake\n1080p', title: 'Film.2020.1080p.WEB.x264.AAC-FAKE\n👤 12 💾 1.5 GB ⚙️ SiteA', infoHash: 'a'.repeat(40), fileIdx: 0,
        behaviorHints: { bingeGroup: 'fake|1080p', filename: 'Film.2020.1080p.WEB.x264.AAC-FAKE.mkv' }, sources: ['tracker:udp://tracker.example:80', 'dht:aaa'] },
      { name: 'Fake\n720p', title: 'Film.2020.720p.WEB.x264.AAC-FAKE\n👤 300 💾 700 MB ⚙️ SiteB', infoHash: 'b'.repeat(40) },
      { name: 'Fake\n720p', title: 'Film.2020.720p.WEB.x264.AAC-FAKE (again)\n👤 5', infoHash: 'B'.repeat(40) },
      { name: '[DB+] Fake\n1080p', title: 'Film.2020.1080p.BluRay.x264.AAC-FAKE\n💾 2 GB', url: at('debrid', '/dl/1'),
        behaviorHints: { filename: 'Film.2020.1080p.BluRay.x264.AAC-FAKE.mp4', proxyHeaders: { request: { 'X-Token': 'debrid-ok' } } } },
      { name: 'Fake HLS', title: 'Film 2020 720p HLS', url: at('cdn', '/v.m3u8') },
      { name: 'Fake evil', title: 'Film 2020 evil', url: at('debrid', '/dl/evil') },
      { name: 'Plain', title: 'Film 2020 plain http', url: 'http://cdn.playpex-test.dev:' + port + '/film.mp4' },
      { name: 'Web page', externalUrl: 'https://example.org/watch' },
      { name: 'Trailer', ytId: 'dQw4w9WgXcQ' },
      { name: 'Elsewhere', title: 'Film 2020 other country', url: at('cdn', '/film.mp4'), behaviorHints: { countryWhitelist: ['xxx'] } }
    ];
  };

  function json(res, value, cache) {
    res.setHeader('Content-Type', 'application/json');
    if (cache) {
      res.setHeader('Cache-Control', 'max-age=60');
    }
    res.end(JSON.stringify(value));
  }

  function addon(res, p) {
    // a second add-on that only answers subtitles (its plugin has one hook: the adapter registers no other)
    if (p === '/subs-only/manifest.json') {
      return json(res, { id: 'org.test.subsonly', name: 'Subs Only', version: '0.1.0', types: ['movie'], idPrefixes: ['tt'], resources: ['subtitles'], catalogs: [] });
    }
    if (p.indexOf('/subs-only/subtitles/movie/tt0000001') === 0) {
      return json(res, { subtitles: [{ id: 'x', url: at('subs', '/9.srt'), lang: 'ger' }] });
    }
    var m = /^(?:\/cfg=([A-Za-z0-9]+))?(\/.*)$/.exec(p), rest = m[2];
    if (rest === '/manifest.json') {
      return json(res, manifest(!!m[1]));
    }
    var cat = /^\/catalog\/(\w+)\/([\w-]+)(?:\/(.+))?\.json$/.exec(rest);
    if (cat) {
      var extra = {};
      (cat[3] || '').split('&').filter(Boolean).forEach(function (kv) {
        var x = kv.split('=');
        extra[decodeURIComponent(x[0])] = decodeURIComponent(x[1] || '');
      });
      if (cat[1] === 'movie' && cat[2] === 'top') {
        if (extra.search) {
          return json(res, { metas: metas(2, 900, 'Found ' + extra.search) });
        }
        var skip = parseInt(extra.skip || '0', 10);
        return json(res, { metas: skip >= 100 ? metas(10, 100, extra.genre) : metas(100, 0, extra.genre), cacheMaxAge: 120 });
      }
      if (cat[1] === 'channel' && cat[2] === 'chans') {
        return json(res, { metas: [{ id: 'fk:1', type: 'channel', name: 'Fake Channel', poster: at('img', '/poster.png'), posterShape: 'landscape' }] });
      }
      res.statusCode = 404;
      return res.end('<html>no</html>');
    }
    if (rest === '/meta/channel/fk%3A1.json') {
      return json(res, { meta: { id: 'fk:1', type: 'channel', name: 'Fake Channel', description: 'Its videos', background: at('img', '/poster.png'),
        videos: [
          { id: 'fk:1:1', title: 'First video', released: '2026-01-01T00:00:00.000Z', thumbnail: at('img', '/poster.png') },
          { id: 'fk:1:2', title: 'Second video', released: '2026-02-01T00:00:00.000Z' }
        ] } });
    }
    if (rest === '/stream/movie/tt0000001.json') {
      return json(res, { streams: STREAMS(), cacheMaxAge: 3600, staleRevalidate: 60, staleError: 600 });
    }
    if (rest === '/addon_catalog/all/community.json') {
      return json(res, { addons: [
        { transportUrl: at('addon', '/subs-only/manifest.json'), manifest: { id: 'org.test.subsonly', name: 'Subs Only', version: '0.1.0', types: ['movie'], idPrefixes: ['tt'], resources: ['subtitles'], catalogs: [] } },
        { transportUrl: 'https://addon.playpex-test.dev:' + port + '/songs/manifest.json', manifest: { id: 'org.test.songs', name: 'Songs', version: '1.0.0', types: ['music'], resources: ['catalog'], catalogs: [] } }
      ] });
    }
    if (rest === '/stream/movie/tt1000900.json') {
      return json(res, { streams: [{ name: 'Fake\n1080p', title: 'Found.Heat.1995.1080p.WEB.x264.AAC-FAKE\n👤 40', infoHash: 'd'.repeat(40) }] });
    }
    if (rest === '/stream/movie/tt0000009.json') {
      return json(res, { streams: [{ title: 'x'.repeat(3 * 1024 * 1024), infoHash: 'c'.repeat(40) }] });
    }
    if (rest === '/stream/channel/fk%3A1%3A1.json') {
      return json(res, { streams: [{ name: 'Fake', title: 'First video', url: at('cdn', '/film.mp4') }, { name: 'Fake', title: 'Trailer', ytId: 'dQw4w9WgXcQ' }] });
    }
    var sub = /^\/subtitles\/movie\/tt0000001(?:\/(.+))?\.json$/.exec(rest);
    if (sub) {
      return json(res, { subtitles: [
        { id: '1', url: at('subs', '/1.srt'), lang: 'eng', subtitleFileName: 'Film.2020.srt' },
        { id: '2', url: at('subs', '/2.srt'), lang: 'pob' },
        { id: '3', url: at('subs', '/3.srt'), lang: 'fre', subtitleFileName: sub[1] ? 'matched by hash' : 'Film.fr.srt' }
      ] });
    }
    res.statusCode = 404;
    res.end('<html>not here</html>');
  }

  var account = { loggedOut: 0 };

  function stremioApi(req, res, p) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
      if (p === '/api/login') {
        return json(res, body.email === 'stremio@example.test' && body.password === 'right-pass' ?
          { result: { authKey: 'auth-123', user: { email: body.email } } } : { error: { code: 3, message: 'Wrong passphrase', wrongPass: true } });
      }
      if (p === '/api/logout') {
        account.loggedOut++;
        return json(res, { result: { success: true } });
      }
      if (p === '/api/addonCollectionGet') {
        if (body.authKey !== 'auth-123') {
          return json(res, { error: { code: 1, message: 'Session does not exist' } });
        }
        return json(res, { result: { addons: [
          { transportUrl: at('addon', '/cfg=IMPORTED9/manifest.json'), manifest: manifest(true), flags: {} },
          { transportUrl: at('addon', '/subs-only/manifest.json'), manifest: { id: 'org.test.subsonly', name: 'Subs Only', version: '0.1.0', types: ['movie'], idPrefixes: ['tt'], resources: ['subtitles'], catalogs: [] }, flags: {} },
          { transportUrl: at('addon', '/manifest.json'), manifest: Object.assign(manifest(false), { id: 'com.linvo.cinemeta', name: 'Cinemeta' }), flags: { official: true, protected: true } },
          { transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', manifest: { id: 'org.stremio.local', name: 'Local Files', version: '1.0.0', resources: ['meta', 'stream'], types: ['movie'] }, flags: { official: true } },
          { transportUrl: at('addon', '/songs/manifest.json'), manifest: { id: 'org.test.songs', name: 'Songs', version: '1.0.0', types: ['music'], resources: ['catalog'], catalogs: [{ type: 'music', id: 's', name: 'S' }] }, flags: {} }
        ] } });
      }
      res.statusCode = 404;
      res.end();
    });
  }

  var server = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
    var url = new URL(req.url, 'https://x'), host = String(req.headers.host || '').split('.')[0];
    counts[host + url.pathname] = (counts[host + url.pathname] || 0) + 1;
    asked.push(host + url.pathname);
    if (host === 'api') {
      return stremioApi(req, res, url.pathname);
    }
    if (host === 'addon') {
      return addon(res, url.pathname);
    }
    if (host === 'debrid') {
      if (url.pathname === '/dl/evil') {
        res.statusCode = 302;
        res.setHeader('Location', 'https://loop.playpex-test.dev:' + port + '/film.mp4');
        return res.end();
      }
      if (req.headers['x-token'] !== 'debrid-ok') {
        res.statusCode = 403;
        return res.end();
      }
      res.statusCode = 302;
      res.setHeader('Location', at('cdn', '/film.mp4'));
      return res.end();
    }
    if (host === 'cdn') {
      if (url.pathname === '/v.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttps://parts.playpex-test.dev:' + port + '/seg0.ts\n#EXT-X-ENDLIST\n');
      }
      if (url.pathname === '/film.mp4') {
        var range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        if (range) {
          var s = parseInt(range[1], 10), e = range[2] ? Math.min(parseInt(range[2], 10), FILM.length - 1) : FILM.length - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', 'bytes ' + s + '-' + e + '/' + FILM.length);
          res.setHeader('Content-Length', e - s + 1);
          return res.end(FILM.subarray(s, e + 1));
        }
        res.setHeader('Content-Length', FILM.length);
        return res.end(FILM);
      }
    }
    if (host === 'parts' && url.pathname === '/seg0.ts') {
      return res.end(Buffer.alloc(188 * 10, 0x47));
    }
    if (host === 'subs') {
      res.setHeader('Content-Type', 'application/x-subrip');
      return res.end('1\n00:00:01,000 --> 00:00:02,000\nHello ' + url.pathname + '\n');
    }
    if (host === 'img') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise(function (resolve) {
    server.listen(0, ADDRESS, function () {
      port = server.address().port;
      var lookup = function (host, options, callback) {
        var address = host === 'loop.playpex-test.dev' ? '127.0.0.1' : /\.playpex-test\.dev$/.test(host) ? ADDRESS : null;
        if (!address) {
          return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        }
        callback(null, options && options.all ? [{ address: address, family: 4 }] : address, 4);
      };
      resolve({
        port: port,
        url: function (p) { return at('addon', p || '/manifest.json'); },
        http: function () { return { lookup: lookup, ports: [port], ca: tls.cert, allowAddresses: [ADDRESS] }; },
        counts: counts,
        asked: asked,
        account: account,
        apiBase: 'https://api.playpex-test.dev:' + port,
        film: FILM,
        version: version,
        stop: function () {
          return new Promise(function (ok) {
            server.close(function () {
              fs.rmSync(dir, { recursive: true, force: true });
              ok();
            });
            server.closeAllConnections();
          });
        }
      });
    });
  });
}

module.exports = { start: start };
