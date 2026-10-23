'use strict';

// The library as clients browse it (lib/library/view.js, media-server plan
// step 7), on fake services: one entry per title, a show's episodes and
// seasons, the episode added last, other videos by folder. The routes (and
// the kids rule against the database) are in the contract test.

var test = require('node:test'),
  assert = require('node:assert/strict'),
  view = require('../lib/library/view');

var SHOWS = { id: 'a', path: '/media/Shows', kind: 'shows', audience: 'everyone', builtin: false },
  CLIPS = { id: 'b', path: '/media/Clips', kind: 'other', audience: 'everyone', builtin: false },
  DOWNLOADS = { id: 'c', path: '/cache/torrent_data', kind: 'mixed', audience: 'everyone', builtin: true };

function episode(id, season, number, day, extra) {
  return Object.assign({
    id: id, folderId: 'a', relPath: 'Show/S0' + season + 'E0' + number + '.mkv', size: 10, state: 'ok',
    addedAt: new Date(Date.UTC(2026, 9, day)), probe: { width: 1920, duration: 2700 }, parse: null,
    item: { kind: 'episode', tmdbId: 100 + number, showTmdbId: 1396, season: season, episode: number, imdbId: 'tt0903747',
      title: 'Breaking Bad', episodeTitle: 'Ep ' + number, year: 2008, artwork: { posterPath: '/bb.jpg', backdropPath: null } },
    folder: SHOWS
  }, extra);
}

var FILES = [
  episode('1', 1, 1, 1),
  episode('2', 1, 2, 5),
  episode('3', 2, 1, 3),
  episode('4', 1, 2, 2, { probe: { width: 3840 } }),     // a second file of S01E02 (4K)
  { id: '5', folderId: 'b', relPath: 'Trip/2019/beach.mp4', size: 5, state: 'ok', addedAt: new Date(), probe: null, parse: null,
    item: { kind: 'movie', tmdbId: 9, title: 'Beach' }, folder: CLIPS },
  { id: '6', folderId: 'c', relPath: 'Some.Thing.mkv', size: 5, state: 'unmatched', addedAt: new Date(), probe: null,
    parse: { resolution: '720p' }, item: null, folder: DOWNLOADS }
];

var services = {
  library: {
    shown: function (options) {
      return Promise.resolve(FILES.filter(function (f) { return !options.folderId || f.folderId === options.folderId; }));
    },
    folders: function () { return Promise.resolve([SHOWS, CLIPS, DOWNLOADS]); },
    folder: function (id) { return Promise.resolve([SHOWS, CLIPS, DOWNLOADS].filter(function (f) { return f.id === id; })[0] || null); }
  }
};

test('home: a show is one entry (episodes, seasons, the one added last); other videos by folder', function () {
  return view.home(services, { kid: false }).then(function (home) {
    assert.equal(home.movies.length, 0, 'a file of an other folder is an other video, matched or not');
    var show = home.shows[0];
    assert.deepEqual([show.tmdbId, show.fileCount, show.episodeCount, show.seasonCount, show.quality],
      [1396, 4, 3, 2, '2160p']);
    assert.deepEqual(show.latest, { season: 1, episode: 2, episodeTitle: 'Ep 2' });
    assert.equal(show.addedAt, '2026-10-05T00:00:00.000Z');
    assert.deepEqual(home.recent.map(function (t) { return t.tmdbId; }), [1396]);
    assert.deepEqual(home.other, { count: 2, folders: [{ id: 'b', name: 'Clips', count: 1 }, { id: 'c', name: 'Downloads', count: 1 }] });
  });
});

test('folder: one level at a time, parent paths, paths that leave the folder refused', function () {
  return view.folder(services, 'b', '', { kid: false }).then(function (root) {
    assert.deepEqual(root.folders, [{ name: 'Trip', path: 'Trip', count: 1 }]);
    assert.equal(root.parent, null);
    return view.folder(services, 'b', 'Trip/2019/', { kid: false });
  }).then(function (level) {
    assert.equal(level.path, 'Trip/2019');
    assert.equal(level.parent, 'Trip');
    assert.deepEqual(level.videos.map(function (v) { return [v.name, v.ref]; }), [['beach.mp4', 'f_5']]);
    return assert.rejects(view.folder(services, 'b', 'Trip/../..', { kid: false }), /Not a path/);
  });
});
