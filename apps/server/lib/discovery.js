'use strict';

// Finding this server on the LAN (docs/server-separation-plan.md §5.7; the
// wire format is described in @playpex/protocol `DISCOVERY`):
//   1. mDNS / DNS-SD: `_playpex._tcp.local` on the HTTP port in use, TXT
//      id / v / ver / name (bonjour-service, pure JS), on a host name people can
//      type: `network.hostname` + .local (playpex.local; playpex-2.local when
//      another device answers to it), its A records answered by this server
//   2. UDP responder on 28471: a client broadcasts `PLAYPEX_DISCOVER 1`, the
//      server answers it alone with { id, name, port, apiVersion, minApiVersion, version }
//
//   discovery.start(info, { lan, udpPort })   from index.js once listening
//   discovery.stop() → Promise                sends the mDNS goodbye, closes the sockets
//   discovery.refresh()                       after the server name or the setting changed
//   discovery.status()                        for the dashboard's Overview
//   discovery.hostName()                      'playpex.local' once claimed, else null (lib/middleware.js, lib/auth)
//
// Runs only with LAN sharing on, outside recovery mode, and with
// `network.discovery` on. Errors are logged and shown in status(), never thrown:
// a server that can't advertise still serves clients that know its address.

var dgram = require('dgram'),
  net = require('net'),
  protocol = require('@playpex/protocol'),
  mdnsSocket = require('@playpex/protocol/mdns'),
  settings = require('./settings'),
  identity = require('./identity'),
  log = require('./logger').child('discovery');

var DISCOVERY = protocol.DISCOVERY;

// mDNS instance names are one DNS label: at most 63 bytes
var MAX_NAME_BYTES = 63;
// Answers per client address and window, so the responder can't be used to
// flood someone (the answer is ~8× the query)
var RATE_WINDOW_MS = 10000,
  RATE_MAX = 20;

var current = null,     // start()'s arguments, for refresh()
  bonjour = null,
  service = null,
  socket = null,
  rate = {},            // address → { count, since }
  state = initialState();

function initialState() {
  return {
    enabled: false,
    reason: null,       // why it's off: 'lanSharing' | 'disabled' | 'recovery'
    mdns: { state: 'off', name: null, host: null, error: null },
    udp: { state: 'off', port: null, error: null }
  };
}

