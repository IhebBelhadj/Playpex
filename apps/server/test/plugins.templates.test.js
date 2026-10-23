'use strict';

// What clients render of plugins (docs/plugins-plan.md step P1, server side)
// and a plugin's settings in the dashboard (§4.3, §6.3), on a real server
// with the example plugin `plugins/hello` (and a broken copy of it):
//
//   GET /plugins: sections, screens and slots, labels translated (Accept-Language), `play`
//   data answers checked against where the manifest uses the handler: a
//   screen's template, a slot's kind (a wrong shape → 502 PLUGIN_FAILED)
//   /admin/plugins/:id/settings: definitions, values, secrets (never shown),
//   per profile values, validation, actions; values reach the handlers

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-templates-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  schemas = require('../lib/plugins/schemas');

var HELLO = path.join(__dirname, '..', '..', '..', 'plugins', 'hello'),
  base = null,
  cookie = null,
  profile = null;

// A copy of hello whose catalog answers a list's shape
function broken() {
  var dir = path.join(tmp, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  var m = JSON.parse(fs.readFileSync(path.join(HELLO, 'playpex-plugin.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'broken', name: 'Broken', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' }, audience: 'everyone',
    permissions: { storage: '4KB' },
    contributes: {
      screens: [{ name: 'home', template: 'catalog', data: 'home' }],
      slots: [{ slot: 'core.movie.actions', data: 'actions' }],
      settings: m.contributes.settings.filter(function (s) { return s.type !== "secret" && s.type !== "action"; })
        .map(function (s) { return Object.assign({}, s, { label: s.label.replace(/^@/, "") }); })
    }
  }));
  fs.writeFileSync(path.join(dir, 'server.js'),
    'playpex.data("home", function () { return { data: { items: [] } }; });' +
    'playpex.data("actions", function () { return { data: [{ key: "x", label: "No icon" }] }; });');
  return dir;
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
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function data(name, args, query, headers) {
  return call('POST', '/plugins/hello/data/' + name + (query || ''), { args: args || {} }, headers);
}

test.before(function () {
  return server.start({
    port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
    plugins: { dirs: [HELLO, broken()], installed: false }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'templates-pass' });
  }).then(function () {
    // signed in by hand: call() doesn't keep headers
    return new Promise(function (resolve, reject) {
      var body = Buffer.from(JSON.stringify({ username: 'admin', password: 'templates-pass' }));
    var req = http.request(new URL('/api/v1/auth/sign-in/username', base), {
      method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' }
    }, function (res) {
      cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(body);
  });
  }).then(function () {
    return call('POST', '/profiles', { name: 'Ana' });
  }).then(function (r) {
    assert.equal(r.status, 201, r.text);
    profile = r.json.id;
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('GET /plugins: what clients render, translated', function () {
  return call('GET', '/plugins', undefined, { 'Accept-Language': 'fr-FR,fr;q=0.9' }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var hello = r.json.plugins.filter(function (p) { return p.id === 'hello'; })[0];
    assert.ok(hello);
    assert.equal(hello.play, true);
    assert.equal(hello.sections[0].menu.label, 'Bonjour');
    assert.equal(hello.sections[0].screen, 'home');
    assert.deepEqual(hello.screens.map(function (s) { return s.template; }), ['catalog', 'title', 'releases', 'list']);
    assert.equal(hello.slots.length, 4);
    assert.equal(hello.settings, undefined, 'settings are the dashboard\'s');
    return call('GET', '/plugins');
  }).then(function (r) {
    var hello = r.json.plugins.filter(function (p) { return p.id === 'hello'; })[0];
    assert.equal(hello.sections[0].menu.label, 'Hello');
  });
});

test('screen handlers answer their template\'s shape', function () {
  return data('home', { params: {}, query: '', filters: {} }, '?profile=' + profile).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(schemas.apiProblem('templates/properties/catalog', r.json.data), null);
    assert.equal(r.json.data.rows[0].page.data, 'page');
    return data('page', { page: 1 }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.items.length, 12, 'the rowSize default');
    assert.equal(r.json.data.last, false);
    return data('title', { params: { id: '3' } }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(schemas.apiProblem('templates/properties/title', r.json.data), null);
    return data('releases', { params: { id: '3' }, query: '', filters: { quality: ['1080p'] }, page: 1 });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.data.releases.length > 0);
    assert.ok(r.json.data.releases.every(function (x) { return x.quality === '1080p'; }));
    return data('menu', { params: {} });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(schemas.apiProblem('templates/properties/list', r.json.data), null);
  });
});

test('slot handlers answer their slot\'s kind', function () {
  var movie = { kind: 'movie', tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix', year: '1999' };
  return data('movieAction', { slot: 'core.movie.actions', context: { movie: movie } }, '?profile=' + profile).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data[0].key, 'hello:party');
    return data('searchFilter', { slot: 'core.search.filters', context: { query: 'harbour' } }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.chip.label, 'Hello');
    assert.ok(r.json.data.rows[0].items.every(function (c) { return /harbour/i.test(c.title); }));
  });
});

