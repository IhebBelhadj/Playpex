'use strict';

// Events, schedules, writes, linking and notifications (docs/plugins-plan.md
// step P3b) on a real server, with test plugins and a local HTTPS server
// (openssl certificate on 127.0.0.2) as a fake device-code service:
//
//   playback.* reach a plugin only for profiles granted events.playback; a kids profile's never reach an adults plugin
//   a full queue drops the oldest and the next event says how many (dropped: n)
//   a job runs on its interval, never overlaps itself (a run still going skips the next), runs again after a restart
//   writes go through the core (watch list, watched, ratings, downloads) with `by`, never come back to their writer,
//   and a profile not granted the scope is never written
//   linking against the fake device-code service stores the token and refreshes it near expiry; unlink forgets it
//   a notification reaches only the named profiles, once per device, is kept for a device that asks later,
//   never reaches a kids profile from an adults plugin, and is rate limited

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-events-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
// no TMDB from tests (writes ask it for posters, best effort)
process.env.TMDB_API_KEY = '';

var server = require('..'),
  plugins = require('../lib/plugins'),
  bus = require('../lib/plugins/bus'),
  schemas = require('../lib/plugins/schemas'),
  sessions = require('../lib/sessions');

var TEST_HOST = '127.0.0.2',
  HOST = 'api.playpex-test.dev',
  base = null,
  cookie = null,
  remote = null,
  remotePort = 0,
  tls = null,
  options = null,
  device = { approved: false, tokenCalls: 0, refreshes: 0 },
  ana = null, bob = null, kid = null;

// ── fixtures ────────────────────────────────────────────────────────────────

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

function lookup(host, opts, callback) {
  if (host !== HOST) {
    return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  }
  callback(null, [{ address: TEST_HOST, family: 4 }]);
}

// The fake service: a slow answer, and an RFC 8628 device flow
function web(req, res) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var url = new URL(req.url, 'https://x'),
      form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/slow') {
      return setTimeout(function () { res.end('{"slow":true}'); }, 300);
    }
    if (url.pathname === '/device/code') {
      assert.equal(form.get('client_id'), 'client-1');
      return res.end(JSON.stringify({ device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://' + HOST + '/activate',
        expires_in: 600, interval: 1 }));
    }
    if (url.pathname === '/device/token') {
      if (form.get('grant_type') === 'refresh_token') {
        device.refreshes++;
        assert.equal(form.get('refresh_token'), 'rt-1');
        return res.end(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
      }
      device.tokenCalls++;
      assert.equal(form.get('device_code'), 'dc-1');
      if (!device.approved) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'authorization_pending' }));
      }
      // expires within the refresh margin: link.status refreshes it
      return res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 60 }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
}

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

// Records every event it gets in its store; data handlers to read them and to write
var RECORDER = String.raw`
var NAMES = ['playback.started', 'playback.progress', 'playback.paused', 'playback.ended', 'playback.finished',
  'watchlist.added', 'watchlist.removed', 'watched.set', 'watched.cleared', 'rating.set',
  'download.added', 'download.completed', 'download.removed', 'library.changed'];
var log = [];
NAMES.forEach(function (name) {
  try {
    playpex.events.on(name, function (e) { log.push(e); });
  } catch (err) { /* not in its permissions */ }
});
playpex.data('events', function () { var out = log; log = []; return { data: out }; });
`;

var WATCHER = RECORDER + String.raw`
playpex.data('write', async function (args) {
  try {
    var r;
    switch (args.op) {
      case 'watchlist.add': r = await playpex.watchlist.add(args.profileId, args.title); break;
      case 'watchlist.list': r = await playpex.watchlist.list(args.profileId); break;
      case 'watched.set': r = await playpex.watched.set(args.profileId, args.title, args.options); break;
      case 'progress.set': r = await playpex.progress.set(args.profileId, args.title, args.position, args.duration); break;
      case 'ratings.set': r = await playpex.ratings.set(args.profileId, args.title, args.value); break;
      case 'downloads.add': r = await playpex.downloads.add(args.request); break;
      case 'downloads.list': r = await playpex.downloads.list(); break;
      case 'profiles': r = await playpex.profiles.list(args.permission); break;
      case 'link': r = await playpex.link.status('acct', args.profileId); break;
      case 'notify': r = await playpex.notify.send(args.profiles, args.message); break;
    }
    return { data: { ok: true, value: r === undefined ? null : r } };
  } catch (err) {
    return { data: { ok: false, code: err.code || 'ERROR', message: err.message } };
  }
});
`;

