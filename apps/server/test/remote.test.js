'use strict';

// Control from the server (docs/remote-control-plan.md): session commands
// addressed to one device's events sockets (local and declared with
// ?control=playback), Stop asking the player first then cutting, the remote
// socket relaying a controller's input to its target (capabilities, shapes,
// take-over, refusals, cursor back), GET /remote/targets; answers against
// openapi.yaml. The real server with the fake engine, offline.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  WebSocket = require('ws'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-remote-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  sessions = require('../lib/sessions'),
  engines = require('../lib/torrents/engines'),
  logger = require('../lib/logger'),
  helpers = require('./helpers/torrent');

var seedDir = path.join(tmp, 'seed'),
  seeder = engines.create('fake'),
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } },
  film = helpers.make(seedDir, 'Film.2021', [{ path: 'film.mkv', size: 400000 }]),
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

// A socket that keeps what it receives; .next(type|topic) waits for one
function socket(apiPath, headers) {
  var ws = new WebSocket(base.replace('http', 'ws') + '/api/v1' + apiPath, { headers: headers || {} }),
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
  ws.ready = new Promise(function (resolve, reject) {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.closed = new Promise(function (resolve) { ws.on('close', function (code) { resolve(code); }); });
  ws.next = function (what, test, ms) {
    var match = function (m) { return (m.type === what || m.topic === what) && (!test || test(m)); },
      seen = got.filter(match)[0];
    if (seen) {
      got.splice(got.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise(function (resolve, reject) {
      var w = { match: match, resolve: function (m) { clearTimeout(timer); got.splice(got.indexOf(m), 1); resolve(m); } },
        timer = setTimeout(function () { reject(new Error('no ' + what)); }, ms || 3000);
      waiting.push(w);
    });
  };
  ws.json = function (msg) { ws.send(JSON.stringify(msg)); };
  return ws;
}

function nothing(ws, what, ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 300); }).then(function () {
    assert.ok(!ws.got.some(function (m) { return m.type === what || m.topic === what; }), 'no ' + what);
  });
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  sessions.configure({ stopAskMs: 400 });
  return seeder.init({ dataDir: seedDir, stateDir: path.join(seedDir, '.state'), log: logger.child('torrent') }).then(function () {
    return seeder.add({ infoHash: film.infoHash, torrentFile: film.torrentFile, savePath: seedDir });
  }).then(function () {
    return server.start(OPTIONS);
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'remote-pass' });
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
      req.end(JSON.stringify({ username: 'admin', password: 'remote-pass' }));
    });
  });
});