test('effects: a confirm with a toast after it', function () {
  return data('wave', { id: 3 }, '?profile=' + profile).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.effects[0].type, 'confirm');
    assert.equal(r.json.effects[0].then.type, 'toast');
  });
});

test('a wrong shape for its template or slot → 502 PLUGIN_FAILED', function () {
  return call('POST', '/plugins/broken/data/home', { args: {} }).then(function (r) {
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.code, 'PLUGIN_FAILED');
    assert.match(r.json.error, /templates\/properties\/catalog/);
    return call('POST', '/plugins/broken/data/actions', { args: {} });
  }).then(function (r) {
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error, /slots\/actions/);
  });
});

test('settings: admin only', function () {
  var saved = cookie;
  cookie = null;
  return call('GET', '/admin/plugins/hello/settings').then(function (r) {
    cookie = saved;
    assert.equal(r.status, 401);
  });
});

test('settings: definitions, defaults, secrets and profiles', function () {
  return call('GET', '/admin/plugins/hello/settings', undefined, { 'Accept-Language': 'fr' }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    var s = r.json;
    var greeting = s.definitions.filter(function (d) { return d.key === 'greeting'; })[0];
    assert.equal(greeting.label, 'Salutation');
    assert.equal(greeting.group, 'Greeting');
    var layout = s.definitions.filter(function (d) { return d.key === 'layout'; })[0];
    assert.deepEqual(layout.options[1], { value: 'still', label: 'Wide pictures' });
    assert.equal(s.definitions.filter(function (d) { return d.key === 'minRating'; })[0].level, 'advanced');
    assert.deepEqual(s.server, { greeting: 'Hello', shout: false, rowSize: 12, minRating: 0 });
    assert.deepEqual(s.secrets, { apiToken: false });
    assert.equal(s.profiles.length, 1);
    assert.deepEqual(s.profiles[0].values, { layout: 'poster', showReleases: true, nickname: null });
  });
});

test('settings: values checked, all or nothing', function () {
  return call('PUT', '/admin/plugins/hello/settings', { values: { rowSize: 2.5, shout: 'yes', layout: 'poster', nope: 1 } }).then(function (r) {
    assert.equal(r.status, 400, r.text);
    var keys = r.json.errors.map(function (e) { return e.key; }).sort();
    assert.deepEqual(keys, ['layout', 'nope', 'rowSize', 'shout']);
    return call('PUT', '/admin/plugins/hello/settings', { profile: profile, values: { nickname: 'Ana 2' } });
  }).then(function (r) {
    assert.equal(r.status, 400, 'pattern');
    return call('PUT', '/admin/plugins/hello/settings', { values: { rowSize: 50 } });
  }).then(function (r) {
    assert.equal(r.status, 400, 'max');
    return call('PUT', '/admin/plugins/hello/settings', { profile: 'nobody', values: { layout: 'still' } });
  }).then(function (r) {
    assert.equal(r.status, 404);
    return call('GET', '/admin/plugins/hello/settings');
  }).then(function (r) {
    assert.equal(r.json.server.rowSize, 12, 'nothing saved');
  });
});