var ADULTS = RECORDER + String.raw`
playpex.data('notify', async function (args) {
  return { data: await playpex.notify.send(args.profiles, args.message) };
});
`;

// Events taking 300 ms each (an HTTP call): its queue fills
var SLOW = String.raw`
var got = [];
playpex.events.on('watchlist.added', async function (e) {
  await playpex.http.request({ url: 'https://${HOST}:PORT/slow', responseType: 'json' });
  got.push({ tmdbId: e.data.title.tmdbId, dropped: e.dropped || 0 });
});
playpex.data('got', function () { return { data: got }; });
`;

// A job of 150 ms whose runs take 300 ms (an HTTP call): never two at once
var TICKER = String.raw`
var runs = [];
playpex.schedule.every('tick', 150, async function () {
  var start = Date.now();
  await playpex.http.request({ url: 'https://${HOST}:PORT/slow', responseType: 'json' });
  runs.push([start, Date.now()]);
});
playpex.data('runs', function () { return { data: runs }; });
`;

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
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function data(plugin, name, args) {
  return call('POST', '/plugins/' + plugin + '/data/' + name, { args: args || {} }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return r.json.data;
  });
}

function events(plugin) {
  return bus.settled().then(function () { return wait(150); }).then(function () { return data(plugin, 'events'); });
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn, ms) {
  var end = Date.now() + (ms || 8000);
  return new Promise(function (resolve, reject) {
    (function poll() {
      Promise.resolve(fn()).then(function (ok) {
        if (ok) {
          return resolve(ok);
        }
        if (Date.now() > end) {
          return reject(new Error('timed out'));
        }
        setTimeout(poll, 100);
      }, reject);
    })();
  });
}

function grant(plugin, profile, permission, granted) {
  return call('PUT', '/admin/plugins/' + plugin + '/grants', { profile: profile, permission: permission, granted: granted !== false })
    .then(function (r) { assert.equal(r.status, 200, r.text); return r.json; });
}

// A player's lease and keepalives, as lib/routes/media.js would make them
function play(profileId, key) {
  var req = { get: function (h) { return h.toLowerCase() === 'x-playpex-device' ? 'tv-1' : undefined; }, query: {}, socket: { remoteAddress: '127.0.0.1' } };
  var lease = sessions.acquire(key, req);
  lease.ref = key;
  var media = { mediaType: 'movie', tmdbId: 603 };
  sessions.report(lease, { positionS: 10, durationS: 100, profileId: profileId, media: media, title: 'The Matrix' });
  sessions.report(lease, { positionS: 20, durationS: 100, profileId: profileId, media: media, paused: true });
  sessions.report(lease, { positionS: 95, durationS: 100, profileId: profileId, media: media, paused: false });
  sessions.release(key, 'tv-1');
}

function start() {
  return server.start(options).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return until(function () {
      var all = plugins.list();
      return all.length === 4 && all.every(function (p) { return p.state === 'enabled'; });
    }, 20000);
  });
}

