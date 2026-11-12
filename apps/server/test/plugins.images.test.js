'use strict';

// Plugins' pictures through the server (docs/plugin-layer-plan.md §3, step 1)
// on a real server: a test plugin's slot answers cards and a title info whose
// pictures are on a network host, an images host, an undeclared host and a
// host resolving to loopback; a local HTTPS server (openssl certificate,
// 127.0.0.2) is the web and serves a PNG, a JPEG, an SVG, an HTML page and a
// picture too large.
//
//   every picture URL becomes images/<token> · the token names the URL, is stable and can't be forged
//   declared hosts (network, images) serve the picture with its type · cached: a second read doesn't reach the web
//   an undeclared host, loopback, SVG, HTML and > 5 MB answer 404 · a token of another plugin 404
//   permissions.images is checked like network and said in words

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  https = require('https'),
  childProcess = require('child_process');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-images-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  images = require('../lib/plugins/images'),
  protocol = require('@playpex/protocol/plugins');

var TEST_HOST = '127.0.0.2',
  PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]),
  JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]),
  base = null,
  remote = null,
  remotePort = 0,
  tls = null,
  hits = {};

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

function lookup(host, options, callback) {
  var map = {
    'api.playpex-test.dev': TEST_HOST, 'img.playpex-test.dev': TEST_HOST,
    'other.playpex-test.dev': TEST_HOST, 'loop.playpex-test.dev': '127.0.0.1'
  };
  if (!map[host]) {
    return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  }
  callback(null, [{ address: map[host], family: 4 }]);
}

function web(req, res) {
  var key = req.headers.host.split(':')[0] + req.url;
  hits[key] = (hits[key] || 0) + 1;
  if (req.url === '/a.png') {
    res.setHeader('Content-Type', 'application/octet-stream');   // the bytes decide, not the header
    return res.end(PNG);
  }
  if (req.url === '/b.jpg') {
    return res.end(JPEG);
  }
  if (req.url === '/c.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  }
  if (req.url === '/d.png') {
    res.setHeader('Content-Type', 'image/png');
    return res.end('<html><body>not a picture</body></html>');
  }
  if (req.url === '/big.png') {
    return res.end(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
  }
  res.statusCode = 404;
  res.end();
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
        resolve({ status: res.statusCode, headers: res.headers, json: json, raw: raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

var PICS = String.raw`
var W = 'https://HOST:PORT';
playpex.data('rows', function () {
  return { data: [{ key: 'pics:row', title: 'Pictures', items: [
    { key: 1, title: 'Network host', image: W.replace('HOST', 'api.playpex-test.dev') + '/a.png',
      info: { title: 'Network host', backdrop: W.replace('HOST', 'img.playpex-test.dev') + '/b.jpg' } },
    { key: 2, title: 'Images host', image: W.replace('HOST', 'img.playpex-test.dev') + '/b.jpg' },
    { key: 3, title: 'Undeclared host', image: W.replace('HOST', 'other.playpex-test.dev') + '/a.png' },
    { key: 4, title: 'Loopback', image: W.replace('HOST', 'loop.playpex-test.dev') + '/a.png' },
    { key: 5, title: 'SVG', image: W.replace('HOST', 'api.playpex-test.dev') + '/c.svg' },
    { key: 6, title: 'HTML', image: W.replace('HOST', 'api.playpex-test.dev') + '/d.png' },
    { key: 7, title: 'Too large', image: W.replace('HOST', 'api.playpex-test.dev') + '/big.png' },
    { key: 8, title: 'Asset', image: 'assets/icon.png' },
    { key: 9, title: 'None', image: null }
  ] }] };
});
`;

function writePlugin(id, permissions, code) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'icon.png'), PNG);
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: id, name: id, version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' }, audience: 'everyone',
    permissions: permissions, contributes: { slots: [{ slot: 'core.movies.rows', data: 'rows' }] }
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), code.replace(/PORT/g, String(remotePort)));
  return dir;
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
    var perms = {
      network: ['api.playpex-test.dev'],
      images: ['img.playpex-test.dev', 'loop.playpex-test.dev']
    };
    return server.start({
      port: 0, console: false, torrents: { engine: 'fake', discovery: false }, library: false,
      plugins: {
        dirs: [writePlugin('pics', perms, PICS), writePlugin('other', perms, PICS)],
        http: { lookup: lookup, ports: [remotePort], ca: tls.cert, allowAddresses: [TEST_HOST] }
      }
    });
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 2 && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve();
        }
        if (Date.now() > until) {
          return reject(new Error('plugins not loaded'));
        }
        setTimeout(poll, 50);
      })();
    });
  });
});

