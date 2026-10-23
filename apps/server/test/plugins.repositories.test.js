'use strict';

// Plugin repositories (docs/plugins-plan.md step P4b, lib/plugins/repositories.js)
// on a real server, against local repositories: signed indexes and packages
// served over HTTPS on 127.0.0.2 (a throwaway openssl certificate; skipped
// without openssl) under made-up names a fake resolver points there.
//
//   the official repository is built in and never offers or installs an adults plugin
//   adding a repository: previewed with its key, trusted once
//   a required and an optional dependency in one consent; plugins.call through exports only
//   auto updates: one asking for nothing new installs by itself, one with a new host waits
//   origin pinning: another repository's same id doesn't update it; moving needs consent
//   an unchanged index answers 304; a failing repository keeps its last good index
//   an index re-signed with another key is refused until the admin accepts it
//   broken switches it (and what needs it) off, a fixed version turns them back on
//   removing a required plugin names its dependents first
//   a repository package adds a repository; an older listed version installs
//   a replacement (migratesFrom) takes the settings of the plugin it replaces

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  crypto = require('crypto'),
  childProcess = require('child_process'),
  yazl = require('yazl'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-repos-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  signing = require('@playpex/protocol/signing'),
  userData = require('../lib/userData');

var TEST_HOST = '127.0.0.2',
  HOSTS = ['official.playpex-test.dev', 'repo.playpex-test.dev', 'other.playpex-test.dev'],
  base = null,
  cookie = null,
  site = null,
  sitePort = 0,
  tls = null,
  served = {},       // path → Buffer
  failing = {},      // repository → status to answer
  seen = [],         // [{ path, ifNoneMatch, status }]
  keys = { official: signing.generate(), extra: signing.generate(), extra2: signing.generate(), other: signing.generate(), third: signing.generate() };

// the answers of the new routes, against openapi.yaml
var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

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
  if (HOSTS.indexOf(host) === -1) {
    return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  }
  callback(null, [{ address: TEST_HOST, family: 4 }]);
}

function url(host, file) {
  return 'https://' + host + ':' + sitePort + '/' + file;
}

// A package: a zip with its manifest and server.js
function zip(entries) {
  return new Promise(function (resolve) {
    var z = new yazl.ZipFile(), chunks = [];
    Object.keys(entries).forEach(function (name) { z.addBuffer(Buffer.from(entries[name]), name); });
    z.end();
    z.outputStream.on('data', function (c) { chunks.push(c); });
    z.outputStream.on('end', function () { resolve(Buffer.concat(chunks)); });
  });
}

var CODE = {
  resolver: 'playpex.data("resolve", function (args) { return { data: { resolved: args, by: "resolver" } }; });\n' +
    'playpex.data("secret", function () { return { data: "not exported" }; });',
  player: 'playpex.data("ask", async function (args) { return { data: await playpex.plugins.call(args.id, args.name, { x: 1 }) }; });',
  plain: 'playpex.data("hello", function () { return { data: "hello" }; });'
};

function manifestOf(p) {
  var m = {
    id: p.id, name: p.name || p.id, version: p.version, publisher: { name: 'Test' }, api: { server: '^1' },
    audience: p.audience || 'everyone', permissions: p.permissions || {}
  };
  ['requires', 'exports', 'migratesFrom', 'contributes'].forEach(function (k) {
    if (p[k]) {
      m[k] = p[k];
    }
  });
  return m;
}

/**
 * Publishes a repository on the test site: its packages, index.json and
 * index.json.sig signed by `pair` (`claims`: the key the index names, when another)
 */
