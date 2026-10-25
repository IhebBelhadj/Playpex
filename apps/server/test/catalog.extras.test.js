'use strict';

// Metadata providers (docs/providers-plan.md §7.2, step 7) on a real server:
// test plugins with `metadata.details` / the older `metadata.title` in real
// sandboxes, lib/tmdb.js#get stubbed. GET /catalog/titles/…/extras: what they
// add in the admin's order (Settings › Metadata), the core's details as their
// input, `metadata.title` answers folded in as `lines`, a plugin with both
// asked once, a switched-off provider never asked, a failing one in `errors`,
// an adults plugin never for a kids profile, answers against openapi.yaml.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http'),
  YAML = require('yaml'),
  Ajv2020 = require('ajv/dist/2020');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-extras-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  settings = require('../lib/settings'),
  userData = require('../lib/userData'),
  tmdb = require('../lib/tmdb');

var base = null,
  kids = null,
  grown = null;

var ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(YAML.parse(fs.readFileSync(require.resolve('@playpex/protocol/openapi.yaml'), 'utf8')), 'spec');

function conforms(schema, value) {
  var validate = ajv.getSchema('spec#/components/schemas/' + schema);
  assert.ok(validate(value), schema + ': ' + ajv.errorsText(validate.errors));
}

tmdb.get = function (apiPath) {
  if (apiPath === '/movie/949') {
    return Promise.resolve({
      id: 949, title: 'Heat', original_title: 'Heat', release_date: '1995-12-15', imdb_id: 'tt0113277', runtime: 170,
      genres: [{ id: 80, name: 'Crime' }], videos: { results: [] }
    });
  }
  return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
};

// ── test plugins ────────────────────────────────────────────────────────────

var DETAILS = String.raw`
playpex.hooks.on('metadata.details', function (input) {
  return {
    ratings: [{ source: 'Trakt', value: 84, max: 100, votes: 1200, url: 'https://trakt.tv/movies/heat-1995' }],
    tags: [input.details.title + ' ' + input.details.year, input.details.genres.join('/'), input.title.imdbId],
    links: [{ label: 'On Trakt', url: 'https://trakt.tv/movies/heat-1995' }],
    lines: [{ kind: 'chip', text: 'Runtime ' + input.details.runtime }]
  };
});
`;
var TITLE = String.raw`
playpex.hooks.on('metadata.title', function (input) {
  return { meta: [{ kind: 'text', text: 'Older ' + input.title.tmdbId }] };
});
`;
var BOTH = DETAILS.replace("source: 'Trakt'", "source: 'Both'") + TITLE.replace("'Older '", "'Both title '");
var BROKEN = String.raw`
playpex.hooks.on('metadata.details', function () { throw new Error('nope'); });
`;

function writePlugin(id, hooks, code, extra) {
  var dir = path.join(tmp, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify(Object.assign({
    id: id, name: id[0].toUpperCase() + id.slice(1), version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: { hooks: hooks }
  }, extra)));
  fs.writeFileSync(path.join(dir, 'server.js'), code);
  return dir;
}

function get(url, expected) {
  return new Promise(function (resolve, reject) {
    http.get(new URL('/api/v1' + url, base), { agent: false }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode !== (expected || 200)) {
          return reject(new Error(url + ' → ' + res.statusCode + ' ' + JSON.stringify(body)));
        }
        resolve(body);
      });
    }).on('error', reject);
  });
}

function calls(id, hook) {
  var hooks = plugins.get(id).stats.hooks[hook];
  return hooks ? hooks.calls : 0;
}

test.before(function () {
  var dirs = [
    writePlugin('trakty', ['metadata.details'], DETAILS),
    writePlugin('older', ['metadata.title'], TITLE),
    writePlugin('both', ['metadata.details', 'metadata.title'], BOTH),
    writePlugin('broken', ['metadata.details'], BROKEN),
    writePlugin('night', ['metadata.details'], DETAILS.replace("source: 'Trakt'", "source: 'Night'"), { audience: 'adults' })
  ];
  return server.start({
    port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false }, plugins: { dirs: dirs }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    var until = Date.now() + 20000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var all = plugins.list();
        if (all.length === 5 && all.every(function (p) { return p.state !== 'loading'; })) {
          return resolve();
        }
        if (Date.now() > until) {
          return reject(new Error('plugins not loaded'));
        }
        setTimeout(poll, 50);
      })();
    });
  }).then(function () {
    return userData.services();
  }).then(function (s) {
    return Promise.all([s.profiles.create({ name: 'Kid', isKid: true }), s.profiles.create({ name: 'Grown' })]);
  }).then(function (made) {
    kids = made[0];
    grown = made[1];
  });
});

test.after(function () {
  return server.stop();
});

function summary(body) {
  return body.providers.map(function (p) { return p.plugin; });
}

test('every provider\'s additions, by id until the admin orders them; the core\'s details as input', function () {
  return get('/catalog/titles/movie/949/extras?profile=' + grown.id).then(function (body) {
    conforms('CatalogExtras', body);
    assert.deepEqual(summary(body), ['both', 'night', 'older', 'trakty']);
    var trakty = body.providers[3];
    assert.deepEqual(trakty.ratings, [{ source: 'Trakt', value: 84, max: 100, votes: 1200, url: 'https://trakt.tv/movies/heat-1995' }]);
    assert.deepEqual(trakty.tags, ['Heat 1995', 'Crime', 'tt0113277']);
    assert.deepEqual(trakty.lines, [{ kind: 'chip', text: 'Runtime 170' }]);
    assert.equal(trakty.name, 'Trakty');
    assert.deepEqual(body.providers[2], { plugin: 'older', name: 'Older', ratings: [], tags: [], links: [], lines: [{ kind: 'text', text: 'Older 949' }] },
      'metadata.title folded in as lines');
    assert.equal(body.providers[0].ratings[0].source, 'Both');
    assert.equal(calls('both', 'metadata.title'), 0, 'a plugin with both: only metadata.details');
    assert.deepEqual(body.errors.map(function (e) { return e.plugin; }), ['broken'], 'a failing provider only leaves itself out');
  });
});

test('Settings › Metadata: the order, a provider switched off is never asked', function () {
  settings.update({ metadata: { order: ['trakty', 'older'], disabled: ['both'] } });
  var before = calls('both', 'metadata.details');
  return get('/catalog/titles/movie/949/extras?profile=' + grown.id).then(function (body) {
    assert.deepEqual(summary(body), ['trakty', 'older', 'night']);
    assert.equal(calls('both', 'metadata.details'), before);
    assert.throws(function () { settings.update({ metadata: { order: ['Not An Id'] } }); }, /plugin ids/);
  }).finally(function () {
    settings.update({ metadata: { order: [], disabled: [] } });
  });
});

test('a kids profile never gets an adults plugin; no profile: the same rule', function () {
  return get('/catalog/titles/movie/949/extras?profile=' + kids.id).then(function (body) {
    assert.equal(summary(body).indexOf('night'), -1);
    return get('/catalog/titles/movie/949/extras');
  }).then(function (body) {
    assert.ok(summary(body).indexOf('trakty') !== -1);
    return get('/catalog/titles/movie/949/extras?profile=nobody', 404);
  }).then(function () {
    return get('/catalog/titles/movie/404/extras', 404);
  }).then(function () {
    return get('/catalog/titles/person/949/extras', 400);
  });
});
