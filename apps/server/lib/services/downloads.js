'use strict';

// Downloads (docs/media-server-plan.md §4.2): the record of every torrent the
// server knows, running or not. The torrent client (lib/torrents/client.js)
// owns the lifecycle and is the only writer; this service keeps the rows
// valid (hash, state, intent) and fills the defaults.

var errors = require('./errors');

var HASH = /^[0-9a-f]{40}$/,
  STATES = ['queued', 'downloading', 'seeding', 'paused', 'completed', 'checking', 'error'],
  INTENTS = ['stream', 'download'];

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ now?: function(): Date }} options
 */
module.exports = function downloadsService(repositories, options) {
  var repo = repositories.downloads,
    now = options.now || function () { return new Date(); };

  function checkHash(infoHash) {
    if (typeof infoHash !== 'string' || !HASH.test(infoHash)) {
      throw errors.invalid('Not an info hash: ' + infoHash);
    }
  }

  function check(patch) {
    if (patch.state !== undefined && STATES.indexOf(patch.state) === -1) {
      throw errors.invalid('Unknown download state: ' + patch.state);
    }
    if (patch.intent !== undefined && INTENTS.indexOf(patch.intent) === -1) {
      throw errors.invalid('Unknown download intent: ' + patch.intent);
    }
    if (patch.selectedFiles !== undefined && patch.selectedFiles !== null &&
      (!Array.isArray(patch.selectedFiles) || patch.selectedFiles.some(function (p) { return typeof p !== 'string'; }))) {
      throw errors.invalid('selectedFiles must be a list of paths, or null');
    }
  }

  return {
    list: function () {
      return repo.list();
    },

    get: function (infoHash) {
      return repo.find(infoHash);
    },

    // A new row (state, intent and saveDir required); the existing one if the
    // hash is already known
    create: function (record) {
      return Promise.resolve().then(function () {
        checkHash(record.infoHash);
        check(record);
        if (!record.state || !record.intent || !record.saveDir) {
          throw errors.invalid('A download needs a state, an intent and a save dir');
        }
        var row = Object.assign({
          name: null, magnet: null, torrentFile: null, error: null, selectedFiles: null, sizeBytes: null,
          doneBytes: 0, uploadedBytes: 0, addedBy: null, profileId: null, titleRef: null,
          removeWhenWatched: false, label: null, queueOrder: null, forced: false, seedRatio: null, seedMinutes: null,
          downLimitKBps: null, upLimitKBps: null, trackers: null, addedAt: now(), completedAt: null, lastActiveAt: null
        }, record);
        return repo.insert(row).then(function (inserted) {
          return inserted || repo.find(record.infoHash);
        });
      });
    },

    update: function (infoHash, patch) {
      return Promise.resolve().then(function () {
        checkHash(infoHash);
        check(patch);
        var fields = Object.assign({}, patch);
        delete fields.infoHash;
        return Object.keys(fields).length ? repo.update(infoHash, fields) : repo.find(infoHash);
      });
    },

    remove: function (infoHash) {
      return repo.remove(infoHash);
    }
  };
};
