'use strict';

// Installing plugin packages (docs/plugins-plan.md §6.3: the upload and URL
// part of step P4, lib/plugins/install.js) on a real server: packages made
// with scripts/pack-plugin.js (unsigned and signed) and by hand (a GitHub
// source zip with the plugin in a sub folder, unsafe zips).
//
//   unsigned: previewed, refused outside developer mode, installed in it       signed by a trusted key: installed without it
//   an update keeps the previous version; one that doesn't start rolls back    disabled: stopped, not for clients; enabled again
//   kept across a restart; removed: files, row and data gone                   `..`, symlinks, no manifest, two plugins: refused
//   a URL (a local HTTP server) is downloaded and staged                       GitHub repo / release URLs recognised
//   more permissions: installed only when accepted                             rollback: the kept version back, and forward again
//   its page (changelog), its log lines                                        hidden from a profile; clear data

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  childProcess = require('child_process'),
  yazl = require('yazl'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-install-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  install = require('../lib/plugins/install'),
  userData = require('../lib/userData');

var PACK = path.join(__dirname, '..', 'scripts', 'pack-plugin.js'),
  OPTIONS = { port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false } },
  base = null,
  cookie = null,
  files = null,     // a local HTTP server's packages
  filesPort = 0,
  key = path.join(tmp, 'publisher.json');

// the answers of the routes this file covers, against openapi.yaml (the contract test doesn't reach them)
var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

// ── fixtures ────────────────────────────────────────────────────────────────

