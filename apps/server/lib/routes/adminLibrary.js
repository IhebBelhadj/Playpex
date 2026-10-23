'use strict';

// /api/v1/admin/library and /api/v1/admin/fs (docs/media-server-plan.md
// §5.1–5.3, step 4): the library's folders, scans, files and their matches,
// TMDB search for fixing a match, and a folder browser (directories only)
// for adding folders. Mounted by lib/routes/admin.js after requireAdmin.

var express = require('express'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  handle = require('./handle'),
  library = require('../library'),
  matcher = require('../library/match'),
  refs = require('../media/refs'),
  settings = require('../settings'),
  paths = require('../paths'),
  serviceErrors = require('../services/errors');

var router = express.Router();

function iso(date) {
  return date instanceof Date ? date.toISOString() : date || null;
}

function folderView(folder, counts, scan) {
  return {
    id: folder.id,
    path: folder.path,
    kind: folder.kind,
    audience: folder.audience,
    dlna: folder.dlna,
    builtin: folder.builtin,
    status: folder.status,
    addedAt: iso(folder.addedAt),
    lastScanAt: iso(folder.lastScanAt),
    counts: counts || { ok: 0, missing: 0, unmatched: 0, ignored: 0 },
    scanning: !!scan.current && scan.current.folderId === folder.id,
    queued: scan.queued.indexOf(folder.id) !== -1
  };
}

function itemView(item) {
  return item ? {
    id: item.id,
    kind: item.kind,
    tmdbId: item.tmdbId,
    showTmdbId: item.showTmdbId,
    season: item.season,
    episode: item.episode,
    imdbId: item.imdbId,
    title: item.title,
    episodeTitle: item.episodeTitle,
    year: item.year,
    artwork: item.artwork || null
  } : null;
}

function fileView(file, item) {
  return {
    id: file.id,
    ref: refs.file(file.id),
    folderId: file.folderId,
    relPath: file.relPath,
    size: file.size,
    mtime: iso(file.mtime),
    state: file.state,
    matchedBy: file.matchedBy || null,
    addedAt: iso(file.addedAt),
    missingSince: iso(file.missingSince),
    parse: file.parse || null,
    probe: file.probe || null,
    subtitles: (file.subtitles || []).map(function (sub, index) {
      return { index: index, language: sub.language, forced: !!sub.forced, sdh: !!sub.sdh, relPath: sub.relPath };
    }),
    item: itemView(item)
  };
}

function withItem(s, file) {
  if (!file) {
    throw serviceErrors.notFound('No such file');
  }
  return (file.itemId ? s.library.item(file.itemId) : Promise.resolve(null)).then(function (item) {
    return fileView(file, item);
  });
}

// TMDB failures as API errors: no key 503, TMDB down 502
function upstream(err) {
  if (err.status) {
    throw err;
  }
  var e = new Error(err.code === 'PROVIDER_NOT_CONFIGURED' ? 'TMDB_API_KEY is not set' : 'TMDB: ' + err.message);
  e.code = err.code === 'PROVIDER_NOT_CONFIGURED' ? 'PROVIDER_NOT_CONFIGURED' : 'UPSTREAM';
  e.status = err.code === 'PROVIDER_NOT_CONFIGURED' ? 503 : 502;
  throw e;
}

// ── folders and scans ───────────────────────────────────────────────────────

// { folders: [...], scan: { current, queued } }
router.get('/library', handle(function (s) {
  return Promise.all([s.library.folders(), s.library.counts()]).then(function (r) {
    var scan = library.status();
    return { folders: r[0].map(function (f) { return folderView(f, r[1][f.id], scan); }), scan: scan };
  });
}));

// body: { path, kind, audience?, dlna? } → the folder (scanned right away)
router.post('/library/folders', handle(function (s, req) {
  return library.addFolder(req.body || {}).then(function (folder) {
    return folderView(folder, null, library.status());
  });
}, 201));

// body: { kind?, audience?, dlna? }
router.patch('/library/folders/:id', handle(function (s, req) {
  var body = req.body || {};
  return s.library.updateFolder(req.params.id, { kind: body.kind, audience: body.audience, dlna: body.dlna }).then(function (folder) {
    if (!folder) {
      throw serviceErrors.notFound('No such folder');
    }
    if (body.kind !== undefined) {
      library.scan(folder.id, true);   // unmatched files may match as the new kind
    }
    library.changed(folder.id);
    return s.library.counts().then(function (counts) {
      return folderView(folder, counts[folder.id], library.status());
    });
  });
}));

// Forgets the folder and its files' rows; nothing on disk is deleted
router.delete('/library/folders/:id', handle(function (s, req) {
  return library.removeFolder(req.params.id).then(function (removed) {
    if (!removed) {
      throw serviceErrors.notFound('No such folder');
    }
    return { ok: true };
  });
}));

// body: { folderId?, force? } → { current, queued }. force: unmatched files are matched again
router.post('/library/scan', handle(function (s, req) {
  var body = req.body || {};
  if (body.folderId === undefined) {
    return library.scan(null, !!body.force);
  }
  return s.library.folder(String(body.folderId)).then(function (folder) {
    if (!folder) {
      throw serviceErrors.notFound('No such folder');
    }
    return library.scan(folder.id, !!body.force);
  });
}));

// ── files and matches ───────────────────────────────────────────────────────

// ?folder=&state=&item=&q=&limit=&offset= → { files, total }, newest first
router.get('/library/files', handle(function (s, req) {
  return s.library.queryFiles({
    folderId: req.query.folder, state: req.query.state, itemId: req.query.item, q: req.query.q,
    limit: req.query.limit, offset: req.query.offset
  }).then(function (r) {
    return { files: r.files.map(function (f) { return fileView(f, f.item); }), total: r.total };
  });
}));

router.get('/library/files/:id', handle(function (s, req) {
  return s.library.file(req.params.id).then(function (file) { return withItem(s, file); });
}));

// A file the admin changed: clients refetch what they show (library.changed)
function touched(s, file) {
  if (file) {
    library.changed(file.folderId);
  }
  return withItem(s, file);
}

// body: { kind: 'movie', tmdbId } | { kind: 'episode', showTmdbId, season, episode }:
// the admin's match (kept by rescans)
router.put('/library/files/:id/match', handle(function (s, req) {
  var identity = req.body || {};
  return s.library.file(req.params.id).then(function (file) {
    if (!file) {
      throw serviceErrors.notFound('No such file');
    }
    if (!(identity.kind === 'movie' && Number.isInteger(identity.tmdbId) ||
      identity.kind === 'episode' && Number.isInteger(identity.showTmdbId) && Number.isInteger(identity.season) &&
      Number.isInteger(identity.episode))) {
      throw serviceErrors.invalid('A match is { kind: "movie", tmdbId } or { kind: "episode", showTmdbId, season, episode }');
    }
    return matcher.describe(identity, library.catalog()).catch(upstream).then(function (details) {
      if (!details) {
        throw serviceErrors.invalid(identity.kind === 'movie' ? 'No such movie on TMDB' : 'No such episode on TMDB');
      }
      var key = identity.kind === 'movie' ? { kind: 'movie', tmdbId: identity.tmdbId } :
        { kind: 'episode', showTmdbId: identity.showTmdbId, season: identity.season, episode: identity.episode };
      return s.library.match(file.id, key, details, 'admin');
    });
  }).then(function (file) { return touched(s, file); });
}));

// Forgets the match (the next scan matches the file again)
router.delete('/library/files/:id/match', handle(function (s, req) {
  return s.library.unmatch(req.params.id).then(function (file) { return touched(s, file); });
}));

// body: { ignored: boolean }
router.put('/library/files/:id/ignored', handle(function (s, req) {
  var ignored = req.body && req.body.ignored;
  if (typeof ignored !== 'boolean') {
    return Promise.reject(serviceErrors.invalid('ignored must be true or false'));
  }
  return s.library.ignore(req.params.id, ignored).then(function (file) { return touched(s, file); });
}));

// ?kind=movie|tv&q=&year= → { results: [{ tmdbId, title, year, overview, posterPath }] } (to fix a match)
router.get('/library/search', handle(function (s, req) {
  var kind = req.query.kind, q = String(req.query.q || '').trim(), year = parseInt(req.query.year, 10) || null;
  if (['movie', 'tv'].indexOf(kind) === -1 || !q) {
    return Promise.reject(serviceErrors.invalid('kind (movie or tv) and q are needed'));
  }
  return library.catalog().search(kind, q.slice(0, 200), year).catch(upstream).then(function (results) {
    return {
      results: results.slice(0, 20).map(function (r) {
        var date = r.release_date || r.first_air_date;
        return {
          tmdbId: r.id,
          title: r.title || r.name || '',
          year: date ? parseInt(date.slice(0, 4), 10) || null : null,
          overview: r.overview || null,
          posterPath: r.poster_path || null
        };
      })
    };
  });
}));

// ── folder browser ──────────────────────────────────────────────────────────

// Where to start: the file system's roots (drives on Windows), home, downloads
function places() {
  var list = [{ name: 'Home', path: os.homedir() }, { name: 'Downloads', path: settings.get('storage.downloadDir') || paths.downloads }];
  if (process.platform === 'win32') {
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (letter) {
      var drive = letter + ':\\';
      if (fs.existsSync(drive)) {
        list.push({ name: letter + ':', path: drive });
      }
    });
  } else {
    list.push({ name: '/', path: '/' });
    ['/media', '/mnt', '/Volumes'].forEach(function (dir) {
      if (fs.existsSync(dir)) {
        list.push({ name: dir, path: dir });
      }
    });
  }
  return list;
}

