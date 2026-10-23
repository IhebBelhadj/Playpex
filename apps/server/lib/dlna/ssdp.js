'use strict';

// SSDP (UPnP Device Architecture 1.0 §1) for the DLNA server: on multicast
// 239.255.255.250:1900, NOTIFY ssdp:alive when starting and every 15 minutes
// (max-age 1800 s: an announcement at half of it), ssdp:byebye when stopping,
// and answers to M-SEARCH. Each network interface announces its own address
// in LOCATION; an M-SEARCH is answered with the address of the interface on
// the asker's subnet. Written on dgram, like lib/discovery.js (decision H).
//
//   ssdp.start({ udn, port, server, onSearch, onRenderer, ssdpPort }) → { stop() → Promise, status() }
//
// Only private / loopback / link-local senders get an answer, 20 per 10 s
// per address. `onRenderer(address, location)`: a MediaRenderer announced
// itself (for the dashboard's "seen by" names).

var dgram = require('dgram'),
  os = require('os'),
  net = require('net'),
  discovery = require('../discovery'),
  log = require('../logger').child('dlna');

var GROUP = '239.255.255.250',
  PORT = 1900,
  MAX_AGE = 1800,
  ANNOUNCE_MS = MAX_AGE * 1000 / 2,
  RATE_WINDOW_MS = 10000,
  RATE_MAX = 20;

var DEVICE = 'urn:schemas-upnp-org:device:MediaServer:1',
  SERVICES = [
    'urn:schemas-upnp-org:service:ContentDirectory:1',
    'urn:schemas-upnp-org:service:ConnectionManager:1',
    'urn:microsoft.com:service:X_MS_MediaReceiverRegistrar:1'
  ];

// IPv4 interfaces that aren't loopback: { address, netmask }
function interfaces() {
  var nets = os.networkInterfaces();
  return Object.keys(nets).reduce(function (all, name) {
    return all.concat(nets[name].filter(function (a) {
      return a.family === 'IPv4' && !a.internal;
    }).map(function (a) {
      return { address: a.address, netmask: a.netmask };
    }));
  }, []);
}

function toInt(ip) {
  return ip.split('.').reduce(function (n, part) { return (n << 8) + Number(part) >>> 0; }, 0) >>> 0;
}

// The interface address to give `remote` (on its subnet), else the first one
function addressFor(remote) {
  if (/^127\./.test(remote)) {
    return '127.0.0.1';
  }
  var all = interfaces();
  if (net.isIPv4(remote)) {
    var r = toInt(remote);
    var same = all.filter(function (a) {
      var mask = toInt(a.netmask);
      return (toInt(a.address) & mask) === (r & mask);
    })[0];
    if (same) {
      return same.address;
    }
  }
  return all.length ? all[0].address : '127.0.0.1';
}

// [nt, usn] of every notification the device makes
function targets(udn) {
  return [
    ['upnp:rootdevice', udn + '::upnp:rootdevice'],
    [udn, udn],
    [DEVICE, udn + '::' + DEVICE]
  ].concat(SERVICES.map(function (s) { return [s, udn + '::' + s]; }));
}

function message(firstLine, headers) {
  return Buffer.from(firstLine + '\r\n' + Object.keys(headers).map(function (k) {
    return k + ': ' + headers[k];
  }).join('\r\n') + '\r\n\r\n');
}

function parse(buffer) {
  var lines = buffer.toString('utf8').split(/\r?\n/),
    headers = {};
  lines.slice(1).forEach(function (line) {
    var i = line.indexOf(':');
    if (i > 0) {
      headers[line.slice(0, i).trim().toUpperCase()] = line.slice(i + 1).trim();
    }
  });
  return { start: lines[0].trim(), headers: headers };
}

// The search targets of the device that match `st`, as [st, usn]
function matching(st, udn) {
  var all = targets(udn);
  if (st === 'ssdp:all') {
    return all;
  }
  // a device or service type of a lower version than ours matches too (§1.2.3)
  var typed = /^(urn:[^:]+:(?:device|service):[^:]+):(\d+)$/.exec(st);
  return all.filter(function (t) {
    if (t[0] === st) {
      return true;
    }
    var mine = typed && /^(urn:[^:]+:(?:device|service):[^:]+):(\d+)$/.exec(t[0]);
    return mine && mine[1] === typed[1] && Number(typed[2]) <= Number(mine[2]);
  }).map(function (t) {
    return [st, t[1]];
  });
}

