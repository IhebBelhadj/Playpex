'use strict';

// Live TV (docs/providers-plan.md step 9) on a real server with the plugin
// plugins/m3u and the made-up IPTV provider of test/helpers/live-web.js (a
// plain-http playlist of 300 channels, a > 50 MB gzipped XMLTV guide over
// https, TS and HLS streams; skipped without openssl):
//
//   the parsers: M3U attributes, names with commas, #EXTGRP / #EXTVLCOPT, stable unique ids · XMLTV times
//   the manifest rules of live hooks, guide screens and url settings (grantsHost, streamHosts)
//   before the admin gives an address: no host · after: the playlist's host over plain http and its port,
//     the hosts the playlist lists for streams only, never for the plugin's own requests
//   300 channels: numbered, grouped, logos through the server · the guide: matched by tvg-id and by name,
//     parsed within the time and memory limits, ≤ 200 channels and 48 h · a channel plays as l_ (TS) or h_ (HLS,
//     its segments from a host the playlist doesn't list), with the playlist's user agent · a host resolving
//     to loopback is refused · settings changes and the admin's refresh · answers against openapi.yaml

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  Ajv2020 = require('ajv/dist/2020'),
  YAML = require('yaml');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-live-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  pluginSettings = require('../lib/plugins/settings'),
  pluginHttp = require('../lib/plugins/http'),
  iptv = require('../lib/plugins/iptv'),
  protocol = require('@playpex/protocol/plugins'),
  liveWeb = require('./helpers/live-web');

var M3U_DIR = path.join(__dirname, '..', '..', '..', 'plugins', 'm3u'),
  web = null,
  base = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');
