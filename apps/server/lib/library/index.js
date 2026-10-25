'use strict';

// The media library's scanner (docs/media-server-plan.md §5.1–5.2, step 4).
// Folders are scanned one at a time, from a queue: on start, every 15 min,
// when a folder is added, when the admin asks, and when a download finishes
// (the download dir is a built-in folder). A scan:
//
//   walk (./walk.js) → diff with the rows by path (size + mtime: unchanged
//   files are not probed or matched again) → new / changed files: parse
//   (./parse.js), .nfo (./nfo.js), ffprobe (lib/transcode.js), match
//   (./match.js over lib/tmdb.js) → files gone: `missing` (kept 7 days, so an
//   unplugged drive keeps its matches) → `library.scan` events (admin).
//
// A file the admin matched (matched_by admin) is never matched again by a
// scan; an ignored one never at all. Unmatched files are tried again by a
// scan the admin asks for (`force`), not by the periodic ones.

var fs = require('fs'),
  path = require('path'),
  walk = require('./walk'),
  parse = require('./parse'),
  nfo = require('./nfo'),
  matcher = require('./match'),
  tmdb = require('../tmdb'),
  transcode = require('../transcode'),
  settings = require('../settings'),
  paths = require('../paths'),
  events = require('../events'),
  userData = require('../userData'),
  plugins = require('../plugins'),
  serviceErrors = require('../services/errors'),
  log = require('../logger').child('library');

var PLUGIN_CONTEXT = { profile: null, device: null, locale: 'en' },
  RESCAN_MS = 15 * 60 * 1000,
  FIRST_SCAN_MS = 5000,
  DOWNLOAD_SCAN_MS = 15000,
  PROGRESS_EVERY = 25,
  WORKERS = 4;

var queue = [],          // [{ folderId, force }]
  current = null,        // { folderId, force, progress }
  timers = [],
  downloadTimer = null,
  running = false,
  listening = false,
  options = { catalog: tmdb, torrents: null, downloadScanMs: DOWNLOAD_SCAN_MS };

function failure(code, message) {
  return code === 'INVALID' ? serviceErrors.invalid(message) : serviceErrors.conflict(message);
}

function services() {
  return userData.services();
}

function downloadDir() {
  return settings.get('storage.downloadDir') || paths.downloads;
}

function overlaps(a, b) {
  return a === b || a.indexOf(b + path.sep) === 0 || b.indexOf(a + path.sep) === 0;
}

function publish(data) {
  events.publish('library.scan', data, { admin: true });
}

// What clients see of the library changed (files, matches, a folder's kind or
// audience): every client, to refetch (lib/library/view.js)
function changed(folderId) {
  events.publish('library.changed', { folderId: folderId || null });
}

// ── folders ─────────────────────────────────────────────────────────────────

/**
 * Adds a folder (its realpath) and scans it. INVALID: not a readable
 * folder; CONFLICT: inside or around a folder of the library.
 * @param {{ path: string, kind: string, audience?: string, dlna?: boolean }} input
 */
function addFolder(input) {
  input = input || {};
  if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
    return Promise.reject(failure('INVALID', 'A folder needs an absolute path'));
  }
  return fs.promises.realpath(input.path).then(function (real) {
    return fs.promises.stat(real).then(function (st) {
      if (!st.isDirectory()) {
        throw failure('INVALID', 'Not a folder: ' + input.path);
      }
      return fs.promises.access(real, fs.constants.R_OK);
    }).then(function () { return real; });
  }, function () {
    throw failure('INVALID', 'No such folder: ' + input.path);
  }).then(function (real) {
    return services().then(function (s) {
      return s.library.folders().then(function (folders) {
        var clash = folders.filter(function (f) { return overlaps(f.path, real); })[0];
        if (clash) {
          throw failure('CONFLICT', clash.path === real ? 'This folder is already in the library' :
            'This folder overlaps a folder of the library: ' + clash.path);
        }
        return s.library.addFolder(Object.assign({}, input, { path: real, builtin: false }));
      });
    });
  }).then(function (folder) {
    log.info('folder added: ' + folder.path, { kind: folder.kind, audience: folder.audience });
    scan(folder.id);
    return folder;
  });
}

// Its rows go; nothing on disk is touched. A scan of it running stops.
function removeFolder(id) {
  queue = queue.filter(function (q) { return q.folderId !== id; });
  return services().then(function (s) { return s.library.removeFolder(id); }).then(function (removed) {
    if (removed) {
      log.info('folder removed: ' + id);
      changed(id);
    }
    return removed;
  });
}

