'use strict';

// Playpex on the web, one address (docs/web-unified-plan.md): GET /clients,
// the settings clients.*, /m/ served like /tv/, a web client turned off, and
// /app/: the page (its CSP, nothing from the request in it) and its script run
// in a vm with a made-up browser: TVs, phones, tablets and computers, a
// remembered or asked view, a client off or not built, ?at= places.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  vm = require('vm'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-entry-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';
process.env.PLAYPEX_TV_WEB_DIR = path.join(tmp, 'public-tv');
process.env.PLAYPEX_MOBILE_WEB_DIR = path.join(tmp, 'public-m');

var server = require('..'),
  logger = require('../lib/logger');

var OPTIONS = { port: 0, console: false, library: false, plugins: false, torrents: { engine: 'fake', discovery: false } },
  base = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

function call(urlPath) {
  return new Promise(function (resolve, reject) {
    http.get(new URL(urlPath, base), { agent: false }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text: text,
          body: /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null });
      });
    }).on('error', reject);
  });
}

function build(dir, file) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>' + file + '</title>');
}

test.before(function () {
  logger.configure({ level: 'warn', dir: path.join(tmp, 'logs'), console: false });
  return server.start(OPTIONS).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('GET /clients: nothing built yet, the defaults', function () {
  return call('/api/v1/clients').then(function (res) {
    assert.equal(res.status, 200);
    conforms('WebClients', res.body);
    assert.deepEqual(res.body.web.map(function (c) { return [c.id, c.path, c.enabled, c.built]; }),
      [['tv', '/tv/', true, false], ['mobile', '/m/', true, false]]);
    assert.deepEqual(res.body.open, { computers: 'tv', tablets: 'mobile' });
  });
});

test('/m/: not built → 404; built: index fallback, hashed files immutable', function () {
  return call('/m/').then(function (res) {
    assert.equal(res.status, 404);
    assert.match(res.text, /build:mobile-web/);
    build(process.env.PLAYPEX_MOBILE_WEB_DIR, 'mobile');
    var hashed = 'entry-' + 'a'.repeat(32) + '.js';
    fs.mkdirSync(path.join(process.env.PLAYPEX_MOBILE_WEB_DIR, '_expo'), { recursive: true });
    fs.writeFileSync(path.join(process.env.PLAYPEX_MOBILE_WEB_DIR, '_expo', hashed), 'x');
    fs.writeFileSync(path.join(process.env.PLAYPEX_MOBILE_WEB_DIR, 'metadata.json'), '{}');
    return Promise.all([call('/m'), call('/m/title/movie/603'), call('/m/_expo/' + hashed), call('/m/metadata.json'), call('/api/v1/clients')]);
  }).then(function (r) {
    assert.equal(r[0].status, 301);
    assert.equal(r[0].headers.location, '/m/');
    assert.equal(r[1].status, 200);
    assert.match(r[1].text, /mobile/);
    assert.equal(r[1].headers['cache-control'], 'no-cache');
    assert.match(r[2].headers['cache-control'], /immutable/);
    assert.equal(r[3].headers['cache-control'], 'public, max-age=3600');
    assert.equal(r[4].body.web[1].built, true);
  });
});

test('/app/: one page, its own CSP, nothing from the request in it', function () {
  return Promise.all([call('/app'), call('/app/?view=%3Cscript%3E&at=%22x'), call('/app/index.html')]).then(function (r) {
    assert.equal(r[0].status, 301);
    assert.equal(r[0].headers.location, '/app/');
    assert.equal(r[1].status, 200);
    assert.match(r[1].headers['content-security-policy'], /script-src 'sha256-/);
    assert.doesNotMatch(r[1].headers['content-security-policy'], /unsafe-inline/);
    assert.equal(r[1].headers['cache-control'], 'no-cache');
    assert.doesNotMatch(r[1].text, /%3Cscript|%22x/);
    assert.equal(r[2].text, r[1].text);
    // the script the CSP names is the page's
    var script = /<script>([\s\S]*)<\/script>/.exec(r[1].text)[1],
      digest = "'sha256-" + require('crypto').createHash('sha256').update(script).digest('base64') + "'";
    assert.ok(r[1].headers['content-security-policy'].indexOf(digest) !== -1);
  });
});

test('a web client turned off: 403 page, /clients says so, back on', function () {
  build(process.env.PLAYPEX_TV_WEB_DIR, 'tv');
  server.settings.update({ clients: { tvWeb: false } });
  return Promise.all([call('/tv/'), call('/tv/home/list'), call('/api/v1/clients'), call('/m/')]).then(function (r) {
    assert.equal(r[0].status, 403);
    assert.match(r[0].text, /Playpex TV is turned off/);
    assert.match(r[0].text, /href="\/app\/"/);
    assert.equal(r[1].status, 403);
    assert.equal(r[2].body.web[0].enabled, false);
    assert.equal(r[3].status, 200);
    server.settings.update({ clients: { tvWeb: true } });
    return call('/tv/');
  }).then(function (res) {
    assert.equal(res.status, 200);
  });
});

test('settings: computers and tablets take tv or mobile only', function () {
  assert.throws(function () { server.settings.update({ clients: { computers: 'phone' } }); }, /tv or mobile/);
  server.settings.update({ clients: { computers: 'mobile', tablets: 'tv' } });
  return call('/api/v1/clients').then(function (res) {
    assert.deepEqual(res.body.open, { computers: 'mobile', tablets: 'tv' });
    server.settings.update({ clients: { computers: 'tv', tablets: 'mobile' } });
  });
});

// The page's script in a made-up browser: where it goes
var UA = {
  tizen: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
  webos: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.128 Safari/537.36 WebAppManager',
  firetv: 'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.5.1 like Chrome/112.0.5615.213 Safari/537.36',
  pixel: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
};

function run(script, opts) {
  var gone = null, shown = [], storage = Object.assign({}, opts.storage || {});
  var answer = opts.clients === undefined ? {
    web: [{ id: 'tv', path: '/tv/', enabled: true, built: true }, { id: 'mobile', path: '/m/', enabled: true, built: true }],
    open: { computers: 'tv', tablets: 'mobile' }
  } : opts.clients;
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {
    if (answer === null) return this.onerror();
    this.status = 200;
    this.responseText = JSON.stringify(answer);
    this.onload();
  };
  var context = {
    location: { search: opts.search || '', replace: function (to) { gone = to; } },
    navigator: { userAgent: UA[opts.ua] },
    screen: opts.screen || { width: 1920, height: 1080 },
    matchMedia: function (q) {
      var touch = !!opts.touch;
      return { matches: q === '(pointer: coarse)' ? touch : q === '(any-pointer: fine)' ? !touch : false };
    },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
      setItem: function (k, v) { storage[k] = String(v); },
      removeItem: function (k) { delete storage[k]; }
    },
    document: { getElementById: function (id) { return { style: {}, id: shown.push(id) && id }; } },
    XMLHttpRequest: XMLHttpRequest,
    RegExp: RegExp, JSON: JSON, Math: Math, Object: Object
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { to: gone, shown: shown, storage: storage };
}

test('/app/ script: each kind of device, choices, places', function () {
  return call('/app/').then(function (res) {
    var script = /<script>([\s\S]*)<\/script>/.exec(res.text)[1];
    var phone = { ua: 'pixel', touch: true, screen: { width: 412, height: 915 } },
      tablet = { ua: 'ipad', touch: true, screen: { width: 820, height: 1180 } };

    assert.equal(run(script, { ua: 'tizen' }).to, '/tv/');
    assert.equal(run(script, { ua: 'webos' }).to, '/tv/');
    assert.equal(run(script, { ua: 'firetv', touch: true, screen: { width: 1920, height: 1080 } }).to, '/tv/');
    assert.equal(run(script, phone).to, '/m/');
    assert.equal(run(script, tablet).to, '/m/');
    assert.equal(run(script, { ua: 'desktop' }).to, '/tv/');
    // the admin's choices
    var choices = { web: [{ id: 'tv', path: '/tv/', enabled: true, built: true }, { id: 'mobile', path: '/m/', enabled: true, built: true }],
      open: { computers: 'mobile', tablets: 'tv' } };
    assert.equal(run(script, Object.assign({ clients: choices }, tablet)).to, '/tv/');
    assert.equal(run(script, { ua: 'desktop', clients: choices }).to, '/m/');
    // asked, then remembered; auto forgets
    var asked = run(script, { ua: 'desktop', search: '?view=mobile' });
    assert.equal(asked.to, '/m/');
    assert.equal(asked.storage['playpex.web.view'], 'mobile');
    assert.equal(run(script, { ua: 'desktop', storage: asked.storage }).to, '/m/');
    var auto = run(script, { ua: 'desktop', search: '?view=auto', storage: asked.storage });
    assert.equal(auto.to, '/tv/');
    assert.equal(auto.storage['playpex.web.view'], undefined);
    assert.equal(run(script, { ua: 'desktop', search: '?view=nonsense' }).to, '/tv/');
    // places
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=title%2Fmovie%2F603' }).to, '/tv/movies/movie/603');
    assert.equal(run(script, { ua: 'desktop', search: '?view=mobile&at=title/tv/1399' }).to, '/m/title/tv/1399');
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=title/tv/1399' }).to, '/tv/shows/show/1399');
    assert.equal(run(script, { ua: 'desktop', search: '?view=mobile&at=person/287' }).to, '/m/person/287');
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=home' }).to, '/tv/home/list');
    assert.equal(run(script, { ua: 'desktop', search: '?view=mobile&at=mylist' }).to, '/m/mylist');
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=movie' }).to, '/tv/');
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=..%2F..%2Fadmin' }).to, '/tv/');
    assert.equal(run(script, { ua: 'desktop', search: '?view=tv&at=constructor' }).to, '/tv/');
    // one off or not built: the other; neither: the page says so
    var tvOff = { web: [{ id: 'tv', path: '/tv/', enabled: false, built: true }, { id: 'mobile', path: '/m/', enabled: true, built: true }],
      open: { computers: 'tv', tablets: 'mobile' } };
    assert.equal(run(script, { ua: 'tizen', clients: tvOff }).to, '/m/');
    var none = { web: [{ id: 'tv', path: '/tv/', enabled: false, built: true }, { id: 'mobile', path: '/m/', enabled: true, built: false }],
      open: { computers: 'tv', tablets: 'mobile' } };
    var nothing = run(script, { ua: 'desktop', clients: none });
    assert.equal(nothing.to, null);
    assert.ok(nothing.shown.indexOf('none') !== -1);
    // the server didn't answer: the device's view anyway
    assert.equal(run(script, Object.assign({ clients: null }, phone)).to, '/m/');
  });
});
