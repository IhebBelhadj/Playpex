'use strict';

// The Storage page as a file browser (docs/dashboard-plan.md §6, step 6):
// every place Playpex keeps media (the library's folders, and the download
// folder when no library folder is it), one level at a time, with what each
// file is to Playpex (its library row and match, the download writing it,
// subtitles), and deleting with the torrent client's rules.
//
//   places()                       → { places: [{ id, name, kind, root, bytes, measuring, disk, status }] }
//   browse({ place, path, sort, q }) → { place, path, parent, entries, total, measuring }
//   remove({ place, path })        → { ok, freedBytes }   CONFLICT while a running torrent writes there
//   largest(placeId)               → { folders: [{ path, bytes }] }   the 10 biggest title folders
//   subtitle({ place, path })      → WebVTT text of a subtitle file there (the player adds it)
//
// Sizes never walk the disk in a request: a place is measured in the
// background (allocated blocks: torrent files are sparse), kept 10 minutes,
// measured again after a library scan or a download's change; until then a
// folder's size is null ("Measuring…").

var fs = require('fs'),
  path = require('path'),
  torrents = require('./torrents/client'),
  refs = require('./media/refs'),
  system = require('./system'),
  events = require('./events'),
  userData = require('./userData'),
  log = require('./logger').child('library');

var STALE_MS = 10 * 60 * 1000,
  SEARCH_LIMIT = 200,
  SEARCH_ENTRIES = 50000,
  VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg|flv|ogv)$/i,
  SUBTITLE = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i;

var indexes = {};   // root → { at, measuring (Promise|null), dirs: Map(rel → { bytes, files, folders, own }) }

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// ── sizes ──────────────────────────────────────────────────────────────────

function onDisk(st) {
  return st.blocks !== undefined ? st.blocks * 512 : st.size;
}

// One walk of `root`: each directory's total (and the bytes of its own files),
// one directory at a time (no burst of open files on a big library)
function measure(root) {
  var dirs = new Map(), started = Date.now();
  function walk(rel) {
    var full = path.join(root, rel), entry = { bytes: 0, files: 0, folders: 0, own: 0 };
    dirs.set(rel, entry);
    return fs.promises.readdir(full, { withFileTypes: true }).catch(function () { return []; }).then(function (list) {
      return list.filter(function (d) { return d.name[0] !== '.'; }).reduce(function (chain, d) {
        return chain.then(function () {
          var child = rel ? rel + '/' + d.name : d.name;
          if (d.isDirectory()) {
            entry.folders++;
            return walk(child).then(function (sub) { entry.bytes += sub.bytes; });
          }
          entry.files++;
          return fs.promises.stat(path.join(full, d.name)).then(function (st) {
            entry.bytes += onDisk(st);
            entry.own += onDisk(st);
          }, function () {});
        });
      }, Promise.resolve());
    }).then(function () { return entry; });
  }
  return walk('').then(function () {
    log.debug('measured ' + root + ' in ' + (Date.now() - started) + ' ms (' + dirs.size + ' folders)');
    return dirs;
  });
}

// The place's index, measuring it in the background when missing or stale
function index(root) {
  var ix = indexes[root] || (indexes[root] = { at: 0, measuring: null, dirs: null });
  if (!ix.measuring && Date.now() - ix.at > STALE_MS) {
    ix.measuring = measure(root).then(function (dirs) {
      ix.dirs = dirs;
      ix.at = Date.now();
    }, function (err) {
      log.warn('cannot measure ' + root + ': ' + err.message);
    }).then(function () {
      ix.measuring = null;
    });
  }
  return ix;
}

function stale(root) {
  Object.keys(indexes).forEach(function (r) {
    if (!root || r === root) {
      indexes[r].at = 0;
    }
  });
}

// downloads that finished or went, library scans: sizes changed
events.onPublish(function (topic, data) {
  if (topic === 'download.removed' || (topic === 'download.updated' && data && /^(seeding|completed)$/.test(data.state)) ||
    (topic === 'library.scan' && data && data.state === 'done') || topic === 'library.changed') {
    stale();
  }
});

// ── places ─────────────────────────────────────────────────────────────────

function realpath(p) {
  return fs.promises.realpath(p).catch(function () { return null; });
}

