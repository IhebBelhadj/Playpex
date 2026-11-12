'use strict';

// The YouTube receiver (docs/cast-plan.md §6, step 5), without YouTube: a
// screen's player (lib/cast/youtube.js#playerFor) driven as yt-cast-receiver
// drives it. A phone's cast becomes a cast of an embed to that screen (title
// from oEmbed, stubbed here; nothing saved), YouTube's pause / seek / stop
// reach the screen as session commands with the cast's id, the screen's
// reports feed the position the phone shows, YouTube's volume is the screen's
// player.volume, the end of a video plays Up next, a screen without embeds
// refuses. The admin's status route and a screen's TV code. Nothing reaches
// the network: no receiver is started (the server runs with youtubeCast off).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  WebSocket = require('ws'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-cast-youtube-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  logger = require('../lib/logger'),
  inspect = require('../lib/links/inspect'),
  youtube = require('../lib/cast/youtube');

var OPTIONS = { port: 0, console: false, library: false, youtubeCast: false, torrents: { engine: 'fake', discovery: false } },
  base = null,
  cookie = null,
  open = [];

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
      headers: Object.assign({}, options.device ? { 'X-Playpex-Device': options.device } : {},
        payload ? { 'Content-Type': 'application/json' } : {}, options.admin ? { Cookie: cookie } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// A screen's events socket; .next(topic) waits for one
function screen(device, accepts) {
  var ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/events?device=' + device + '&control=playback,cast&accepts=' + accepts + '&topics=cast,session,settings'),
    got = [], waiting = [];
  open.push(ws);
  ws.on('message', function (data) {
    var msg = JSON.parse(String(data));
    got.push(msg);
    waiting = waiting.filter(function (w) {
      if (w.match(msg)) {
        w.resolve(msg);
        return false;
      }
      return true;
    });
  });
  ws.got = got;
  ws.next = function (topic, check) {
    var match = function (m) { return m.topic === topic && (!check || check(m)); },
      seen = got.filter(match)[0];
    if (seen) {
      got.splice(got.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no ' + topic)); }, 3000);
      waiting.push({ match: match, resolve: function (m) { clearTimeout(timer); got.splice(got.indexOf(m), 1); resolve(m); } });
    });
  };
  return new Promise(function (resolve, reject) {
    ws.on('open', function () { resolve(ws); });
    ws.on('error', reject);
  });
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  // no YouTube: the title a cast gets
  inspect.youtubeInfo = function (id) {
    return Promise.resolve(id === 'dQw4w9WgXcQ' ? { title: 'A song', author: 'A singer' } : {});
  };
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'yt-pass-1' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'yt-pass-1' }));
    });
  });
});

