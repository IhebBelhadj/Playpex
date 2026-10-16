'use strict';

var torrentStream = require('torrent-stream');
var _ = require('lodash');
var net = require('net');
var log = require('./logger').child('torrent');

var BITTORRENT_PORT = 6881;
var tryPort = new Promise(function (resolve) {
  function findPort(port) {
    
    var s = net.createServer();
    
    s.listen(port, function() {
      var port = s.address().port;
      s.close(function() {
        resolve(port);
      });
    });

    s.on('error', function() {
      findPort(0);
    });

  }
  findPort(BITTORRENT_PORT);
});

module.exports = function (torrent, opts) {
  var engine = torrentStream(torrent, _.cloneDeep(opts));

  engine.once('verifying', function () {
    var totalPieces = engine.torrent.pieces.length;
    var verifiedPieces = 0;

    log.debug('verifying ' + engine.infoHash);
    engine.files.forEach(function (file, i) {
      log.debug(i + ' ' + file.name);
    });

    engine.on('verify', function () {
      if (++verifiedPieces === totalPieces) {
        engine.emit('finished');
        log.info('finished ' + engine.infoHash);
      }
    });
  });

  engine.once('ready', function () {
    log.info('ready ' + engine.infoHash);
    engine.ready = true;

    // select the largest file
    var file = engine.files.reduce(function (a, b) {
      return a.length > b.length ? a : b;
    });
    file.select();
  });

  engine.on('uninterested', function () {
    log.debug('uninterested ' + engine.infoHash);
  });

  engine.on('interested', function () {
    log.debug('interested ' + engine.infoHash);
  });

  engine.on('idle', function () {
    log.debug('idle ' + engine.infoHash);
  });

  engine.on('error', function (e) {
    log.warn('error ' + engine.infoHash + ': ' + e);
  });

  engine.once('destroyed', function () {
    log.info('destroyed ' + engine.infoHash);
    engine.removeAllListeners();
  });

  tryPort.then(function (port) {
    engine.listen(port, function () {
      log.debug('listening ' + engine.infoHash + ' on port ' + engine.port);
    });
  });

  return engine;
};