// The download dir as a built-in folder (kind mixed), kept at the current dir
function ensureDownloadFolder() {
  var dir = downloadDir();
  return fs.promises.mkdir(dir, { recursive: true }).then(function () {
    return fs.promises.realpath(dir);
  }).then(function (real) {
    return services().then(function (s) {
      return s.library.folders().then(function (folders) {
        var builtin = folders.filter(function (f) { return f.builtin; })[0],
          clash = folders.filter(function (f) { return !f.builtin && overlaps(f.path, real); })[0];
        if (clash) {
          // the admin's folder holds the downloads already
          return builtin ? s.library.removeFolder(builtin.id).then(function () { return null; }) : null;
        }
        if (builtin) {
          return builtin.path === real ? builtin : s.library.updateFolder(builtin.id, { path: real });
        }
        return s.library.addFolder({ path: real, kind: 'mixed', builtin: true });
      });
    });
  }).catch(function (err) {
    log.warn('download folder not in the library: ' + err.message);
    return null;
  });
}

// ── scanning ────────────────────────────────────────────────────────────────

/**
 * Queues a scan of one folder, or of every folder (no id). `force`: unmatched
 * files are matched again, files never probed are probed again; 'rematch'
 * (its information provider changed): every file the admin didn't match is.
 */
function scan(folderId, force) {
  var ids = folderId ? Promise.resolve([folderId]) :
    services().then(function (s) { return s.library.folders(); }).then(function (all) {
      return all.map(function (f) { return f.id; });
    });
  return ids.then(function (list) {
    list.forEach(function (id) {
      var queued = queue.filter(function (q) { return q.folderId === id; })[0];
      var level = force === 'rematch' ? 'rematch' : !!force;
      if (queued) {
        queued.force = queued.force === 'rematch' || level === 'rematch' ? 'rematch' : queued.force || level;
      } else if (!(current && current.folderId === id && !force)) {
        queue.push({ folderId: id, force: level });
      }
    });
    next();
    return status();
  });
}

function status() {
  return {
    current: current ? Object.assign({ folderId: current.folderId }, current.progress) : null,
    queued: queue.map(function (q) { return q.folderId; })
  };
}

function next() {
  if (current || !queue.length || !running) {
    return;
  }
  current = queue.shift();
  current.progress = { total: 0, processed: 0, added: 0, changed: 0, missing: 0, matched: 0, unmatched: 0 };
  var job = current;
  scanFolder(job).catch(function (err) {
    log.error('scan failed: ' + err.message, { err: err, folderId: job.folderId });
    publish(Object.assign({ folderId: job.folderId, state: 'error', error: err.message }, job.progress));
    return services().then(function (s) {
      return s.library.updateFolder(job.folderId, { status: 'error: ' + err.message });
    }).catch(function () {});
  }).then(function () {
    current = null;
    next();
  });
}

function sameTime(a, b) {
  return a instanceof Date && b instanceof Date && Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
}