function publish(host, repo, pair, plugins, claims) {
  var dir = repo.id;
  return Promise.all(plugins.map(function (p) {
    return Promise.all(p.versions.map(function (v) {
      var manifest = manifestOf(Object.assign({ id: p.id, name: p.name }, v, v.manifestAudience ? { audience: v.manifestAudience } : {}));
      return zip({ 'playpex-plugin.json': JSON.stringify(manifest), 'server.js': v.code || CODE[p.id] || CODE.plain }).then(function (buffer) {
        var file = dir + '/' + p.id + '-' + v.version + '.ppx';
        served['/' + file] = buffer;
        var entry = {
          version: v.version, url: url(host, file), sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          size: buffer.length, releasedAt: '2026-10-20', api: { server: '^1' }, audience: v.audience || 'everyone',
          permissions: v.permissions || {}, lifecycle: v.lifecycle || 'stable', changelog: 'Version ' + v.version
        };
        ['requires', 'reason', 'replacedBy'].forEach(function (k) {
          if (v[k]) {
            entry[k] = v[k];
          }
        });
        return entry;
      });
    })).then(function (versions) {
      return { id: p.id, name: p.name || p.id, publisher: { name: 'Test' }, listing: { summary: p.name || p.id, categories: ['tools'] },
        versions: versions.reverse() };
    });
  })).then(function (entries) {
    var bytes = Buffer.from(JSON.stringify({
      format: 1,
      repository: { id: repo.id, name: repo.name, key: claims || pair.publicKey },
      generatedAt: new Date().toISOString(),
      plugins: entries
    }));
    served['/' + dir + '/index.json'] = bytes;
    served['/' + dir + '/index.json.sig'] = Buffer.from(signing.sign(bytes, pair.privateKey));
    return url(host, dir + '/index.json');
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
        resolve({ status: res.statusCode, json: json, text: text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

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

function ok(r) {
  assert.ok(r.status >= 200 && r.status < 300, r.status + ' ' + r.text);
  return r.json;
}

function plugin(id) {
  return call('GET', '/admin/plugins').then(function (r) {
    return r.json.plugins.filter(function (p) { return p.id === id; })[0] || null;
  });
}

function repository(id) {
  return call('GET', '/admin/plugins/repositories').then(function (r) {
    return r.json.repositories.filter(function (x) { return x.id === id; })[0] || null;
  });
}

function refresh(id) {
  return call('POST', '/admin/plugins/repositories/refresh', id ? { id: id } : {}).then(ok);
}

/** Stages a catalog plugin; the preview */
function stage(repo, id, version) {
  return call('POST', '/admin/plugins/catalog/install', Object.assign({ repository: repo, id: id }, version ? { version: version } : {})).then(ok);
}

function installFrom(repo, id, version, body) {
  return stage(repo, id, version).then(function (p) {
    return call('POST', '/admin/plugins/packages/' + p.token + '/install', body || {}).then(ok);
  });
}

var OFFICIAL = [
  { id: 'cleanup', name: 'Cleanup', versions: [{ version: '1.0.0' }] },
  { id: 'adultstuff', name: 'Adult stuff', versions: [{ version: '1.0.0', audience: 'adults' }] },
  // its index says everyone, its package says adults: still refused
  { id: 'sneaky', name: 'Sneaky', versions: [{ version: '1.0.0', manifestAudience: 'adults' }] }
];

var RESOLVER = { id: 'resolver', name: 'Resolver', versions: [{ version: '1.0.0', exports: ['resolve'] }] },
  HELPER = { id: 'helper', name: 'Helper', versions: [{ version: '1.0.0' }] },
  PLAYER = { id: 'player', name: 'Player', versions: [{ version: '1.0.0', requires: [{ id: 'resolver', version: '^1' }, { id: 'helper', version: '*', optional: true }] }] };

var skip = function () { return !tls && 'no openssl'; };

test.before(function () {
  tls = certificate();
  if (!tls) {
    return null;
  }
  return new Promise(function (resolve) {
    site = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
      var p = req.url.split('?')[0], body = served[p], repo = p.split('/')[1];
      var entry = { path: p, ifNoneMatch: req.headers['if-none-match'] || null, status: 200 };
      seen.push(entry);
      if (failing[repo]) {
        entry.status = res.statusCode = failing[repo];
        return res.end('down');
      }
      if (!body) {
        entry.status = res.statusCode = 404;
        return res.end();
      }
      var etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
      if (req.headers['if-none-match'] === etag) {
        entry.status = res.statusCode = 304;
        return res.end();
      }
      res.setHeader('ETag', etag);
      res.end(body);
    }).listen(0, TEST_HOST, function () {
      sitePort = site.address().port;
      resolve();
    });
  }).then(function () {
    return publish(HOSTS[0], { id: 'playpex', name: 'Playpex' }, keys.official, OFFICIAL);
  }).then(function (officialUrl) {
    return server.start({
      port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false },
      plugins: {
        http: { lookup: lookup, ports: [sitePort], ca: tls.cert, allowAddresses: [TEST_HOST] },
        repositories: { official: { id: 'playpex', name: 'Playpex', url: officialUrl, key: keys.official.publicKey }, startDelayMs: false }
      }
    });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return call('POST', '/admin/setup', { username: 'admin', password: 'repos-pass-1' });
  }).then(function () {
    return call('POST', '/auth/sign-in/username', { username: 'admin', password: 'repos-pass-1' });
  }).then(function (r) {
    cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0];
  });
});

test.after(function () {
  return server.stop().then(function () {
    if (site) {
      site.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── tests ───────────────────────────────────────────────────────────────────

test('admin only', { skip: skip() }, function () {
  var saved = cookie;
  cookie = null;
  return Promise.all([call('GET', '/admin/plugins/repositories'), call('GET', '/admin/plugins/catalog')]).then(function (r) {
    cookie = saved;
    assert.equal(r[0].status, 401);
    assert.equal(r[1].status, 401);
  });
});

test('the official repository is built in and never offers or installs an adults plugin', { skip: skip() }, function () {
  return refresh().then(function (r) {
    var official = r.repositories.filter(function (x) { return x.builtin; })[0];
    conforms('PluginRepository', official);
    assert.equal(official.id, 'playpex');
    assert.equal(official.error, null);
    assert.equal(official.plugins, 2, 'cleanup and sneaky (its index lies)');
    assert.deepEqual(official.refused.map(function (x) { return x.id; }), ['adultstuff']);
    return call('GET', '/admin/plugins/catalog');
  }).then(function (r) {
    conforms('PluginCatalog', r.json);
    var ids = r.json.plugins.map(function (p) { return p.id; });
    assert.deepEqual(ids.sort(), ['cleanup', 'sneaky']);
    return Promise.all([
      call('POST', '/admin/plugins/catalog/install', { repository: 'playpex', id: 'adultstuff' }),
      call('POST', '/admin/plugins/catalog/install', { repository: 'playpex', id: 'sneaky' }),
      call('DELETE', '/admin/plugins/repositories/playpex'),
      call('POST', '/admin/plugins/repositories/playpex/key', { key: keys.extra.publicKey })
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 404, 'not offered at all');
    assert.equal(r[1].status, 403, r[1].text);
    assert.match(r[1].json.error, /official Playpex repository doesn't carry adults plugins/);
    assert.equal(r[2].status, 409, 'the official repository can only be turned off');
    assert.equal(r[3].status, 409);
    return installFrom('playpex', 'cleanup');
  }).then(function (p) {
    conforms('AdminPlugin', p);
    assert.equal(p.origin, 'repository');
    assert.deepEqual(p.repository, { id: 'playpex', name: 'Playpex' });
    assert.equal(p.state, 'enabled');
    assert.equal(p.signer, null);
  });
});

test('adding a repository: previewed with its key, trusted once', { skip: skip() }, function () {
  var indexUrl;
  return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra, [RESOLVER, HELPER, PLAYER]).then(function (u) {
    indexUrl = u;
    return call('POST', '/admin/plugins/repositories/preview', { url: u });
  }).then(function (r) {
    var p = ok(r);
    conforms('PluginRepositoryPreview', p);
    assert.equal(p.id, 'extra');
    assert.equal(p.fingerprint, signing.fingerprint(keys.extra.publicKey));
    assert.equal(p.plugins, 3);
    return Promise.all([
      call('POST', '/admin/plugins/repositories', { url: indexUrl, key: keys.other.publicKey }),
      call('POST', '/admin/plugins/repositories/preview', { url: 'http://repo.playpex-test.dev/index.json' }),
      call('POST', '/admin/plugins/repositories/preview', { url: url(HOSTS[1], 'nothing/index.json') })
    ]);
  }).then(function (r) {
    assert.equal(r[0].status, 409, 'not the key the admin saw');
    assert.equal(r[1].status, 400, 'https only');
    assert.equal(r[2].status, 502);
    return call('POST', '/admin/plugins/repositories', { url: indexUrl, key: keys.extra.publicKey });
  }).then(function (r) {
    var repo = ok(r);
    assert.equal(repo.name, 'Extra plugins');
    assert.equal(repo.plugins, 3);
    return call('POST', '/admin/plugins/repositories', { url: indexUrl, key: keys.extra.publicKey });
  }).then(function (r) {
    assert.equal(r.status, 409, 'once');
  });
});

test('a required and an optional dependency in one consent; plugins.call through exports only', { skip: skip() }, function () {
  return stage('extra', 'player').then(function (p) {
    conforms('PluginPackagePreview', p);
    assert.equal(p.installable, true, p.reason);
    assert.deepEqual(p.dependencies.map(function (d) { return [d.id, d.optional, d.installed, d.version]; }),
      [['resolver', false, false, '1.0.0'], ['helper', true, false, '1.0.0']]);
    return call('POST', '/admin/plugins/packages/' + p.token + '/install', { optional: [] });
  }).then(function (r) {
    assert.equal(ok(r).state, 'enabled');
    return Promise.all([plugin('resolver'), plugin('helper'), plugin('player')]);
  }).then(function (r) {
    assert.equal(r[0].state, 'enabled', 'the required one came with it');
    assert.equal(r[1], null, 'the optional one wasn\'t chosen');
    assert.deepEqual(r[0].requiredBy, [{ id: 'player', name: 'Player' }]);
    return Promise.all([
      call('POST', '/plugins/player/data/ask', { args: { id: 'resolver', name: 'resolve' } }),
      call('POST', '/plugins/player/data/ask', { args: { id: 'resolver', name: 'secret' } }),
      call('POST', '/plugins/player/data/ask', { args: { id: 'cleanup', name: 'hello' } }),
      call('POST', '/plugins/player/data/ask', { args: { id: 'helper', name: 'hello' } })
    ]);
  }).then(function (r) {
    assert.deepEqual(r[0].json.data, { resolved: { x: 1 }, by: 'resolver' });
    assert.equal(r[1].status, 502, 'not exported');
    assert.equal(r[2].status, 502, 'not in its requires');
    assert.equal(r[3].status, 502, 'required, but not installed');
  });
});

test('auto updates: nothing new installs by itself, a new host waits for the admin', { skip: skip() }, function () {
  RESOLVER.versions.push({ version: '1.1.0', exports: ['resolve'] });
  PLAYER.versions.push({ version: '1.1.0', requires: PLAYER.versions[0].requires, permissions: { network: ['api.example.org'] } });
  return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra, [RESOLVER, HELPER, PLAYER]).then(function () {
    return refresh('extra');
  }).then(function () {
    return Promise.all([plugin('resolver'), plugin('player'), call('GET', '/admin/plugins/updates')]);
  }).then(function (r) {
    assert.equal(r[0].version, '1.1.0', 'installed by itself');
    assert.equal(r[0].state, 'enabled');
    assert.equal(r[1].version, '1.0.0', 'waits');
    assert.equal(r[1].update.needsConsent, true);
    conforms('PluginUpdates', r[2].json);
    var u = r[2].json.updates.filter(function (x) { return x.id === 'player'; })[0];
    assert.equal(u.version, '1.1.0');
    assert.deepEqual(u.added.map(function (a) { return a.key; }), ['network']);
    return call('POST', '/admin/plugins/updates/apply');
  }).then(function (r) {
    assert.deepEqual(ok(r).results.map(function (x) { return [x.id, x.installed]; }), [['player', false]]);
    return stage('extra', 'player');
  }).then(function (p) {
    assert.deepEqual(p.added.map(function (a) { return a.key; }), ['network']);
    return call('POST', '/admin/plugins/packages/' + p.token + '/install', { accept: true });
  }).then(function (r) {
    assert.equal(ok(r).version, '1.1.0');
    return call('GET', '/admin/plugins/updates');
  }).then(function (r) {
    assert.deepEqual(r.json.updates, []);
  });
});

test('origin pinning: another repository\'s same id doesn\'t update it; moving needs consent', { skip: skip() }, function () {
  var token;
  return publish(HOSTS[2], { id: 'other', name: 'Other plugins' }, keys.other,
    [{ id: 'resolver', name: 'Resolver (fork)', versions: [{ version: '9.0.0', exports: ['resolve'] }] }]).then(function (u) {
    return call('POST', '/admin/plugins/repositories', { url: u, key: keys.other.publicKey });
  }).then(function (r) {
    ok(r);
    return refresh();
  }).then(function () {
    return plugin('resolver');
  }).then(function (p) {
    assert.equal(p.version, '1.1.0', 'not from another repository');
    return stage('other', 'resolver');
  }).then(function (p) {
    assert.ok(p.moves, 'a move is shown');
    assert.match(p.moves.from, /Extra plugins/);
    token = p.token;
    return call('POST', '/admin/plugins/packages/' + token + '/install', {});
  }).then(function (r) {
    assert.equal(r.status, 409);
    return call('DELETE', '/admin/plugins/packages/' + token);
  }).then(function () {
    return call('PATCH', '/admin/plugins/repositories/other', { enabled: false });
  }).then(function (r) {
    assert.equal(ok(r).enabled, false);
    return call('GET', '/admin/plugins/catalog?q=fork');
  }).then(function (r) {
    assert.deepEqual(r.json.plugins, [], 'a repository turned off isn\'t browsed');
  });
});

test('an unchanged index answers 304; a failing repository keeps its last good index', { skip: skip() }, function () {
  seen = [];
  return refresh('extra').then(function () {
    var index = seen.filter(function (s) { return s.path === '/extra/index.json'; })[0];
    assert.ok(index.ifNoneMatch, 'asked with its ETag');
    assert.equal(index.status, 304);
    failing.extra = 503;
    return refresh('extra');
  }).then(function () {
    return Promise.all([repository('extra'), call('GET', '/admin/plugins/catalog?q=player')]);
  }).then(function (r) {
    delete failing.extra;
    assert.match(r[0].error, /503/);
    assert.equal(r[0].stale, true);
    assert.equal(r[1].json.plugins.length, 1, 'still browsed from the last good index');
    return refresh('extra');
  }).then(function () {
    return repository('extra');
  }).then(function (r) {
    assert.equal(r.error, null);
  });
});

test('an index re-signed with another key is refused until the admin accepts it', { skip: skip() }, function () {
  RESOLVER.versions.push({ version: '1.2.0', exports: ['resolve'] });
  return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra2, [RESOLVER, HELPER, PLAYER]).then(function () {
    return refresh('extra');
  }).then(function () {
    return Promise.all([repository('extra'), plugin('resolver')]);
  }).then(function (r) {
    assert.equal(r[0].pendingKey.fingerprint, signing.fingerprint(keys.extra2.publicKey));
    assert.match(r[0].error, /another key/);
    assert.equal(r[0].key, keys.extra.publicKey, 'the pinned key stays');
    assert.equal(r[1].version, '1.1.0', 'nothing from the new index');
    return call('POST', '/admin/plugins/repositories/extra/key', { key: keys.other.publicKey });
  }).then(function (r) {
    assert.equal(r.status, 409);
    return call('POST', '/admin/plugins/repositories/extra/key', { key: keys.extra2.publicKey });
  }).then(function (r) {
    var repo = ok(r);
    assert.equal(repo.key, keys.extra2.publicKey);
    assert.equal(repo.pendingKey, null);
    assert.equal(repo.error, null);
    // signed by a key the index doesn't name: just a bad signature
    return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.third, [RESOLVER, HELPER, PLAYER], keys.extra2.publicKey);
  }).then(function () {
    return refresh('extra');
  }).then(function () {
    return repository('extra');
  }).then(function (r) {
    assert.match(r.error, /signature/);
    assert.equal(r.pendingKey, null);
    return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra2, [RESOLVER, HELPER, PLAYER]);
  }).then(function () {
    return refresh('extra');
  }).then(function () {
    return plugin('resolver');
  }).then(function (p) {
    assert.equal(p.version, '1.2.0', 'updated once the new key was accepted');
  });
});

test('broken switches it and what needs it off; a fixed version turns them back on', { skip: skip() }, function () {
  RESOLVER.versions[2].lifecycle = 'broken';
  RESOLVER.versions[2].reason = 'the site changed';
  return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra2, [RESOLVER, HELPER, PLAYER]).then(function () {
    return refresh('extra');
  }).then(function () {
    return Promise.all([plugin('resolver'), plugin('player'), call('PATCH', '/admin/plugins/resolver', { enabled: true })]);
  }).then(function (r) {
    assert.equal(r[0].state, 'disabled');
    assert.match(r[0].held, /^broken: the site changed/);
    assert.equal(r[0].lifecycle.state, 'broken');
    assert.equal(r[1].state, 'disabled', 'what needs it goes off too');
    assert.match(r[1].held, /needs Resolver/);
    assert.equal(r[2].status, 409, 'can\'t be turned on while broken');
    RESOLVER.versions.push({ version: '1.2.1', exports: ['resolve'] });
    return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra2, [RESOLVER, HELPER, PLAYER]);
  }).then(function () {
    return refresh('extra');
  }).then(function () {
    return Promise.all([plugin('resolver'), plugin('player')]);
  }).then(function (r) {
    assert.equal(r[0].version, '1.2.1');
    assert.equal(r[0].state, 'enabled', 'the fix turned it back on');
    assert.equal(r[0].held, null);
    assert.equal(r[1].state, 'enabled', 'and what needs it');
  });
});

test('removing a required plugin names its dependents first', { skip: skip() }, function () {
  return call('DELETE', '/admin/plugins/resolver').then(function (r) {
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.dependents.map(function (d) { return d.id; }), ['player']);
    return call('PATCH', '/admin/plugins/player', { updatePolicy: 'never' });
  }).then(function (r) {
    assert.equal(ok(r).updatePolicy, 'never');
    return call('DELETE', '/admin/plugins/resolver?force=1');
  }).then(function (r) {
    ok(r);
    return Promise.all([plugin('resolver'), plugin('player'), call('PATCH', '/admin/plugins/player', { enabled: true })]);
  }).then(function (r) {
    assert.equal(r[0], null);
    assert.equal(r[1].state, 'disabled');
    assert.match(r[1].held, /needs/);
    assert.equal(r[2].status, 409, 'not without what it needs');
    return installFrom('extra', 'resolver');
  }).then(function () {
    return plugin('player');
  }).then(function (p) {
    assert.equal(p.state, 'enabled', 'back with what it needs');
  });
});