test.before(function () {
  tls = certificate();
  if (!tls) {
    return;
  }
  return new Promise(function (resolve) {
    remote = https.createServer({ key: tls.key, cert: tls.cert }, web);
    remote.listen(0, TEST_HOST, function () {
      remotePort = remote.address().port;
      resolve();
    });
  }).then(function () {
    function port(code) { return code.replace(/PORT/g, String(remotePort)); }
    var dirs = [
      writePlugin('watcher', {
        permissions: {
          network: [HOST], storage: '64KB', secrets: ['clientId'], schedule: false, notify: true, link: ['acct'],
          events: ['playback', 'watchlist', 'downloads'], write: ['watchlist', 'watched', 'ratings', 'downloads']
        },
        link: [{ name: 'acct', label: 'Test account', scope: 'profile', deviceCode: {
          codeUrl: 'https://' + HOST + ':' + remotePort + '/device/code', tokenUrl: 'https://' + HOST + ':' + remotePort + '/device/token',
          clientIdSecret: 'clientId' } }],
        contributes: { settings: [{ key: 'clientId', scope: 'server', type: 'secret', label: 'Client id' }] }
      }, WATCHER),
      writePlugin('adultwatch', { audience: 'adults', permissions: { events: ['playback', 'watchlist'], notify: true } }, ADULTS),
      writePlugin('slow', { permissions: { network: [HOST], events: ['watchlist'] } }, port(SLOW)),
      writePlugin('ticker', { permissions: { network: [HOST], schedule: true } }, port(TICKER))
    ];
    options = {
      port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
      plugins: {
        dirs: dirs, installed: false,
        http: { lookup: lookup, ports: [remotePort], ca: tls.cert, allowAddresses: [TEST_HOST] },
        schedule: { minIntervalMs: 100, startDelayMs: 0 },
        events: { queue: 5 }
      }
    };
    return start();
  }).then(function () {
    return call('POST', '/admin/setup', { username: 'admin', password: 'events-pass' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'events-pass' });
  }).then(function (r) {
    cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0];
    return Promise.all([
      call('POST', '/profiles', { name: 'Ana' }), call('POST', '/profiles', { name: 'Bob' }), call('POST', '/profiles', { name: 'Kid', isKid: true })
    ]);
  }).then(function (r) {
    ana = r[0].json.id;
    bob = r[1].json.id;
    kid = r[2].json.id;
  });
});