function source(version, code, permissions) {
  var dir = path.join(tmp, 'src', 'greeter-' + version);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'greeter', name: 'Greeter', version: version, publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', description: 'Says hello', icon: 'assets/icon.svg', permissions: permissions || { storage: '4KB' }
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), code || 'playpex.data("hello", function () { return { data: "hello ' + version + '" }; });');
  fs.writeFileSync(path.join(dir, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# ' + version + '\n- hello\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not part of the package');
  return dir;
}

function pack(dir, signed) {
  var out = path.join(tmp, path.basename(dir) + (signed ? '-signed' : '') + '.ppx');
  var args = [PACK, dir, '--out', out].concat(signed ? ['--key', key] : []);
  var r = childProcess.spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

// A zip made by hand: [path, content, { mode }]
function zip(entries) {
  return new Promise(function (resolve) {
    var z = new yazl.ZipFile(), chunks = [];
    entries.forEach(function (e) {
      z.addBuffer(Buffer.from(e[1]), e[0], e[2] || {});
    });
    z.end();
    z.outputStream.on('data', function (c) { chunks.push(c); });
    z.outputStream.on('end', function () { resolve(Buffer.concat(chunks)); });
  });
}

function call(method, apiPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    var req = http.request(new URL('/api/v1' + apiPath, base), {
      method: method, agent: false,
      headers: Object.assign({ 'X-Playpex-Device': 'tv-1' }, payload && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {},
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

// multipart/form-data with one file
function upload(buffer, name) {
  var boundary = '----playpex' + Date.now();
  var body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\n' +
      'Content-Type: application/zip\r\n\r\n'),
    buffer,
    Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);
  return call('POST', '/admin/plugins/packages', body, { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
}

function settings(patch) {
  return call('PUT', '/admin/settings', patch).then(function (r) {
    assert.equal(r.status, 200, r.text);
  });
}

function start() {
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
  });
}

function plugin(id) {
  return call('GET', '/admin/plugins').then(function (r) {
    return r.json.plugins.filter(function (p) { return p.id === id; })[0] || null;
  });
}

test.before(function () {
  childProcess.spawnSync(process.execPath, [PACK, '--keygen', key]);
  return new Promise(function (resolve) {
    files = http.createServer(function (req, res) {
      var f = path.join(tmp, decodeURIComponent(req.url.slice(1)));
      if (!/\.ppx$/.test(f) || !fs.existsSync(f)) {
        res.statusCode = 404;
        return res.end();
      }
      res.end(fs.readFileSync(f));
    }).listen(0, '127.0.0.1', function () {
      filesPort = files.address().port;
      resolve();
    });
  }).then(start).then(function () {
    return call('POST', '/admin/setup', { username: 'admin', password: 'install-pass' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'install-pass' });
  }).then(function (r) {
    cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  return server.stop().then(function () {
    files.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── tests ───────────────────────────────────────────────────────────────────

test('admin only', function () {
  var saved = cookie;
  cookie = null;
  return call('GET', '/admin/plugins').then(function (r) {
    cookie = saved;
    assert.equal(r.status, 401);
  });
});

test('unsigned: previewed, refused outside developer mode, installed in it', function () {
  var token;
  return upload(pack(source('1.0.0')), 'greeter-1.0.0.ppx').then(function (r) {
    assert.equal(r.status, 200, r.text);
    var p = r.json;
    token = p.token;
    assert.equal(p.id, 'greeter');
    assert.equal(p.version, '1.0.0');
    assert.equal(p.change, 'install');
    assert.equal(p.signer, null);
    assert.equal(p.installable, false);
    assert.match(p.reason, /developer mode/);
    assert.match(p.icon, /^data:image\/svg\+xml;base64,/);
    assert.match(p.changelog, /# 1\.0\.0/);
    assert.equal(p.fileCount, 4, 'manifest, server.js, icon, changelog: not notes.txt');
    assert.ok(Array.isArray(p.permissions) && p.permissions.length);
    return call('POST', '/admin/plugins/packages/' + token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 403);
    return settings({ plugins: { developerMode: true } });
  }).then(function () {
    return call('POST', '/admin/plugins/packages/' + token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'enabled');
    assert.equal(r.json.origin, 'upload');
    assert.equal(r.json.source, 'greeter-1.0.0.ppx');
    assert.ok(fs.existsSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'greeter', 'server.js')));
    return Promise.all([call('POST', '/plugins/greeter/data/hello', { args: {} }), call('GET', '/plugins')]);
  }).then(function (r) {
    assert.equal(r[0].json.data, 'hello 1.0.0');
    assert.ok(r[1].json.plugins.some(function (p) { return p.id === 'greeter'; }), 'clients see it');
    return call('POST', '/admin/plugins/packages/' + token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 404, 'a token installs once');
  });
});

test('an update keeps the previous version; one that doesn\'t start rolls back', function () {
  return upload(pack(source('1.1.0')), 'greeter-1.1.0.ppx').then(function (r) {
    assert.equal(r.json.change, 'update');
    assert.equal(r.json.current, '1.0.0');
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, '1.1.0');
    assert.equal(r.json.previous, true);
    return upload(pack(source('1.2.0', 'for (;;) {}')), 'greeter-1.2.0.ppx');
  }).then(function (r) {
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 400);
    assert.match(r.json.error, /didn't start/);
    return Promise.all([plugin('greeter'), call('POST', '/plugins/greeter/data/hello', { args: {} })]);
  }).then(function (r) {
    assert.equal(r[0].version, '1.1.0', 'the running version came back');
    assert.equal(r[0].state, 'enabled');
    assert.equal(r[1].json.data, 'hello 1.1.0');
  });
});

test('disabled: stopped and gone for clients; enabled again', function () {
  return call('PATCH', '/admin/plugins/greeter', { enabled: false }).then(function (r) {
    assert.equal(r.json.state, 'disabled');
    return Promise.all([call('GET', '/plugins'), call('POST', '/plugins/greeter/data/hello', { args: {} })]);
  }).then(function (r) {
    assert.ok(!r[0].json.plugins.some(function (p) { return p.id === 'greeter'; }));
    assert.equal(r[1].status, 404);
    return call('PATCH', '/admin/plugins/greeter', { enabled: true });
  }).then(function (r) {
    assert.equal(r.json.state, 'enabled');
    return call('PATCH', '/admin/plugins/greeter', { enabled: 'yes' });
  }).then(function (r) {
    assert.equal(r.status, 400);
  });
});

test('installed plugins load again after a restart', function () {
  return server.stop().then(start).then(function () {
    // they load in the background
    var until = Date.now() + 10000;
    return (function poll() {
      return plugin('greeter').then(function (p) {
        return p.state !== 'loading' || Date.now() > until ? p : new Promise(function (r) { setTimeout(r, 50); }).then(poll);
      });
    })();
  }).then(function (p) {
    assert.equal(p.state, 'enabled');
    assert.equal(p.version, '1.1.0');
  });
});

test('signed by a trusted key: installs without developer mode', function () {
  var publicKey = JSON.parse(fs.readFileSync(key, 'utf8')).publicKey, buffer = pack(source('2.0.0'), true);
  return settings({ plugins: { developerMode: false } }).then(function () {
    return upload(buffer, 'greeter-2.0.0.ppx');
  }).then(function (r) {
    assert.equal(r.json.signer.key, publicKey);
    assert.equal(r.json.signer.trusted, false);
    assert.equal(r.json.installable, false);
    assert.match(r.json.reason, /doesn't trust/);
    return settings({ plugins: { publisherKeys: [publicKey] } });
  }).then(function () {
    return upload(buffer, 'greeter-2.0.0.ppx');
  }).then(function (r) {
    assert.equal(r.json.signer.trusted, true);
    assert.equal(r.json.installable, true);
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, '2.0.0');
    assert.match(r.json.signer, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
    return call('PUT', '/admin/settings', { plugins: { publisherKeys: ['ed25519:nope'] } });
  }).then(function (r) {
    assert.equal(r.status, 400, 'a malformed key');
  });
});

test('a tampered signed package isn\'t signed any more', function () {
  return install.unzip(pack(source('2.0.1'), true)).then(function (all) {
    var entries = all.map(function (f) { return [f.path, f.path === 'server.js' ? 'playpex.data("x", function () { return { data: 1 }; });' : f.bytes]; });
    return zip(entries);
  }).then(function (buffer) {
    return upload(buffer, 'tampered.ppx');
  }).then(function (r) {
    assert.equal(r.json.signer, null);
    assert.equal(r.json.installable, false);
  });
});

test('a GitHub source zip: the plugin found in its sub folder, the rest left out', function () {
  var dir = source('3.0.0');
  var entries = [['playpex-main/README.md', '# repo'], ['playpex-main/package.json', '{}'],
    ['playpex-main/src/index.ts', 'export {}']];
  ['playpex-plugin.json', 'server.js', 'assets/icon.svg', 'CHANGELOG.md', 'notes.txt'].forEach(function (f) {
    entries.push(['playpex-main/plugin/' + f, fs.readFileSync(path.join(dir, f))]);
  });
  return settings({ plugins: { developerMode: true } }).then(function () {
    return zip(entries);
  }).then(function (buffer) {
    return upload(buffer, 'playpex-main.zip');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.root, 'playpex-main/plugin/');
    assert.equal(r.json.fileCount, 4);
    assert.equal(r.json.version, '3.0.0');
    return call('DELETE', '/admin/plugins/packages/' + r.json.token);
  }).then(function (r) {
    assert.equal(r.json.ok, true);
  });
});

test('unsafe or wrong zips are refused', function () {
  var manifest = fs.readFileSync(path.join(source('4.0.0'), 'playpex-plugin.json'));
  return Promise.all([
    // yazl won't write `..`: the same length name, patched in the bytes
    zip([['playpex-plugin.json', manifest], ['server.js', ''], ['xx/evil.js', 'x']]).then(function (b) {
      return Buffer.from(b.toString('latin1').split('xx/evil.js').join('../evil.js'), 'latin1');
    }),
    zip([['playpex-plugin.json', manifest], ['server.js', ''], ['assets/link', '/etc/passwd', { mode: 0o120777 }]]),
    zip([['readme.txt', 'hi']]),
    zip([['a/playpex-plugin.json', manifest], ['b/playpex-plugin.json', manifest]]),
    zip([['playpex-plugin.json', '{"id": 1}'], ['server.js', '']]),
    Promise.resolve(Buffer.from('not a zip'))
  ]).then(function (buffers) {
    return Promise.all(buffers.map(function (b, i) { return upload(b, 'bad-' + i + '.zip'); }));
  }).then(function (r) {
    assert.match(r[0].json.error, /unsafe path|invalid relative path/);
    assert.match(r[1].json.error, /symbolic link/);
    assert.match(r[2].json.error, /no playpex-plugin\.json/);
    assert.match(r[3].json.error, /several plugins/);
    assert.equal(r[4].status, 400);
    assert.match(r[5].json.error, /not a zip/);
    r.forEach(function (x) { assert.equal(x.status, 400, x.text); });
  });
});

test('from a URL: downloaded and staged; GitHub pages recognised', function () {
  pack(source('5.0.0'));
  var url = 'http://127.0.0.1:' + filesPort + '/greeter-5.0.0.ppx';
  return call('POST', '/admin/plugins/packages', { url: url }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.origin, 'url');
    assert.equal(r.json.source, url);
    assert.equal(r.json.version, '5.0.0');
    return call('POST', '/admin/plugins/packages', { url: 'http://127.0.0.1:' + filesPort + '/missing.ppx' });
  }).then(function (r) {
    assert.equal(r.status, 502);
    assert.match(r.json.error, /HTTP 404/);
    return call('POST', '/admin/plugins/packages', { url: 'ftp://example.org/x.zip' });
  }).then(function (r) {
    assert.equal(r.status, 400);
    var gh = install.GITHUB;
    assert.deepEqual(gh.exec('https://github.com/acme/playpex-trakt').slice(1, 4), ['acme', 'playpex-trakt', undefined]);
    assert.deepEqual(gh.exec('https://github.com/acme/trakt.git').slice(1, 3), ['acme', 'trakt']);
    assert.deepEqual(gh.exec('https://github.com/acme/trakt/releases/tag/v1.2.0').slice(1, 4), ['acme', 'trakt', 'v1.2.0']);
    assert.deepEqual(gh.exec('https://github.com/acme/trakt/releases/latest').slice(1, 4), ['acme', 'trakt', undefined]);
    assert.equal(gh.exec('https://github.com/acme/trakt/releases/download/v1/trakt.ppx'), null, 'an asset is a direct link');
  });
});

test('an update asking for more is installed only when accepted', function () {
  var token;
  return upload(pack(source('3.0.0', null, { storage: '4KB', notify: true })), 'greeter-3.0.0.ppx').then(function (r) {
    assert.equal(r.status, 200, r.text);
    conforms('PluginPackagePreview', r.json);
    assert.deepEqual(r.json.added.map(function (x) { return x.key; }), ['notify']);
    assert.deepEqual(r.json.removed, []);
    token = r.json.token;
    return call('POST', '/admin/plugins/packages/' + token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /accept/);
    return call('POST', '/admin/plugins/packages/' + token + '/install', { accept: true });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, '3.0.0');
    assert.equal(r.json.previousVersion, '2.0.0');
  });
});

test('rollback: the kept version comes back, and forward again', function () {
  return call('POST', '/admin/plugins/greeter/rollback').then(function (r) {
    assert.equal(r.status, 200, r.text);
    conforms('PluginPackagePreview', r.json);
    assert.equal(r.json.rollback, true);
    assert.equal(r.json.version, '2.0.0');
    assert.equal(r.json.change, 'downgrade');
    assert.deepEqual(r.json.added, []);
    assert.deepEqual(r.json.removed.map(function (x) { return x.key; }), ['notify']);
    return call('POST', '/admin/plugins/packages/' + r.json.token + '/install');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, '2.0.0');
    assert.equal(r.json.previousVersion, '3.0.0');
    return Promise.all([call('POST', '/plugins/greeter/data/hello', { args: {} }), call('POST', '/admin/plugins/greeter/rollback')]);
  }).then(function (r) {
    assert.equal(r[0].json.data, 'hello 2.0.0');
    assert.equal(r[1].json.version, '3.0.0', 'rolling back again goes forward');
    assert.deepEqual(r[1].json.added.map(function (x) { return x.key; }), ['notify']);
    return call('DELETE', '/admin/plugins/packages/' + r[1].json.token);
  });
});

test('its page and its log lines', function () {
  return Promise.all([call('GET', '/admin/plugins/greeter'), call('GET', '/admin/logs?plugin=greeter'), call('GET', '/admin/plugins/nope')])
    .then(function (r) {
      assert.equal(r[0].status, 200, r[0].text);
      conforms('AdminPlugin', r[0].json);
      assert.match(r[0].json.changelog, /# 2\.0\.0/);
      assert.deepEqual(r[0].json.requires, []);
      assert.ok(r[1].json.entries.length > 0);
      assert.ok(r[1].json.entries.every(function (e) { return e.plugin === 'greeter'; }));
      assert.equal(r[2].status, 404);
    });
});

test('hidden from a profile: nothing of it for that profile', function () {
  var kid;
  return call('POST', '/profiles', { name: 'Hidden kid', isKid: true }).then(function (r) {
    assert.equal(r.status, 201, r.text);
    kid = r.json.id;
    return call('PUT', '/admin/plugins/greeter/profiles', { profile: kid, shown: false });
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    conforms('PluginSettings', r.json);
    assert.equal(r.json.profiles.filter(function (p) { return p.id === kid; })[0].shown, false);
    return Promise.all([
      call('GET', '/plugins?profile=' + kid),
      call('POST', '/plugins/greeter/data/hello?profile=' + kid, { args: {} }),
      call('POST', '/plugins/greeter/data/hello', { args: {} }),
      call('PUT', '/admin/plugins/greeter/profiles', { profile: 'nobody', shown: false }),
      call('PUT', '/admin/plugins/greeter/profiles', { profile: kid })
    ]);
  }).then(function (r) {
    assert.ok(!r[0].json.plugins.some(function (p) { return p.id === 'greeter'; }));
    assert.equal(r[1].status, 403);
    assert.equal(r[2].json.data, 'hello 2.0.0', 'other callers still get it');
    assert.equal(r[3].status, 404);
    assert.equal(r[4].status, 400);
    return call('PUT', '/admin/plugins/greeter/profiles', { profile: kid, shown: true });
  }).then(function () {
    return call('GET', '/plugins?profile=' + kid);
  }).then(function (r) {
    assert.ok(r.json.plugins.some(function (p) { return p.id === 'greeter'; }));
  });
});

test('clear data: what it kept is gone, it runs again', function () {
  var kid;
  return Promise.all([
    userData.services().then(function (s) { return s.plugins.store.set('greeter', 'k', 1, 4096); }),
    call('GET', '/profiles')
  ]).then(function (r) {
    kid = r[1].json.profiles.filter(function (p) { return p.name === 'Hidden kid'; })[0].id;
    return call('PUT', '/admin/plugins/greeter/profiles', { profile: kid, shown: false });
  }).then(function () {
    return call('POST', '/admin/plugins/greeter/clear');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    conforms('AdminPlugin', r.json);
    assert.equal(r.json.state, 'enabled');
    return Promise.all([
      userData.services().then(function (s) { return s.plugins.store.get('greeter', 'k'); }),
      call('GET', '/plugins?profile=' + kid)
    ]);
  }).then(function (r) {
    assert.equal(r[0], null);
    assert.ok(r[1].json.plugins.some(function (p) { return p.id === 'greeter'; }), 'shown again');
  });
});

test('removed: files, row and data gone', function () {
  var dir = path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', 'greeter');
  return userData.services().then(function (s) {
    return s.plugins.store.set('greeter', 'k', 1, 4096);
  }).then(function () {
    return call('DELETE', '/admin/plugins/greeter');
  }).then(function (r) {
    assert.equal(r.status, 200, r.text);
    assert.ok(!fs.existsSync(dir));
    assert.ok(!fs.existsSync(path.join(process.env.PLAYPEX_CONFIG_DIR, 'plugins', '.previous', 'greeter')));
    return Promise.all([plugin('greeter'), userData.services().then(function (s) { return s.plugins.store.get('greeter', 'k'); }),
      call('DELETE', '/admin/plugins/greeter')]);
  }).then(function (r) {
    assert.equal(r[0], null);
    assert.equal(r[1], null, 'its store rows are gone');
    assert.equal(r[2].status, 404);
  });
});
