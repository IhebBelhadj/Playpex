'use strict';

// The dashboard's Storage page (docs/server-separation-plan.md §7): what the
// download directory holds, and cleaning it up.
//
// torrent-stream writes every file at <downloadDir>/<file path>, and a
// torrent's file paths start with its name (multi-file: a folder, single
// file: the file), so each top-level entry of the directory is one torrent's
// data. An entry a running torrent writes to is "active" and can't be deleted.
//
//   storage.list()        → Promise<{ dir, disk, totalBytes, items: [{ name, bytes, modifiedAt, infoHash, torrentName }] }>
//   storage.remove(name)  → Promise<{ ok }>        (NOT_FOUND / CONFLICT when active)
//   storage.clear()       → Promise<{ removed, freedBytes }>   every entry no torrent uses
//   storage.checkDir(dir) → Promise<{ path, exists, writable, free, total }>  for the download dir setting

var fs = require('fs'),
  path = require('path'),
  store = require('./store'),
  system = require('./system'),
  log = require('./logger').child('torrent');

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// Bytes on disk (allocated blocks: torrent files are sparse until downloaded)
function sizeOf(file) {
  return fs.promises.lstat(file).then(function (st) {
    var bytes = st.blocks !== undefined ? st.blocks * 512 : st.size;
    if (!st.isDirectory()) {
      return { bytes: bytes, mtime: st.mtimeMs };
    }
    return fs.promises.readdir(file).then(function (names) {
      return Promise.all(names.map(function (n) { return sizeOf(path.join(file, n)); }));
    }).then(function (children) {
      return children.reduce(function (sum, c) {
        return { bytes: sum.bytes + c.bytes, mtime: Math.max(sum.mtime, c.mtime) };
      }, { bytes: 0, mtime: st.mtimeMs });
    });
  }, function () {
    return { bytes: 0, mtime: 0 };
  });
}

// top-level entry name → { infoHash, torrentName } of the running torrents
function activeEntries() {
  return store.list().reduce(function (all, torrent) {
    (torrent.files || []).forEach(function (f) {
      var top = f.path.split(/[\\/]/)[0];
      all[top] = { infoHash: torrent.infoHash, torrentName: torrent.torrent ? torrent.torrent.name : null };
    });
    return all;
  }, {});
}

function list() {
  var dir = system.downloadDir(), active = activeEntries();
  return fs.promises.readdir(dir).catch(function (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }).then(function (names) {
    return Promise.all(names.map(function (name) {
      return sizeOf(path.join(dir, name)).then(function (s) {
        var a = active[name] || null;
        return {
          name: name,
          bytes: s.bytes,
          modifiedAt: s.mtime ? new Date(s.mtime).toISOString() : null,
          infoHash: a ? a.infoHash : null,
          torrentName: a ? a.torrentName : null
        };
      });
    }));
  }).then(function (items) {
    items.sort(function (a, b) { return b.bytes - a.bytes; });
    return system.disk(dir).then(function (d) {
      return {
        dir: path.resolve(dir),
        disk: d ? { free: d.free, total: d.total } : null,
        totalBytes: items.reduce(function (sum, i) { return sum + i.bytes; }, 0),
        items: items
      };
    });
  });
}

// A top-level entry of the download dir, by its exact name (no paths)
function entryPath(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw failure('INVALID', 'Not an entry of the download directory');
  }
  return path.join(system.downloadDir(), name);
}

function remove(name) {
  return Promise.resolve().then(function () {
    var file = entryPath(name);
    if (activeEntries()[name]) {
      throw failure('CONFLICT', 'A running torrent uses it; stop its sessions first');
    }
    return fs.promises.lstat(file).catch(function () {
      throw failure('NOT_FOUND', 'No such entry: ' + name);
    }).then(function () {
      return fs.promises.rm(file, { recursive: true, force: true });
    }).then(function () {
      log.info('deleted from the download dir: ' + name);
      return { ok: true };
    });
  });
}

function clear() {
  return list().then(function (result) {
    var idle = result.items.filter(function (i) { return !i.infoHash; });
    return Promise.all(idle.map(function (i) {
      return fs.promises.rm(path.join(result.dir, i.name), { recursive: true, force: true })
        .then(function () { return i.bytes; }, function (err) {
          log.warn('cannot delete ' + i.name + ': ' + err.message);
          return null;
        });
    })).then(function (freed) {
      var done = freed.filter(function (b) { return b !== null; });
      log.info('download dir cleared: ' + done.length + ' entries');
      return { removed: done.length, freedBytes: done.reduce(function (s, b) { return s + b; }, 0) };
    });
  });
}

// For the download dir setting: absolute, and writable (the directory, or the
// closest existing parent it would be created in)
function checkDir(dir) {
  return Promise.resolve().then(function () {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
      throw failure('INVALID', 'The download directory must be an absolute path');
    }
    var target = path.resolve(dir), existing = target;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      existing = path.dirname(existing);
    }
    return fs.promises.stat(existing).then(function (st) {
      if (existing === target && !st.isDirectory()) {
        return false;
      }
      return fs.promises.access(existing, fs.constants.W_OK).then(function () { return true; }, function () { return false; });
    }, function () {
      return false;
    }).then(function (writable) {
      return system.disk(target).then(function (d) {
        return {
          path: target,
          exists: existing === target,
          writable: writable,
          free: d ? d.free : null,
          total: d ? d.total : null
        };
      });
    });
  });
}

module.exports = {
  list: list,
  remove: remove,
  clear: clear,
  checkDir: checkDir
};
