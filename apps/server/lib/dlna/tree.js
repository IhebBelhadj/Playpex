'use strict';

// The DLNA ContentDirectory tree (docs/media-server-plan.md §7): what TVs
// browse, built from the library's rows. Only files of folders marked
// "include in DLNA" whose audience is `everyone` (never an adults-only
// folder), in state ok / unmatched.
//
//   0                                   root
//   ├─ movies                           matched movies, A–Z
//   ├─ shows → shows/<tmdbId> → shows/<tmdbId>/<season>    episodes in order
//   ├─ recent                           the 50 files added last
//   └─ folders → folders/<folderId> → folders/<folderId>/<base64url dir> …   as on disk
//
// Item ids are `<container id>|<file id>`: one file shows in several
// containers (a movie under Movies, Recently added and its folder), each
// with its own parent. Objects here are abstract: lib/dlna/http.js turns a
// file into its <res> URL and artwork paths into URLs.

var path = require('path'),
  view = require('../library/view');

var RECENT = 50;

function byName(a, b) {
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
}

function stem(relPath) {
  return path.posix.basename(relPath).replace(/\.[^.]+$/, '');
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function episodeCode(item) {
  return 'S' + pad(item.season) + 'E' + pad(item.episode);
}

function encodeDir(dir) {
  return Buffer.from(dir, 'utf8').toString('base64url');
}

function decodeDir(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  var dir = Buffer.from(text, 'base64url').toString('utf8');
  return encodeDir(dir) === text ? dir : null;
}

/**
 * @param {Array} files   services.library.shown({ kid: true }) (audience everyone)
 * @param {Array} folders services.library.folders()
 */
function build(files, folders) {
  var shownFolders = folders.filter(function (f) {
      return f.dlna && f.audience === 'everyone';
    }),
    allowed = {};
  shownFolders.forEach(function (f) { allowed[f.id] = f; });
  files = files.filter(function (f) {
    return allowed[f.folderId] && f.folder && f.folder.dlna;
  });

  var byId = {},
    movies = [],
    shows = {},
    movieCount = {};
  files.forEach(function (file) {
    byId[file.id] = file;
    if (view.isOther(file)) {
      return;
    }
    var item = file.item;
    if (item.kind === 'movie' && item.tmdbId) {
      movies.push(file);
      movieCount[item.tmdbId] = (movieCount[item.tmdbId] || 0) + 1;
    } else if (item.kind === 'episode' && item.showTmdbId) {
      var show = shows[item.showTmdbId] = shows[item.showTmdbId] || {
        tmdbId: item.showTmdbId,
        title: item.title || stem(file.relPath),
        year: item.year || null,
        poster: item.artwork && item.artwork.posterPath || null,
        seasons: {}
      };
      (show.seasons[item.season] = show.seasons[item.season] || []).push(file);
    }
  });

  return {
    files: byId,
    movies: movies,
    movieCount: movieCount,
    shows: shows,
    recent: files.slice().sort(function (a, b) {
      return new Date(b.addedAt) - new Date(a.addedAt);
    }).slice(0, RECENT),
    folders: shownFolders,
    count: files.length
  };
}

function quality(file) {
  var w = file.probe && file.probe.width;
  return w >= 3200 ? '2160p' : w >= 1800 ? '1080p' : w >= 1200 ? '720p' :
    file.parse && file.parse.resolution || null;
}

function movieTitle(snapshot, file) {
  var item = file.item,
    title = (item.title || stem(file.relPath)) + (item.year ? ' (' + item.year + ')' : '');
  // two files of one movie (1080p + 4K): tell them apart
  if (snapshot.movieCount[item.tmdbId] > 1) {
    title += ' - ' + (quality(file) || stem(file.relPath));
  }
  return title;
}

function episodeTitle(file) {
  return episodeCode(file.item) + (file.item.episodeTitle ? ' - ' + file.item.episodeTitle : '');
}

// A file as an item of `parentId`; `naming`: how it is called there
function item(snapshot, parentId, file, naming) {
  var it = file.item && !view.isOther(file) ? file.item : null,
    artwork = it && it.artwork || {},
    title;
  if (naming === 'file' || !it) {
    title = stem(file.relPath);
  } else if (it.kind === 'movie') {
    title = movieTitle(snapshot, file);
  } else if (naming === 'episode') {
    title = episodeTitle(file);
  } else {
    title = (it.title || '') + ' - ' + episodeTitle(file);
  }
  return {
    id: parentId + '|' + file.id,
    parentId: parentId,
    title: title,
    upnpClass: it && it.kind === 'movie' ? 'object.item.videoItem.movie' : 'object.item.videoItem',
    date: it && it.year ? it.year + '-01-01' : null,
    season: it && it.kind === 'episode' ? it.season : null,
    episode: it && it.kind === 'episode' ? it.episode : null,
    art: artwork.stillPath && it.kind === 'episode' ? artwork.stillPath : artwork.posterPath || null,
    file: file
  };
}

function container(id, parentId, title, childCount, art) {
  return { container: true, id: id, parentId: parentId, title: title, childCount: childCount, art: art || null };
}

function seasonTitle(season) {
  return Number(season) === 0 ? 'Specials' : 'Season ' + season;
}

// The subfolders and files of one level of a folder: { dirs: [name], files: [file] }
function level(snapshot, folderId, dir) {
  var prefix = dir ? dir + '/' : '',
    dirs = {},
    files = [];
  Object.keys(snapshot.files).forEach(function (id) {
    var file = snapshot.files[id];
    if (file.folderId !== folderId || (prefix && file.relPath.indexOf(prefix) !== 0)) {
      return;
    }
    var rest = file.relPath.slice(prefix.length),
      slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(file);
    } else {
      dirs[rest.slice(0, slash)] = (dirs[rest.slice(0, slash)] || 0) + 1;
    }
  });
  return { dirs: dirs, files: files };
}

