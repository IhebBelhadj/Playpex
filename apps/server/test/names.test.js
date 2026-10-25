'use strict';

// Release names (lib/media/names.js, docs/providers-plan.md step 2): what the
// core and plugins (`playpex.names.*`) read from a torrent's or a file's name.
//
//   parse: the release corpus (test/fixtures/releases.tsv) and the library's
//          (filenames.tsv: paths read like the library reads them)
//   describe: what Chromium plays · matchKind / matches: the strict matcher
//   rank: plays here → audio → healthy swarm → single before pack → resolution → seeds

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path'),
  names = require('../lib/media/names');

function norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function corpus(file) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').split('\n')
    .filter(function (l) { return l && l[0] !== '#'; });
}

function num(v) {
  return v === '' ? null : Number(v);
}

test('parse: the release corpus', function () {
  var rows = corpus('releases.tsv'),
    wrong = rows.map(function (line) {
      var f = line.split('\t'), p = names.parse(f[0]),
        want = {
          title: norm(f[1]), year: num(f[2]), season: num(f[3]), episode: num(f[4]), pack: f[5] === 'yes',
          resolution: f[6] || null, codec: f[7] || null, audio: f[8] || null, hdr: f[9] === 'yes'
        },
        got = {
          title: norm(p.title), year: p.year, season: p.season, episode: p.episode, pack: p.pack,
          resolution: p.resolution, codec: p.codec, audio: p.audio, hdr: p.hdr
        };
      return JSON.stringify(want) === JSON.stringify(got) ? null : f[0] + '\n  want ' + JSON.stringify(want) + '\n  got  ' + JSON.stringify(got);
    }).filter(Boolean);
  assert.ok(rows.length >= 20);
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.equal(names.parse('Show.2019.S03E05E06.2160p.WEB-DL').episodeEnd, 6);
});

test('parse: library paths read as the library reads them', function () {
  var rows = corpus('filenames.tsv'),
    wrong = rows.filter(function (line) {
      var f = line.split('\t'), p = names.parse(f[0]);
      return norm(p.title) !== norm(f[2]) || (f[3] && p.year !== +f[3]) ||
        (f[1] === 'episode' && (p.season !== +f[4] || p.episode !== +f[5]));
    });
  assert.ok(rows.length >= 300);
  // a path's reading is the library's; names.parse adds tags to it, never other titles
  assert.deepEqual(wrong, [], wrong.length + ' paths read differently');
});

test('parse: anything', function () {
  [null, undefined, '', 42, {}, 'x'.repeat(5000)].forEach(function (v) {
    var p = names.parse(v);
    assert.equal(typeof p.pack, 'boolean');
    assert.equal(typeof p.hdr, 'boolean');
  });
});

test('describe: what plays here', function () {
  assert.deepEqual(names.describe('Movie 2020 1080p WEB x264 AAC'), { quality: '1080p', codec: 'x264', audio: 'supported', playable: true });
  assert.deepEqual(names.describe('Movie 2020 2160p HEVC DDP5.1'), { quality: '2160p', codec: 'x265', audio: 'unsupported', playable: false });
  assert.equal(names.describe('Movie 2020 720p 10bit').playable, false);
  assert.equal(names.describe('Movie XviD').codec, 'xvid');
  assert.equal(names.describe('Movie 4K').quality, '2160p');
  assert.equal(names.describe('Movie').quality, 'SD');
});

test('matchKind: the strict matcher', function () {
  assert.equal(names.matchKind('Breaking.Bad.S01E02.720p', 'Breaking Bad', 1, 2), 'episode');
  assert.equal(names.matchKind('Breaking Bad 2008 US S01E02', 'Breaking Bad', 1, 2), 'episode');
  assert.equal(names.matchKind('Breaking.Brad.S01E02.720p', 'Breaking Bad', 1, 2), null);
  assert.equal(names.matchKind('Breaking.Bad.S01E02-E05.720p', 'Breaking Bad', 1, 2), null);
  assert.equal(names.matchKind('Breaking.Bad.S01E021.720p', 'Breaking Bad', 1, 2), null);
  assert.equal(names.matchKind('Breaking Bad S01 1080p', 'Breaking Bad', 1, 2), 'pack');
  assert.equal(names.matchKind('Breaking Bad Season 1 1080p', 'Breaking Bad', 1, 2), 'pack');
  assert.equal(names.matchKind('Breaking Bad S01-S05 1080p', 'Breaking Bad', 1, 2), null);
  assert.equal(names.matchKind('Lego Friends S01E02', 'Friends', 1, 2), null);
});