test.after(function () {
  return server.stop().then(function () {
    if (remote) {
      remote.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

var skip = function () { return !tls && 'no openssl'; };

// ── events ──────────────────────────────────────────────────────────────────

test('playback events only for profiles granted events.playback', { skip: skip() }, function () {
  return grant('watcher', ana, 'events.playback').then(function (view) {
    assert.deepEqual(view.profiles.filter(function (p) { return p.id === ana; })[0].grants, ['events.playback']);
    assert.ok(view.personal.some(function (x) { return x.key === 'events.playback'; }));
    return Promise.all([events('watcher'), events('adultwatch')]);
  }).then(function () {
    play(ana, 'f_ana');
    play(bob, 'f_bob');
    return events('watcher');
  }).then(function (got) {
    var names = got.map(function (e) { return e.name; });
    assert.deepEqual(names, ['playback.started', 'playback.paused', 'playback.progress', 'playback.finished', 'playback.ended']);
    assert.ok(got.every(function (e) { return e.context.profile.id === ana; }), 'Bob wasn\'t granted');
    assert.deepEqual(got[0].data, { title: { kind: 'movie', tmdbId: 603 }, position: 10, duration: 100, source: 'file' });
    assert.equal(got[0].context.device.id, 'tv-1');
    got.forEach(function (e) { assert.equal(schemas.apiProblem('event', e), null, e.name); });
    return events('adultwatch');
  }).then(function (got) {
    assert.deepEqual(got, [], 'the adults plugin wasn\'t granted either');
  });
});

test('a kids profile\'s events never reach an adults plugin', { skip: skip() }, function () {
  return Promise.all([grant('adultwatch', ana, 'events.playback'), call('PUT', '/admin/plugins/adultwatch/grants',
    { profile: kid, permission: 'events.playback', granted: true })]).then(function (r) {
    assert.equal(r[1].status, 404, 'a kids profile isn\'t offered an adults plugin');
    play(kid, 'f_kid');
    return call('PUT', '/profiles/' + kid + '/watchlist/movie/550', { title: 'Fight Club' });
  }).then(function () {
    return Promise.all([events('adultwatch'), events('watcher')]);
  }).then(function (r) {
    assert.deepEqual(r[0], []);
    assert.deepEqual(r[1].map(function (e) { return e.name; }), ['watchlist.added'], 'an everyone plugin sees the kid\'s watch list');
    assert.equal(r[1][0].by, 'user');
    return call('DELETE', '/profiles/' + kid + '/watchlist/movie/550');
  }).then(function () {
    return events('watcher');
  }).then(function (got) {
    assert.deepEqual(got.map(function (e) { return e.name; }), ['watchlist.removed']);
  });
});

test('a full queue drops the oldest; the next event says how many', { skip: skip() }, function () {
  var adds = [];
  for (var i = 1; i <= 12; i++) {
    adds.push(call('PUT', '/profiles/' + bob + '/watchlist/movie/' + (1000 + i), { title: 'Film ' + i }));
  }
  return Promise.all(adds).then(function () {
    return until(function () {
      return data('slow', 'got').then(function (got) { return got.length >= 6 && got; });
    }, 10000);
  }).then(function () {
    return wait(1500);
  }).then(function () {
    return data('slow', 'got');
  }).then(function (got) {
    var dropped = got.reduce(function (n, g) { return n + g.dropped; }, 0),
      films = got.filter(function (g) { return g.tmdbId > 1000; }).length;
    assert.ok(films < 12, 'some were dropped: ' + JSON.stringify(got));
    assert.equal(films + dropped, 12, 'every event is delivered or counted: ' + JSON.stringify(got));
    assert.ok(got.some(function (g) { return g.dropped > 0; }));
    return Promise.all([events('watcher'), events('adultwatch')]);
  });
});

// ── writes ──────────────────────────────────────────────────────────────────

var MATRIX = { kind: 'movie', tmdbId: 603, title: 'The Matrix' };

test('writes need the profile\'s grant; they go through the core with `by` and never come back', { skip: skip() }, function () {
  return data('watcher', 'write', { op: 'watchlist.add', profileId: bob, title: MATRIX }).then(function (r) {
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PERMISSION_DENIED');
    return call('GET', '/profiles/' + bob + '/watchlist');
  }).then(function (r) {
    assert.ok(!r.json.some(function (w) { return w.tmdbId === 603; }), 'Bob\'s watch list untouched');
    return Promise.all([grant('watcher', ana, 'write.watchlist'), grant('watcher', ana, 'write.watched'), grant('watcher', ana, 'write.ratings')]);
  }).then(function () {
    return data('watcher', 'write', { op: 'profiles', permission: 'write.watchlist' });
  }).then(function (r) {
    assert.deepEqual(r.value, [{ id: ana, kids: false }]);
    return data('watcher', 'write', { op: 'watchlist.add', profileId: ana, title: MATRIX });
  }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    return call('GET', '/profiles/' + ana + '/watchlist');
  }).then(function (r) {
    assert.ok(r.json.some(function (w) { return w.tmdbId === 603 && w.title === 'The Matrix'; }), JSON.stringify(r.json));
    return data('watcher', 'write', { op: 'watched.set', profileId: ana, title: MATRIX, options: { at: '2026-01-02T03:04:05Z' } });
  }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    return call('GET', '/profiles/' + ana + '/history');
  }).then(function (r) {
    var view = r.json.filter(function (h) { return h.tmdbId === 603; })[0];
    assert.ok(view, JSON.stringify(r.json));
    assert.equal(new Date(view.watchedAt).toISOString(), '2026-01-02T03:04:05.000Z');
    return data('watcher', 'write', { op: 'ratings.set', profileId: ana, title: MATRIX, value: 9 });
  }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    return data('watcher', 'write', { op: 'ratings.set', profileId: ana, title: MATRIX, value: 11 });
  }).then(function (r) {
    assert.equal(r.code, 'INVALID');
    return Promise.all([events('watcher'), events('adultwatch')]);
  }).then(function (r) {
    assert.deepEqual(r[0], [], 'its own writes never come back to it');
    var names = r[1].map(function (e) { return e.name + ' ' + e.by; });
    assert.deepEqual(names, ['watchlist.added plugin:watcher', 'watched.set plugin:watcher', 'rating.set plugin:watcher']);
    assert.equal(r[1][2].data.rating, 10, 'a like');
    r[1].forEach(function (e) { assert.equal(schemas.apiProblem('event', e), null, e.name); });
  });
});

test('progress.set keeps the core\'s newer position', { skip: skip() }, function () {
  var episode = { kind: 'episode', tmdbId: 1396, season: 1, episode: 2, title: 'Breaking Bad' };
  return call('PUT', '/profiles/' + ana + '/progress/tv/1396', { season: 1, episode: 2, positionS: 600, durationS: 2800 }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return data('watcher', 'write', { op: 'progress.set', profileId: ana, title: episode, position: 300, duration: 2800 });
  }).then(function (r) {
    assert.equal(r.value, true, 'a write made now is newer: ' + JSON.stringify(r));
    return call('GET', '/profiles/' + ana + '/progress/tv/1396?season=1&episode=2');
  }).then(function (r) {
    assert.equal(r.json.resume.positionS, 300);
  });
});

test('downloads: added by the plugin, its own listed', { skip: skip() }, function () {
  return data('watcher', 'write', { op: 'downloads.add', request: { infoHash: 'a'.repeat(40), title: 'Big Buck Bunny', ref: MATRIX } }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    return call('GET', '/downloads');
  }).then(function (r) {
    var d = r.json.filter(function (x) { return x.infoHash === 'a'.repeat(40); })[0];
    assert.ok(d);
    assert.equal(d.addedBy, 'plugin:watcher');
    assert.deepEqual(d.title, { mediaType: 'movie', tmdbId: 603, title: 'Big Buck Bunny' });
    return data('watcher', 'write', { op: 'downloads.list' });
  }).then(function (r) {
    assert.deepEqual(r.value.map(function (d) { return d.infoHash; }), ['a'.repeat(40)]);
    return events('watcher');
  }).then(function (got) {
    assert.deepEqual(got.filter(function (e) { return e.name.indexOf('download.') === 0; }), [], 'its own download isn\'t told back');
    return call('DELETE', '/downloads/' + 'a'.repeat(40) + '?data=delete');
  });
});

