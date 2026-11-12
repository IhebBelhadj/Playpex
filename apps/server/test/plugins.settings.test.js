'use strict';

// List settings (docs/plugin-layer-plan.md §4, step 2) on a real server with a
// test plugin declaring a list of entries (a name, an address that grants its
// host, a switch) and a list of plain values, saved through the dashboard's
// route and read by the plugin's own code.
//
//   defaults: an empty list · entries get ids, missing fields their defaults · ids kept on edit and move
//   limits (maxItems, unique, unknown fields, a field's own rules) refused with the entry named, all or nothing
//   each entry's address grants its host (permissions in words name the list) · a removed entry's host goes
//   the plugin reads the arrays with playpex.settings.get · the definitions reach the dashboard with their fields

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-settings-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  grants = require('../lib/plugins/grants');

var base = null, cookie = null;

var MANIFEST = {
  id: 'lists', name: 'Lists', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1.5' }, audience: 'everyone',
  permissions: { sources: ['live'], hooks: ['live.channels', 'live.stream'] },
  contributes: {
    settings: [
      {
        key: 'playlists', scope: 'server', type: 'list', label: 'Playlists', itemLabel: 'Playlist', titleField: 'name', maxItems: 3,
        fields: [
          { key: 'name', type: 'text', label: 'Name', maxLength: 20 },
          { key: 'url', type: 'url', label: 'Address', grantsHost: true, streamHosts: true },
          { key: 'on', type: 'switch', label: 'Use it', default: true }
        ]
      },
      { key: 'groups', scope: 'server', type: 'list', label: 'Groups', item: { type: 'text', maxLength: 20 }, maxItems: 4, unique: true }
    ]
  }
};

var CODE = String.raw`
playpex.hooks.on('live.channels', function () { return { channels: [] }; });
playpex.hooks.on('live.stream', function () { return { source: null }; });
playpex.data('read', function () {
  return Promise.all([playpex.settings.get('playlists'), playpex.settings.get('groups')]).then(function (v) {
    return { data: { playlists: v[0], groups: v[1] } };
  });
});
`;

function call(method, apiPath, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function save(values) {
  return call('PUT', '/admin/plugins/lists/settings', { values: values });
}

function read() {
  return plugins.data('lists', 'read', {}, { profile: null, device: null, locale: 'en' }).then(function (a) { return a.data; });
}

test.before(function () {
  var dir = path.join(tmp, 'plugins', 'lists');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(dir, 'server.js'), CODE);
  return server.start({
    port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false, plugins: { dirs: [dir] }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var p = plugins.get('lists');
        if (p && p.state === 'enabled') {
          return resolve();
        }
        if ((p && p.state === 'failed') || Date.now() > until) {
          return reject(new Error('plugin not loaded: ' + (p && p.error)));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function () {
    return call('POST', '/admin/setup', { username: 'admin', password: 'lists-pass' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'lists-pass' });
  }).then(function (res) {
    cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  return (base ? server.stop() : Promise.resolve()).then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('lists start empty; the dashboard gets their fields', function () {
  return call('GET', '/admin/plugins/lists/settings').then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.server, { playlists: [], groups: [] });
    var d = r.json.definitions[0];
    assert.equal(d.type, 'list');
    assert.equal(d.maxItems, 3);
    assert.equal(d.itemLabel, 'Playlist');
    assert.deepEqual(d.fields.map(function (f) { return f.key; }), ['name', 'url', 'on']);
    assert.equal(d.fields[1].grantsHost, true);
    assert.equal(r.json.definitions[1].item.type, 'text');
    return read();
  }).then(function (v) {
    assert.deepEqual(v, { playlists: [], groups: [] });
  });
});

var saved = null;

test('entries get ids and defaults; each address grants its host', function () {
  return save({
    playlists: [{ name: 'Sports', url: 'http://iptv.example.net:8080/get.php?u=1' }, { name: 'News', url: 'https://news.example.org/list.m3u' }],
    groups: ['News', 'Sports']
  }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    saved = r.json.server.playlists;
    assert.equal(saved.length, 2);
    saved.forEach(function (e) { assert.match(e.id, /^e_[a-z2-7]{8}$/); assert.equal(e.on, true); });
    assert.notEqual(saved[0].id, saved[1].id);
    var hosts = grants.hosts(plugins.get('lists')).map(function (h) { return h.host + ':' + h.port + ' ' + h.entry; });
    assert.deepEqual(hosts.sort(), ['iptv.example.net:8080 ' + saved[0].id, 'news.example.org:443 ' + saved[1].id].sort());
    assert.ok(grants.match(plugins.get('lists'), 'http://iptv.example.net:8080/live/1.ts'), 'the entry\'s host and port');
    assert.equal(grants.match(plugins.get('lists'), 'http://iptv.example.net:9999/x'), null, 'not another port');
    var words = grants.describe(plugins.get('lists')).map(function (x) { return x.text; }).join(' | ');
    assert.match(words, /iptv\.example\.net:8080 \(plain http\), the address given in its list "Playlists › Sports"/);
    return read();
  }).then(function (v) {
    assert.deepEqual(v.playlists, saved);
    assert.deepEqual(v.groups, ['News', 'Sports']);
  });
});

test('ids are kept when entries are edited and moved; a removed entry\'s host goes', function () {
  var moved = [Object.assign({}, saved[1], { name: 'News 2' }), saved[0]];
  return save({ playlists: moved }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    var now = r.json.server.playlists;
    assert.deepEqual(now.map(function (e) { return e.id; }), [saved[1].id, saved[0].id]);
    assert.equal(now[0].name, 'News 2');
    return save({ playlists: [now[1]] });
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(grants.hosts(plugins.get('lists')).map(function (h) { return h.host; }), ['iptv.example.net']);
    assert.equal(grants.match(plugins.get('lists'), 'https://news.example.org/list.m3u'), null);
  });
});

test('what a list can\'t hold is refused with the entry named, and nothing is saved', function () {
  var cases = [
    [{ playlists: [{}, {}, {}, {}] }, /playlists holds at most 3/],
    [{ playlists: [{ name: 'x'.repeat(21) }] }, /playlists \[0\]\.name is longer than 20/],
    [{ playlists: [{ url: 'ftp://x.example/a' }] }, /playlists \[0\]\.url/],
    [{ playlists: [{ name: 'A', colour: 'red' }] }, /playlists \[0\] has no field colour/],
    [{ playlists: 'nope' }, /playlists must be a list/],
    [{ groups: ['a', 'A'] }, /groups holds a value twice/],
    [{ groups: ['a', 3] }, /groups \[1\] must be text/],
    [{ groups: ['a'], playlists: [{ name: 'y'.repeat(30) }] }, /playlists/]
  ];
  return cases.reduce(function (p, c) {
    return p.then(function () {
      return save(c[0]).then(function (r) {
        assert.equal(r.status, 400, JSON.stringify(c[0]));
        assert.match(r.json.error, c[1]);
      });
    });
  }, Promise.resolve()).then(read).then(function (v) {
    assert.deepEqual(v.groups, ['News', 'Sports'], 'the last case saved nothing');
    assert.equal(v.playlists.length, 1);
  });
});

test('null resets a list to its default', function () {
  return save({ playlists: null, groups: null }).then(function (r) {
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.server, { playlists: [], groups: [] });
    assert.deepEqual(grants.hosts(plugins.get('lists')), []);
  });
});