function placeList() {
  var downloadDir = path.resolve(system.downloadDir());
  // the download folder is made with the first download: never "offline" before it
  return fs.promises.mkdir(downloadDir, { recursive: true }).catch(function () {}).then(function () {
    return userData.services();
  }).then(function (s) {
    return s.library.folders();
  }).then(function (folders) {
    return Promise.all(folders.map(function (f) { return realpath(f.path); })).then(function (reals) {
      var list = folders.map(function (f, i) {
        return {
          id: 'folder:' + f.id,
          folderId: f.id,
          name: f.builtin ? 'Downloads' : path.basename(f.path) || f.path,
          kind: f.builtin ? 'downloads' : f.kind,
          root: reals[i] || f.path,
          online: !!reals[i],
          builtin: !!f.builtin
        };
      });
      return realpath(downloadDir).then(function (realDownloads) {
        var covered = list.some(function (p) { return p.root === (realDownloads || downloadDir); });
        if (!covered) {
          list.unshift({ id: 'downloads', folderId: null, name: 'Downloads', kind: 'downloads', root: realDownloads || downloadDir,
            online: !!realDownloads, builtin: true });
        }
        // the download folder first, then the library's by name
        return list.sort(function (a, b) {
          return (b.kind === 'downloads') - (a.kind === 'downloads') || a.name.localeCompare(b.name);
        });
      });
    });
  });
}

function places() {
  return placeList().then(function (list) {
    return Promise.all(list.map(function (p) {
      var ix = p.online ? index(p.root) : null, top = ix && ix.dirs && ix.dirs.get('');
      return system.disk(p.root).then(function (d) {
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          root: p.root,
          bytes: top ? top.bytes : null,
          measuring: !!(ix && !ix.dirs),
          disk: d ? { free: d.free, total: d.total } : null,
          status: p.online ? 'online' : 'offline'
        };
      });
    }));
  }).then(function (list) {
    return { places: list };
  });
}

function findPlace(id) {
  return placeList().then(function (list) {
    var p = list.filter(function (x) { return x.id === id; })[0];
    if (!p) {
      throw failure('NOT_FOUND', 'No such place');
    }
    if (!p.online) {
      throw failure('CONFLICT', p.name + ' is offline: ' + p.root + ' isn\'t there');
    }
    return p;
  });
}

// `rel` ('a/b', '' = the root) inside the place, as a real path that stays inside it
function inside(place, rel) {
  rel = typeof rel === 'string' ? rel.replace(/^\/+|\/+$/g, '') : '';
  if (rel.split('/').some(function (part) { return part === '..' || part === '.'; }) || /\\/.test(rel) || /\0/.test(rel)) {
    return Promise.reject(failure('INVALID', 'Not a path inside this place'));
  }
  var full = path.join(place.root, rel);
  return fs.promises.realpath(full).then(function (real) {
    if (real !== place.root && real.indexOf(place.root + path.sep) !== 0) {
      throw failure('NOT_FOUND', 'Not inside this place');
    }
    return { rel: rel, full: full };
  }, function () {
    throw failure('NOT_FOUND', 'No such file or folder');
  });
}

// ── what a file is ─────────────────────────────────────────────────────────

function itemTitle(item) {
  if (!item) {
    return null;
  }
  if (item.kind === 'episode') {
    var code = 'S' + String(item.season).padStart(2, '0') + 'E' + String(item.episode).padStart(2, '0');
    return (item.title ? item.title + ' · ' : '') + code;
  }
  return (item.title || 'Movie') + (item.year ? ' (' + item.year + ')' : '');
}

// The library's rows of a place's folder, each with its item: { rows: Map(relPath → { row, item }) }
// (two queries for the whole folder, read once per listing or search)
function libraryOf(place, s) {
  if (!place.folderId) {
    return Promise.resolve({ rows: new Map() });
  }
  return Promise.all([s.library.files(place.folderId), s.library.shown({ folderId: place.folderId })]).then(function (r) {
    var items = new Map(), rows = new Map();
    r[1].forEach(function (f) { items.set(f.id, f.item); });
    r[0].forEach(function (row) { rows.set(row.relPath, { row: row, item: items.get(row.id) || null }); });
    return { rows: rows };
  });
}

// The rows of the files directly in `rel`, by name
function libraryRows(lib, rel) {
  var out = {};
  lib.rows.forEach(function (entry, relPath) {
    var slash = relPath.lastIndexOf('/');
    if ((slash === -1 ? '' : relPath.slice(0, slash)) === rel) {
      out[relPath.slice(slash + 1)] = entry;
    }
  });
  return out;
}