// ── schedules ───────────────────────────────────────────────────────────────

function overlaps(runs) {
  return runs.some(function (r, i) { return i > 0 && r[0] < runs[i - 1][1]; });
}

test('a job runs on its interval, never overlaps itself, and again after a restart', { skip: skip() }, function () {
  return until(function () {
    return data('ticker', 'runs').then(function (runs) { return runs.length >= 3 && runs; });
  }, 10000).then(function (runs) {
    assert.ok(!overlaps(runs), JSON.stringify(runs));
    return call('GET', '/admin/plugins');
  }).then(function (r) {
    var job = r.json.plugins.filter(function (p) { return p.id === 'ticker'; })[0].jobs[0];
    assert.equal(job.name, 'tick');
    assert.ok(job.runs >= 3 && job.skipped >= 1, JSON.stringify(job));
    return server.stop();
  }).then(function () {
    var saved = cookie;
    return start().then(function () { cookie = saved; });
  }).then(function () {
    return until(function () {
      return data('ticker', 'runs').then(function (runs) { return runs.length >= 2 && runs; });
    }, 10000);
  }).then(function (runs) {
    assert.ok(!overlaps(runs));
  });
});

// ── linking ─────────────────────────────────────────────────────────────────

test('a device-code link: the code, the token kept, refreshed near expiry, unlinked', { skip: skip() }, function () {
  return call('POST', '/admin/plugins/watcher/links/acct/start', { profile: ana }).then(function (r) {
    assert.equal(r.status, 400, 'no client id yet');
    assert.match(r.json.error, /clientId/);
    return call('PUT', '/admin/plugins/watcher/settings', { values: { clientId: 'client-1' } });
  }).then(function () {
    return call('POST', '/admin/plugins/watcher/links/acct/start', {});
  }).then(function (r) {
    assert.equal(r.status, 400, 'a profile link needs its profile');
    return call('POST', '/admin/plugins/watcher/links/acct/start', { profile: ana });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kind, 'code');
    assert.equal(r.json.code, 'ABCD-1234');
    assert.equal(r.json.url, 'https://' + HOST + '/activate');
    return wait(1300);
  }).then(function () {
    assert.ok(device.tokenCalls >= 1, 'it polls');
    return call('GET', '/admin/plugins/watcher/links/acct/progress?profile=' + ana);
  }).then(function (r) {
    assert.equal(r.json.state, 'pending');
    device.approved = true;
    return until(function () {
      return call('GET', '/admin/plugins/watcher/links/acct/progress?profile=' + ana).then(function (x) { return x.json.state === 'done'; });
    }, 8000);
  }).then(function () {
    return call('GET', '/admin/plugins/watcher/links');
  }).then(function (r) {
    var accounts = r.json.links[0].accounts;
    assert.equal(accounts.length, 3, 'one per profile');
    assert.equal(accounts.filter(function (a) { return a.profileId === ana; })[0].linked, true);
    assert.equal(accounts.filter(function (a) { return a.profileId === bob; })[0].linked, false);
    return data('watcher', 'write', { op: 'link', profileId: ana });
  }).then(function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.linked, true);
    assert.equal(r.value.accessToken, 'at-2', 'refreshed: it expired within the margin');
    assert.equal(device.refreshes, 1);
    return data('watcher', 'write', { op: 'link', profileId: ana });
  }).then(function (r) {
    assert.equal(r.value.accessToken, 'at-2');
    assert.equal(device.refreshes, 1, 'fresh now: no second refresh');
    return data('watcher', 'write', { op: 'link', profileId: bob });
  }).then(function (r) {
    assert.deepEqual(r.value, { linked: false, accessToken: null, expiresAt: null });
    return call('DELETE', '/admin/plugins/watcher/links/acct?profile=' + ana);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return data('watcher', 'write', { op: 'link', profileId: ana });
  }).then(function (r) {
    assert.equal(r.value.linked, false);
  });
});