test('settings: saved values reach the handlers, null resets', function () {
  return call('PUT', '/admin/plugins/hello/settings', { values: { rowSize: 5, greeting: 'Hi', shout: true, apiToken: 'secret-1' } }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.server.rowSize, 5);
    assert.deepEqual(r.json.secrets, { apiToken: true });
    assert.ok(r.text.indexOf('secret-1') === -1, 'a secret is never shown');
    return call('PUT', '/admin/plugins/hello/settings', { profile: profile, values: { layout: 'still', nickname: 'Ana' } });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.profiles[0].values.layout, 'still');
    return data('page', { page: 1 }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.json.data.items.length, 5);
    assert.equal(r.json.data.items[0].variant, 'still');
    return data('home', { params: {}, query: '', filters: {} }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.json.data.title, 'HI!, Ana');
    return call('PUT', '/admin/plugins/hello/settings', { values: { rowSize: null, apiToken: '' } });
  }).then(function (r) {
    assert.equal(r.json.server.rowSize, 12);
    assert.deepEqual(r.json.secrets, { apiToken: false });
  });
});

test('settings: an action runs its handler; unknown ones 404', function () {
  return call('PUT', '/admin/plugins/hello/settings', { values: { apiToken: 'tok' } }).then(function () {
    return call('POST', '/admin/plugins/hello/settings/testConnection/run', undefined, { 'Accept-Language': 'fr' });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.effects[0].type, 'toast');
    assert.match(r.json.effects[0].text, /de l'extension d'exemple \(a token is set\)$/);
    return call('POST', '/admin/plugins/hello/settings/greeting/run');
  }).then(function (r) {
    assert.equal(r.status, 404);
    return call('GET', '/admin/plugins');
  }).then(function (r) {
    var hello = r.json.plugins.filter(function (p) { return p.id === 'hello'; })[0];
    assert.equal(hello.settings, 9);
  });
});

// ── the example's P3b parts: a custom link, a write, a notification ─────────

test('hello: a custom link (a form), a write needing the grant, a notification', function () {
  return call('GET', '/admin/plugins/hello/links').then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.links[0].kind, 'custom');
    assert.equal(r.json.links[0].accounts[0].linked, false);
    return call('POST', '/admin/plugins/hello/links/demo/start', { profile: profile });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kind, 'form');
    assert.equal(r.json.form[0].key, 'name');
    return call('POST', '/admin/plugins/hello/links/demo/submit', { profile: profile, values: {} });
  }).then(function (r) {
    assert.deepEqual(r.json, { state: 'pending', message: 'Type a name' });
    return call('POST', '/admin/plugins/hello/links/demo/submit', { profile: profile, values: { name: 'Ana' } });
  }).then(function (r) {
    assert.equal(r.json.state, 'done');
    return data('whoami', {}, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.json.effects[0].text, 'Linked as Ana');
    return data('addToList', { tmdbId: 603, title: 'The Matrix' }, '?profile=' + profile);
  }).then(function (r) {
    assert.match(r.json.effects[0].text, /Ask the server's admin/, 'not granted yet');
    return call('PUT', '/admin/plugins/hello/grants', { profile: profile, permission: 'write.watchlist', granted: true });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    return data('addToList', { tmdbId: 603, title: 'The Matrix' }, '?profile=' + profile);
  }).then(function (r) {
    assert.equal(r.json.effects[0].text, 'Hello added The Matrix to your list');
    return call('GET', '/profiles/' + profile + '/watchlist');
  }).then(function (r) {
    assert.ok(r.json.some(function (w) { return w.tmdbId === 603; }));
    // its own write isn't told back to it: no notification; the profile's own add is
    return call('PUT', '/profiles/' + profile + '/watchlist/movie/550', { title: 'Fight Club' });
  }).then(function () {
    return require('../lib/plugins/bus').settled();
  }).then(function () {
    var until = Date.now() + 5000;
    return (function poll() {
      return call('GET', '/plugins/notifications?profile=' + profile).then(function (r) {
        if (r.json.notifications.length || Date.now() > until) {
          return r;
        }
        return new Promise(function (ok) { setTimeout(ok, 100); }).then(poll);
      });
    })();
  }).then(function (r) {
    assert.deepEqual(r.json.notifications.map(function (n) { return n.text; }), ['Hello saw “Fight Club” on your list']);
  });
});
