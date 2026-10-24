'use strict';

// The play pipeline's rules (lib/play, docs/media-server-plan.md §6, step 6),
// without a server: ranking with and without "Prefer files on this server",
// the same file found twice, when a client may play without asking, which
// download is the title and which of its files plays, playability by name.
// The route itself is in the contract test (a library file) and the downloads
// test (a finished download played from disk).

var test = require('node:test'),
  assert = require('node:assert/strict'),
  play = require('../lib/play'),
  handlers = require('../lib/play/handlers');

function source(id, type, extra) {
  return Object.assign({ id: id, type: type, provider: type, label: id + '.mkv', playable: 'yes', badges: [], notes: [] }, extra);
}

var FILE = source('f_1', 'file', { quality: '1080p', size: 4e9 }),
  FILE_4K = source('f_2', 'file', { quality: '2160p', size: 2e10, playable: 'maybe' }),
  AVI = source('f_3', 'file', { quality: '480p', size: 7e8, playable: 'no' }),
  DONE = source('t_a_1', 'download', { infoHash: 'a', progress: 1, size: 2e9 }),
  HALF = source('t_b_1', 'download', { infoHash: 'b', progress: 0.5, size: 2e9 }),
  T1 = source('torrent:c', 'torrent', { infoHash: 'c', seeds: 300 }),
  T2 = source('torrent:d', 'torrent', { infoHash: 'd', seeds: 10, playable: 'audio-converted' }),
  T3 = source('torrent:e', 'torrent', { infoHash: 'e', seeds: 5 });

function ids(list) {
  return list.map(function (s) { return s.id; });
}

test('rank: files on this server that play first, then playability, then a file being downloaded, then torrents in their order', function () {
  var all = [T1, T2, T3, HALF, AVI, FILE_4K, DONE, FILE];
  assert.deepEqual(ids(play.rank(all, { preferLocal: true })),
    ['f_1', 't_a_1', 'f_2', 't_b_1', 'torrent:c', 'torrent:e', 'torrent:d', 'f_3']);
  // off: what plays first, disk only breaks ties; torrents keep their provider's order
  assert.deepEqual(ids(play.rank(all, { preferLocal: false })),
    ['f_1', 't_a_1', 't_b_1', 'torrent:c', 'torrent:e', 'torrent:d', 'f_2', 'f_3']);
});

test('dedupe: a finished download that is also a library file, a torrent that is a download', function () {
  var copy = source('t_x_1', 'download', { infoHash: 'x', progress: 1, label: 'f_1.mkv', size: 4e9 }),
    known = source('torrent:b', 'torrent', { infoHash: 'b' });
  assert.deepEqual(ids(play.dedupe([FILE, copy, HALF, known, T1, T1])), ['f_1', 't_b_1', 'torrent:c']);
});

test('policy: a lone file on this server that plays starts without asking', function () {
  assert.equal(play.policy([FILE, T1], { preferLocal: true }).autoplay, 'f_1');
  assert.equal(play.policy([FILE, T1], { preferLocal: false }).autoplay, null);
  assert.equal(play.policy([FILE, DONE, T1], { preferLocal: true }).autoplay, null, 'two: the picker');
  assert.equal(play.policy([FILE_4K, T1], { preferLocal: true }).autoplay, null, 'maybe: the picker');
  assert.equal(play.policy([T1], { preferLocal: true }).autoplay, null);
});

test('groups: server, stream, torrent in that order, each with its best, count and how soon it plays', function () {
  var stream = source('r_1', 'plugin', { plugin: 'p' }),
    cached = source('torrent:f', 'torrent', { infoHash: 'f', seeds: 2, resolver: { plugin: 'p', label: 'Debrid' } }),
    quiet = source('torrent:g', 'torrent', { infoHash: 'g', seeds: null }),
    paused = source('t_h_1', 'download', { infoHash: 'h', progress: 0.2, state: 'paused' }),
    running = source('t_i_1', 'download', { infoHash: 'i', progress: 0.2, state: 'downloading' }),
    list = [T3, FILE, stream, T1, cached, quiet, paused, running].map(function (s) { return Object.assign({}, s); }),
    found = play.groups(list);
  assert.deepEqual(found, [
    { group: 'server', best: 'f_1', count: 3, readiness: 'instant' },
    { group: 'stream', best: 'r_1', count: 2, readiness: 'instant' },
    { group: 'torrent', best: 'torrent:e', count: 3, readiness: 'slow' }
  ]);
  var by = {};
  list.forEach(function (s) { by[s.id] = s.group + ' ' + s.readiness; });
  assert.deepEqual(by, {
    'torrent:e': 'torrent slow', f_1: 'server instant', r_1: 'stream instant', 'torrent:c': 'torrent seconds',
    'torrent:f': 'stream instant', 'torrent:g': 'torrent unknown', t_h_1: 'server unknown', t_i_1: 'server seconds'
  });
  assert.deepEqual(play.groups([]), []);
});

