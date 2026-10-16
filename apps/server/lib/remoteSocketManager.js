'use strict'

module.exports = function (server) {
  var io = require('socket.io').listen(server),
    _ = require('lodash'),
    progress = require('./progressbar'),
    store = require('./store');

  io.sockets.on('connection', function (socket) {
    // Listen to client emitted events
    socket.on('event', function (payload) {

    });
  });


  // Emit events to client here
  if(false) io.sockets.emit('event', data);

};