test.after(function () {
  return (base ? server.stop() : Promise.resolve()).then(function () {
    if (remote) {
      remote.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function rows() {
  return call('POST', '/plugins/pics/data/rows', { args: { slot: 'core.movies.rows', context: {} } }).then(function (res) {
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.data[0].items;
  });
}

test('permissions.images is checked like network and said in words', function () {
  var m = {
    id: 'pics', name: 'Pics', version: '1.0.0', publisher: { name: 'T' }, api: { server: '^1' }, audience: 'everyone',
    permissions: { images: ['img.example.com', '*.cdn.example.com'] }
  };
  assert.deepEqual(protocol.checkManifest(m), []);
  var text = protocol.describePermissions(m).map(function (x) { return x.text; });
  assert.ok(text.indexOf('Shows pictures from img.example.com, *.cdn.example.com') !== -1, text.join(' | '));
  var bad = Object.assign({}, m, { permissions: { images: ['192.168.1.2'] } });
  assert.ok(protocol.checkManifest(bad).some(function (p) { return /images/.test(p.path || p); }));
});

test('every picture URL leaves as images/<token>; assets and null stay', function (t) {
  if (!tls) {
    return t.skip('openssl is needed for the HTTPS test server');
  }
  return rows().then(function (items) {
    items.slice(0, 7).forEach(function (c) {
      assert.match(c.image, /^images\/[\w-]+\.[\w-]{22}$/, c.title);
      assert.doesNotMatch(JSON.stringify(c), /playpex-test\.dev/, c.title);
    });
    assert.match(items[0].info.backdrop, /^images\//);
    assert.equal(items[7].image, 'assets/icon.png');
    assert.equal(items[8].image, null);
    // stable: the same URL gives the same token
    return rows().then(function (again) {
      assert.equal(again[0].image, items[0].image);
    });
  });
});

test('declared hosts serve the picture, typed by its bytes, then from the cache', function (t) {
  if (!tls) {
    return t.skip('openssl is needed for the HTTPS test server');
  }
  return rows().then(function (items) {
    return call('GET', '/plugins/pics/' + items[0].image).then(function (res) {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.raw.equals(PNG));
      return call('GET', '/plugins/pics/' + items[1].image);
    }).then(function (res) {
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/jpeg');
      var before = hits['api.playpex-test.dev/a.png'];
      return call('GET', '/plugins/pics/' + items[0].image).then(function (again) {
        assert.equal(again.status, 200);
        assert.equal(hits['api.playpex-test.dev/a.png'], before, 'read from the cache');
      });
    });
  });
});

test('an undeclared host, loopback, SVG, HTML and a picture over 5 MB answer 404', function (t) {
  if (!tls) {
    return t.skip('openssl is needed for the HTTPS test server');
  }
  return rows().then(function (items) {
    return Promise.all(items.slice(2, 7).map(function (c) {
      return call('GET', '/plugins/pics/' + c.image).then(function (res) {
        assert.equal(res.status, 404, c.title);
        assert.equal(res.raw.length, 0, c.title);
      });
    })).then(function () {
      assert.equal(hits['other.playpex-test.dev/a.png'], undefined, 'an undeclared host is never asked');
    });
  });
});

test('a token is the plugin\'s own: forged or another plugin\'s answers 404', function (t) {
  if (!tls) {
    return t.skip('openssl is needed for the HTTPS test server');
  }
  return rows().then(function (items) {
    var tokenPart = items[0].image.slice('images/'.length);
    assert.equal(images.untoken('pics', tokenPart), 'https://api.playpex-test.dev:' + remotePort + '/a.png');
    assert.equal(images.untoken('other', tokenPart), null);
    var forged = Buffer.from('https://api.playpex-test.dev:' + remotePort + '/b.jpg').toString('base64url') + '.' + tokenPart.split('.')[1];
    return Promise.all([
      call('GET', '/plugins/other/' + items[0].image),
      call('GET', '/plugins/pics/images/' + forged),
      call('GET', '/plugins/pics/images/nonsense')
    ]).then(function (all) {
      all.forEach(function (res) { assert.equal(res.status, 404); });
    });
  });
});

test('sniff knows the picture formats and nothing else', function () {
  assert.equal(images.sniff(PNG), 'png');
  assert.equal(images.sniff(JPEG), 'jpg');
  assert.equal(images.sniff(Buffer.from('GIF89a......')), 'gif');
  assert.equal(images.sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.equal(images.sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')])), 'avif');
  assert.equal(images.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(images.sniff(Buffer.from('<html>')), null);
});

test('learned picture hosts: taught only by what the server fetched, for pictures only, at most 5000', function (t) {
  if (!tls) {
    return t.skip('openssl is needed for the HTTPS test server');
  }
  var grants = require('../lib/plugins/grants'), pluginHttp = require('../lib/plugins/http'),
    pics = plugins.get('pics'), other = 'https://other.playpex-test.dev:' + remotePort + '/a.png';
  // no host call lets plugin code teach a host
  assert.doesNotMatch(fs.readFileSync(require.resolve('../lib/plugins/host.js'), 'utf8'), /grants\.learn|'grants\./);
  // a document from an address that isn't a streamHosts setting's teaches nothing
  assert.equal(grants.learn(pics, 'https://api.playpex-test.dev/list', [other], { scope: 'image' }), 0);
  assert.equal(grants.learn(pics, null, [other, 'ftp://x.example/a', 'not a url'], { scope: 'image', from: 'answer' }), 1);
  // pictures only: neither its requests nor its streams may use the host
  assert.throws(function () { pluginHttp.target(pics, other); }, /permissions\.network/);
  assert.throws(function () { pluginHttp.target(pics, other, { stream: true }); }, /permissions\.network/);
  assert.ok(pluginHttp.target(pics, other, { image: true }));
  images.configure();   // the refusal of the earlier test is forgotten
  return rows().then(function (items) {
    return call('GET', '/plugins/pics/' + items[2].image);
  }).then(function (res) {
    assert.equal(res.status, 200, 'the undeclared host, once learned');
    assert.equal(res.headers['content-type'], 'image/png');
    // the oldest go past 5000
    var many = [];
    for (var i = 0; i < 5001; i++) {
      many.push('https://h' + i + '.example.com/x.png');
    }
    grants.learn(pics, null, many, { scope: 'image', from: 'answer' });
    assert.equal(grants.learnedCount(pics, 'image'), 5000);
    assert.throws(function () { pluginHttp.target(pics, other, { image: true }); }, 'the first one learned is gone');
  });
});
