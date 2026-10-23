'use strict';

// The media library's records (docs/media-server-plan.md §5): folders the
// admin added, the video files found in them and what they are (items). Rows
// only: lib/media checks paths on disk (realpath inside the folder) and
// streams the files; lib/library (the scanner) fills the files and matches.

var crypto = require('crypto'),
  path = require('path'),
  errors = require('./errors'),
  dataErrors = require('../data/errors');

var KINDS = ['movies', 'shows', 'mixed', 'other'],
  AUDIENCES = ['everyone', 'adults'],
  FILE_STATES = ['ok', 'missing', 'unmatched', 'ignored'],
  MATCHED_BY = ['auto', 'nfo', 'admin'],
  // a match decided this way is only replaced by one as strong or stronger
  STRENGTH = { auto: 0, nfo: 1, admin: 2 },
  MISSING_DAYS = 7;

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// { kind: 'movie', tmdbId } | { kind: 'episode', showTmdbId, season, episode }
function checkIdentity(identity) {
  identity = identity || {};
  if (identity.kind === 'movie' && positiveInt(identity.tmdbId)) {
    return;
  }
  if (identity.kind === 'episode' && positiveInt(identity.showTmdbId) && Number.isInteger(identity.season) &&
    identity.season >= 0 && positiveInt(identity.episode)) {
    return;
  }
  throw errors.invalid('A match is { kind: "movie", tmdbId } or { kind: "episode", showTmdbId, season, episode }');
}

// A path inside a folder: relative, '/' separated, never leaving it
function checkRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 4096 || relPath.indexOf('\0') !== -1 ||
    relPath.indexOf('\\') !== -1 || path.posix.isAbsolute(relPath) || path.win32.isAbsolute(relPath) ||
    relPath.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
    throw errors.invalid('Not a path inside a folder: ' + relPath);
  }
}

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ now?: function(): Date }} options
 */
/**
 * @typedef {import('../data/contracts').MediaFile} MediaFile
 */