test('a repository package adds a repository; an older listed version installs', { skip: skip() }, function () {
  return publish(HOSTS[2], { id: 'third', name: 'Third plugins' }, keys.third, [HELPER]).then(function (u) {
    return zip({ 'playpex-plugin.json': JSON.stringify({
      type: 'repository', id: 'third-repository', name: 'Third plugins', version: '1.0.0', publisher: { name: 'Third' },
      repository: { url: u, key: keys.third.publicKey }
    }) });
  }).then(function (buffer) {
    return upload(buffer, 'third-repository.ppx');
  }).then(function (r) {
    var p = ok(r);
    conforms('PluginPackagePreview', p);
    assert.equal(p.kind, 'repository');
    assert.equal(p.adds.name, 'Third plugins');
    assert.equal(p.adds.fingerprint, signing.fingerprint(keys.third.publicKey));
    return call('POST', '/admin/plugins/packages/' + p.token + '/install', {});
  }).then(function (r) {
    assert.equal(ok(r).repository.id, 'third');
    return stage('extra', 'resolver', '1.0.0');
  }).then(function (p) {
    assert.equal(p.change, 'downgrade');
    return call('POST', '/admin/plugins/packages/' + p.token + '/install', {});
  }).then(function (r) {
    assert.equal(ok(r).version, '1.0.0');
  });
});