test.after(function () {
  open.forEach(function (ws) { ws.terminate(); });
  return server.stop().then(function () {
    return seeder.close();
  }).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function session(device) {
  return call('GET', '/sessions', undefined, { admin: true }).then(function (res) {
    return res.body.filter(function (s) { return s.deviceId === device; })[0];
  });
}

test('session commands reach only the session\'s device, which declared them', function () {
  var tv = socket('/events?device=tv-1&control=playback&topics=session'),
    other = socket('/events?device=tv-2&control=playback&topics=session'),
    plain = socket('/events?device=tv-3&topics=session'),
    id = null;
  return Promise.all([tv.ready, other.ready, plain.ready]).then(function () {
    return call('POST', '/torrents', { link: film.magnet }, { device: 'tv-1' });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return session('tv-1');
  }).then(function (s) {
    conforms('Session', s);
    assert.deepEqual(s.control, { online: true, playback: true, keyboard: false, pointer: false, text: false });
    id = s.id;
    return call('POST', '/sessions/' + id + '/commands', { action: 'pause' });
  }).then(function (res) {
    assert.equal(res.status, 401, 'the admin only');
    return call('POST', '/sessions/' + id + '/commands', { action: 'jump' }, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 400);
    return call('POST', '/sessions/' + id + '/commands', { action: 'seek' }, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 400, 'seek needs positionS');
    return call('POST', '/sessions/' + id + '/commands', { action: 'seek', positionS: 125.5 }, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 202);
    assert.equal(res.body.delivered, 1);
    return tv.next('session.command');
  }).then(function (msg) {
    conforms('SessionCommandEvent', msg.data);
    assert.equal(msg.data.action, 'seek');
    assert.equal(msg.data.positionS, 125.5);
    assert.equal(msg.data.sessionId, id);
    assert.equal(msg.data.infoHash, film.infoHash);
    assert.equal(msg.data.by, 'admin');
    return Promise.all([nothing(other, 'session.command'), nothing(plain, 'session.command')]);
  }).then(function () {
    // the device closes its socket: offline
    tv.close();
    return tv.closed;
  }).then(function () {
    return call('POST', '/sessions/' + id + '/commands', { action: 'pause' }, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DEVICE_OFFLINE');
    return call('DELETE', '/torrents/' + film.infoHash, undefined, { device: 'tv-1' });
  });
});

test('a device that doesn\'t take commands: UNSUPPORTED; Stop cuts it at once', function () {
  var tv = socket('/events?device=tv-4&topics=session'), id = null;
  return tv.ready.then(function () {
    return call('POST', '/torrents', { link: film.magnet }, { device: 'tv-4' });
  }).then(function () {
    return session('tv-4');
  }).then(function (s) {
    id = s.id;
    assert.equal(s.control.online, true);
    assert.equal(s.control.playback, false);
    return call('POST', '/sessions/' + id + '/commands', { action: 'pause' }, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'UNSUPPORTED');
    return call('DELETE', '/sessions/' + id, undefined, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return tv.next('session.ended', function (m) { return m.data.id === id; });
  });
});

test('Stop asks the player first, then cuts a player that keeps the lease', function () {
  var tv = socket('/events?device=tv-5&control=playback&topics=session'), id = null;
  return tv.ready.then(function () {
    return call('POST', '/torrents', { link: film.magnet }, { device: 'tv-5' });
  }).then(function () {
    return session('tv-5');
  }).then(function (s) {
    id = s.id;
    return call('DELETE', '/sessions/' + id, undefined, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 200);
    return tv.next('session.command');
  }).then(function (msg) {
    assert.equal(msg.data.action, 'stop');
    return session('tv-5');
  }).then(function (s) {
    assert.ok(s, 'still there while the player is asked');
    // this "player" never lets go: cut after stopAskMs
    return tv.next('session.ended', function (m) { return m.data.id === id; }, 3000);
  }).then(function () {
    return session('tv-5');
  }).then(function (s) {
    assert.equal(s, undefined);
  });
});

test('the remote socket relays a controller\'s input to its target', function () {
  var target = socket('/remote?device=tv-6'), controller = null, second = null, intruder = null;
  return target.ready.then(function () {
    target.json({ type: 'hello', role: 'target', capabilities: { keyboard: true, pointer: true, text: false }, screen: { width: 1440, height: 810 } });
    return target.next('state');
  }).then(function (state) {
    assert.equal(state.connected, false, 'no controller yet');
    return call('GET', '/remote/targets', undefined, { admin: true });
  }).then(function (res) {
    assert.equal(res.status, 200);
    var t = res.body.filter(function (x) { return x.deviceId === 'tv-6'; })[0];
    conforms('RemoteTarget', t);
    assert.deepEqual(t.capabilities, { keyboard: true, pointer: true, text: false, rtc: false });
    assert.equal(t.controller, null);
    // a client without the admin's session can't control
    intruder = socket('/remote?role=controller&device=tv-6');
    return intruder.ready.then(function () { return intruder.closed; });
  }).then(function (code) {
    assert.equal(code, 4003);
    controller = socket('/remote?role=controller&device=tv-6', { Cookie: cookie });
    return controller.ready;
  }).then(function () {
    return Promise.all([controller.next('state', function (s) { return s.connected; }), target.next('state', function (s) { return s.connected; })]);
  }).then(function (states) {
    assert.equal(states[0].device.id, 'tv-6');
    assert.deepEqual(states[0].screen, { width: 1440, height: 810 });
    assert.equal(states[1].controller.name, 'admin');
    controller.json({ type: 'key', phase: 'down', key: 'ArrowDown', code: 'ArrowDown', modifiers: ['shift', 'hyper'], repeat: true, extra: 1 });
    return target.next('key');
  }).then(function (key) {
    assert.deepEqual(key, { type: 'key', phase: 'down', key: 'ArrowDown', code: 'ArrowDown', modifiers: ['shift'], repeat: true });
    controller.json({ type: 'text', text: 'dune' });                 // not declared: dropped
    controller.json({ type: 'pointer', phase: 'move', dx: 12, dy: -5000 });
    return target.next('pointer');
  }).then(function (p) {
    assert.deepEqual(p, { type: 'pointer', phase: 'move', dx: 12, dy: -4000 });
    controller.json({ type: 'pointer', phase: 'down', button: 'left' });
    controller.json({ type: 'pointer', phase: 'down', button: 'nose' });
    controller.json({ type: 'pointer', phase: 'move', x: 0.5, y: 2 });
    return target.next('pointer', function (m) { return m.phase === 'down'; });
  }).then(function (p) {
    assert.equal(p.button, 'left');
    return target.next('pointer', function (m) { return m.phase === 'move'; });
  }).then(function (p) {
    assert.deepEqual(p, { type: 'pointer', phase: 'move', x: 0.5, y: 1 });
    return nothing(target, 'text');
  }).then(function () {
    target.json({ type: 'cursor', x: 0.25, y: 0.75 });
    return controller.next('cursor');
  }).then(function (c) {
    assert.deepEqual(c, { type: 'cursor', x: 0.25, y: 0.75 });
    // no rtc declared: no WebRTC set-up reaches it
    controller.json({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0' } } });
    return nothing(target, 'signal');
  }).then(function () {
    return call('GET', '/sessions', undefined, { admin: true });
  }).then(function () {
    // a second controller takes over
    second = socket('/remote?role=controller&device=tv-6', { Cookie: cookie });
    return second.ready;
  }).then(function () {
    return Promise.all([controller.next('state', function (s) { return s.reason === 'taken'; }), controller.closed,
      second.next('state', function (s) { return s.connected; })]);
  }).then(function (r) {
    assert.equal(r[1], 4001);
    // the controller lets go: the target hears it
    second.json({ type: 'bye' });
    return target.next('state', function (s) { return !s.connected && s.reason === 'ended'; });
  }).then(function () {
    // the target leaves: a new controller hears it's offline
    target.close();
    return target.closed;
  }).then(function () {
    var late = socket('/remote?role=controller&device=tv-6', { Cookie: cookie });
    return late.ready.then(function () { return late.next('state'); });
  }).then(function (state) {
    assert.equal(state.connected, false);
    assert.equal(state.reason, 'offline');
  });
});

test('the remote socket relays WebRTC set-up between a controller and an rtc target', function () {
  var target = socket('/remote?device=tv-7'), controller = null;
  return target.ready.then(function () {
    target.json({ type: 'hello', role: 'target', capabilities: { keyboard: true, pointer: true, text: true, rtc: true } });
    controller = socket('/remote?role=controller&device=tv-7', { Cookie: cookie });
    return controller.ready;
  }).then(function () {
    return controller.next('state', function (s) { return s.connected; });
  }).then(function (state) {
    assert.equal(state.capabilities.rtc, true);
    controller.json({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 offer' }, extra: 1 } });
    return target.next('signal');
  }).then(function (m) {
    assert.deepEqual(m, { type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 offer' } } });
    target.json({ type: 'signal', data: { description: { type: 'answer', sdp: 'v=0 answer' } } });
    return controller.next('signal');
  }).then(function (m) {
    assert.deepEqual(m.data, { description: { type: 'answer', sdp: 'v=0 answer' } });
    controller.json({ type: 'signal', data: { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
    return target.next('signal');
  }).then(function (m) {
    assert.deepEqual(m.data, { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } });
    target.json({ type: 'signal', data: { candidate: null } });
    return controller.next('signal');
  }).then(function (m) {
    assert.deepEqual(m.data, { candidate: null });
    // malformed ones are dropped
    controller.json({ type: 'signal', data: { description: { type: 'rollback', sdp: 'x' } } });
    controller.json({ type: 'signal', data: 'offer' });
    controller.json({ type: 'signal', data: { candidate: { candidate: 42 } } });
    return nothing(target, 'signal');
  }).then(function () {
    controller.close();
    target.close();
    return target.closed;
  });
});

test('a target without a device id is refused', function () {
  var ws = socket('/remote');
  return ws.ready.then(function () { return ws.closed; }).then(function (code) {
    assert.equal(code, 4003);
  });
});
