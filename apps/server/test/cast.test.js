'use strict';

// Casting (docs/cast-plan.md §4): screens are the devices whose events socket
// says ?control=cast; a cast reaches only its screen; the checks (casting
// off, what the screen accepts, profiles and PINs, an adults-only folder's
// file and kids profiles, tracking); the screen's keepalive naming the cast
// and its state relayed to the sender; commands from the sender (through the
// session, or straight to the screen for an embedded video), refused to
// others; a new cast replacing the running one. Answers against openapi.yaml.
// The real server with the fake engine, offline.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  WebSocket = require('ws'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-cast-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  settings = require('../lib/settings'),
  userData = require('../lib/userData'),
  logger = require('../lib/logger');

var OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } },
  libraryDir = path.join(tmp, 'library', 'Movies'),
  adultDir = path.join(tmp, 'library', 'Adults'),
  diskData = Buffer.alloc(200000, 7),
  base = null,
  cookie = null,
  open = [],
  movieRef = null,
  adultRef = null,
  profiles = {};

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

// An events socket that keeps what it receives; .next(topic) waits for one
function socket(query) {
  var ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/events?' + query), got = [], waiting = [];
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
  ws.ready = new Promise(function (resolve, reject) {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.closed = new Promise(function (resolve) { ws.on('close', resolve); });
  ws.next = function (topic, check, ms) {
    var match = function (m) { return m.topic === topic && (!check || check(m)); },
      seen = got.filter(match)[0];
    if (seen) {
      got.splice(got.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no ' + topic)); }, ms || 3000);
      waiting.push({ match: match, resolve: function (m) { clearTimeout(timer); got.splice(got.indexOf(m), 1); resolve(m); } });
    });
  };
  return ws;
}

function nothing(ws, topic, ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 300); }).then(function () {
    assert.ok(!ws.got.some(function (m) { return m.topic === topic; }), 'no ' + topic);
  });
}

function screen(device, extra) {
  var ws = socket('device=' + device + '&control=playback,cast&topics=cast,session' + (extra || ''));
  return ws.ready.then(function () { return ws; });
}

function sender(device) {
  var ws = socket('device=' + device + '&topics=cast');
  return ws.ready.then(function () { return ws; });
}

function cast(to, request, from) {
  return call('POST', '/cast/screens/' + to + '/play', request, { device: from || 'phone-1' });
}

function movie(extra) {
  return Object.assign({ title: 'Movie', source: { ref: movieRef }, profileId: profiles.adult,
    item: { mediaType: 'movie', tmdbId: 27205 } }, extra || {});
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  fs.mkdirSync(path.join(libraryDir, 'Movie (2020)'), { recursive: true });
  fs.mkdirSync(adultDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'Movie (2020)', 'movie.mkv'), diskData);
  fs.writeFileSync(path.join(adultDir, 'film.mkv'), diskData);
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'cast-pass' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'cast-pass' }));
    });
  }).then(function () {
    return Promise.all([
      call('POST', '/profiles', { name: 'Grown-up' }),
      call('POST', '/profiles', { name: 'Kid', isKid: true }),
      call('POST', '/profiles', { name: 'Locked', pin: '1234' })
    ]);
  }).then(function (made) {
    profiles = { adult: made[0].body.id, kid: made[1].body.id, locked: made[2].body.id };
    return userData.services();
  }).then(function (s) {
    return Promise.all([
      s.library.addFolder({ path: libraryDir, kind: 'movies' }).then(function (folder) {
        return s.library.addFile(folder.id, { relPath: 'Movie (2020)/movie.mkv', size: diskData.length });
      }),
      s.library.addFolder({ path: adultDir, kind: 'other', audience: 'adults' }).then(function (folder) {
        return s.library.addFile(folder.id, { relPath: 'film.mkv', size: diskData.length });
      })
    ]);
  }).then(function (rows) {
    movieRef = 'f_' + rows[0].id;
    adultRef = 'f_' + rows[1].id;
  });
});