function start(options) {
  var udn = options.udn,
    port = options.ssdpPort !== undefined ? options.ssdpPort : PORT,
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }),
    state = { state: 'starting', port: port, error: null },
    rate = {},
    timers = [],
    stopped = false;

  function location(address) {
    return 'http://' + address + ':' + options.port + '/dlna/description.xml';
  }

  function allowed(address) {
    var now = Date.now(), entry = rate[address];
    if (!entry || now - entry.since > RATE_WINDOW_MS) {
      if (Object.keys(rate).length > 1000) {
        rate = {};
      }
      entry = rate[address] = { count: 0, since: now };
    }
    return ++entry.count <= RATE_MAX;
  }

  function send(buffer, address, to) {
    if (stopped && !to.byebye) {
      return;
    }
    try {
      if (address) {
        sock.setMulticastInterface(address);
      }
    } catch (e) {
      return;   // that interface went away
    }
    sock.send(buffer, to.port, to.address, function (err) {
      if (err) {
        log.debug('SSDP not sent: ' + err.message, { via: address });
      }
    });
  }

  // NOTIFY every target on every interface ('ssdp:alive' | 'ssdp:byebye')
  function notify(nts) {
    interfaces().forEach(function (iface) {
      targets(udn).forEach(function (t) {
        var headers = { HOST: GROUP + ':' + PORT, NT: t[0], NTS: nts, USN: t[1] };
        if (nts === 'ssdp:alive') {
          headers['CACHE-CONTROL'] = 'max-age=' + MAX_AGE;
          headers.LOCATION = location(iface.address);
          headers.SERVER = options.server;
        }
        send(message('NOTIFY * HTTP/1.1', headers), iface.address, { address: GROUP, port: PORT, byebye: nts === 'ssdp:byebye' });
      });
    });
  }

  function answer(msg, rinfo) {
    var st = msg.headers.ST, mx = parseInt(msg.headers.MX, 10);
    if (!st || !/^"?ssdp:discover"?$/i.test(msg.headers.MAN || '')) {
      return;
    }
    var found = matching(st, udn);
    if (!found.length || !allowed(rinfo.address)) {
      return;
    }
    if (options.onSearch) {
      options.onSearch(rinfo.address, msg.headers['USER-AGENT'] || null);
    }
    var address = addressFor(rinfo.address);
    // spread the answers over MX seconds (≤ 5), at once for a unicast search
    var delay = mx > 0 ? Math.floor(Math.random() * Math.min(mx, 5) * 1000) : 0;
    var timer = setTimeout(function () {
      found.forEach(function (t) {
        send(message('HTTP/1.1 200 OK', {
          'CACHE-CONTROL': 'max-age=' + MAX_AGE,
          DATE: new Date().toUTCString(),
          EXT: '',
          LOCATION: location(address),
          SERVER: options.server,
          ST: t[0],
          USN: t[1],
          'CONTENT-LENGTH': 0
        }), null, { address: rinfo.address, port: rinfo.port });
      });
    }, delay);
    timer.unref();
  }

  sock.on('message', function (buffer, rinfo) {
    if (buffer.length > 8192 || !discovery.isLocalAddress(rinfo.address)) {
      return;
    }
    var msg = parse(buffer);
    if (/^M-SEARCH \* HTTP\/1\.[01]$/i.test(msg.start)) {
      answer(msg, rinfo);
    } else if (/^NOTIFY \* HTTP\/1\.[01]$/i.test(msg.start) && msg.headers.NTS === 'ssdp:alive' &&
      /:device:MediaRenderer:\d+$/.test(msg.headers.NT || '') && msg.headers.LOCATION && options.onRenderer) {
      options.onRenderer(rinfo.address, msg.headers.LOCATION);
    }
  });
  sock.on('error', function (err) {
    if (stopped) {
      return;
    }
    state = {
      state: 'error',
      port: port,
      error: err.code === 'EADDRINUSE' ? 'UDP port ' + port + ' is in use by another program' :
        err.code === 'EACCES' ? 'not allowed to use UDP port ' + port : err.message
    };
    log.warn('SSDP unavailable: ' + state.error + '; DLNA devices can\'t find this server by themselves', { code: err.code });
    try { sock.close(); } catch (e) { /* closed */ }
  });
  sock.bind(port, '0.0.0.0', function () {
    if (stopped) {
      return;
    }
    var joined = 0;
    interfaces().forEach(function (iface) {
      try {
        sock.addMembership(GROUP, iface.address);
        joined++;
      } catch (e) {
        log.debug('SSDP: not joined on ' + iface.address + ': ' + e.message);
      }
    });
    try { sock.setMulticastTTL(2); } catch (e) { /* default TTL */ }
    state = { state: 'listening', port: port, error: null, interfaces: joined };
    // twice: UDP gets lost
    notify('ssdp:alive');
    timers.push(setTimeout(function () { notify('ssdp:alive'); }, 1500), setInterval(function () {
      notify('ssdp:alive');
    }, ANNOUNCE_MS));
    timers.forEach(function (t) { t.unref(); });
    log.info('SSDP on UDP ' + port + ' (' + joined + ' network' + (joined === 1 ? '' : 's') + ')');
  });

  return {
    status: function () {
      return Object.assign({}, state);
    },
    // the server name changed: announce again
    announce: function () {
      if (state.state === 'listening') {
        notify('ssdp:alive');
      }
    },
    stop: function () {
      if (stopped) {
        return Promise.resolve();
      }
      timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
      var wasListening = state.state === 'listening';
      stopped = true;
      return new Promise(function (resolve) {
        if (wasListening) {
          notify('ssdp:byebye');
        }
        // the byebyes leave before the socket closes
        setTimeout(function () {
          try { sock.close(); } catch (e) { /* closed */ }
          resolve();
        }, wasListening ? 200 : 0).unref();
      });
    }
  };
}

module.exports = {
  start: start,
  interfaces: interfaces,
  addressFor: addressFor,
  // tests
  matching: matching,
  DEVICE: DEVICE,
  SERVICES: SERVICES
};