test('matches: a plugin titleRef', function () {
  var episode = { kind: 'episode', tmdbId: 1396, title: 'Breaking Bad', season: 1, episode: 2 };
  assert.equal(names.matches('Breaking.Bad.S01E02.720p', episode), 'episode');
  assert.equal(names.matches('Breaking.Bad.S01.1080p', episode), 'pack');
  assert.equal(names.matches('Breaking.Brad.S01E02', episode), null);
  var show = { kind: 'show', tmdbId: 1396, title: 'Breaking Bad' };
  assert.equal(names.matches('Breaking Bad S03E04 1080p', show), 'episode');
  assert.equal(names.matches('Breaking Bad S03 1080p', show), 'pack');
  assert.equal(names.matches('Breaking Badly S03E04', show), null);
  var movie = { kind: 'movie', tmdbId: 949, title: 'Heat', year: 1995 };
  assert.equal(names.matches('Heat.1995.1080p.BluRay', movie), 'movie');
  assert.equal(names.matches('Heat.1996.1080p.BluRay', movie), 'movie');
  assert.equal(names.matches('Heat.2019.1080p', movie), null);
  assert.equal(names.matches('Heat.Wave.1995.1080p', movie), null);
  assert.equal(names.matches('Heat 1995 S01E01', movie), null);
  assert.equal(names.matches('Heat 1995', { kind: 'video' }), null);
  assert.equal(names.matches('Heat 1995', null), null);
});

test('rank: the streaming order', function () {
  var ranked = names.rank([
    { name: 'A 2160p HEVC', seeds: 500 },
    { name: 'B 1080p x264 DDP5.1', seeds: 900 },
    { name: 'C 1080p x264 AAC', seeds: 20 },
    { name: 'D 720p x264 AAC', seeds: 30 },
    { name: 'E 1080p x264 AAC', seeds: 3 },
    { name: 'F S01 1080p x264 AAC', seeds: 300 },
    { name: 'G 1080p x264 AAC', seeds: 25, extra: 'kept' }
  ]).map(function (t) { return t.name; });
  assert.deepEqual(ranked, ['G 1080p x264 AAC', 'C 1080p x264 AAC', 'D 720p x264 AAC', 'F S01 1080p x264 AAC',
    'E 1080p x264 AAC', 'B 1080p x264 DDP5.1', 'A 2160p HEVC']);
  // an explicit pack flag wins over the name
  assert.deepEqual(names.rank([{ name: 'X 1080p AAC', seeds: 50, pack: true }, { name: 'Y 720p AAC', seeds: 50 }])
    .map(function (t) { return t.name; }), ['Y 720p AAC', 'X 1080p AAC']);
});

test('release: release lists keep their reading', function () {
  assert.deepEqual(names.release('Lioness 2023 S03E01 1080p WEB h264-ETHEL EZTV', 'tv'),
    { title: 'Lioness', year: 2023, season: 3, episode: 1, pack: false });
  assert.deepEqual(names.release('Blade Runner 2049 2017 1080p', 'movie'), { title: 'Blade Runner 2049', year: 2017 });
});

test('searchWords / searchMatches: keywords however a name spells them', function () {
  assert.equal(names.searchWords(' Breaking.Bad_S01 & Grey\'s '), 'Breaking Bad S01 and Greys');
  [
    ['Breaking.Bad.S01E01.720p', 'breaking bad', true],
    ['Breaking Bad S01E01', 'breaking.bad', true],
    ['Breaking.Bad.S01E01', 'breakingbad', true],
    ['Breaking.Brad.S01', 'breaking bad', false],
    ['Spider-Man.No.Way.Home.2021.1080p', 'spiderman', true],
    ['Spiderman.2002.720p', 'spider man', true],
    ['Spiderman.2002', 'spider-man 2002', true],
    ['Greys.Anatomy.S19E01', 'grey\'s anatomy', true],
    ['Breaking.Bad.S01E05.1080p', 'breaking bad s01', true],
    ['Breaking.Bad.S01E05', 'breaking bad s02', false],
    ['Big.Trouble.in.Little.China.1986', 'big buck bunny', false],
    ['Big.Buck.Bunny.1080p', 'big buck bunny 1080p', true],
    ['The.Office.US.S01', 'office', true],
    ['Officer.Down.2013', 'office', false],
    ['Amélie.2001', 'amelie', true],
    ['Law.&.Order.S01', 'law and order', true],
    ['It.2017', 'it', true],
    ['Kites.2010', 'it', false],
    ['Anything at all', '', true]
  ].forEach(function (c) {
    assert.equal(names.searchMatches(c[0], c[1]), c[2], c[0] + ' / ' + c[1]);
  });
});