test.after(function () {
  open.forEach(function (ws) { ws.terminate(); });
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('screens: devices whose events socket takes casts, with what they accept', function () {
  var tv, plain, embedOnly;
  return Promise.all([screen('tv-a'), sender('tv-plain'), screen('tv-embed', '&accepts=embed,nonsense')]).then(function (s) {
    tv = s[0]; plain = s[1]; embedOnly = s[2];
    return call('GET', '/cast/screens', undefined, { device: 'tv-a' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    res.body.forEach(function (x) { conforms('CastScreen', x); });
    var byId = {};
    res.body.forEach(function (x) { byId[x.deviceId] = x; });
    assert.ok(byId['tv-a'] && byId['tv-embed']);
    assert.ok(!byId['tv-plain'], 'a socket without control=cast is no screen');
    assert.equal(byId['tv-a'].self, true);
    assert.equal(byId['tv-embed'].self, false);
    assert.deepEqual(byId['tv-a'].accepts, { media: true, magnet: true, embed: true });
    assert.deepEqual(byId['tv-embed'].accepts, { media: false, magnet: false, embed: true });
    tv.close();
    plain.close();
    embedOnly.close();
    return Promise.all([tv.closed, plain.closed, embedOnly.closed]);
  }).then(function () {
    return call('GET', '/cast/screens', undefined, { device: 'phone-1' });
  }).then(function (res) {
    assert.ok(!res.body.some(function (x) { return x.deviceId === 'tv-a'; }), 'gone with its socket');
  });
});

test('a cast reaches only its screen; the sender follows it through the session', function () {
  var tv, other, phone, castId, sessionId;
  return Promise.all([screen('tv-1'), screen('tv-2'), sender('phone-1')]).then(function (s) {
    tv = s[0]; other = s[1]; phone = s[2];
    return cast('tv-1', { source: { ref: movieRef } });
  }).then(function (res) {
    assert.equal(res.status, 400, 'title missing');
    return cast('tv-1', { title: 'x', source: { ref: 'nope' } });
  }).then(function (res) {
    assert.equal(res.status, 400, 'not a ref');
    return cast('tv-9', movie());
  }).then(function (res) {
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DEVICE_OFFLINE');
    return cast('tv-1', movie({ positionS: 30, pin: undefined }));
  }).then(function (res) {
    assert.equal(res.status, 202);
    assert.equal(res.body.delivered, 1);
    castId = res.body.castId;
    return tv.next('cast.play');
  }).then(function (msg) {
    conforms('CastPlayEvent', msg.data);
    assert.equal(msg.data.castId, castId);
    assert.equal(msg.data.from.deviceId, 'phone-1');
    assert.equal(msg.data.profileId, profiles.adult);
    assert.equal(msg.data.request.source.ref, movieRef);
    assert.equal(msg.data.request.positionS, 30);
    assert.equal(msg.data.request.tracking, 'full');
    return phone.next('cast.updated', function (m) { return m.data.castId === castId; });
  }).then(function (msg) {
    conforms('Cast', msg.data);
    assert.equal(msg.data.state, 'opening');
    return nothing(other, 'cast.play');
  }).then(function () {
    // the screen's player opens the file and names the cast in its keepalive
    return call('POST', '/media/' + movieRef + '/keepalive', { castId: castId, positionS: 31, durationS: 5400, paused: false,
      profileId: profiles.adult, title: 'Movie' }, { device: 'tv-1' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    sessionId = res.body.sessionId;
    return phone.next('cast.updated', function (m) { return m.data.castId === castId && m.data.state === 'playing'; });
  }).then(function (msg) {
    assert.equal(msg.data.sessionId, sessionId);
    assert.equal(msg.data.positionS, 31);
    assert.equal(msg.data.durationS, 5400);
    return call('GET', '/cast/' + castId, undefined, { device: 'phone-1' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('Cast', res.body);
    return call('GET', '/cast/' + castId, undefined, { device: 'stranger' });
  }).then(function (res) {
    assert.equal(res.status, 404, 'only its sender, screen and the admin see it');
    // the sender drives it: through the screen's session
    return call('POST', '/cast/' + castId + '/commands', { action: 'pause' }, { device: 'phone-1' });
  }).then(function (res) {
    assert.equal(res.status, 202);
    return tv.next('session.command');
  }).then(function (msg) {
    conforms('SessionCommandEvent', msg.data);
    assert.equal(msg.data.action, 'pause');
    assert.equal(msg.data.sessionId, sessionId);
    return call('POST', '/cast/' + castId + '/commands', { action: 'pause' }, { device: 'stranger' });
  }).then(function (res) {
    assert.equal(res.status, 403);
    // and through /sessions/{id}/commands, which stays the admin's for anyone else
    return call('POST', '/sessions/' + sessionId + '/commands', { action: 'seek', positionS: 60 }, { device: 'phone-1' });
  }).then(function (res) {
    assert.equal(res.status, 202);
    return tv.next('session.command', function (m) { return m.data.action === 'seek'; });
  }).then(function (msg) {
    assert.equal(msg.data.positionS, 60);
    return call('POST', '/sessions/' + sessionId + '/commands', { action: 'pause' }, { device: 'stranger' });
  }).then(function (res) {
    assert.equal(res.status, 401);
    // the screen lets go: the cast ends for the sender
    return call('DELETE', '/media/' + movieRef, undefined, { device: 'tv-1' });
  }).then(function () {
    return phone.next('cast.ended', function (m) { return m.data.castId === castId; }, 5000);
  }).then(function (msg) {
    assert.equal(msg.data.state, 'ended');
  });
});

test('an embedded video: commands go straight to the screen, which reports its state', function () {
  var tv, phone, castId;
  return Promise.all([screen('tv-3'), sender('phone-2')]).then(function (s) {
    tv = s[0]; phone = s[1];
    return cast('tv-3', { title: 'A video', source: { embed: { provider: 'vimeo', id: 'abcdefgh' } } }, 'phone-2');
  }).then(function (res) {
    assert.equal(res.status, 400, 'YouTube only');
    return cast('tv-3', { title: 'A video', source: { embed: { provider: 'youtube', id: 'dQw4w9WgXcQ' } } }, 'phone-2');
  }).then(function (res) {
    assert.equal(res.status, 202);
    castId = res.body.castId;
    return tv.next('cast.play');
  }).then(function (msg) {
    assert.equal(msg.data.profileId, null, 'no profile asked: the screen\'s own');
    assert.deepEqual(msg.data.request.source, { embed: { provider: 'youtube', id: 'dQw4w9WgXcQ' } });
    return call('POST', '/cast/' + castId + '/state', { state: 'playing', positionS: 12, durationS: 212 }, { device: 'phone-2' });
  }).then(function (res) {
    assert.equal(res.status, 403, 'only the screen reports');
    return call('POST', '/cast/' + castId + '/state', { state: 'dancing' }, { device: 'tv-3' });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('POST', '/cast/' + castId + '/state', { state: 'playing', positionS: 12, durationS: 212 }, { device: 'tv-3' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    conforms('Cast', res.body);
    return phone.next('cast.updated', function (m) { return m.data.state === 'playing'; });
  }).then(function (msg) {
    assert.equal(msg.data.positionS, 12);
    return call('POST', '/cast/' + castId + '/commands', { action: 'seekBy', deltaS: 10 }, { device: 'phone-2' });
  }).then(function (res) {
    assert.equal(res.status, 202);
    return tv.next('session.command');
  }).then(function (msg) {
    conforms('SessionCommandEvent', msg.data);
    assert.equal(msg.data.castId, castId);
    assert.equal(msg.data.sessionId, null);
    assert.equal(msg.data.deltaS, 10);
    return call('POST', '/cast/' + castId + '/commands', { action: 'stop' }, { device: 'phone-2' });
  }).then(function (res) {
    assert.equal(res.status, 202);
    return Promise.all([tv.next('session.command', function (m) { return m.data.action === 'stop'; }),
      phone.next('cast.ended', function (m) { return m.data.castId === castId; })]);
  }).then(function () {
    return call('POST', '/cast/' + castId + '/commands', { action: 'pause' }, { device: 'phone-2' });
  }).then(function (res) {
    assert.equal(res.status, 404, 'an ended cast takes no commands');
  });
});

test('a screen that plays only embeds refuses a file; a new cast replaces the running one', function () {
  var tv, phone, first;
  return Promise.all([screen('tv-4', '&accepts=embed'), sender('phone-3')]).then(function (s) {
    tv = s[0]; phone = s[1];
    return cast('tv-4', movie(), 'phone-3');
  }).then(function (res) {
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'UNSUPPORTED');
    return cast('tv-4', { title: 'One', source: { embed: { provider: 'youtube', id: 'aaaaaaaaaaa' } } }, 'phone-3');
  }).then(function (res) {
    first = res.body.castId;
    return cast('tv-4', { title: 'Two', source: { embed: { provider: 'youtube', id: 'bbbbbbbbbbb' } } }, 'phone-3');
  }).then(function (res) {
    assert.equal(res.status, 202);
    return phone.next('cast.ended', function (m) { return m.data.castId === first; });
  }).then(function () {
    return call('GET', '/cast/screens', undefined, { device: 'phone-3' });
  }).then(function (res) {
    var mine = res.body.filter(function (x) { return x.deviceId === 'tv-4'; })[0];
    assert.equal(mine.playing.title, 'Two');
    tv.close();
  });
});

test('profiles: a locked one needs its PIN, or the device that opened it', function () {
  var tv;
  return screen('tv-5').then(function (s) {
    tv = s;
    return cast('tv-5', movie({ profileId: 'nobody' }));
  }).then(function (res) {
    assert.equal(res.status, 404);
    return cast('tv-5', movie({ profileId: profiles.locked }));
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CAST_REFUSED');
    return cast('tv-5', movie({ profileId: profiles.locked, pin: '0000' }));
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN', 'a wrong PIN');
    return cast('tv-5', movie({ profileId: profiles.locked, pin: '1234' }));
  }).then(function (res) {
    assert.equal(res.status, 202);
    // phone-4 opened it on the profile picker: it may cast as it
    return call('POST', '/profiles/' + profiles.locked + '/unlock', { pin: '1234' }, { device: 'phone-4' });
  }).then(function () {
    return cast('tv-5', movie({ profileId: profiles.locked }), 'phone-4');
  }).then(function (res) {
    assert.equal(res.status, 202);
    // the admin may cast as any profile
    return call('POST', '/cast/screens/tv-5/play', movie({ profileId: profiles.locked }), { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 202);
    tv.close();
  });
});

test('an adults-only source: never as or to a kids profile, never tracked', function () {
  var tv;
  return screen('tv-6').then(function (s) {
    tv = s;
    return cast('tv-6', { title: 'Film', source: { ref: adultRef }, profileId: profiles.kid });
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CAST_REFUSED');
    return cast('tv-6', { title: 'Film', source: { ref: adultRef }, profileId: profiles.adult });
  }).then(function (res) {
    assert.equal(res.status, 202);
    return tv.next('cast.play');
  }).then(function (msg) {
    assert.equal(msg.data.request.tracking, 'none', 'forced');
    // the screen plays something as the kid now: refused there too
    return call('POST', '/media/' + movieRef + '/keepalive', { profileId: profiles.kid }, { device: 'tv-6' });
  }).then(function () {
    return cast('tv-6', { title: 'Film', source: { ref: adultRef }, profileId: profiles.adult });
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CAST_REFUSED');
    // an ordinary film is fine
    return cast('tv-6', movie());
  }).then(function (res) {
    assert.equal(res.status, 202);
    return call('DELETE', '/media/' + movieRef, undefined, { device: 'tv-6' });
  }).then(function () {
    // an expired plugin source is said so at once
    return cast('tv-6', { title: 'Gone', source: { ref: 'r_' + '0'.repeat(32) } });
  }).then(function (res) {
    assert.equal(res.status, 404);
    tv.close();
  });
});

test('casting off on the server: refused', function () {
  var tv;
  return screen('tv-7').then(function (s) {
    tv = s;
    settings.update({ cast: { enabled: false } });
    return cast('tv-7', movie());
  }).then(function (res) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CAST_REFUSED');
    settings.update({ cast: { enabled: true } });
    tv.close();
  });
});
