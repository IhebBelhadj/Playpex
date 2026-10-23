'use strict';

// The library as clients browse it (docs/media-server-plan.md §5.5, step 7):
// what is on this server for one profile (a kids profile never sees files of
// adults-only folders). Answers of GET /library/home, /library/titles/…,
// /library/folders/… (lib/routes/library.js):
//   home     movies and shows on this server (one entry per title), the
//            titles added last, the folders holding "other videos"
//   title    whether a movie / which episodes of a show are on this server
//   folder   one level of a folder's other videos: subfolders and files
// Other videos = files not matched to a title, and every file of an `other`
// folder. Files in state ok / unmatched only (missing / ignored never show).

var path = require('path'),
  refs = require('../media/refs'),
  qualityOf = require('../play/handlers').qualityOf,
  invalid = require('../services/errors').invalid,
  notFound = require('../services/errors').notFound;

var RECENT = 20,
  QUALITY_RANK = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };

function isOther(file) {
  return file.state === 'unmatched' || !file.item || file.folder.kind === 'other';
}

function folderName(folder) {
  return folder.builtin ? 'Downloads' : path.basename(folder.path) || folder.path;
}

function quality(file) {
  return qualityOf(file.probe && file.probe.width, file.parse && file.parse.resolution);
}

function better(a, b) {
  return (QUALITY_RANK[b] || 0) > (QUALITY_RANK[a] || 0) ? b : a;
}

function iso(date) {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

// natural order: "Episode 2" before "Episode 10"
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function byTitle(a, b) {
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.year || 0) - (b.year || 0);
}

// One entry per movie / show, from its files
function titles(files) {
  var found = {};
  files.forEach(function (file) {
    if (isOther(file)) {
      return;
    }
    var item = file.item,
      movie = item.kind === 'movie',
      tmdbId = movie ? item.tmdbId : item.showTmdbId,
      key = (movie ? 'movie:' : 'tv:') + tmdbId,
      artwork = item.artwork || {},
      entry = found[key];
    if (!tmdbId) {
      return;
    }
    if (!entry) {
      entry = found[key] = {
        mediaType: movie ? 'movie' : 'tv',
        tmdbId: tmdbId,
        imdbId: item.imdbId || null,
        title: item.title || path.basename(file.relPath),
        year: item.year || null,
        posterPath: artwork.posterPath || null,
        backdropPath: artwork.backdropPath || null,
        addedAt: file.addedAt,
        fileCount: 0,
        quality: null,
        episodeCount: movie ? null : 0,
        seasonCount: movie ? null : 0,
        latest: null,
        episodes: movie ? null : {},
        seasons: movie ? null : {}
      };
    }
    entry.fileCount++;
    entry.quality = better(entry.quality, quality(file));
    if (!movie) {
      entry.episodes[item.season + 'x' + item.episode] = true;
      entry.seasons[item.season] = true;
    }
    if (file.addedAt >= entry.addedAt) {
      entry.addedAt = file.addedAt;
      if (!movie) {
        entry.latest = { season: item.season, episode: item.episode, episodeTitle: item.episodeTitle || null };
      }
    }
  });
  return Object.keys(found).map(function (key) {
    var entry = found[key];
    if (entry.episodes) {
      entry.episodeCount = Object.keys(entry.episodes).length;
      entry.seasonCount = Object.keys(entry.seasons).length;
    }
    delete entry.episodes;
    delete entry.seasons;
    entry.addedAt = iso(entry.addedAt);
    return entry;
  });
}

/**
 * @returns {Promise<{ movies: object[], shows: object[], recent: object[], other: { count: number, folders: object[] } }>}
 */