test('Treat as adults: an installed plugin follows the adults rules at once; off again; not for developer copies', function () {
  var userData = require('../lib/userData'), kid = null, s;
  return userData.services().then(function (svc) {
    s = svc;
    return s.profiles.create({ name: 'Kid', isKid: true });
  }).then(function (made) {
    kid = made;
    // a developer copy has no install row: nothing to set
    return call('PATCH', '/admin/plugins/lists', { adults: true });
  }).then(function (r) {
    assert.equal(r.status, 404, JSON.stringify(r.json));
    // as an install would record it
    return s.plugins.installed.save({ id: 'lists', version: '1.0.0', origin: 'upload' });
  }).then(function () {
    assert.equal(plugins.blocked(plugins.get('lists'), { profile: { id: kid.id, kids: true } }), false);
    return call('PATCH', '/admin/plugins/lists', { adults: true });
  }).then(function (r) {
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.audience, 'adults');
    assert.equal(r.json.declaredAudience, 'everyone');
    assert.equal(r.json.adultsByAdmin, true);
    var p = plugins.get('lists');
    assert.equal(plugins.blocked(p, { profile: { id: kid.id, kids: true } }), true, 'no kids profile');
    assert.equal(p.declaredAudience, 'everyone', 'what it may get more still follows its manifest');
    var played = require('../lib/plugins/effects').filter(p, [{ type: 'play', request: { title: 'T', sources: [{ kind: 'magnet', label: 'x', infoHash: 'a'.repeat(40) }] } }]);
    return Promise.all([call('GET', '/plugins?profile=' + kid.id), call('GET', '/admin/plugins/lists/settings'), Promise.resolve(played)]);
  }).then(function (r) {
    assert.ok(!r[0].json.plugins.some(function (x) { return x.id === 'lists'; }), 'gone from the kid\'s client view');
    assert.ok(!r[1].json.profiles.some(function (x) { return x.kids; }), 'no kids profile on its Profiles tab');
    var play = r[2].effects.filter(function (e) { return e.type === 'play'; })[0];
    if (play) {
      assert.equal(play.request.tracking, 'none', 'nothing it plays is tracked');
    }
    return s.plugins.installed.save({ id: 'lists', version: '1.1.0', origin: 'upload' });
  }).then(function () {
    return s.plugins.installed.get('lists');
  }).then(function (row) {
    assert.equal(row.adults, true, 'kept across an update');
    return call('PATCH', '/admin/plugins/lists', { adults: 'yes' });
  }).then(function (r) {
    assert.equal(r.status, 400);
    return call('PATCH', '/admin/plugins/lists', { adults: false });
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.json.audience, 'everyone');
    assert.equal(plugins.blocked(plugins.get('lists'), { profile: { id: kid.id, kids: true } }), false);
  });
});

test('Treat as adults is stricter only: a plugin whose manifest declares adults stays one', function () {
  var userData = require('../lib/userData'),
    dir = path.join(tmp, 'plugins', 'grownup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'grownup', name: 'Grown-up', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1.5' }, audience: 'adults', permissions: {}
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), '');
  return plugins.load(dir, 'upload').then(function () {
    return userData.services().then(function (s) { return s.plugins.installed.save({ id: 'grownup', version: '1.0.0', origin: 'upload' }); });
  }).then(function () {
    return call('PATCH', '/admin/plugins/grownup', { adults: false });
  }).then(function (r) {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /declares it an adults plugin/);
    return call('PATCH', '/admin/plugins/grownup', { adults: true });
  }).then(function (r) {
    assert.equal(r.status, 200);
    assert.equal(r.json.audience, 'adults');
  });
});
