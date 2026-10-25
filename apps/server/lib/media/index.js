'use strict';

// Media: one way to stream, probe and transcode a file, wherever it is
// (docs/media-server-plan.md §5.4). A media ref (./refs.js) resolves to a
// Media, through the torrent client (a file of a torrent) or through the
// library's rows (a file on disk, `folder.path + rel_path`, whose realpath
// must stay inside the folder's: no route ever takes a path from a client).
//
//   Media = { ref, kind: 'torrent' | 'file' | 'remote' | 'hls' | 'live', key, name, path, size,
//             infoHash (torrent), fullPath, folder, mtime, subtitles (file),
//             pluginId (remote: a plugin's http source, lib/plugins/remote.js;
//             hls / live: its HLS or continuous stream, ./hls.js: size null, never opened as bytes) }
//   key: what leases hold (lib/sessions.js): the info hash of a torrent (its
//   leases are shared by every file and route), the ref of a disk file or of
//   a remote source.
//
// ffmpeg / ffprobe read a disk file, or a finished file of a stopped
// download, from its path; a torrent file still downloading through our own
// byte-range route (so the engine fetches what they read).

var fs = require('fs'),
  path = require('path'),
  refs = require('./refs'),
  torrents = require('../torrents/client'),
  userData = require('../userData'),
  auth = require('../auth'),
  protocol = require('@playpex/protocol');

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function notFound() {
  return failure('NOT_FOUND', 'No such media');
}

// The Media of a torrent's file (the torrent routes' {infoHash}/{path}), or null
function torrentFile(infoHash, filePath) {
  var download = torrents.get(infoHash),
    file = download && (torrents.files(download.infoHash) || []).filter(function (f) { return f.path === filePath; })[0];
  if (!file) {
    return null;
  }
  return {
    ref: refs.torrent(download.infoHash, file.path),
    kind: 'torrent',
    key: download.infoHash,
    name: file.name,
    path: file.path,
    size: file.size,
    infoHash: download.infoHash
  };
}

function fromTorrent(parsed) {
  var all = torrents.get(parsed.infoHash) && torrents.files(parsed.infoHash) || [],
    file = all.filter(function (f) { return refs.pathHash(f.path) === parsed.pathHash; })[0];
  return file ? torrentFile(parsed.infoHash, file.path) : null;
}

// A library file: its row, its folder, and its realpath inside the folder's
function fromLibrary(parsed) {
  return userData.services().then(function (s) {
    return s.library.file(parsed.id).then(function (row) {
      if (!row || row.state === 'missing') {
        return null;
      }
      return s.library.folder(row.folderId).then(function (folder) {
        return folder ? inside(folder, row) : null;
      });
    });
  });
}

function inside(folder, row) {
  return Promise.all([
    fs.promises.realpath(folder.path),
    fs.promises.realpath(path.join(folder.path, row.relPath.split('/').join(path.sep)))
  ]).then(function (real) {
    if (real[1].indexOf(real[0] + path.sep) !== 0) {
      return null;
    }
    return fs.promises.stat(real[1]).then(function (st) {
      if (!st.isFile()) {
        return null;
      }
      return {
        ref: refs.file(row.id),
        kind: 'file',
        key: refs.file(row.id),
        name: path.basename(real[1]),
        path: row.relPath,
        size: st.size,
        mtime: st.mtimeMs,
        fullPath: real[1],
        folder: folder,
        subtitles: row.subtitles || []
      };
    });
  }, function () {
    return null;   // gone from disk (an unplugged drive): the scanner marks it missing
  });
}

/**
 * The Media of a ref; rejects NOT_FOUND (unknown, gone, or a path leaving
 * its folder).
 * @returns {Promise<object>}
 */
function resolve(ref) {
  var parsed = refs.parse(ref);
  if (!parsed) {
    return Promise.reject(notFound());
  }
  if (parsed.kind === 'remote') {
    return require('../plugins/remote').media(ref);
  }
  if (parsed.kind === 'hls' || parsed.kind === 'live') {
    return require('./hls').media(ref);
  }
  var found = parsed.kind === 'torrent' ? Promise.resolve(fromTorrent(parsed)) : fromLibrary(parsed);
  return found.then(function (media) {
    if (!media) {
      throw notFound();
    }
    return media;
  });
}

