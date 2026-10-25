'use strict';

// Direct downloads (docs/search-plan.md decision C): files fetched over HTTP,
// not torrents. lib/downloads/direct.js owns the lifecycle and is the only
// writer; this service keeps the rows valid and fills the defaults.

var crypto = require('crypto'),
  errors = require('./errors');

var STATES = ['queued', 'downloading', 'paused', 'completed', 'error'],
  KINDS = ['file', 'hls'];

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ now?: function(): Date }} options
 */
module.exports = function directDownloadsService(repositories, options) {
  var repo = repositories.directDownloads,
    now = options.now || function () { return new Date(); };

  function check(patch) {
    if (patch.state !== undefined && STATES.indexOf(patch.state) === -1) {
      throw errors.invalid('Unknown direct download state: ' + patch.state);
    }
    if (patch.kind !== undefined && KINDS.indexOf(patch.kind) === -1) {
      throw errors.invalid('Unknown direct download kind: ' + patch.kind);
    }
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name || /[\\/\0]/.test(patch.name) || patch.name[0] === '.')) {
      throw errors.invalid('A file name without folders: ' + patch.name);
    }
  }

  return {
    list: function () {
      return repo.list();
    },

    get: function (id) {
      return repo.find(id);
    },

    // name, kind, url, by and saveDir required
    create: function (record) {
      return Promise.resolve().then(function () {
        check(record);
        if (!record.name || !record.kind || !record.url || !record.by || !record.saveDir) {
          throw errors.invalid('A direct download needs a name, a kind, a URL, its owner and a save dir');
        }
        return repo.insert(Object.assign({
          id: crypto.randomUUID(), state: 'queued', headers: null, sizeBytes: null, doneBytes: 0, error: null,
          addedAt: now(), completedAt: null
        }, record));
      });
    },

    update: function (id, patch) {
      return Promise.resolve().then(function () {
        check(patch);
        var fields = Object.assign({}, patch);
        delete fields.id;
        return Object.keys(fields).length ? repo.update(id, fields) : repo.find(id);
      });
    },

    remove: function (id) {
      return repo.remove(id);
    }
  };
};
