'use strict';

// mDNS on every network of a machine with several (Ethernet + Wi-Fi, VPN,
// Docker bridges), for the server's advertiser and Node clients' browsers.
// multicast-dns (under bonjour-service) sends each packet through the default
// multicast interface only, so a query that came in on another network is
// answered on the wrong one and never reaches the asker. Avahi and Apple's
// Bonjour send on every interface; this does the same.
//
//   const mdnsSocket = require('@playpex/protocol/mdns')
//   const socket = mdnsSocket.create()
//   const bonjour = new Bonjour({ socket })          // multicast-dns binds it
//   mdnsSocket.sendOnEveryInterface(bonjour.server.mdns, socket)
//
// Node only (dgram, os): not exported by index.js, which browsers load too.

var dgram = require('dgram'),
  os = require('os');

function create() {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true });
}

// The first IPv4 address of each interface that isn't loopback
function interfaces() {
  var nets = os.networkInterfaces();
  return Object.keys(nets).map(function (name) {
    return nets[name].filter(function (a) { return a.family === 'IPv4' && !a.internal; })[0];
  }).filter(Boolean).map(function (a) { return a.address; });
}

// Wraps mdns.send (used by respond() and query()): a packet for the multicast
// group goes out once per interface, one after the other, since the outgoing
// interface is a socket option. Packets to one address (unicast replies) are
// unchanged. Send errors on an interface that is down are ignored.
function sendOnEveryInterface(mdns, socket) {
  var send = mdns.send;
  mdns.send = function (value, rinfo, cb) {
    if (typeof rinfo === 'function') {
      cb = rinfo;
      rinfo = null;
    }
    cb = cb || function () {};
    var targets = interfaces();
    if (rinfo || targets.length < 2 || !socket.setMulticastInterface) {
      return send(value, rinfo, cb);
    }
    // multicast-dns binds the socket when it starts; the interface can only
    // be chosen once it is bound
    try {
      socket.address();
    } catch (e) {
      socket.once('listening', function () { mdns.send(value, null, cb); });
      return;
    }
    var i = 0, firstError = null, sent = 0;
    (function next() {
      if (i === targets.length) {
        return cb(sent ? null : firstError);
      }
      var address = targets[i++];
      try {
        socket.setMulticastInterface(address);
      } catch (e) {
        firstError = firstError || e;
        return next();
      }
      send(value, null, function (err) {
        if (err) {
          firstError = firstError || err;
        } else {
          sent++;
        }
        next();
      });
    })();
  };
}

module.exports = {
  create: create,
  interfaces: interfaces,
  sendOnEveryInterface: sendOnEveryInterface
};
