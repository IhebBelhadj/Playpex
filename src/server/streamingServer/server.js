#!/usr/bin/env node
'use strict';

// Since Node 17 dns.lookup() returns addresses in resolver order. On IPv6 /
// NAT64 networks that's an IPv6 address first, which the (IPv4-only) DHT and
// UDP tracker sockets can't send to: the DHT never bootstraps and torrents only
// get the few peers one tracker hands out. Must run before any lookup.
require('dns').setDefaultResultOrder('ipv4first');

// Local secrets (TMDB_API_KEY, ...) from the repo's .env; real environment
// variables win. Packaged builds don't ship a .env, use the environment there.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

var

  http = require('http'),
  cors = require('cors'),
  socket = require('./lib/socket'),
  remoteSocket = require('./lib/remoteSocketManager'),
  api = require('./lib/api')
    .use(cors());

var server = http.createServer(api);
socket(server);
var port = process.env.STREAMER_PORT || 9000;

server.listen(port).on('error', function (e) {
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
    throw e;
  }
  console.error('Port ' + port + ' is busy. Trying the next available port...');
  server.listen(++port);
}).on('listening', function () {
  console.log('streamer Listening on http://localhost:' + port);
});

// Resolves with the port actually bound (it moves up when 9000 is taken);
// electron.js hands it to the UI
module.exports = {
  ready: new Promise(function (resolve) {
    server.once('listening', function () {
      resolve(server.address().port);
    });
  })
};

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








