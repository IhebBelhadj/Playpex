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

// Each interface that isn't loopback and has an IPv4 address: the first one
// (where multicast leaves from) and all of its addresses
function networks() {
  var nets = os.networkInterfaces();
  return Object.keys(nets).map(function (name) {
    var list = nets[name].filter(function (a) { return !a.internal; }),
      v4 = list.filter(function (a) { return a.family === 'IPv4'; });
    return v4.length ? { address: v4[0].address, addresses: list.map(function (a) { return a.address.toLowerCase(); }) } : null;
  }).filter(Boolean);
}

// The first IPv4 address of each interface that isn't loopback
function interfaces() {
  return networks().map(function (n) { return n.address; });
}

// A copy of `packet` for one network: the A / AAAA records of this machine's
// addresses keep only that network's own. A device on the Wi-Fi asking for
// playpex.local must get the Wi-Fi address, never a Docker bridge's or a VPN's
// that it can't reach (Avahi and Bonjour answer per interface the same way).
function forNetwork(packet, net, mine) {
  if (!packet || (!packet.answers && !packet.additionals)) {
    return packet;
  }
  function keep(rr) {
    if (rr.type !== 'A' && rr.type !== 'AAAA') {
      return true;
    }
    var a = String(rr.data).toLowerCase();
    return !mine[a] || net.addresses.indexOf(a) !== -1;
  }
  var copy = Object.assign({}, packet);
  if (packet.answers) {
    copy.answers = packet.answers.filter(keep);
  }
  if (packet.additionals) {
    copy.additionals = packet.additionals.filter(keep);
  }
  return copy;
}

// Wraps mdns.send (used by respond() and query()): a packet for the multicast
// group goes out once per interface, one after the other, since the outgoing
// interface is a socket option, each copy with only that interface's addresses
// (forNetwork). Packets to one address (unicast replies) are unchanged. Send errors on an interface that is down are ignored.
function sendOnEveryInterface(mdns, socket) {
  var send = mdns.send;
  mdns.send = function (value, rinfo, cb) {
    if (typeof rinfo === 'function') {
      cb = rinfo;
      rinfo = null;
    }
    cb = cb || function () {};
    var nets = networks(), targets = nets.map(function (n) { return n.address; }), mine = {};
    nets.forEach(function (n) { n.addresses.forEach(function (a) { mine[a] = true; }); });
    if (rinfo || !socket.setMulticastInterface) {
      return send(value, rinfo, cb);
    }
    if (targets.length < 2) {
      return send(nets.length ? forNetwork(value, nets[0], mine) : value, null, cb);
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
      var net = nets[i], address = targets[i++];
      try {
        socket.setMulticastInterface(address);
      } catch (e) {
        firstError = firstError || e;
        return next();
      }
      send(forNetwork(value, net, mine), null, function (err) {
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
  forNetwork: forNetwork,
  sendOnEveryInterface: sendOnEveryInterface
};