function matches(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

function call(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {})
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

// The first `bytes` of a continuous answer
function head(apiPath, bytes) {
  return new Promise(function (resolve, reject) {
    var req = http.get(new URL('/api/v1' + apiPath, base), { agent: false, headers: { 'X-Playpex-Device': 'tv-1' } }, function (res) {
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

function skip(t) {
  if (!web) {
    t.skip('openssl is needed for the IPTV test web');
    return true;
  }
  return false;
}

// ── parsers and rules (no server) ──────────────────────────────────────────

test('M3U: attributes, names with commas, groups, options, stable unique ids, the guide it names', function () {
  var text = [
    '#EXTM3U url-tvg="https://epg.example.com/a.xml.gz,https://epg.example.com/b.xml" x-tvg-url="https://epg.example.com/a.xml.gz"',
    '#EXTINF:-1 tvg-id="news.uk" tvg-name="News, UK" tvg-logo="https://img.example.com/n.png" group-title="News" tvg-chno="7",News, UK HD',
    '#EXTVLCOPT:http-user-agent=Box/2',
    '#EXTVLCOPT:http-referrer=https://portal.example.com/',
    'http://tv.example.com:8080/live/u/p/1.ts',
    '#EXTINF:-1,Same Name',
    '#EXTGRP:Films',
    'https://tv.example.com/2.m3u8',
    '#EXTINF:-1,Same Name',
    '#EXTGRP:Films',
    'https://tv.example.com/3.m3u8',
    '#EXTINF:-1 tvg-id="dup",Dup A',
    'https://tv.example.com/4.ts',
    '#EXTINF:-1 tvg-id="dup",Dup B',
    'https://tv.example.com/5.ts',
    '#EXTINF:-1,Radio',
    'rtmp://tv.example.com/no',
    'https://tv.example.com/bare/stream-9.ts',
    ''
  ].join('\r\n');
  var a = iptv.parseM3u(text), b = iptv.parseM3u(text);
  assert.deepEqual(a.epg, ['https://epg.example.com/a.xml.gz', 'https://epg.example.com/b.xml']);
  assert.equal(a.total, 7);
  assert.equal(a.entries.length, 6, 'rtmp left out');
  var first = a.entries[0];
  assert.equal(first.id, 'news.uk');
  assert.equal(first.name, 'News, UK HD');
  assert.equal(first.tvgName, 'News, UK');
  assert.equal(first.group, 'News');
  assert.equal(first.number, 7);
  assert.equal(first.logo, 'https://img.example.com/n.png');
  assert.equal(first.userAgent, 'Box/2');
  assert.equal(first.referrer, 'https://portal.example.com/');
  assert.equal(a.entries[1].group, 'Films');
  var ids = a.entries.map(function (e) { return e.id; });
  assert.equal(new Set(ids).size, ids.length, 'unique ids: ' + ids);
  assert.deepEqual(ids, b.entries.map(function (e) { return e.id; }), 'stable');
  assert.ok(ids.every(function (id) { return /^[A-Za-z0-9._:@-]+$/.test(id); }));
  assert.notEqual(a.entries[3].id, 'dup', 'a tvg-id two channels share is no id');
  assert.equal(a.entries[5].name, 'stream-9.ts');
});

test('XMLTV times and names', function () {
  assert.equal(iptv.xmltvTime('20261025210000 +0200'), Date.UTC(2026, 9, 25, 19, 0, 0));
  assert.equal(iptv.xmltvTime('202610252100 -0130'), Date.UTC(2026, 9, 25, 22, 30, 0));
  assert.equal(iptv.xmltvTime('20261025210000'), Date.UTC(2026, 9, 25, 21, 0, 0));
  assert.ok(isNaN(iptv.xmltvTime('yesterday')));
  assert.equal(iptv.normalize('Channel 7 HD'), iptv.normalize('channel 7'));
  assert.equal(iptv.normalize('Écran (FR) 1080p'), 'ecran');
});

test('manifest rules: live hooks together, guide screens, url settings that grant hosts', function () {
  function manifest(patch) {
    return Object.assign({
      id: 'tv', name: 'TV', version: '1.0.0', publisher: { name: 'T' }, api: { server: '^1' }, audience: 'everyone',
      permissions: { sources: ['live'], hooks: ['live.channels', 'live.stream'] },
      contributes: { settings: [{ key: 'list', scope: 'server', type: 'url', label: 'List', grantsHost: true }] }
    }, patch);
  }
  var good = protocol.checkManifest(manifest({}));
  assert.deepEqual(good, []);
  var m3u = JSON.parse(fs.readFileSync(path.join(M3U_DIR, 'playpex-plugin.json'), 'utf8'));
  assert.deepEqual(protocol.checkManifest(m3u, { files: ['assets/live.svg'] }), []);
  function says(m, re) {
    var problems = protocol.checkManifest(m);
    assert.ok(problems.some(function (p) { return re.test(p.message); }), JSON.stringify(problems));
  }
  says(manifest({ permissions: { sources: ['live'], hooks: ['live.channels'] } }), /go together/);
  says(manifest({ permissions: { sources: ['live'], hooks: ['live.guide', 'live.stream'] } }), /live\.guide needs live\.channels|go together/);
  says(manifest({ permissions: { sources: ['magnet'], hooks: ['live.channels', 'live.stream'] } }), /hls or live/);
  says(manifest({ contributes: {} }), /stream hosts in permissions\.network/);
  says(manifest({ contributes: { settings: [{ key: 'list', scope: 'profile', type: 'url', label: 'List', grantsHost: true }] } }), /scope server/);
  says(manifest({ contributes: { settings: [{ key: 'list', scope: 'server', type: 'url', label: 'List', grantsHost: true, default: 'https://a.example.org/' }] } }), /no default/);
  says(manifest({ permissions: { sources: ['hls'], hooks: ['play.collect'], network: ['a.example.org'] },
    contributes: { screens: [{ name: 'g', template: 'guide' }] } }), /guide screen/);
  var words = protocol.describePermissions(m3u).map(function (x) { return x.text; }).join(' | ');
  assert.match(words, /address you give in its setting "Playlist \(M3U\)", and the stream hosts that address lists/);
  assert.match(words, /Adds TV channels/);
  assert.deepEqual(protocol.grantOf('http://Box.Example.com:25461/get.php?u=1'), { host: 'box.example.com', port: 25461, scheme: 'http' });
  assert.equal(protocol.grantOf('ftp://x.example.com/'), null);
  assert.match(protocol.urlProblem('https://u:p@x.example.com/'), /user name/);
});

// ── on a server ────────────────────────────────────────────────────────────

test.before(function () {
  return liveWeb.start().then(function (w) {
    web = w;
    if (!web) {
      return;
    }
    return server.start({
      port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
      plugins: { dirs: [M3U_DIR], http: web.http(), repositories: false }
    }).then(function (info) {
      base = 'http://127.0.0.1:' + info.port;
      var until = Date.now() + 20000;
      return new Promise(function (resolve, reject) {
        (function poll() {
          var p = plugins.get('m3u');
          if (p && p.state !== 'loading') {
            return p.state === 'enabled' ? resolve() : reject(new Error('m3u: ' + p.state + ' ' + p.error));
          }
          if (Date.now() > until) {
            return reject(new Error('m3u not loaded'));
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

test('without a playlist: no channels, the guide screen says why, and no host to reach', function (t) {
  if (skip(t)) {
    return;
  }
  var plugin = plugins.get('m3u');
  assert.throws(function () { pluginHttp.target(plugin, web.playlist); }, function (e) { return e.code === 'HTTPS_ONLY'; });
  return call('GET', '/live').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.providers.length, 1);
    assert.equal(r.json.providers[0].plugin, 'm3u');
    assert.equal(r.json.providers[0].guide, true);
    return call('GET', '/live/m3u/channels');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.channels, []);
    matches('LiveChannels', r.json);
    return call('POST', '/plugins/m3u/data/guide', {});
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.data.empty, /No playlist yet/);
    return call('GET', '/plugins');
  }).then(function (r) {
    assert.equal(r.json.capabilities.live, true);
    assert.equal(r.json.plugins.filter(function (p) { return p.id === 'm3u'; })[0].screens[0].template, 'guide');
  });
});

test('the admin\'s addresses: url settings checked, their hosts granted (http, their port), shown in its permissions', function (t) {
  if (skip(t)) {
    return;
  }
  var plugin = plugins.get('m3u');
  return pluginSettings.update('m3u', { values: { playlist: 'ftp://iptv.playpex-test.dev/list' } }).then(function () {
    assert.fail('ftp accepted');
  }, function (err) {
    assert.equal(err.code, 'INVALID');
    assert.match(err.errors[0].message, /https:\/\/ or http:\/\//);
    return pluginSettings.update('m3u', { values: { playlist: web.playlist, guide: web.guide } });
  }).then(function (view) {
    assert.equal(view.server.playlist, web.playlist);
    var def = view.definitions.filter(function (d) { return d.key === 'playlist'; })[0];
    assert.equal(def.type, 'url');
    assert.equal(def.grantsHost, true);
    assert.ok(pluginHttp.target(plugin, web.playlist).granted);
    // the port and plain http are the granted host's only
    assert.throws(function () { pluginHttp.target(plugin, 'http://iptv.playpex-test.dev:1/x'); }, /only port 443|https/);
    assert.throws(function () { pluginHttp.target(plugin, 'http://other.playpex-test.dev:' + web.ports.httpPort + '/x'); }, /https/);
    var described = require('../lib/plugins/grants').describe(plugin).map(function (x) { return x.text; }).join(' | ');
    assert.match(described, new RegExp('Talks to iptv\\.playpex-test\\.dev:' + web.ports.httpPort + ' \\(plain http\\)'));
  });
});

var channels = null;

test('300 channels: numbered, grouped, their logos through the server; the playlist\'s hosts learned for streams only', function (t) {
  if (skip(t)) {
    return;
  }
  var plugin = plugins.get('m3u');
  return call('GET', '/live/m3u/channels').then(function (r) {
    assert.equal(r.status, 200, r.text);
    matches('LiveChannels', r.json);
    channels = r.json.channels;
    assert.equal(channels.length, web.channels);
    assert.equal(channels[0].name, 'Channel 1');
    assert.equal(channels[0].number, 101, 'tvg-chno');
    assert.equal(channels[10].number, 111, 'after the highest');
    assert.equal(new Set(channels.map(function (c) { return c.number; })).size, channels.length);
    assert.deepEqual(r.json.groups.map(function (g) { return g.name; }).sort(), liveWeb.GROUPS.slice().sort());
    assert.ok(r.json.groups.every(function (g) { return g.count === web.channels / 5; }));
    assert.match(channels[1].logo, /^\/live\/m3u\/logos\//, 'an http logo: through the server');
    assert.match(channels[0].logo, /^\/live\/m3u\/logos\//, 'a logo on a learned host: through the server');
    assert.doesNotMatch(r.text, /password=|playpex-test\.dev/, 'no address of the provider reaches a client');
    // a stream host the playlist lists: for streams, never the plugin's own requests
    assert.ok(pluginHttp.target(plugin, 'https://logos.playpex-test.dev:' + web.ports.httpsPort + '/1.png', { stream: true }).granted);
    assert.throws(function () { pluginHttp.target(plugin, 'https://logos.playpex-test.dev:' + web.ports.httpsPort + '/1.png'); }, /port|permissions/);
    return call('GET', channels[1].logo.replace(/^/, ''));
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['content-type'], 'image/png');
    return call('GET', '/live/m3u/channels?group=Sport&q=channel');
  }).then(function (r) {
    assert.equal(r.json.channels.length, web.channels / 5);
    assert.ok(r.json.channels.every(function (c) { return c.group === 'Sport'; }));
    return call('GET', '/live/m3u/channels?q=Channel%2042');
  }).then(function (r) {
    assert.deepEqual(r.json.channels.map(function (c) { return c.name; }), ['Channel 42']);
    return call('GET', '/live/m3u/logos/forged.AAAAAAAAAAAAAAAAAAAAAA');
  }).then(function (r) {
    assert.equal(r.status, 404);
  });
});

test('the guide: > 50 MB of XMLTV parsed within the limits, matched by tvg-id and by name, 200 channels × 6 h', function (t) {
  if (skip(t)) {
    return;
  }
  assert.ok(web.guideSize > 50 * 1024 * 1024, 'the made-up guide is ' + Math.round(web.guideSize / 1048576) + ' MB');
  var from = new Date(Math.floor(Date.now() / 1800000) * 1800000), to = new Date(from.getTime() + 6 * 3600000),
    ids = channels.slice(0, 200).map(function (c) { return c.id; }),
    heap = process.memoryUsage().heapUsed, started = Date.now();
  return call('GET', '/live/m3u/guide?channels=' + encodeURIComponent(ids.join(',')) + '&from=' + from.toISOString() + '&to=' + to.toISOString()).then(function (r) {
    var took = Date.now() - started, grew = process.memoryUsage().heapUsed - heap;
    assert.equal(r.status, 200, r.text);
    assert.ok(took < 30000, 'took ' + took + ' ms (live.guide has 30 s)');
    assert.ok(grew < 400 * 1024 * 1024, 'the heap grew by ' + Math.round(grew / 1048576) + ' MB');
    var list = r.json.programmes;
    list.forEach(function (p) { matches('LiveProgramme', p); });
    var byChannel = {};
    list.forEach(function (p) { (byChannel[p.channel] = byChannel[p.channel] || []).push(p); });
    assert.equal(Object.keys(byChannel).length, 200, 'every channel matched (odd ones by name)');
    var one = byChannel[channels[2].id];   // Channel 3: odd, by name
    assert.equal(one.length, 12);
    assert.equal(one[0].start, from.toISOString());
    assert.match(one[0].title, /^Show \d+ on Channel 3$/);
    assert.match(one[0].subtitle, /^Part \d$/);
    assert.match(one[0].episode, /^S\d E\d+$/);
    assert.ok(one[0].description.length <= 600);
    assert.equal(one[0].category, liveWeb.GROUPS[3 % 5]);
    // again: kept (no second parse, no second download)
    var downloads = web.stats.requests['https epg /guide.xml.gz'];
    started = Date.now();
    return call('GET', '/live/m3u/guide?channels=' + channels[5].id + '&from=' + from.toISOString() + '&to=' + new Date(from.getTime() + 3600000).toISOString()).then(function (r2) {
      assert.equal(r2.json.programmes.length, 2);
      assert.ok(Date.now() - started < 2000, 'took ' + (Date.now() - started) + ' ms');
      assert.equal(web.stats.requests['https epg /guide.xml.gz'], downloads);
    });
  }).then(function () {
    return call('GET', '/live/m3u/guide?channels=' + channels[0].id + '&from=' + from.toISOString() + '&to=' + new Date(from.getTime() + 49 * 3600000).toISOString());
  }).then(function (r) {
    assert.equal(r.status, 400);
    return call('GET', '/live/m3u/guide?channels=' + channels.slice(0, 201).map(function (c) { return c.id; }).join(',') + '&from=' + from.toISOString() + '&to=' + to.toISOString());
  }).then(function (r) {
    assert.equal(r.status, 400);
  });
});

test('a channel plays: TS as l_ (with its user agent), HLS as h_ with segments from a host the playlist doesn\'t list', function (t) {
  if (skip(t)) {
    return;
  }
  if (!web.streams) {
    return t.skip('ffmpeg is needed for the streams');
  }
  var ts = channels[0], live = channels[2];
  return call('POST', '/live/m3u/channels/' + ts.id + '/play').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.source.ref, /^l_[0-9a-f]{32}$/);
    assert.equal(r.json.source.format, 'live');
    assert.equal(r.json.source.live, true);
    assert.equal(r.json.channel.id, ts.id);
    assert.doesNotMatch(r.text, /playpex-test/);
    return head('/media/' + r.json.source.ref + '?device=tv-1', 64 * 1024).then(function (m) {
      assert.equal(m.status, 200);
      assert.equal(m.headers['content-type'], 'video/x-matroska');
      assert.equal(m.raw.subarray(0, 4).toString('hex'), '1a45dfa3', 'Matroska');
      assert.equal(web.stats.userAgents['/live/1.ts'], 'PlaypexTestBox/1.0');
      return call('DELETE', '/media/' + r.json.source.ref + '?device=tv-1');
    });
  }).then(function () {
    return call('POST', '/live/m3u/channels/' + live.id + '/play');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.source.ref, /^h_[0-9a-f]{32}$/);
    assert.equal(r.json.source.format, 'hls');
    var ref = r.json.source.ref;
    return call('GET', '/media/' + ref + '/index.m3u8?device=tv-1').then(function (p) {
      assert.equal(p.status, 200, p.text);
      var segment = p.text.split('\n').filter(function (l) { return l && l[0] !== '#'; })[0];
      assert.match(segment, /^r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\/\d+\.ts$/);
      return call('GET', '/media/' + ref + '/' + segment + '?device=tv-1');
    }).then(function (s) {
      assert.equal(s.status, 200, s.text);
      assert.equal(s.raw[0], 0x47, 'an MPEG-TS packet');
      return call('DELETE', '/media/' + ref + '?device=tv-1');
    });
  });
});

test('a channel on a host resolving to loopback is refused; unknown channels 404', function (t) {
  if (skip(t)) {
    return;
  }
  var evil = channels[channels.length - 1];
  return call('POST', '/live/m3u/channels/' + evil.id + '/play').then(function (r) {
    assert.equal(r.status, 200, 'the plugin may name it: the address check is the stream\'s');
    return call('GET', '/media/' + r.json.source.ref + '?device=tv-1');
  }).then(function (m) {
    assert.equal(m.status, 502, m.text);
    assert.match(m.json.error, /can't reach|address/);
    return call('POST', '/live/m3u/channels/nope/play');
  }).then(function (r) {
    assert.equal(r.status, 404);
  });
});

test('the admin: channels with their status, Refresh; a new address drops the old channels', function (t) {
  if (skip(t)) {
    return;
  }
  var adminChannels = require('../lib/live');
  var status = adminChannels.status('m3u');
  assert.equal(status.channels, web.channels);
  assert.ok(status.durationMs >= 0);
  var before = web.stats.requests['http /get.php'];
  return pluginSettings.update('m3u', { values: { groups: 'news, kids' } }).then(function () {
    assert.equal(adminChannels.status('m3u').channels, null, 'forgotten after a settings change');
    return call('GET', '/live/m3u/channels');
  }).then(function (r) {
    assert.equal(r.json.channels.length, (web.channels / 5) * 2);
    assert.equal(web.stats.requests['http /get.php'], before, 'the playlist came from the disk cache');
    return pluginSettings.update('m3u', { values: { groups: null, playlist: null } });
  }).then(function () {
    return call('GET', '/live/m3u/channels');
  }).then(function (r) {
    assert.deepEqual(r.json.channels, []);
    assert.throws(function () { pluginHttp.target(plugins.get('m3u'), web.playlist); });
  });
});