// ?path= → { path, parent, dirs: [{ name, path }], places }: directories only,
// no hidden ones, no file names
router.get('/fs', handle(function (s, req) {
  var asked = req.query.path ? String(req.query.path) : null;
  if (!asked) {
    return Promise.resolve({ path: null, parent: null, dirs: [], places: places() });
  }
  if (!path.isAbsolute(asked)) {
    return Promise.reject(serviceErrors.invalid('path must be absolute'));
  }
  return fs.promises.realpath(asked).then(function (real) {
    return fs.promises.readdir(real, { withFileTypes: true }).then(function (entries) {
      return Promise.all(entries.filter(function (e) {
        return e.name[0] !== '.' && (e.isDirectory() || e.isSymbolicLink());
      }).slice(0, 5000).map(function (e) {
        var full = path.join(real, e.name);
        return (e.isDirectory() ? Promise.resolve(true) : fs.promises.stat(full).then(function (st) {
          return st.isDirectory();
        }, function () { return false; })).then(function (dir) {
          return dir ? { name: e.name, path: full } : null;
        });
      })).then(function (dirs) {
        var parent = path.dirname(real);
        return {
          path: real,
          parent: parent === real ? null : parent,
          dirs: dirs.filter(Boolean).sort(function (a, b) { return a.name.localeCompare(b.name); }),
          places: places()
        };
      });
    });
  }, function () {
    throw serviceErrors.notFound('No such folder');
  }).catch(function (err) {
    if (err.status) {
      throw err;
    }
    throw serviceErrors.forbidden('This folder can\'t be read');
  });
}));

module.exports = router;