// ── notifications ───────────────────────────────────────────────────────────

test('notifications: only the named profiles, once per device, kept for a device that asks later', { skip: skip() }, function () {
  return data('watcher', 'write', { op: 'notify', profiles: [ana], message: { text: 'Synced 3 titles', tone: 'success', key: 'sync' } }).then(function (r) {
    assert.deepEqual(r.value, { sent: [ana], limited: [] });
    return data('watcher', 'write', { op: 'notify', profiles: [ana], message: { text: 'Synced 4 titles', tone: 'success', key: 'sync' } });
  }).then(function () {
    return call('GET', '/plugins/notifications?profile=' + ana);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.notifications.map(function (n) { return n.text; }), ['Synced 4 titles'], 'one per key, the newest');
    assert.equal(r.json.notifications[0].name, 'Watcher');
    return call('GET', '/plugins/notifications?profile=' + ana);
  }).then(function (r) {
    assert.deepEqual(r.json.notifications, [], 'once per device');
    return call('GET', '/plugins/notifications?profile=' + ana, undefined, { 'X-Playpex-Device': 'tv-2' });
  }).then(function (r) {
    assert.equal(r.json.notifications.length, 1, 'kept for another device');
    return call('GET', '/plugins/notifications?profile=' + bob);
  }).then(function (r) {
    assert.deepEqual(r.json.notifications, []);
    return data('adultwatch', 'notify', { profiles: 'all', message: { text: 'Hello' } });
  }).then(function (r) {
    assert.ok(r.sent.indexOf(kid) === -1 && r.sent.indexOf(ana) !== -1, JSON.stringify(r));
    var sends = [];
    for (var i = 0; i < 11; i++) {
      sends.push(data('watcher', 'write', { op: 'notify', profiles: [bob], message: { text: 'n' + i } }));
    }
    return Promise.all(sends);
  }).then(function (r) {
    var limited = r.filter(function (x) { return x.value.limited.length; }).length;
    assert.equal(limited, 1, 'the 11th within an hour is refused (one before for Ana doesn\'t count for Bob)');
  });
});

test('the dashboard sees its account links and personal permissions', { skip: skip() }, function () {
  return call('GET', '/admin/plugins').then(function (r) {
    var watcher = r.json.plugins.filter(function (p) { return p.id === 'watcher'; })[0];
    assert.equal(watcher.links, 1);
    assert.ok(watcher.personal >= 4);
  });
});
