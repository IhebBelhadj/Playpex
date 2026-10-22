'use strict';

// Engine-neutral helpers on torrent files and their data on disk: where a
// file lives, whether a selection is complete, deleting a torrent's data.
// Paths inside a torrent come from its metainfo: they are never trusted to
// stay inside the save path.

var fs = require('fs'),
  path = require('path');

// <savePath>/<file path>, or null when the path would leave savePath
function location(savePath, filePath) {
  var root = path.resolve(savePath),
    full = path.resolve(root, filePath);
  return full.indexOf(root + path.sep) === 0 ? full : null;
}

// The top-level entries of the save path a torrent writes (a folder for a
// multi-file torrent, the file for a single-file one)
function topEntries(files) {
  var seen = {};
  (files || []).forEach(function (f) {
    var top = f.path.split(/[\\/]/)[0];
    if (top && top !== '.' && top !== '..') {
      seen[top] = true;
    }
  });
  return Object.keys(seen);
}

// Deletes a torrent's files from savePath, then the folders they leave empty
function deleteData(savePath, files) {
  var dirs = {};
  return Promise.all((files || []).map(function (f) {
    var full = location(savePath, f.path);
    if (!full) {
      return null;
    }
    for (var dir = path.dirname(full); dir.indexOf(path.resolve(savePath) + path.sep) === 0; dir = path.dirname(dir)) {
      dirs[dir] = true;
    }
    return fs.promises.rm(full, { force: true });
  })).then(function () {
    // deepest first; a folder that still holds something stays
    return Object.keys(dirs).sort(function (a, b) { return b.length - a.length; }).reduce(function (chain, dir) {
      return chain.then(function () { return fs.promises.rmdir(dir).catch(function () {}); });
    }, Promise.resolve());
  });
}

// Whether a file of a finished download is still on disk at its size (the
// admin may have deleted or moved it since)
function present(savePath, file) {
  var full = location(savePath, file.path);
  if (!full) {
    return Promise.resolve(false);
  }
  return fs.promises.stat(full).then(function (st) {
    return st.isFile() && st.size === file.size;
  }, function () {
    return false;
  });
}

module.exports = {
  location: location,
  topEntries: topEntries,
  deleteData: deleteData,
  present: present
};