// Whether `profileId` may play it: files of an adults-only folder are never
// played by a kids profile
function allowed(media, profileId) {
  if (!media.folder || media.folder.audience !== 'adults' || typeof profileId !== 'string' || !profileId) {
    return Promise.resolve(true);
  }
  return userData.services().then(function (s) {
    return s.profiles.get(profileId);
  }).then(function (profile) {
    return !profile.isKid;
  }, function () {
    return true;   // an unknown profile is no kid's
  });
}

/**
 * Its bytes start…end (inclusive; the whole file without a range) as a
 * Readable. A torrent's file may start the torrent again (admission: BUSY);
 * a stream download then fetches only this file, with its tail early.
 */
function open(media, range) {
  if (media.kind === 'file') {
    return Promise.resolve(fs.createReadStream(media.fullPath, {
      start: range ? range.start : 0,
      end: range ? range.end : Math.max(0, media.size - 1)
    }));
  }
  if (media.kind === 'remote') {
    return require('../plugins/remote').open(media, range);
  }
  if (media.kind === 'hls' || media.kind === 'live') {
    return Promise.reject(failure('NOT_SUPPORTED', 'A stream has no bytes to read by range'));
  }
  return torrents.prepareStream(media.infoHash, media.path).then(function () {
    torrents.prefetchTail(media.infoHash, media.path);
    return torrents.stream(media.infoHash, media.path, range ? { start: range.start, end: range.end } : null);
  });
}

/**
 * What ffmpeg / ffprobe read: a path on disk (`file:` so that no name is
 * taken for a protocol or an option), else this server's byte-range route
 * as `deviceId` with the per-process secret (lib/auth: lets them in without
 * a token; their reads keep the lease without changing the session's method).
 * @returns {Promise<string>}
 */
function input(media, localPort, deviceId) {
  var disk = media.kind === 'file' ? Promise.resolve(media.fullPath) :
    media.kind === 'torrent' ? torrents.diskPath(media.infoHash, media.path) : Promise.resolve(null);
  return disk.then(function (full) {
    if (full) {
      return 'file:' + full;
    }
    return 'http://127.0.0.1:' + localPort + protocol.API_PREFIX + '/media/' + media.ref + '?' +
      protocol.DEVICE_PARAM + '=' + encodeURIComponent(deviceId) + '&internal=' + auth.internalUrlToken();
  });
}

/**
 * A sidecar subtitle file of a disk file (the scanner's list, by index):
 * { relPath, language, buffer }; rejects NOT_FOUND (no such index, gone,
 * over 10 MB, or leaving its folder).
 * @returns {Promise<{ relPath: string, language: string|null, buffer: Buffer }>}
 */
function sidecar(media, index) {
  var sub = media.kind === 'file' && media.subtitles[index];
  if (!sub) {
    return Promise.reject(notFound());
  }
  return Promise.all([
    fs.promises.realpath(media.folder.path),
    fs.promises.realpath(path.join(media.folder.path, sub.relPath.split('/').join(path.sep)))
  ]).then(function (real) {
    if (real[1].indexOf(real[0] + path.sep) !== 0) {
      throw notFound();
    }
    return fs.promises.stat(real[1]).then(function (st) {
      if (!st.isFile() || st.size > 10 * 1024 * 1024) {
        throw notFound();
      }
      return fs.promises.readFile(real[1]);
    });
  }).then(function (buffer) {
    return { relPath: sub.relPath, language: sub.language || null, buffer: buffer };
  }, function () {
    throw notFound();
  });
}

// One of them as WebVTT
function subtitle(media, index) {
  return sidecar(media, index).then(function (found) {
    return require('../subtitles').toVtt(found.buffer, found.language);
  });
}

// The probe cache's key: a torrent's file never changes; a disk file can
function probeKey(media) {
  return media.kind === 'file' ? media.ref + ':' + media.size + ':' + media.mtime : media.ref;
}

module.exports = {
  refs: refs,
  resolve: resolve,
  torrentFile: torrentFile,
  allowed: allowed,
  open: open,
  input: input,
  probeKey: probeKey,
  subtitle: subtitle,
  sidecar: sidecar
};
