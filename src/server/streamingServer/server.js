#!/usr/bin/env node
'use strict';

var STATIC_OPTIONS = { maxAge: 3600000 };

var

  http = require('http'),
  path = require('path'),
  cors = require('cors'),
  serveStatic = require('serve-static'),
  socket = require('./lib/socket'),
  remoteSocket = require('./lib/remoteSocketManager'),
  api = require('./lib/api')
    .use(serveStatic(path.join(__dirname, 'torrents'), STATIC_OPTIONS))
    .use(cors());

var server = http.createServer(api);
socket(server);
var port = process.STREAMER_PORT || 9000;

server.listen(port).on('error', function (e) {
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
    throw e;
  }
  console.error('Port ' + port + ' is busy. Trying the next available port...');
  server.listen(++port);
}).on('listening', function () {
  console.log('streamer Listening on http://localhost:' + port);
});

var socketServer = http.createServer();
remoteSocket(socketServer);
var remotePort = process.env.REMOTE_PORT || 9500;

socketServer.listen(remotePort).on('error', function (e) {
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
    throw e;
  }
  console.error('Port ' + remotePort + ' is busy. Trying the next available port...');
  socketServer.listen(++remotePort);
}).on('listening', function () {
  console.log('Remote manager listening on http://localhost:' + remotePort);
});