function scanFolder(job) {
  var s, folder, progress = job.progress, started = Date.now();
  return services().then(function (found) {
    s = found;
    return s.library.folder(job.folderId);
  }).then(function (f) {
    folder = f;
    if (!folder) {
      return null;
    }
    return s.library.updateFolder(folder.id, { status: 'scanning' }).then(function () {
      publish(Object.assign({ folderId: folder.id, state: 'scanning' }, progress));
      return s.library.folders();
    }).then(function (all) {
      return walk(folder.path, all.map(function (f) { return f.path; }));
    }).then(function (walked) {
      return s.library.files(folder.id).then(function (rows) {
        return walked.missing ? gone(rows) : diff(walked.files, rows);
      }).then(function () {
        return s.library.updateFolder(folder.id, { status: walked.missing ? 'missing' : 'ok', lastScanAt: new Date() });
      }).then(function () {
        return s.library.purge();
      }).then(function (purged) {
        if (progress.added || progress.changed || progress.missing || progress.matched || purged.files) {
          changed(folder.id);
        }
        log.info('scanned ' + folder.path + (walked.missing ? ' (missing)' : ''), Object.assign({
          ms: Date.now() - started
        }, progress));
        publish(Object.assign({ folderId: folder.id, state: walked.missing ? 'missing' : 'done' }, progress));
      });
    });
  });

  // An unreachable folder: its files are missing (kept 7 days)
  function gone(rows) {
    return rows.filter(function (r) { return r.state !== 'missing'; }).reduce(function (chain, row) {
      return chain.then(function () {
        progress.missing++;
        return s.library.updateFile(row.id, { state: 'missing', missingSince: new Date() });
      });
    }, Promise.resolve());
  }

  function diff(files, rows) {
    var byPath = {}, work = [];
    rows.forEach(function (r) { byPath[r.relPath] = r; });
    var skip = skipped();
    var steps = files.filter(function (file) { return !skip(file.relPath); }).map(function (file) {
      var row = byPath[file.relPath];
      delete byPath[file.relPath];
      return function () {
        if (!row) {
          progress.added++;
          return s.library.addFile(folder.id, {
            relPath: file.relPath, size: file.size, mtime: file.mtime, parse: parse(file.relPath), subtitles: file.subtitles
          }).then(function (added) {
            work.push({ row: added, file: file, probe: true, match: true });
          });
        }
        if (row.size !== file.size || !sameTime(row.mtime, file.mtime)) {
          progress.changed++;
          return s.library.updateFile(row.id, {
            size: file.size, mtime: file.mtime, probe: null, parse: parse(file.relPath), subtitles: file.subtitles,
            state: row.state === 'missing' ? (row.itemId ? 'ok' : 'unmatched') : row.state, missingSince: null
          }).then(function (updated) {
            work.push({ row: updated, file: file, probe: true, match: updated.matchedBy !== 'admin' });
          });
        }
        var patch = {};
        if (JSON.stringify(row.subtitles || []) !== JSON.stringify(file.subtitles)) {
          patch.subtitles = file.subtitles;
        }
        if (row.state === 'missing') {
          patch.state = row.itemId ? 'ok' : 'unmatched';
          patch.missingSince = null;
        }
        var rematch = job.force === 'rematch' && row.matchedBy !== 'admin',
          again = job.force && row.state !== 'ignored' && (!row.probe || rematch || !row.itemId && row.matchedBy !== 'admin');
        return (Object.keys(patch).length ? s.library.updateFile(row.id, patch) : Promise.resolve(row)).then(function (r) {
          if (again) {
            work.push({ row: r, file: file, probe: !r.probe, match: rematch || !r.itemId });
          }
        });
      };
    });
    return steps.reduce(function (chain, step) {
      return chain.then(function () { return running ? step() : null; });
    }, Promise.resolve()).then(function () {
      if (!running) {
        return;
      }
      // what the walk didn't find
      return Object.keys(byPath).map(function (k) { return byPath[k]; }).filter(function (r) {
        return r.state !== 'missing';
      }).reduce(function (chain, row) {
        return chain.then(function () {
          progress.missing++;
          return s.library.updateFile(row.id, { state: 'missing', missingSince: new Date() });
        });
      }, Promise.resolve());
    }).then(function () {
      progress.total = work.length;
      return run(work);
    });
  }

  // Files of the download dir that a download is still writing
  function skipped() {
    if (!folder.builtin || !options.torrents) {
      return function () { return false; };
    }
    var owners = options.torrents.owners(folder.path);
    return function (relPath) {
      var owner = owners[relPath.split('/')[0]];
      return !!owner && !owner.done;
    };
  }

  // WORKERS files at a time (TMDB answers take most of the time)
  function run(work) {
    var probing = true, matching = folder.kind !== 'other', pending = work.slice(), workers = [];

    function worker() {
      var task = pending.shift();
      return task && running && current ? one(task).then(worker) : Promise.resolve();
    }

    function one(task) {
      var full = path.join(folder.path, task.row.relPath.split('/').join(path.sep)),
        probe = task.probe && probing ? transcode.probe('file:' + full, null, { cache: false })
          .then(function (info) {
            // ffprobe answers nothing for a file it can't read: not a probe
            if (!info.video && !info.audio.length) {
              log.debug('nothing probed in ' + task.row.relPath);
              return;
            }
            return s.library.updateFile(task.row.id, { probe: info });
          }, function (err) {
            if (err.code === 'ENOENT') {
              probing = false;
              log.warn('ffprobe not found: library files are not probed');
            } else {
              log.debug('probe failed: ' + task.row.relPath + ': ' + err.message);
            }
          }) : Promise.resolve();
      return probe.then(function () {
        if (!task.match || !matching || task.row.state === 'ignored') {
          return;
        }
        return identify(task).then(function (found) {
          if (found === false) {
            matching = false;   // no TMDB key, or TMDB down: later
            return;
          }
          if (found) {
            progress.matched++;
          } else {
            progress.unmatched++;
          }
        });
      }).then(function () {
        progress.processed++;
        if (progress.processed % PROGRESS_EVERY === 0) {
          publish(Object.assign({ folderId: folder.id, state: 'scanning' }, progress));
        }
      });
    }

    for (var i = 0; i < WORKERS; i++) {
      workers.push(worker());
    }
    return Promise.all(workers);
  }

  // The folder's information provider, when it's a plugin (library.match,
  // docs/plugins-plan.md §4.3): its identity with TMDB's details, else null
  // (no answer, the plugin not running: the core's own rules then)
  function byPlugin(row, parsed, ids) {
    if (!folder.matcher || folder.kind === 'other') {
      return Promise.resolve(null);
    }
    var file = { relPath: row.relPath.slice(0, 4096), folderKind: folder.kind, parse: parsed, size: row.size },
      known = {},
      tmdbId = ids.tmdbId || ids.showTmdbId,
      imdbId = ids.imdbId || ids.showImdbId;
    if (Number.isInteger(tmdbId) && tmdbId > 0) {
      known.tmdbId = tmdbId;
    }
    if (typeof imdbId === 'string' && /^tt\d{5,10}$/.test(imdbId)) {
      known.imdbId = imdbId;
    }
    if (Object.keys(known).length) {
      file.ids = known;
    }
    if (row.probe && typeof row.probe.duration === 'number') {
      file.duration = row.probe.duration;
    }
    return plugins.runHook('library.match', { file: file }, PLUGIN_CONTEXT, { only: folder.matcher }).then(function (r) {
      var identity = r.results[0] && r.results[0].output.identity;
      if (!identity) {
        return null;
      }
      identity = identity.kind === 'movie' ? { kind: 'movie', tmdbId: identity.tmdbId } :
        { kind: 'episode', showTmdbId: identity.showTmdbId, season: identity.season, episode: identity.episode };
      return matcher.describe(identity, options.catalog).then(function (details) {
        return details ? { identity: identity, details: details, matchedBy: 'auto', score: 1 } : null;
      });
    }, function () {
      return null;
    });
  }

  // true: matched · null: no confident match · false: couldn't ask TMDB
  function identify(task) {
    var parsed = task.row.parse || parse(task.row.relPath),
      nfoFiles = (task.file.nfo || []).map(function (rel) {
        return path.join(folder.path, rel.split('/').join(path.sep));
      });
    return nfo.read(nfoFiles).then(function (ids) {
      return byPlugin(task.row, parsed, ids).then(function (found) {
        return found || matcher.match(parsed, ids, folder.kind, options.catalog);
      });
    }).then(function (found) {
      if (!found) {
        return task.row.matchedBy === 'admin' ? true : s.library.unmatch(task.row.id).then(function () { return null; });
      }
      return s.library.match(task.row.id, found.identity, found.details, found.matchedBy).then(function () {
        return true;
      });
    }, function (err) {
      if (err.code === 'PROVIDER_NOT_CONFIGURED') {
        log.warn('TMDB_API_KEY is not set: library files are not matched');
      } else {
        log.warn('TMDB lookup failed, files stay unmatched until the next scan: ' + err.message);
      }
      return false;
    });
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function onEvent(topic, data) {
  var finished = data && ((topic === 'download.updated' && ['seeding', 'completed'].indexOf(data.state) !== -1) ||
    (topic === 'direct.updated' && data.state === 'completed'));   // a file fetched over HTTP (lib/downloads/direct.js)
  if (!running || !finished) {
    return;
  }
  clearTimeout(downloadTimer);
  downloadTimer = setTimeout(function () {
    services().then(function (s) { return s.library.folders(); }).then(function (folders) {
      var builtin = folders.filter(function (f) { return f.builtin; })[0];
      if (builtin) {
        scan(builtin.id);
      }
    }).catch(function () {});
  }, options.downloadScanMs);
  downloadTimer.unref();
}

/**
 * Starts the timers (first scan after 5 s, then every 15 min).
 * @param {{ catalog?: object, torrents?: object, firstScanMs?: number, downloadScanMs?: number }} opts
 *   catalog: lib/tmdb.js (tests give a fake); torrents: the torrent client
 *   (files a download is still writing are skipped)
 */
function start(opts) {
  opts = opts || {};
  options = {
    catalog: opts.catalog || tmdb,
    torrents: opts.torrents || null,
    downloadScanMs: opts.downloadScanMs !== undefined ? opts.downloadScanMs : DOWNLOAD_SCAN_MS
  };
  running = true;
  if (!listening) {
    events.onPublish(onEvent);
    listening = true;
  }
  var first = setTimeout(function () {
    ensureDownloadFolder().then(function () { return scan(); }).catch(function (err) {
      log.warn('library unavailable: ' + err.message);
    });
  }, opts.firstScanMs !== undefined ? opts.firstScanMs : FIRST_SCAN_MS);
  var every = setInterval(function () {
    scan().catch(function () {});
  }, RESCAN_MS);
  [first, every].forEach(function (t) { t.unref(); });
  timers.push(first, every);
}

// The scan running stops after its current file; resolves then
function stop() {
  running = false;
  timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
  timers = [];
  clearTimeout(downloadTimer);
  queue = [];
  return idle();
}

// Resolves when nothing is scanning or queued (tests)
function idle() {
  return new Promise(function (resolve) {
    (function check() {
      if (!current && !queue.length) {
        return resolve();
      }
      setTimeout(check, 50);
    })();
  });
}

module.exports = {
  catalog: function () { return options.catalog; },
  start: start,
  stop: stop,
  scan: scan,
  status: status,
  idle: idle,
  addFolder: addFolder,
  removeFolder: removeFolder,
  changed: changed,
  ensureDownloadFolder: ensureDownloadFolder
};