test('a replacement (migratesFrom) takes the settings of the plugin it replaces', { skip: skip() }, function () {
  var SETTINGS = { settings: [{ key: 'greeting', scope: 'server', type: 'text', label: 'Greeting', default: 'hi' }] };
  var OLD = { id: 'oldie', name: 'Oldie', versions: [{ version: '1.0.0', contributes: SETTINGS, lifecycle: 'deprecated', replacedBy: 'newbie' }] },
    NEW = { id: 'newbie', name: 'Newbie', versions: [{ version: '1.0.0', contributes: SETTINGS, migratesFrom: ['oldie'] }] };
  return publish(HOSTS[1], { id: 'extra', name: 'Extra plugins' }, keys.extra2, [RESOLVER, HELPER, PLAYER, OLD, NEW]).then(function () {
    return refresh('extra');
  }).then(function () {
    return installFrom('extra', 'oldie');
  }).then(function (p) {
    assert.deepEqual(p.lifecycle, { state: 'deprecated', reason: null, replacedBy: 'newbie', listed: true });
    return call('PUT', '/admin/plugins/oldie/settings', { values: { greeting: 'hello there' } });
  }).then(function (r) {
    ok(r);
    return installFrom('extra', 'newbie');
  }).then(function () {
    return call('GET', '/admin/plugins/newbie/settings');
  }).then(function (r) {
    assert.equal(ok(r).server.greeting, 'hello there');
  });
});