function quality(row) {
  var p = row.probe;
  if (!p || !p.height) {
    return (row.parse && row.parse.resolution) || null;
  }
  return p.height >= 2000 ? '2160p' : p.height >= 1000 ? '1080p' : p.height >= 700 ? '720p' : p.height + 'p';
}

// What a matched file is, for the dashboard: its title, its episode, its artwork
function mediaOf(item) {
  if (!item) {
    return null;
  }
  var art = item.artwork || {};
  return {
    mediaType: item.kind === 'episode' ? 'tv' : 'movie',
    tmdbId: item.kind === 'episode' ? item.showTmdbId : item.tmdbId,
    title: item.title || null,
    year: item.year || null,
    season: item.kind === 'episode' ? item.season : null,
    episode: item.kind === 'episode' ? item.episode : null,
    episodeTitle: item.kind === 'episode' ? item.episodeTitle || null : null,
    posterPath: art.posterPath || null,
    stillPath: art.stillPath || null
  };
}

// A folder's titles: the matched files under it; one title → its media (a
// movie's folder, a show's or a season's), else only how many
function folderTitles(lib, rel) {
  var titles = new Map(), episodes = 0, prefix = rel + '/';
  lib.rows.forEach(function (entry, relPath) {
    if (relPath.indexOf(prefix) !== 0 || !entry.item || entry.row.state === 'missing' || entry.row.state === 'ignored') {
      return;
    }
    var m = mediaOf(entry.item), key = m.mediaType + ':' + m.tmdbId;
    if (m.mediaType === 'tv') {
      episodes++;
    }
    if (!titles.has(key)) {
      titles.set(key, Object.assign({}, m, { season: null, episode: null, episodeTitle: null, stillPath: null }));
    }
  });
  return {
    titles: titles.size || null,
    media: titles.size === 1 ? Object.assign(titles.values().next().value, { episodes: episodes || null }) : null
  };
}

// The download writing `rel` of the download folder (its top-level entry)
function downloadOf(place, rel) {
  var downloadDir = path.resolve(system.downloadDir());
  if (place.root !== downloadDir && place.root !== safeReal(downloadDir)) {
    return null;
  }
  var top = rel.split('/')[0], owner = top ? torrents.owners(system.downloadDir())[top] : null;
  if (!owner) {
    return null;
  }
  var d = torrents.get(owner.infoHash);
  return d ? { infoHash: owner.infoHash, name: owner.name, active: owner.active, state: d.state, progress: d.progress } : null;
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return p;
  }
}

function describe(name, lib, download) {
  if (lib) {
    var r = lib.row;
    if (r.state === 'ignored') {
      return { kind: 'ignored', text: 'Ignored' };
    }
    if (r.state === 'missing') {
      return { kind: 'missing', text: 'Missing' };
    }
    if (lib.item) {
      return { kind: 'matched', text: itemTitle(lib.item) };
    }
    return { kind: 'unmatched', text: 'Not matched' };
  }
  if (download && download.progress !== null && download.progress < 1) {
    return { kind: 'downloading', text: 'Download in progress ' + Math.floor(download.progress * 100) + ' %' };
  }
  if (SUBTITLE.test(name)) {
    return { kind: 'subtitles', text: 'Subtitles' };
  }
  if (VIDEO.test(name)) {
    return { kind: 'video', text: download ? 'A download (not in the library)' : 'Not scanned yet' };
  }
  return { kind: 'other', text: 'Not a video' };
}

// ── browse ─────────────────────────────────────────────────────────────────

function sorter(sort) {
  var by = {
    name: function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); },
    size: function (a, b) { return (b.bytes || 0) - (a.bytes || 0); },
    date: function (a, b) { return (b.modifiedAt || '').localeCompare(a.modifiedAt || ''); }
  }[sort] || null;
  return function (a, b) {
    // folders first
    return (b.type === 'folder') - (a.type === 'folder') || (by || function () { return 0; })(a, b) || a.name.localeCompare(b.name);
  };
}

