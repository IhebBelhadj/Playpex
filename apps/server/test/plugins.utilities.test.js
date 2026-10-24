'use strict';

// Host utilities for source plugins (docs/providers-plan.md step 2,
// lib/plugins/utilities.js) called from a real sandbox: `playpex.names.*`,
// `playpex.html.select` and `playpex.torrent.info`, with no permission.
//
//   names: the core's parse / describe / matches / rank   bad arguments → INVALID
//   html.select: text + attributes, fields, caps            a selector that doesn't parse → INVALID
//   torrent.info: a hand-made .torrent's hash, name, files  bytes that aren't one → INVALID

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  http = require('http');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-plugins-utilities-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
process.env.PLAYPEX_DISCOVERY = '0';

var server = require('..'),
  plugins = require('../lib/plugins'),
  helpers = require('./helpers/torrent');

var base = null;

// One handler calling any playpex function by name: { fn: 'names.parse', args: [...] };
// `bytes` (a list of numbers) becomes a Uint8Array argument
var CALLER = String.raw`
playpex.data('call', function (input) {
  var fn = input.fn.split('.').reduce(function (o, k) { return o[k]; }, playpex);
  var args = input.bytes ? [new Uint8Array(input.bytes)] : input.args || [];
  return Promise.resolve().then(function () { return fn.apply(null, args); }).then(function (value) {
    return { data: { value: value } };
  }, function (err) {
    return { data: { code: err.code || null, message: err.message } };
  });
});
`;

function call(fn, args, bytes) {
  var body = Buffer.from(JSON.stringify({ args: { fn: fn, args: args || [], bytes: bytes ? Array.from(bytes) : null } }));
  return new Promise(function (resolve, reject) {
    var req = http.request(new URL('/api/v1/plugins/tools/data/call', base), {
      method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': 'test-device-1' }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode !== 200) {
          return reject(new Error(fn + ' → ' + res.statusCode + ' ' + JSON.stringify(json)));
        }
        resolve(json.data);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test.before(function () {
  var dir = path.join(tmp, 'plugins', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'playpex-plugin.json'), JSON.stringify({
    id: 'tools', name: 'tools', version: '1.0.0', publisher: { name: 'Test' }, api: { server: '^1' },
    audience: 'everyone', permissions: {}
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), CALLER);
  return server.start({
    port: 0, console: false, library: false, torrents: { engine: 'fake', discovery: false }, plugins: { dirs: [dir] }
  }).then(function (info) {
    base = 'http://127.0.0.1:' + info.port;
    return helpers.until(function () {
      var p = plugins.get('tools');
      return p && p.state === 'enabled';
    }, 20000, 'the plugin');
  });
});

test.after(function () {
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('names: the core\'s reading of release names', function () {
  return Promise.all([
    call('names.parse', ['Severance S02E10 2160p ATVP WEB-DL DDP5 1 Atmos DV HDR H 265-FLUX']),
    call('names.describe', ['Movie 2020 1080p WEB x264 AAC']),
    call('names.matches', ['Breaking.Brad.S01E02.720p', { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 2 }]),
    call('names.matches', ['Breaking.Bad.S01.1080p', { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 2 }]),
    call('names.matches', ['Heat.1995.1080p', { kind: 'movie', tmdbId: 949, title: 'Heat', year: 1995 }]),
    call('names.rank', [[{ name: 'A 2160p HEVC', seeds: 500, id: 1 }, { name: 'B 1080p x264 AAC', seeds: 20, id: 2 }]])
  ]).then(function (r) {
    assert.deepEqual(r[0].value, {
      title: 'Severance', year: null, season: 2, episode: 10, episodeEnd: null, pack: false,
      resolution: '2160p', source: 'web-dl', codec: 'hevc', audio: 'eac3', hdr: true
    });
    assert.deepEqual(r[1].value, { quality: '1080p', codec: 'x264', audio: 'supported', playable: true });
    assert.equal(r[2].value, null);
    assert.equal(r[3].value, 'pack');
    assert.equal(r[4].value, 'movie');
    assert.deepEqual(r[5].value.map(function (i) { return i.id; }), [2, 1]);
  });
});

test('names: bad arguments', function () {
  return Promise.all([
    call('names.parse', [42]),
    call('names.parse', ['x'.repeat(2000)]),
    call('names.matches', ['Heat', { kind: 'film', title: 'Heat' }]),
    call('names.rank', [[{ seeds: 3 }]]),
    call('names.rank', ['nope'])
  ]).then(function (r) {
    r.forEach(function (answer) { assert.equal(answer.code, 'INVALID', JSON.stringify(answer)); });
  });
});

test('html.select: text, attributes and fields', function () {
  var page = '<table><tr class="row"><td><a class="t" href="/t/1">Heat  1995\n1080p</a></td><td class="s">412</td></tr>' +
    '<tr class="row"><td><a class="t" href="/t/2">Heat 1995 720p</a></td><td class="s">9</td></tr></table>';
  return Promise.all([
    call('html.select', [page, 'a.t']),
    call('html.select', [page, 'tr.row', { name: 'a.t', link: 'a.t@href', seeds: 'td.s', klass: '@class', missing: 'b' }]),
    call('html.select', [page, 'p']),
    call('html.select', [page, 'tr[[']),
    call('html.select', [page, '']),
    call('html.select', [12, 'a']),
    call('html.select', [page, 'a', { bad: 3 }])
  ]).then(function (r) {
    assert.deepEqual(r[0].value, [
      { text: 'Heat 1995 1080p', attributes: { class: 't', href: '/t/1' } },
      { text: 'Heat 1995 720p', attributes: { class: 't', href: '/t/2' } }
    ]);
    assert.deepEqual(r[1].value, [
      { name: 'Heat 1995 1080p', link: '/t/1', seeds: '412', klass: 'row', missing: null },
      { name: 'Heat 1995 720p', link: '/t/2', seeds: '9', klass: 'row', missing: null }
    ]);
    assert.deepEqual(r[2].value, []);
    r.slice(3).forEach(function (answer) { assert.equal(answer.code, 'INVALID', JSON.stringify(answer)); });
  });
});

test('html.select: at most 500 matches', function () {
  var page = new Array(700).fill('<i>x</i>').join('');
  return call('html.select', [page, 'i']).then(function (r) {
    assert.equal(r.value.length, 500);
  });
});

test('torrent.info: a .torrent\'s hash, name and files', function () {
  var made = helpers.make(path.join(tmp, 'seed'), 'Show.S01.1080p', [
    { path: 'Show.S01E01.mkv', size: 70000 }, { path: 'Subs/English.srt', size: 300 }
  ]);
  return Promise.all([
    call('torrent.info', null, made.torrentFile),
    call('torrent.info', null, Buffer.from('not a torrent')),
    call('torrent.info', [])
  ]).then(function (r) {
    assert.equal(r[0].value.infoHash, made.infoHash);
    assert.equal(r[0].value.name, 'Show.S01.1080p');
    assert.equal(r[0].value.size, 70300);
    assert.deepEqual(r[0].value.files, [
      { index: 0, path: 'Show.S01.1080p/Show.S01E01.mkv', size: 70000 },
      { index: 1, path: 'Show.S01.1080p/Subs/English.srt', size: 300 }
    ]);
    assert.equal(r[1].code, 'INVALID');
    assert.equal(r[2].code, null, 'no bytes: refused in the sandbox');
    assert.match(r[2].message, /Uint8Array/);
  });
});