test('policy: player.autoplayKind plays the best of that group when it plays', function () {
  var stream = source('r_1', 'plugin', { plugin: 'p' }),
    risky = source('r_2', 'plugin', { plugin: 'p', playable: 'maybe' });
  function autoplay(list, kind) {
    list = list.map(function (s) { return Object.assign({}, s); });
    return play.policy(list, { preferLocal: false, autoplayKind: kind }, play.groups(list)).autoplay;
  }
  assert.equal(autoplay([stream, T1], 'stream'), 'r_1');
  assert.equal(autoplay([stream, T1], 'ask'), null);
  assert.equal(autoplay([stream, T1], 'server'), null, 'no such group');
  assert.equal(autoplay([risky, T1], 'stream'), null, 'its best may not play');
  assert.equal(autoplay([FILE, DONE, T1], 'server'), 'f_1', 'two files: the best one');
});

test('titleOf: the request is checked', function () {
  assert.throws(function () { play.titleOf({ kind: 'show', tmdbId: 1, title: 'x' }); }, /kind/);
  assert.throws(function () { play.titleOf({ kind: 'movie', tmdbId: 0, title: 'x' }); }, /tmdbId/);
  assert.throws(function () { play.titleOf({ kind: 'movie', tmdbId: 1, title: 'x', imdbId: '123' }); }, /imdbId/);
  assert.throws(function () { play.titleOf({ kind: 'episode', tmdbId: 1, title: 'x', season: 1 }); }, /episode/);
  assert.deepEqual(play.titleOf({ kind: 'episode', tmdbId: 1, title: ' Show ', season: 0, episode: 3 }),
    { kind: 'episode', tmdbId: 1, imdbId: null, title: 'Show', year: null, season: 0, episode: 3, profileId: null });
});

test('downloads: which one is the title, which file plays', function () {
  var episode = { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 2, episode: 5 },
    movie = { kind: 'movie', tmdbId: 27205, title: 'Inception', year: 2010 };
  assert.ok(handlers.isTitle({ title: { mediaType: 'tv', tmdbId: 1396, season: 2, episode: 1 } }, episode), 'its show: a pack');
  assert.ok(!handlers.isTitle({ title: { mediaType: 'movie', tmdbId: 1396 } }, episode));
  assert.ok(handlers.isTitle({ title: null, name: 'Breaking.Bad.S02.1080p.WEB' }, episode), 'by name');
  assert.ok(handlers.isTitle({ title: null, name: 'Breaking.Bad.S02E05.720p.HDTV' }, episode));
  assert.ok(!handlers.isTitle({ title: null, name: 'Breaking.Bad.S03.1080p.WEB' }, episode));
  assert.ok(!handlers.isTitle({ title: null, name: 'Breaking.Bad.2008.1080p' }, episode), 'a film of that name');
  assert.ok(handlers.isTitle({ title: null, name: 'Inception.2010.1080p.BluRay.x264' }, movie));
  assert.ok(!handlers.isTitle({ title: null, name: 'Inception.2011.1080p' }, movie));

  var pack = [
    { name: 'Breaking.Bad.S02E04.mkv', path: 'S02/Breaking.Bad.S02E04.mkv', size: 9e8 },
    { name: 'Breaking.Bad.S02E05.mkv', path: 'S02/Breaking.Bad.S02E05.mkv', size: 8e8 },
    { name: 'Breaking.Bad.S02E05.nfo', path: 'S02/Breaking.Bad.S02E05.nfo', size: 1e3 }
  ];
  assert.equal(handlers.fileFor(pack, episode).name, 'Breaking.Bad.S02E05.mkv');
  assert.equal(handlers.fileFor(pack, Object.assign({}, episode, { episode: 6 })), null);
  assert.equal(handlers.fileFor([{ name: 'sample.mkv', path: 'sample.mkv', size: 1e6 },
    { name: 'movie.mp4', path: 'movie.mp4', size: 2e9 }], movie).name, 'movie.mp4');
});

test('playable by name: XviD never, HEVC maybe, Dolby converted when ffmpeg is there', function () {
  assert.equal(play.playableByName('Show.S01E01.XviD-GRP', true).playable, 'no');
  assert.equal(play.playableByName('Show.S01E01.1080p.x265', true).playable, 'maybe');
  assert.equal(play.playableByName('Show.S01E01.1080p.WEB.DDP5.1.H.264', true).playable, 'audio-converted');
  assert.equal(play.playableByName('Show.S01E01.1080p.WEB.DDP5.1.H.264', false).playable, 'no');
  assert.equal(play.playableByName('Show.S01E01.720p.HDTV.x264.AAC', false).playable, 'yes');
});