function entryOf(place, rel, dirent, st, ix, library, libs, download) {
  var child = rel ? rel + '/' + dirent.name : dirent.name, modified = st ? new Date(st.mtimeMs).toISOString() : null;
  if (dirent.isDirectory()) {
    var dir = ix.dirs && ix.dirs.get(child), inside = folderTitles(library, child);
    return {
      type: 'folder', name: dirent.name, path: child, bytes: dir ? dir.bytes : null,
      items: dir ? dir.files + dir.folders : null, modifiedAt: modified, what: null, ref: null, fileId: null,
      media: inside.media, titles: inside.titles, quality: null, duration: null,
      download: download ? { infoHash: download.infoHash, active: download.active } : null
    };
  }
  var lib = libs[dirent.name] || null, what = describe(dirent.name, lib, download), ref = null;
  if (lib && lib.row.state !== 'missing') {
    ref = 'f_' + lib.row.id;
  } else if (download && VIDEO.test(dirent.name)) {
    ref = refs.torrent(download.infoHash, child);
  }
  return {
    type: 'file', name: dirent.name, path: child, bytes: st ? st.size : null, onDisk: st ? onDisk(st) : null, items: null,
    modifiedAt: modified, what: what, ref: ref, fileId: lib ? lib.row.id : null,
    media: lib && lib.row.state !== 'missing' && lib.row.state !== 'ignored' ? mediaOf(lib.item) : null, titles: null,
    quality: lib ? quality(lib.row) : null,
    duration: lib && lib.row.probe && lib.row.probe.duration ? lib.row.probe.duration : null,
    download: download ? { infoHash: download.infoHash, active: download.active } : null
  };
}

function listing(place, rel, ix, s) {
  return Promise.all([fs.promises.readdir(path.join(place.root, rel), { withFileTypes: true }), libraryOf(place, s)]).then(function (r) {
    var dirents = r[0].filter(function (d) { return d.name[0] !== '.'; }), lib = r[1], libs = libraryRows(lib, rel);
    return Promise.all(dirents.map(function (d) {
      return fs.promises.stat(path.join(place.root, rel, d.name)).catch(function () { return null; }).then(function (st) {
        if (st && st.isDirectory() && !d.isDirectory()) {
          d = { name: d.name, isDirectory: function () { return true; } };   // a symlink to a folder
        }
        return entryOf(place, rel, d, st, ix, lib, libs, downloadOf(place, rel ? rel + '/' + d.name : d.name));
      });
    }));
  });
}

// names containing every word of `q`, anywhere in the place (≤ 200, ≤ 50 000 entries looked at)
function search(place, q, ix, s) {
  var words = q.toLowerCase().split(/\s+/).filter(Boolean), found = [], seen = 0;
  function walk(rel) {
    if (found.length >= SEARCH_LIMIT || seen >= SEARCH_ENTRIES) {
      return Promise.resolve();
    }
    return fs.promises.readdir(path.join(place.root, rel), { withFileTypes: true }).catch(function () { return []; }).then(function (list) {
      return list.filter(function (d) { return d.name[0] !== '.'; }).reduce(function (chain, d) {
        return chain.then(function () {
          seen++;
          var child = rel ? rel + '/' + d.name : d.name, lower = d.name.toLowerCase();
          if (found.length < SEARCH_LIMIT && words.every(function (w) { return lower.indexOf(w) !== -1; })) {
            found.push({ rel: rel, dirent: d });
          }
          return d.isDirectory() ? walk(child) : null;
        });
      }, Promise.resolve());
    });
  }
  return Promise.all([walk(''), libraryOf(place, s)]).then(function (r) {
    var byDir = {}, lib = r[1];
    found.forEach(function (f) { (byDir[f.rel] = byDir[f.rel] || []).push(f.dirent); });
    return Promise.all(Object.keys(byDir).map(function (rel) {
      var libs = libraryRows(lib, rel);
      return Promise.all(byDir[rel].map(function (d) {
        return fs.promises.stat(path.join(place.root, rel, d.name)).catch(function () { return null; }).then(function (st) {
          return entryOf(place, rel, d, st, ix, lib, libs, downloadOf(place, rel ? rel + '/' + d.name : d.name));
        });
      }));
    }));
  }).then(function (groups) {
    return [].concat.apply([], groups);
  });
}

function browse(query) {
  var place, s;
  return Promise.all([findPlace(query.place), userData.services()]).then(function (r) {
    place = r[0];
    s = r[1];
    return inside(place, query.path);
  }).then(function (at) {
    var ix = index(place.root), q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    return fs.promises.stat(at.full).then(function (st) {
      if (!st.isDirectory()) {
        throw failure('INVALID', 'Not a folder');
      }
      return q ? search(place, q, ix, s) : listing(place, at.rel, ix, s);
    }).then(function (entries) {
      entries.sort(sorter(query.sort));
      var here = ix.dirs && ix.dirs.get(at.rel);
      return {
        place: place.id,
        path: at.rel,
        parent: at.rel ? (at.rel.lastIndexOf('/') === -1 ? '' : at.rel.slice(0, at.rel.lastIndexOf('/'))) : null,
        bytes: here ? here.bytes : null,
        measuring: !ix.dirs,
        search: q || null,
        entries: entries
      };
    });
  });
}