test.after(function () {
  open.forEach(function (ws) { ws.close(); });
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('a phone\'s cast reaches the screen as an embed, YouTube\'s remote drives it, the screen\'s state comes back', function () {
  var tv, player, castId;
  return screen('yt-tv', 'media,magnet,embed').then(function (ws) {
    tv = ws;
    return youtube.playerFor('yt-tv');
  }).then(function (p) {
    player = p;
    player.sender = { name: 'Pixel', user: { name: 'Anna' } };
    return player.doPlay({ id: 'dQw4w9WgXcQ' }, 42);
  }).then(function (ok) {
    assert.equal(ok, true);
    return tv.next('cast.play');
  }).then(function (m) {
    conforms('CastPlayEvent', m.data);
    castId = m.data.castId;
    assert.equal(player.castId, castId);
    assert.deepEqual(m.data.request.source, { embed: { provider: 'youtube', id: 'dQw4w9WgXcQ' } });
    assert.equal(m.data.request.title, 'A song');
    assert.equal(m.data.request.subtitle, 'A singer');
    assert.equal(m.data.request.positionS, 42);
    assert.equal(m.data.request.tracking, 'none');
    assert.equal(m.data.profileId, null);
    assert.equal(m.data.from.name, 'YouTube · Anna');
    return player.doPause();
  }).then(function (ok) {
    assert.equal(ok, true);
    return tv.next('session.command', function (m) { return m.data.action === 'pause'; });
  }).then(function (m) {
    assert.equal(m.data.castId, castId);
    assert.equal(m.data.sessionId, null);
    return player.doSeek(120);
  }).then(function () {
    return tv.next('session.command', function (m) { return m.data.action === 'seek'; });
  }).then(function (m) {
    assert.equal(m.data.positionS, 120);
    return player.doResume();
  }).then(function () {
    return tv.next('session.command', function (m) { return m.data.action === 'resume'; });
  }).then(function () {
    // the embed reports its state: what YouTube shows
    return call('POST', '/cast/' + castId + '/state', { state: 'playing', positionS: 130, durationS: 212 }, { device: 'yt-tv' });
  }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return wait(100);
  }).then(function () {
    return Promise.all([player.doGetPosition(), player.doGetDuration()]);
  }).then(function (r) {
    assert.ok(r[0] >= 130 && r[0] < 132, 'position ' + r[0]);
    assert.equal(r[1], 212);
    return call('POST', '/cast/' + castId + '/state', { state: 'paused', positionS: 140, durationS: 212 }, { device: 'yt-tv' });
  }).then(function () {
    return wait(100);
  }).then(function () {
    return player.doGetPosition();
  }).then(function (position) {
    assert.equal(position, 140, 'paused on the screen: no longer moving');
  });
});

test('YouTube\'s far seek (stop, then play the same video) seeks in place: no new player; a stop alone closes it', function () {
  var tv, player, castId;
  return screen('yt-seek', 'embed').then(function (ws) {
    tv = ws;
    return youtube.playerFor('yt-seek');
  }).then(function (p) {
    player = p;
    return player.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  }).then(function () {
    return tv.next('cast.play');
  }).then(function (m) {
    castId = m.data.castId;
    return player.doStop();
  }).then(function () {
    return player.doPlay({ id: 'dQw4w9WgXcQ' }, 105);
  }).then(function (ok) {
    assert.equal(ok, true);
    return tv.next('session.command', function (m) { return m.data.action === 'seek'; });
  }).then(function (m) {
    assert.equal(m.data.positionS, 105);
    assert.equal(m.data.castId, castId, 'the same cast');
    assert.equal(player.castId, castId);
    return wait(1800);
  }).then(function () {
    assert.ok(!tv.got.some(function (m) { return m.topic === 'cast.play'; }), 'no new cast');
    assert.ok(!tv.got.some(function (m) { return m.topic === 'session.command' && m.data.action === 'stop'; }), 'never stopped');
    return player.doStop();
  }).then(function () {
    return tv.next('session.command', function (m) { return m.data.action === 'stop'; });
  }).then(function (m) {
    assert.equal(m.data.castId, castId);
    assert.equal(player.castId, null);
  });
});

test('YouTube\'s volume is the screen\'s Playpex volume (player.volume)', function () {
  var tv, player;
  return screen('yt-vol', 'embed').then(function (ws) {
    tv = ws;
    return youtube.playerFor('yt-vol');
  }).then(function (p) {
    player = p;
    return player.doGetVolume();
  }).then(function (volume) {
    assert.deepEqual(volume, { level: 100, muted: false }, 'the default');
    return player.doSetVolume({ level: 30.4, muted: false });
  }).then(function (ok) {
    assert.equal(ok, true);
    return tv.next('settings.changed');
  }).then(function (m) {
    assert.deepEqual(m.data.keys, ['player.volume']);
    return call('GET', '/settings', undefined, { device: 'yt-vol' });
  }).then(function (r) {
    assert.equal(r.body.device['player.volume'], 30);
    return player.doGetVolume();
  }).then(function (volume) {
    assert.equal(volume.level, 30);
  });
});

test('the end of a video plays Up next; stopped on the screen, YouTube is told', function () {
  var tv, player, castId, nexts = 0, external = [];
  return screen('yt-end', 'embed').then(function (ws) {
    tv = ws;
    return youtube.playerFor('yt-end');
  }).then(function (p) {
    player = p;
    player.next = function () { nexts++; return Promise.resolve(true); };
    player.pause = function () { return Promise.resolve(true); };
    player.notifyExternalStateChange = function (s) { external.push(s); return Promise.resolve(); };
    return player.doPlay({ id: 'abcdefghijk' }, 0);
  }).then(function () {
    return tv.next('cast.play');
  }).then(function (m) {
    castId = m.data.castId;
    assert.equal(m.data.request.title, 'YouTube video', 'no title from oEmbed');
    return call('POST', '/cast/' + castId + '/state', { state: 'playing', positionS: 299, durationS: 300 }, { device: 'yt-end' });
  }).then(function () {
    return call('POST', '/cast/' + castId + '/state', { state: 'ended' }, { device: 'yt-end' });
  }).then(function () {
    return wait(150);
  }).then(function () {
    assert.equal(nexts, 1, 'Up next');
    assert.equal(player.castId, null);
    // another video, stopped half way on the screen (its own remote, another cast)
    return player.doPlay({ id: 'abcdefghijk' }, 0);
  }).then(function () {
    return tv.next('cast.play');
  }).then(function (m) {
    return call('POST', '/cast/' + m.data.castId + '/state', { state: 'playing', positionS: 40, durationS: 300 }, { device: 'yt-end' }).then(function () {
      return call('POST', '/cast/' + m.data.castId + '/state', { state: 'ended' }, { device: 'yt-end' });
    });
  }).then(function () {
    return wait(150);
  }).then(function () {
    assert.equal(nexts, 1, 'no Up next');
    return import('yt-cast-receiver');
  }).then(function (m) {
    assert.ok(external.indexOf(m.PLAYER_STATUSES.STOPPED) >= 0, 'stopped: ' + JSON.stringify(external));
  });
});

test('a screen that plays no embeds refuses; its stop needs no cast', function () {
  var player;
  return screen('yt-noembed', 'media,magnet').then(function () {
    return youtube.playerFor('yt-noembed');
  }).then(function (p) {
    player = p;
    return player.doPlay({ id: 'dQw4w9WgXcQ' }, 0);
  }).then(function (ok) {
    assert.equal(ok, false);
    assert.equal(player.castId, null);
    return player.doPause();
  }).then(function (ok) {
    assert.equal(ok, false, 'nothing to pause');
    return player.doStop();
  }).then(function (ok) {
    assert.equal(ok, true);
  });
});

test('the admin sees the receivers; a screen asks its TV code; off by default; LAN interfaces only', function () {
  return Promise.all([
    call('GET', '/cast/youtube', undefined, { admin: true }),
    call('GET', '/cast/youtube', undefined, { device: 'yt-tv' }),
    call('GET', '/cast/youtube/code', undefined, { device: 'not-a-screen' }),
    call('GET', '/admin/settings', undefined, { admin: true })
  ]).then(function (r) {
    assert.equal(r[0].status, 200, JSON.stringify(r[0].body));
    conforms('CastYouTube', r[0].body);
    assert.equal(r[0].body.enabled, false, 'cast.youtube is off by default');
    assert.ok(r[0].body.receivers.some(function (x) { return x.deviceId === 'yt-tv'; }));
    assert.equal(r[1].status, 401);
    assert.equal(r[2].status, 200);
    assert.deepEqual(r[2].body, { code: null });
    assert.equal(r[3].body.settings.cast.youtube, false);
    youtube.lanInterfaces().forEach(function (name) {
      assert.doesNotMatch(name, /^(lo|docker|br-|veth|virbr|incus|tailscale|wg)/);
    });
  });
});