function home(services, options) {
  return Promise.all([services.library.shown({ kid: options.kid }), services.library.folders()]).then(function (r) {
    var files = r[0],
      all = titles(files),
      folders = {};
    files.filter(isOther).forEach(function (file) {
      folders[file.folderId] = (folders[file.folderId] || 0) + 1;
    });
    var other = r[1].filter(function (folder) {
      return folders[folder.id];
    }).map(function (folder) {
      return { id: folder.id, name: folderName(folder), count: folders[folder.id] };
    }).sort(byName);
    return {
      movies: all.filter(function (t) { return t.mediaType === 'movie'; }).sort(byTitle),
      shows: all.filter(function (t) { return t.mediaType === 'tv'; }).sort(byTitle),
      recent: all.slice().sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0; }).slice(0, RECENT),
      other: {
        count: other.reduce(function (sum, f) { return sum + f.count; }, 0),
        folders: other
      }
    };
  });
}

/**
 * Whether a title is on this server: its files, and for a show which episodes
 * @returns {Promise<{ mediaType: string, tmdbId: number, fileCount: number, episodes: Array<{ season: number, episode: number, fileCount: number }> }>}
 */
function title(services, mediaType, tmdbId, options) {
  tmdbId = Number(tmdbId);
  return services.library.titleFiles(mediaType, tmdbId, { kid: options.kid }).then(function (files) {
    var episodes = {};
    if (mediaType === 'tv') {
      files.forEach(function (f) {
        var key = f.season + 'x' + f.episode;
        episodes[key] = episodes[key] || { season: f.season, episode: f.episode, fileCount: 0 };
        episodes[key].fileCount++;
      });
    }
    return {
      mediaType: mediaType,
      tmdbId: tmdbId,
      fileCount: files.length,
      episodes: Object.keys(episodes).map(function (k) { return episodes[k]; })
        .sort(function (a, b) { return a.season - b.season || a.episode - b.episode; })
    };
  });
}

// '' (the folder itself) or a path inside it: '/' separated, never leaving it
function checkDir(dir) {
  if (dir === '') {
    return;
  }
  if (dir.length > 4096 || dir.indexOf('\0') !== -1 || dir.indexOf('\\') !== -1 ||
    dir.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
    throw invalid('Not a path inside the folder: ' + dir);
  }
}

/**
 * One level of a folder's other videos: the subfolders holding some (with how
 * many, at any depth) and the videos right in it, by name. 404 for a folder
 * this profile doesn't see.
 */
function folder(services, folderId, dir, options) {
  return Promise.resolve().then(function () {
    dir = typeof dir === 'string' ? dir.replace(/^\/+|\/+$/g, '') : '';
    checkDir(dir);
    return services.library.folder(folderId);
  }).then(function (found) {
    if (!found || (options.kid && found.audience === 'adults')) {
      throw notFound('No such folder');
    }
    return services.library.shown({ kid: options.kid, folderId: found.id }).then(function (files) {
      var prefix = dir ? dir + '/' : '',
        subfolders = {},
        videos = [];
      files.filter(isOther).forEach(function (file) {
        if (prefix && file.relPath.indexOf(prefix) !== 0) {
          return;
        }
        var rest = file.relPath.slice(prefix.length),
          slash = rest.indexOf('/');
        if (slash !== -1) {
          var name = rest.slice(0, slash);
          subfolders[name] = subfolders[name] || { name: name, path: prefix + name, count: 0 };
          subfolders[name].count++;
          return;
        }
        videos.push({
          id: file.id,
          ref: refs.file(file.id),
          name: rest,
          size: file.size,
          duration: file.probe && file.probe.duration || null,
          quality: quality(file),
          addedAt: iso(file.addedAt)
        });
      });
      if (dir && !videos.length && !Object.keys(subfolders).length) {
        throw notFound('No videos in ' + dir);
      }
      return {
        folder: { id: found.id, name: folderName(found) },
        path: dir,
        parent: dir ? (dir.lastIndexOf('/') === -1 ? '' : dir.slice(0, dir.lastIndexOf('/'))) : null,
        folders: Object.keys(subfolders).map(function (k) { return subfolders[k]; }).sort(byName),
        videos: videos.sort(byName)
      };
    });
  });
}

module.exports = {
  home: home,
  title: title,
  folder: folder,
  // tests
  isOther: isOther
};