module.exports = function libraryService(repositories, options) {
  var repo = repositories.library,
    now = options.now || function () { return new Date(); };

  function duplicate(err) {
    throw dataErrors.isDuplicate(err) ? errors.conflict(err.message) : err;
  }

  return {
    folders: function () {
      return repo.listFolders();
    },

    folder: function (id) {
      return repo.findFolder(id);
    },

    // { path (absolute: pass its realpath), kind, audience?, dlna?, builtin? }
    addFolder: function (input) {
      return Promise.resolve().then(function () {
        input = input || {};
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
          throw errors.invalid('A folder needs an absolute path');
        }
        if (KINDS.indexOf(input.kind) === -1) {
          throw errors.invalid('kind must be one of ' + KINDS.join(', '));
        }
        if (input.audience !== undefined && AUDIENCES.indexOf(input.audience) === -1) {
          throw errors.invalid('audience must be one of ' + AUDIENCES.join(', '));
        }
        return repo.insertFolder({
          id: crypto.randomUUID(),
          path: input.path,
          kind: input.kind,
          audience: input.audience || 'everyone',
          dlna: !!input.dlna,
          status: 'ok',
          builtin: !!input.builtin,
          addedAt: now(),
          lastScanAt: null
        }).catch(duplicate);
      });
    },

    // { kind?, audience?, dlna?, status?, lastScanAt?, path? (the server's own changes) }
    updateFolder: function (id, patch) {
      return Promise.resolve().then(function () {
        patch = patch || {};
        if (patch.kind !== undefined && KINDS.indexOf(patch.kind) === -1) {
          throw errors.invalid('kind must be one of ' + KINDS.join(', '));
        }
        if (patch.audience !== undefined && AUDIENCES.indexOf(patch.audience) === -1) {
          throw errors.invalid('audience must be one of ' + AUDIENCES.join(', '));
        }
        if (patch.dlna !== undefined && typeof patch.dlna !== 'boolean') {
          throw errors.invalid('dlna must be true or false');
        }
        var fields = {};
        ['kind', 'audience', 'dlna', 'status', 'lastScanAt', 'path'].forEach(function (key) {
          if (patch[key] !== undefined) {
            fields[key] = patch[key];
          }
        });
        return Object.keys(fields).length ? repo.updateFolder(id, fields).catch(duplicate) : repo.findFolder(id);
      });
    },

    // The download dir's folder stays (the server adds it again on start)
    removeFolder: function (id) {
      return repo.findFolder(id).then(function (folder) {
        if (!folder) {
          return false;
        }
        if (folder.builtin) {
          throw errors.conflict('The download folder is always in the library; set its kind to "other" to hide it');
        }
        return repo.removeFolder(id);
      });
    },

    // { folderId?, state?, q?, itemId?, limit? (≤ 500, default 100), offset? } → { files, total }
    queryFiles: function (query) {
      return Promise.resolve().then(function () {
        query = query || {};
        var limit = query.limit === undefined ? 100 : parseInt(query.limit, 10),
          offset = query.offset === undefined ? 0 : parseInt(query.offset, 10);
        if (!(limit >= 1 && limit <= 500) || !(offset >= 0)) {
          throw errors.invalid('limit is 1–500, offset ≥ 0');
        }
        if (query.state !== undefined && FILE_STATES.indexOf(query.state) === -1) {
          throw errors.invalid('Unknown file state: ' + query.state);
        }
        return repo.queryFiles({
          folderId: query.folderId || undefined,
          state: query.state || undefined,
          itemId: query.itemId || undefined,
          q: query.q ? String(query.q).slice(0, 200) : undefined,
          limit: limit,
          offset: offset
        }).then(function (r) {
          return { files: r.rows, total: r.total };
        });
      });
    },

    // { <folderId>: { ok, missing, unmatched, ignored } }
    counts: function () {
      return repo.countFiles().then(function (rows) {
        var counts = {};
        rows.forEach(function (row) {
          counts[row.folderId] = counts[row.folderId] || { ok: 0, missing: 0, unmatched: 0, ignored: 0 };
          counts[row.folderId][row.state] = row.count;
        });
        return counts;
      });
    },

    item: function (id) {
      return repo.findItem(id);
    },

    /**
     * Makes the file this item (found or made from its identity; `details`
     * fill or refresh its title, year, artwork…). A file matched by a stronger
     * decision keeps it (admin > nfo > auto) unless `matchedBy` is as strong.
     * @returns {Promise<MediaFile|null>} the file, null when it is unknown
     */
    match: function (fileId, identity, details, matchedBy) {
      return Promise.resolve().then(function () {
        checkIdentity(identity);
        if (MATCHED_BY.indexOf(matchedBy) === -1) {
          throw errors.invalid('Unknown match source: ' + matchedBy);
        }
        return repo.findFile(fileId);
      }).then(function (file) {
        if (!file) {
          return null;
        }
        if (file.matchedBy && STRENGTH[file.matchedBy] > STRENGTH[matchedBy]) {
          return file;
        }
        var fields = {};
        ['imdbId', 'title', 'episodeTitle', 'year', 'artwork', 'tmdbId'].forEach(function (key) {
          if (details && details[key] !== undefined && details[key] !== null) {
            fields[key] = details[key];
          }
        });
        return repo.findItemFor(identity).then(function (found) {
          if (found) {
            return Object.keys(fields).length ? repo.updateItem(found.id, fields) : found;
          }
          return repo.insertItem(Object.assign({
            id: crypto.randomUUID(),
            kind: identity.kind,
            tmdbId: identity.kind === 'movie' ? identity.tmdbId : null,
            showTmdbId: identity.kind === 'episode' ? identity.showTmdbId : null,
            season: identity.kind === 'episode' ? identity.season : null,
            episode: identity.kind === 'episode' ? identity.episode : null,
            imdbId: null,
            title: null,
            episodeTitle: null,
            year: null,
            artwork: null,
            matchedBy: matchedBy
          }, fields));
        }).then(function (item) {
          return repo.updateFile(file.id, {
            itemId: item.id,
            matchedBy: matchedBy,
            state: file.state === 'missing' || file.state === 'ignored' ? file.state : 'ok'
          });
        });
      });
    },

    // Forgets the file's match (the next scan matches it again)
    unmatch: function (fileId) {
      return repo.findFile(fileId).then(function (file) {
        if (!file) {
          return null;
        }
        return repo.updateFile(fileId, {
          itemId: null,
          matchedBy: null,
          state: file.state === 'missing' || file.state === 'ignored' ? file.state : 'unmatched'
        });
      });
    },

    // An ignored file is never matched nor shown; un-ignoring it brings back its state
    ignore: function (fileId, ignored) {
      return repo.findFile(fileId).then(function (file) {
        if (!file) {
          return null;
        }
        if (ignored) {
          return repo.updateFile(fileId, { state: 'ignored' });
        }
        return file.state === 'ignored' ? repo.updateFile(fileId, { state: file.itemId ? 'ok' : 'unmatched' }) : file;
      });
    },

    // Rows missing for 7 days go (an unplugged drive keeps its matches a while), then items nothing uses
    purge: function () {
      var before = new Date(now().getTime() - MISSING_DAYS * 24 * 3600 * 1000);
      return repo.removeMissingBefore(before).then(function (files) {
        return repo.removeOrphanItems().then(function (items) {
          return { files: files, items: items };
        });
      });
    },

    files: function (folderId) {
      return repo.listFiles(folderId);
    },

    file: function (id) {
      return repo.findFile(id);
    },

    // { relPath, size, mtime, state?, parse?, probe?, subtitles? } of a file in `folderId`
    addFile: function (folderId, input) {
      return Promise.resolve().then(function () {
        input = input || {};
        checkRelPath(input.relPath);
        if (!(Number.isInteger(input.size) && input.size >= 0)) {
          throw errors.invalid('size must be a number of bytes');
        }
        if (input.state !== undefined && FILE_STATES.indexOf(input.state) === -1) {
          throw errors.invalid('Unknown file state: ' + input.state);
        }
        return repo.findFolder(folderId).then(function (folder) {
          if (!folder) {
            throw errors.notFound('No such folder');
          }
          return repo.insertFile({
            id: crypto.randomUUID(),
            folderId: folderId,
            relPath: input.relPath,
            size: input.size,
            mtime: input.mtime instanceof Date ? input.mtime : now(),
            probe: input.probe || null,
            parse: input.parse || null,
            itemId: null,
            state: input.state || 'unmatched',
            matchedBy: null,
            subtitles: input.subtitles || null,
            addedAt: now(),
            missingSince: null
          }).catch(duplicate);
        });
      });
    },

    updateFile: function (id, patch) {
      return Promise.resolve().then(function () {
        if (patch.state !== undefined && FILE_STATES.indexOf(patch.state) === -1) {
          throw errors.invalid('Unknown file state: ' + patch.state);
        }
        if (patch.relPath !== undefined) {
          checkRelPath(patch.relPath);
        }
        if (patch.matchedBy !== undefined && patch.matchedBy !== null && MATCHED_BY.indexOf(patch.matchedBy) === -1) {
          throw errors.invalid('Unknown match source: ' + patch.matchedBy);
        }
        var fields = Object.assign({}, patch);
        delete fields.id;
        delete fields.folderId;
        return Object.keys(fields).length ? repo.updateFile(id, fields) : repo.findFile(id);
      });
    },

    removeFile: function (id) {
      return repo.removeFile(id);
    }
  };
};
