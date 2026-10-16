'use strict';

var fs = require('fs'),
  path = require('path'),
  events = require('events'),
  _ = require('lodash'),
  mkdirp = require('mkdirp'),
  readTorrent = require('read-torrent'),
  engine = require('./engine'),
  trackers = require('./trackers'),
  paths = require('./paths'),
  log = require('./logger').child('torrent'),
  configPath = paths.config,
  configFile = path.join(configPath, 'config.json'),
  storageFile = path.join(configPath, 'torrents.json'),
  torrents = {},
  initialized = false,
  options = {
    path: paths.downloads,   // file data (storage.downloadDir, set by init())
    tmp: paths.cache         // torrent-stream keeps <tmp>/torrent-stream/<hash>.torrent
  };

function save() {
  var state = Object.keys(torrents);
  mkdirp(configPath, function (err) {
    if (err) {
      return log.warn('cannot save the torrent list', { err: err });
    }
    fs.writeFile(storageFile, JSON.stringify(state), function (err) {
      if (err) {
        log.warn('cannot save the torrent list', { err: err });
      }
    });
  });
}

var store = _.extend(new events.EventEmitter(), {
  // options.beforeAdd(infoHash) → Error | null: asked only for a torrent the
  // store doesn't hold yet (lib/sessions.js refuses it past maxTorrents)
  add: function (link, callback, addOptions) {
    if (/^(\w{32}|\w{40})$/.test(link)) {
      link = `magnet:?xt=urn:btih:${link}`;
    }

    readTorrent(link, function (err, torrent) {
      if (err) {
        log.warn('cannot read torrent', { err: err });
        return callback(err);
      }
      var infoHash = torrent.infoHash;
      if (torrents[infoHash]) {
        return callback(null, infoHash);
      }
      var refused = addOptions && addOptions.beforeAdd && addOptions.beforeAdd(infoHash);
      if (refused) {
        return callback(refused);
      }

      log.info('adding ' + infoHash);

      // Magnets often carry few or dead trackers: always announce to the
      // maintained public list as well (lib/trackers.js)
      torrent.announce = _.uniq((torrent.announce || []).concat(trackers.list));

      try {
        // Also as an engine option: when torrent-stream has this torrent's
        // metadata cached (/tmp/torrent-stream/<hash>.torrent) it ignores the
        // magnet's trackers and would rely on DHT alone
        var e = engine(torrent, _.extend({}, options, { trackers: torrent.announce }));
        store.emit('torrent', infoHash, e);
        torrents[infoHash] = e;
        save();
        callback(null, infoHash);
      } catch (e) {
        callback(e);
      }
    });
  },
  get: function (infoHash) {
    return torrents[infoHash];
  },
  // Stops the engine and deletes the downloaded data
  remove: function (infoHash) {
    var torrent = torrents[infoHash];
    if (!torrent) {
      return;
    }
    torrent.destroy();
    torrent.remove(function () {
      torrent.emit('destroyed');
    });
    delete torrents[infoHash];
    save();
  },
  // Stops the engine, the downloaded data stays (storage.deleteAfterWatching off)
  close: function (infoHash) {
    var torrent = torrents[infoHash];
    if (!torrent) {
      return;
    }
    delete torrents[infoHash];
    save();
    torrent.destroy(function () {
      torrent.emit('destroyed');
    });
  },
  list: function () {
    return Object.keys(torrents).map(function (infoHash) {
      return torrents[infoHash];
    });
  },
  // Download directory (every start()), plus optional engine options (e.g.
  // connections) from <config>/config.json (read once). The hashes saved in
  // torrents.json are not resumed (resume on start is off on purpose).
  init: function (opts) {
    if (opts && opts.downloads) {
      options = _.extend({}, options, { path: opts.downloads });
    }
    if (initialized) {
      log.info('downloads in ' + options.path);
      return;
    }
    initialized = true;
    try {
      options = _.extend({}, options, JSON.parse(fs.readFileSync(configFile, 'utf8')));
      log.info('engine options from config.json', { options: options });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn('config.json ignored', { err: e });
      }
    }
    log.info('downloads in ' + options.path);
  },
  // Destroys every engine (downloaded data stays), for stop()
  destroyAll: function (callback) {
    var keys = Object.keys(torrents);
    if (!keys.length) {
      return callback();
    }
    var key = keys[0], torrent = torrents[key];
    delete torrents[key];
    torrent.destroy(function () {
      torrent.emit('destroyed');
      store.destroyAll(callback);
    });
  },
  load: function (infoHash) {
    log.info('loading ' + infoHash);
    var e = engine({ infoHash: infoHash }, options);
    store.emit('torrent', infoHash, e);
    torrents[infoHash] = e;
  }
});

module.exports = store;