// ── delete ─────────────────────────────────────────────────────────────────

function remove(body) {
  var place, at;
  return findPlace(body && body.place).then(function (p) {
    place = p;
    return inside(place, body.path);
  }).then(function (found) {
    at = found;
    if (!at.rel) {
      throw failure('INVALID', 'A place itself isn\'t deleted here: remove it from the library');
    }
    var download = downloadOf(place, at.rel);
    if (download && download.active) {
      throw failure('CONFLICT', 'A running torrent writes here (' + download.name + '): pause it first');
    }
    return fs.promises.lstat(at.full).then(function (st) {
      var bytes = 0;
      var measured = st.isDirectory() ? (index(place.root).dirs || new Map()).get(at.rel) : null;
      bytes = measured ? measured.bytes : onDisk(st);
      return fs.promises.rm(at.full, { recursive: true, force: true }).then(function () {
        log.info('deleted from ' + place.name + ': ' + at.rel);
        // a whole download's entry: the download goes too (its data is gone)
        var top = download && at.rel.indexOf('/') === -1 ? torrents.remove(download.infoHash, { deleteData: false }).catch(function () {}) : null;
        return Promise.all([top, forgetRows(place, at.rel)]);
      }).then(function () {
        stale(place.root);
        return { ok: true, freedBytes: bytes };
      });
    });
  });
}

// the library's rows of what was deleted
function forgetRows(place, rel) {
  if (!place.folderId) {
    return Promise.resolve();
  }
  return userData.services().then(function (s) {
    return s.library.files(place.folderId).then(function (rows) {
      var gone = rows.filter(function (r) { return r.relPath === rel || r.relPath.indexOf(rel + '/') === 0; });
      return Promise.all(gone.map(function (r) { return s.library.removeFile(r.id); })).then(function () {
        if (gone.length) {
          require('./library').changed(place.folderId);
        }
      });
    });
  });
}

// ── a subtitle file, for a player ──────────────────────────────────────────

// A text subtitle file of a place (≤ 10 MB) as WebVTT: the dashboard's player
// adds one from the server's storage
function subtitle(query) {
  var place;
  return findPlace(query.place).then(function (p) {
    place = p;
    return inside(place, query.path);
  }).then(function (at) {
    if (!/\.(srt|ass|ssa|vtt)$/i.test(at.rel)) {
      throw failure(/\.(sub|idx|sup)$/i.test(at.rel) ? 'NOT_SUPPORTED' : 'INVALID',
        /\.(sub|idx|sup)$/i.test(at.rel) ? 'This subtitle is pictures (VobSub, PGS): it can\'t be shown yet' : 'Not a subtitle file (SRT, ASS, SSA or WebVTT)');
    }
    return fs.promises.stat(at.full).then(function (st) {
      if (!st.isFile()) {
        throw failure('INVALID', 'Not a file');
      }
      if (st.size > 10 * 1024 * 1024) {
        throw failure('INVALID', 'This subtitle file is too large');
      }
      return fs.promises.readFile(at.full);
    }).then(function (buffer) {
      var lang = /\.([a-z]{2,3})(\.(forced|sdh|cc))?\.[a-z]+$/i.exec(at.rel);
      return require('./subtitles').toVtt(buffer, lang ? lang[1] : undefined);
    });
  });
}

// ── largest ────────────────────────────────────────────────────────────────

// The biggest "title folders": folders whose own files hold most of their
// size (a film's folder, a season's), not the folders above them
function largest(placeId) {
  return findPlace(placeId).then(function (place) {
    var ix = index(place.root);
    if (!ix.dirs) {
      return { measuring: true, folders: [] };
    }
    var list = [];
    ix.dirs.forEach(function (d, rel) {
      if (rel && d.bytes > 0 && d.own >= d.bytes * 0.5) {
        list.push({ path: rel, bytes: d.bytes });
      }
    });
    list.sort(function (a, b) { return b.bytes - a.bytes; });
    return { measuring: false, folders: list.slice(0, 10) };
  });
}

module.exports = {
  places: places,
  browse: browse,
  remove: remove,
  largest: largest,
  subtitle: subtitle,
  stale: stale
};