// Loopback, private (RFC 1918), link-local, CGNAT (Tailscale and the like),
// IPv6 unique-local / link-local: only those get an answer
function isLocalAddress(address) {
  if (net.isIPv4(address)) {
    var p = address.split('.').map(Number);
    return p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  var a = String(address).toLowerCase();
  return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

function allowed(address) {
  var now = Date.now(), entry = rate[address];
  if (!entry || now - entry.since > RATE_WINDOW_MS) {
    // forget old entries now and then, so the table can't grow without end
    if (Object.keys(rate).length > 1000) {
      rate = {};
    }
    entry = rate[address] = { count: 0, since: now };
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

function reply(info) {
  return {
    id: info.id,
    name: settings.get('general.serverName'),
    host: state.mdns.host,
    port: info.port,
    apiVersion: info.apiVersion,
    minApiVersion: info.minApiVersion,
    version: info.version
  };
}

// ── UDP responder ──────────────────────────────────────────────────────────

function startUdp(info, port) {
  state.udp = { state: 'starting', port: port, error: null };
  // reuseAddr: a second Playpex server on this machine (a test) can listen
  // too; broadcasts reach every socket on the port
  var sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket = sock;
  sock.on('error', function (err) {
    if (socket !== sock) {
      return;
    }
    state.udp = {
      state: 'error',
      port: port,
      error: err.code === 'EADDRINUSE' ? 'UDP port ' + port + ' is in use by another program' :
        err.code === 'EACCES' ? 'not allowed to use UDP port ' + port : err.message
    };
    log.warn('UDP discovery unavailable: ' + state.udp.error +
      '; clients still find this server through mDNS or by its address', { code: err.code, port: port });
    try { sock.close(); } catch (e) { /* already closed */ }
    socket = null;
  });
  sock.on('message', function (msg, rinfo) {
    if (msg.length > 64 || msg.toString('utf8').trim() !== DISCOVERY.QUERY) {
      return;
    }
    if (!isLocalAddress(rinfo.address) || !allowed(rinfo.address)) {
      return;
    }
    var answer = Buffer.from(JSON.stringify(reply(info)));
    sock.send(answer, rinfo.port, rinfo.address, function (err) {
      if (err) {
        log.debug('UDP discovery answer not sent: ' + err.message, { to: rinfo.address });
      }
    });
    log.debug('answered a discovery query', { from: rinfo.address });
  });
  sock.bind(port, '0.0.0.0', function () {
    if (socket === sock) {
      state.udp = { state: 'listening', port: port, error: null };
    }
  });
}

// ── mDNS ───────────────────────────────────────────────────────────────────

// The server name as one DNS label (bonjour-service turns dots into dashes)
function instanceName(name, suffix) {
  var tail = suffix ? ' (' + suffix + ')' : '',
    base = String(name || 'Playpex').trim() || 'Playpex';
  while (Buffer.byteLength(base + tail) > MAX_NAME_BYTES) {
    base = base.slice(0, -1);
  }
  return base + tail;
}

// TXT `id=` of `fqdn` in an mDNS answer packet, or undefined
function txtId(packet, fqdn) {
  var found;
  packet.answers.concat(packet.additionals || []).forEach(function (rr) {
    if (rr.type !== 'TXT' || String(rr.name).toLowerCase() !== fqdn.toLowerCase()) {
      return;
    }
    (Array.isArray(rr.data) ? rr.data : [rr.data]).forEach(function (part) {
      var text = Buffer.isBuffer(part) ? part.toString('utf8') : String(part);
      if (text.indexOf('id=') === 0) {
        found = text.slice(3);
      }
    });
  });
  return found;
}

function startMdns(info) {
  var Bonjour;
  try {
    Bonjour = require('bonjour-service').Bonjour;
  } catch (e) {
    state.mdns = { state: 'error', name: null, host: null, error: e.message };
    log.warn('mDNS unavailable: ' + e.message);
    return;
  }
  var instance, sock = mdnsSocket.create();
  try {
    instance = new Bonjour({ socket: sock }, function (err) {
      log.warn('mDNS error: ' + err.message, { code: err.code });
    });
    // answers leave through every interface, not only the default one
    mdnsSocket.sendOnEveryInterface(instance.server.mdns, sock);
  } catch (e) {
    state.mdns = { state: 'error', name: null, host: null, error: e.message };
    log.warn('mDNS unavailable: ' + e.message);
    return;
  }
  bonjour = instance;
  var mdns = instance.server.mdns;
  // multicast-dns throws on an 'error' nobody listens to (5353 refused…)
  mdns.on('error', function (err) {
    if (bonjour !== instance) {
      return;
    }
    state.mdns = { state: 'error', name: state.mdns.name, host: null, error: err.message };
    log.warn('mDNS unavailable: ' + err.message + '; clients still find this server through UDP or by its address',
      { code: err.code });
  });
  mdns.on('warning', function (err) {
    log.debug('mDNS warning: ' + err.message, { code: err.code });
  });
  publish(instance, info, 0);
}

// Is `fqdn` answered by another server? RFC 6762 §8.1 probing: three queries
// 250 ms apart. bonjour-service probes too, but on a conflict it only logs
// and then sends goodbyes for the other server's name, so it's done here.
function probeName(mdns, fqdn, id, callback) {
  var taken = false, sent = 0, timer = null;
  function onResponse(packet) {
    var answered = packet.answers.concat(packet.additionals || []).some(function (rr) {
      return String(rr.name).toLowerCase() === fqdn.toLowerCase();
    });
    if (answered && txtId(packet, fqdn) !== id) {
      taken = true;
    }
  }
  function next() {
    if (sent === 3 || taken) {
      mdns.removeListener('response', onResponse);
      callback(taken);
      return;
    }
    sent++;
    mdns.query(fqdn, 'ANY');
    timer = setTimeout(next, 250);
    timer.unref();
  }
  mdns.on('response', onResponse);
  next();
}

// Every address of this machine: an A record for our name that holds only these
// is ours (this machine's own responder, Avahi or Bonjour, when the OS is called
// that too), not another device's
function ownAddresses() {
  var nets = require('os').networkInterfaces(), all = {};
  Object.keys(nets).forEach(function (n) {
    nets[n].forEach(function (a) { all[a.address.toLowerCase()] = true; });
  });
  return all;
}

// Does another device answer to `fqdn`? Three A queries 250 ms apart (RFC 6762
// §8.1); an answer whose addresses are all this machine's doesn't count.
function probeHost(mdns, fqdn, callback) {
  var taken = false, sent = 0, mine = ownAddresses();
  function onResponse(packet) {
    packet.answers.concat(packet.additionals || []).forEach(function (rr) {
      if ((rr.type === 'A' || rr.type === 'AAAA') && String(rr.name).toLowerCase() === fqdn && !mine[String(rr.data).toLowerCase()]) {
        taken = true;
      }
    });
  }
  function next() {
    if (sent === 3 || taken) {
      mdns.removeListener('response', onResponse);
      callback(taken);
      return;
    }
    sent++;
    mdns.query(fqdn, 'A');
    setTimeout(next, 250).unref();
  }
  mdns.on('response', onResponse);
  next();
}

// The host name: `network.hostname`.local, else -2 … -9 after it; no setting:
// one made from the id (clients still find the server, nobody types it)
function claimHost(instance, info, callback) {
  var label = settings.get('network.hostname');
  if (!label) {
    return callback('playpex-' + info.id.slice(0, 8) + '.local', false);
  }
  (function attempt(n) {
    var fqdn = (n > 1 ? label.slice(0, 61) + '-' + n : label) + '.local';
    probeHost(instance.server.mdns, fqdn, function (taken) {
      if (bonjour !== instance) {
        return;   // stopped meanwhile
      }
      if (!taken) {
        return callback(fqdn, true);
      }
      if (n === 9) {
        log.warn('mDNS: ' + label + '.local to ' + label + '-9.local are all taken on this network');
        return callback('playpex-' + info.id.slice(0, 8) + '.local', false);
      }
      log.info('another device on the network answers to ' + fqdn + ': trying ' + label + '-' + (n + 1) + '.local');
      attempt(n + 1);
    });
  })(1);
}

// attempt 0: the server name; 1: with a piece of the id, when another server
// on the network already uses that name
function publish(instance, info, attempt, host) {
  if (!host) {
    state.mdns = { state: 'starting', name: null, host: null, error: null };
    return claimHost(instance, info, function (fqdn, friendly) {
      state.mdns.host = friendly ? fqdn : null;
      publish(instance, info, attempt, fqdn);
    });
  }
  var name = instanceName(settings.get('general.serverName'), attempt ? info.id.slice(0, 4) : ''),
    fqdn = name.split('.').join('-') + '.' + DISCOVERY.MDNS_SERVICE;

  state.mdns = { state: 'starting', name: name, host: state.mdns.host, error: null };
  probeName(instance.server.mdns, fqdn, info.id, function (taken) {
    if (bonjour !== instance) {
      return;   // stopped meanwhile
    }
    if (taken) {
      if (attempt === 0) {
        log.info('another server on the network is called "' + name + '": advertising with a piece of its id');
        publish(instance, info, 1, host);
      } else {
        state.mdns = { state: 'error', name: name, host: state.mdns.host, error: 'another server on the network uses the name "' + name + '"' };
        log.warn('mDNS: ' + state.mdns.error);
      }
      return;
    }
    announce(instance, info, name, host);
  });
}

function announce(instance, info, name, host) {
  var published;
  try {
    published = instance.publish({
      name: name,
      type: DISCOVERY.MDNS_TYPE,
      protocol: 'tcp',
      port: info.port,
      probe: false,   // probeName() did
      // our own host name (claimHost), so our A records never clash with the
      // ones the OS's responder (Avahi, Bonjour) announces for <hostname>.local
      host: host,
      txt: {
        id: info.id,
        v: String(info.apiVersion),
        ver: info.version,
        name: settings.get('general.serverName')
      }
    });
  } catch (e) {
    state.mdns = { state: 'error', name: name, host: null, error: e.message };
    log.warn('mDNS: not advertised: ' + e.message);
    return;
  }
  service = published;
  published.once('up', function () {
    if (service === published) {
      state.mdns = { state: 'advertising', name: name, host: state.mdns.host, error: null };
      log.info('advertised as "' + name + '" (' + DISCOVERY.MDNS_SERVICE + ', port ' + info.port + ')' +
        (state.mdns.host ? ': http://' + state.mdns.host + ':' + info.port : ''));
    }
  });
  // 'up' follows the first announcement sent
  setTimeout(function () {
    if (service === published && !published.published && state.mdns.state === 'starting') {
      state.mdns = { state: 'error', name: name, host: null, error: 'not announced (no multicast network?)' };
      log.warn('mDNS: ' + state.mdns.error);
    }
  }, 3000).unref();
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function start(info, options) {
  options = options || {};
  current = { info: info, options: options };
  state = initialState();
  if (info.recovery) {
    state.reason = 'recovery';
  } else if (!options.lan) {
    state.reason = 'lanSharing';
  } else if (!settings.get('network.discovery')) {
    state.reason = 'disabled';
  }
  if (state.reason) {
    log.debug('discovery off (' + state.reason + ')');
    return;
  }
  state.enabled = true;
  startUdp(info, options.udpPort !== undefined ? options.udpPort : DISCOVERY.UDP_PORT);
  startMdns(info);
}

function stop() {
  var sock = socket, instance = bonjour;
  socket = null;
  bonjour = null;
  service = null;
  current = null;
  state = initialState();
  if (sock) {
    try { sock.close(); } catch (e) { /* already closed */ }
  }
  if (!instance) {
    return Promise.resolve();
  }
  // goodbye packets (TTL 0) so browsers drop this server at once
  return new Promise(function (resolve) {
    var done = false;
    function finish() {
      if (!done) {
        done = true;
        try {
          instance.destroy();
        } catch (e) { /* socket already gone */ }
        resolve();
      }
    }
    setTimeout(finish, 1000).unref();
    try {
      instance.unpublishAll(finish);
    } catch (e) {
      finish();
    }
  });
}

// The server name or `network.discovery` changed: advertise again
function refresh() {
  if (!current) {
    return Promise.resolve();
  }
  var again = current;
  return stop().then(function () {
    start(again.info, again.options);
  });
}

function status() {
  return JSON.parse(JSON.stringify(state));
}

// The name people can type, once claimed and announced (else null)
function hostName() {
  return state.mdns.state === 'advertising' ? state.mdns.host : null;
}

module.exports = {
  start: start,
  stop: stop,
  refresh: refresh,
  status: status,
  hostName: hostName,
  isLocalAddress: isLocalAddress
};