function folderTitle(folder) {
  return folder.builtin ? 'Downloads' : path.basename(folder.path) || folder.path;
}

/**
 * The container `id`: { self (its own object), children() }, or null when
 * there is no such container.
 */
function find(snapshot, id) {
  var m;
  if (id === '0') {
    return {
      self: { container: true, id: '0', parentId: '-1', title: 'root', childCount: 4 },
      children: function () {
        return [
          container('movies', '0', 'Movies', snapshot.movies.length),
          container('shows', '0', 'TV shows', Object.keys(snapshot.shows).length),
          container('recent', '0', 'Recently added', snapshot.recent.length),
          container('folders', '0', 'Folders', snapshot.folders.length)
        ];
      }
    };
  }
  if (id === 'movies') {
    return {
      self: container('movies', '0', 'Movies', snapshot.movies.length),
      children: function () {
        return snapshot.movies.map(function (f) { return item(snapshot, 'movies', f, 'title'); }).sort(byName);
      }
    };
  }
  if (id === 'recent') {
    return {
      self: container('recent', '0', 'Recently added', snapshot.recent.length),
      children: function () {
        return snapshot.recent.map(function (f) { return item(snapshot, 'recent', f, 'title'); });
      }
    };
  }
  if (id === 'shows') {
    return {
      self: container('shows', '0', 'TV shows', Object.keys(snapshot.shows).length),
      children: function () {
        return Object.keys(snapshot.shows).map(function (key) {
          var show = snapshot.shows[key];
          return container('shows/' + key, 'shows', show.title + (show.year ? ' (' + show.year + ')' : ''),
            Object.keys(show.seasons).length, show.poster);
        }).sort(byName);
      }
    };
  }
  if ((m = /^shows\/(\d+)$/.exec(id)) && snapshot.shows[m[1]]) {
    var show = snapshot.shows[m[1]];
    return {
      self: container(id, 'shows', show.title + (show.year ? ' (' + show.year + ')' : ''), Object.keys(show.seasons).length, show.poster),
      children: function () {
        return Object.keys(show.seasons).sort(function (a, b) { return a - b; }).map(function (season) {
          return container(id + '/' + season, id, seasonTitle(season), show.seasons[season].length, show.poster);
        });
      }
    };
  }
  if ((m = /^shows\/(\d+)\/(\d+)$/.exec(id)) && snapshot.shows[m[1]] && snapshot.shows[m[1]].seasons[m[2]]) {
    var parent = snapshot.shows[m[1]], episodes = parent.seasons[m[2]];
    return {
      self: container(id, 'shows/' + m[1], seasonTitle(m[2]), episodes.length, parent.poster),
      children: function () {
        return episodes.slice().sort(function (a, b) {
          return a.item.episode - b.item.episode || a.relPath.localeCompare(b.relPath);
        }).map(function (f) { return item(snapshot, id, f, 'episode'); });
      }
    };
  }
  if (id === 'folders') {
    return {
      self: container('folders', '0', 'Folders', snapshot.folders.length),
      children: function () {
        return snapshot.folders.map(function (folder) {
          var here = level(snapshot, folder.id, '');
          return container('folders/' + folder.id, 'folders', folderTitle(folder),
            Object.keys(here.dirs).length + here.files.length);
        }).sort(byName);
      }
    };
  }
  if ((m = /^folders\/([^/|]+)(?:\/([^/|]*))?$/.exec(id))) {
    var folder = snapshot.folders.filter(function (f) { return f.id === m[1]; })[0],
      dir = m[2] === undefined ? '' : decodeDir(m[2]);
    if (!folder || dir === null || (m[2] !== undefined && !dir)) {
      return null;
    }
    var here = level(snapshot, folder.id, dir);
    if (dir && !here.files.length && !Object.keys(here.dirs).length) {
      return null;
    }
    var slash = dir.lastIndexOf('/'),
      parentId = !dir ? 'folders' : slash === -1 ? 'folders/' + folder.id : 'folders/' + folder.id + '/' + encodeDir(dir.slice(0, slash));
    return {
      self: container(id, parentId, dir ? path.posix.basename(dir) : folderTitle(folder),
        Object.keys(here.dirs).length + here.files.length),
      children: function () {
        var dirs = Object.keys(here.dirs).map(function (name) {
          var sub = (dir ? dir + '/' : '') + name;
          return container('folders/' + folder.id + '/' + encodeDir(sub), id, name, null);
        }).sort(byName);
        return dirs.concat(here.files.map(function (f) { return item(snapshot, id, f, 'file'); }).sort(byName));
      }
    };
  }
  return null;
}