// ── repositories built by npm run pack:repository ──────────────────────────

function packRepository(folders, out, pair, id, name, host) {
  var keyFile = path.join(tmp, id + '-key.json');
  fs.writeFileSync(keyFile, JSON.stringify(pair));
  var r = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pack-repository.js')].concat(folders)
    .concat(['--out', out, '--key', keyFile, '--id', id, '--name', name, '--base-url', url(host, id + '/')]), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.readdirSync(out).forEach(function (f) { served['/' + id + '/' + f] = fs.readFileSync(path.join(out, f)); });
  return url(host, id + '/index.json');
}

test('the 18+ plugin: refused by the official repository, installed from its own', { skip: skip() }, function () {
  var ADULT = path.join(__dirname, '..', '..', '..', 'plugins', 'adult'),
    HELLO = path.join(__dirname, '..', '..', '..', 'plugins', 'hello'),
    grownUp, kid;
  // the official index rebuilt by the tool with both plugins in it
  packRepository([HELLO, ADULT], path.join(tmp, 'built-official'), keys.official, 'playpex', 'Playpex', HOSTS[0]);
  var adultIndex = packRepository([ADULT], path.join(tmp, 'built-adult'), keys.third, 'playpex-adult', 'Playpex 18+', HOSTS[1]);
  return refresh('playpex').then(function () {
    return repository('playpex');
  }).then(function (official) {
    assert.equal(official.error, null);
    assert.deepEqual(official.refused.map(function (x) { return x.id; }), ['adult'], 'left out of the official repository');
    return call('POST', '/admin/plugins/catalog/install', { repository: 'playpex', id: 'adult' });
  }).then(function (r) {
    assert.equal(r.status, 404);
    return call('POST', '/admin/plugins/repositories', { url: adultIndex, key: keys.third.publicKey });
  }).then(function (r) {
    assert.equal(ok(r).plugins, 1);
    return installFrom('playpex-adult', 'adult');
  }).then(function (p) {
    assert.equal(p.origin, 'repository');
    assert.equal(p.repository.id, 'playpex-adult');
    assert.equal(p.audience, 'adults');
    return Promise.all([call('POST', '/profiles', { name: 'Grown' }), call('POST', '/profiles', { name: 'Child', isKid: true })]);
  }).then(function (r) {
    grownUp = r[0].json.id;
    kid = r[1].json.id;
    return Promise.all([call('GET', '/plugins?profile=' + grownUp), call('GET', '/plugins?profile=' + kid)]);
  }).then(function (r) {
    assert.ok(r[0].json.plugins.some(function (p) { return p.id === 'adult'; }), 'an adult profile has its section');
    assert.ok(!r[1].json.plugins.some(function (p) { return p.id === 'adult'; }), 'a kids profile never');
  });
});
