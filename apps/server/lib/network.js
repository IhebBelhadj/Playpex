'use strict';

// The machine's LAN interfaces and addresses, for what the server tells others about itself (its `urls`, the
// dashboard's links and QR codes, YouTube casting's announcements): container and VPN bridges left out, and the
// address the machine reaches the outside from (its default route) first.

var os = require('os'),
  dgram = require('dgram');

// Docker / Podman / libvirt / VirtualBox / VMware / WSL bridges and VPNs (Linux, macOS and Windows names)
var VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|incus|lxc|lxd|tun|tap|utun|wg|zt|tailscale|cni|flannel|kube|podman|vEthernet|VMware|VirtualBox|Hyper-V|Loopback)/i;

function ipv4(a) {
  return (a.family === 'IPv4' || a.family === 4) && !a.internal;
}

/** The machine's LAN interfaces (IPv4, not loopback, not a container or VPN bridge) */
function lanInterfaces() {
  var all = os.networkInterfaces(), names = [];
  Object.keys(all).forEach(function (name) {
    if (!VIRTUAL.test(name) && (all[name] || []).some(ipv4)) {
      names.push(name);
    }
  });
  return names;
}

/**
 * The LAN interfaces' IPv4 addresses; `primary` (the default route's address) first when it is one of them. With no
 * such interface (a machine on a bridge only), every non-loopback IPv4 address, as before
 */
function lanAddresses(primary) {
  var all = os.networkInterfaces(), out = [];
  lanInterfaces().forEach(function (name) {
    (all[name] || []).filter(ipv4).forEach(function (a) {
      out.push(a.address);
    });
  });
  if (!out.length) {
    Object.keys(all).forEach(function (name) {
      (all[name] || []).filter(ipv4).forEach(function (a) {
        out.push(a.address);
      });
    });
  }
  if (primary && out.indexOf(primary) > 0) {
    out.splice(out.indexOf(primary), 1);
    out.unshift(primary);
  }
  return out;
}

/**
 * The address this machine sends from to reach the internet (a UDP socket "connected" to a public address: the
 * kernel picks the route, no packet leaves). Resolves null when there is no route (offline) or after 500 ms
 */
function primaryAddress() {
  return new Promise(function (resolve) {
    var socket, done = false;
    function finish(address) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve(address || null);
    }
    var timer = setTimeout(function () { finish(null); }, 500);
    try {
      socket = dgram.createSocket('udp4');
      socket.on('error', function () { finish(null); });
      socket.connect(53, '1.1.1.1', function () {
        var address = null;
        try { address = socket.address().address; } catch (e) { /* not connected */ }
        finish(address === '0.0.0.0' ? null : address);
      });
    } catch (e) {
      finish(null);
    }
  });
}

module.exports = {
  VIRTUAL: VIRTUAL,
  lanInterfaces: lanInterfaces,
  lanAddresses: lanAddresses,
  primaryAddress: primaryAddress
};