/**
 * Browse: the object itself (`BrowseMetadata`) or a page of a container's
 * children (`BrowseDirectChildren`; count 0 = all). Null for an unknown
 * object (UPnP error 701).
 * @returns {{ objects: object[], total: number }|null}
 */
function browse(snapshot, id, flag, start, count) {
  var bar = String(id).lastIndexOf('|');
  if (bar !== -1) {
    // an item: only its own metadata
    var parent = find(snapshot, id.slice(0, bar)),
      found = parent && parent.children().filter(function (o) { return o.id === id; })[0];
    if (!found) {
      return null;
    }
    return flag === 'BrowseMetadata' ? { objects: [found], total: 1 } : { objects: [], total: 0 };
  }
  var c = find(snapshot, String(id));
  if (!c) {
    return null;
  }
  if (flag === 'BrowseMetadata') {
    var self = c.self;
    if (self.childCount === null) {
      self.childCount = c.children().length;
    }
    return { objects: [self], total: 1 };
  }
  var all = c.children();
  all.forEach(function (o) {
    if (o.container && o.childCount === null) {
      o.childCount = find(snapshot, o.id).children().length;
    }
  });
  return { objects: count > 0 ? all.slice(start, start + count) : all.slice(start), total: all.length };
}

module.exports = {
  build: build,
  browse: browse,
  // tests
  encodeDir: encodeDir
};
