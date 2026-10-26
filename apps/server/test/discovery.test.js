'use strict';

// LAN discovery (lib/discovery.js, plan §5.7): the real server with throwaway
// data dirs, its UDP responder on a free port, and mDNS on the real network
// (a short-lived `_playpex._tcp` service named "Playpex test …").
//
//   npm test -w apps/server

var test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path'),
  dgram = require('dgram');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playpex-discovery-'));
process.env.PLAYPEX_CONFIG_DIR = path.join(tmp, 'config');
process.env.PLAYPEX_CACHE_DIR = path.join(tmp, 'cache');
process.env.PLAYPEX_LOG_DIR = path.join(tmp, 'logs');
delete process.env.PLAYPEX_DISCOVERY;
delete process.env.PLAYPEX_LAN_SHARING;

var protocol = require('@playpex/protocol'),
  mdnsSocket = require('@playpex/protocol/mdns'),
  Bonjour = require('bonjour-service').Bonjour,
  server = require('..'),
  discovery = require('../lib/discovery');

var NAME = 'Playpex test ' + process.pid,
  HOST = 'playpex-test-' + process.pid,   // network.hostname: never the real playpex.local
  udpPort = null,
  info = null,
  bonjour = null,
  browser = null;

function freeUdpPort() {
  return new Promise(function (resolve) {
    var s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', function () {
      var port = s.address().port;
      s.close(function () { resolve(port); });
    });
  });
}

// Sends `message` to the responder, resolves with the parsed answer or null
// when none comes within `ms`
function ask(message, ms) {
  return new Promise(function (resolve) {
    var s = dgram.createSocket('udp4'), timer;
    s.on('message', function (msg) {
      clearTimeout(timer);
      s.close();
      resolve(JSON.parse(msg.toString('utf8')));
    });
    s.bind(0, function () {
      s.send(Buffer.from(message), udpPort, '127.0.0.1');
      timer = setTimeout(function () { s.close(); resolve(null); }, ms || 1500);
    });
  });
}

// Resolves with the first mDNS service matching `check`, or rejects after `ms`
function waitFor(event, check, ms) {
  return new Promise(function (resolve, reject) {
    function on(service) {
      if (check(service)) {
        clearTimeout(timer);
        browser.removeListener(event, on);
        resolve(service);
      }
    }
    var timer = setTimeout(function () {
      browser.removeListener(event, on);
      reject(new Error('no mDNS "' + event + '" matching within ' + ms + ' ms'));
    }, ms || 8000);
    browser.on(event, on);
    if (event === 'up') {
      browser.services.forEach(on);
      browser.update();
    }
  });
}

function waitState(check, ms) {
  var until = Date.now() + (ms || 5000);
  return new Promise(function (resolve, reject) {
    (function poll() {
      var s = discovery.status();
      if (check(s)) {
        return resolve(s);
      }
      if (Date.now() > until) {
        return reject(new Error('discovery status: ' + JSON.stringify(s)));
      }
      setTimeout(poll, 100);
    })();
  });
}

test.before(function () {
  return freeUdpPort().then(function (port) {
    udpPort = port;
    server.settings.load();
    server.settings.update({ general: { serverName: NAME }, network: { hostname: HOST } });
    return server.start({ port: 0, console: false, library: false, discoveryPort: udpPort });
  }).then(function (started) {
    info = started;
    var sock = mdnsSocket.create();
    bonjour = new Bonjour({ socket: sock }, function () {});
    mdnsSocket.sendOnEveryInterface(bonjour.server.mdns, sock);
    browser = bonjour.find({ type: protocol.DISCOVERY.MDNS_TYPE, protocol: 'tcp' });
  });
});

test.after(function () {
  browser.stop();
  bonjour.destroy();
  return server.stop().then(function () {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('UDP responder answers the query, and only the query', function () {
  // `host` is set once the name is claimed (about a second after the start)
  return waitState(function (s) { return s.mdns.state === 'advertising'; }, 8000).then(function () {
    return ask(protocol.DISCOVERY.QUERY);
  }).then(function (answer) {
    assert.deepEqual(answer, {
      id: info.id, name: NAME, host: HOST + '.local', port: info.port,
      apiVersion: protocol.API_VERSION, minApiVersion: protocol.MIN_API_VERSION,
      version: require('../package.json').version
    });
    return ask('hello', 600);
  }).then(function (answer) {
    assert.equal(answer, null);
    return ask('PLAYPEX_DISCOVER 1 and more', 600);
  }).then(function (answer) {
    assert.equal(answer, null);
    assert.equal(discovery.status().udp.state, 'listening');
  });
});

test('only local addresses get an answer', function () {
  ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.20', '169.254.3.4', '100.100.1.1', '::1',
    'fd12::1', 'fe80::1'].forEach(function (a) {
    assert.equal(discovery.isLocalAddress(a), true, a);
  });
  ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '11.0.0.1'].forEach(function (a) {
    assert.equal(discovery.isLocalAddress(a), false, a);
  });
});

test('mDNS advertises _playpex._tcp with the id, versions and name', function () {
  return waitFor('up', function (s) { return s.txt && s.txt.id === info.id; }).then(function (service) {
    assert.equal(service.name, NAME);
    assert.equal(service.port, info.port);
    assert.equal(service.txt.v, String(protocol.API_VERSION));
    assert.equal(service.txt.ver, require('../package.json').version);
    assert.equal(service.txt.name, NAME);
    assert.equal(service.host, HOST + '.local');
    return waitState(function (s) { return s.mdns.state === 'advertising'; });
  }).then(function (s) {
    assert.equal(s.enabled, true);
    assert.equal(s.mdns.name, NAME);
    assert.equal(s.mdns.host, HOST + '.local');
    assert.equal(discovery.hostName(), HOST + '.local');
  });
});

// The A records of `fqdn` as another device on the network sees them
function resolve(fqdn) {
  return new Promise(function (done) {
    var found = [];
    function on(packet) {
      packet.answers.concat(packet.additionals || []).forEach(function (rr) {
        if (rr.type === 'A' && String(rr.name).toLowerCase() === fqdn) {
          found.push(rr.data);
        }
      });
    }
    bonjour.server.mdns.on('response', on);
    bonjour.server.mdns.query(fqdn, 'A');
    setTimeout(function () {
      bonjour.server.mdns.removeListener('response', on);
      done(found);
    }, 1200);
  });
}

test('the name on the network resolves to this machine, and the server accepts it as a Host', function () {
  return resolve(HOST + '.local').then(function (addresses) {
    assert.ok(addresses.length > 0, 'no A record for ' + HOST + '.local');
    var mine = mdnsSocket.interfaces();
    assert.ok(addresses.some(function (a) { return mine.indexOf(a) !== -1; }), addresses.join(', '));
    var middleware = require('../lib/middleware');
    assert.equal(middleware.allowedHost(HOST + '.local'), true);
    assert.equal(middleware.allowedHost(HOST + '-2.local'), true);
    assert.equal(middleware.allowedHost('evil.example'), false);
  });
});

test('a name another device answers to: the server takes <name>-2', function () {
  var clash = 'playpex-clash-' + process.pid;
  // a device elsewhere (192.0.2.5: not this machine) that answers to it
  function other(query) {
    query.questions.forEach(function (q) {
      if (String(q.name).toLowerCase() === clash + '.local') {
        bonjour.server.mdns.respond({ answers: [{ name: clash + '.local', type: 'A', ttl: 120, data: '192.0.2.5' }] });
      }
    });
  }
  bonjour.server.mdns.on('query', other);
  server.settings.update({ network: { hostname: clash } });
  return discovery.refresh().then(function () {
    return waitState(function (s) { return s.mdns.state === 'advertising'; }, 8000);
  }).then(function (s) {
    assert.equal(s.mdns.host, clash + '-2.local');
    return ask(protocol.DISCOVERY.QUERY);
  }).then(function (answer) {
    assert.equal(answer.host, clash + '-2.local');
  }).finally(function () {
    bonjour.server.mdns.removeListener('query', other);
    server.settings.update({ network: { hostname: HOST } });
    return discovery.refresh().then(function () {
      return waitState(function (s) { return s.mdns.state === 'advertising'; }, 8000);
    });
  });
});

test('the setting takes a DNS label only', function () {
  var settings = server.settings;
  assert.throws(function () { settings.update({ network: { hostname: 'my server' } }); });
  assert.throws(function () { settings.update({ network: { hostname: '-bad' } }); });
  settings.update({ network: { hostname: 'Living-Room.local' } });
  assert.equal(settings.get('network.hostname'), 'living-room');
  settings.update({ network: { hostname: HOST } });
});

test('a new server name is advertised at once', function () {
  var renamed = NAME + ' renamed';
  server.settings.update({ general: { serverName: renamed } });
  return discovery.refresh().then(function () {
    return waitFor('up', function (s) { return s.txt && s.txt.id === info.id && s.name === renamed; });
  }).then(function () {
    return ask(protocol.DISCOVERY.QUERY);
  }).then(function (answer) {
    assert.equal(answer.name, renamed);
    server.settings.update({ general: { serverName: NAME }, network: { hostname: HOST } });
    return discovery.refresh();
  });
});

test('after a restart on another port, both ways announce the new port', function () {
  var before = info.port;
  return server.restart().then(function (restarted) {
    info = restarted;
    assert.notEqual(info.port, before);
    return ask(protocol.DISCOVERY.QUERY);
  }).then(function (answer) {
    assert.equal(answer.port, info.port);
    return waitFor('up', function (s) { return s.txt && s.txt.id === info.id && s.port === info.port; });
  });
});

test('turned off: no answers, goodbye sent, reason in the status', function () {
  server.settings.update({ network: { discovery: false } });
  var gone = waitFor('down', function (s) { return s.txt && s.txt.id === info.id; });
  return discovery.refresh().then(function () {
    var s = discovery.status();
    assert.equal(s.enabled, false);
    assert.equal(s.reason, 'disabled');
    assert.equal(s.mdns.state, 'off');
    return gone;
  }).then(function () {
    return ask(protocol.DISCOVERY.QUERY, 600);
  }).then(function (answer) {
    assert.equal(answer, null);
    server.settings.update({ network: { discovery: true } });
    return discovery.refresh();
  }).then(function () {
    return waitState(function (s) { return s.udp.state === 'listening'; });
  });
});

test('each network gets only its own addresses in an answer', function () {
  var wifi = { address: '10.80.232.68', addresses: ['10.80.232.68', '10.80.232.67'] },
    mine = { '10.80.232.68': true, '10.80.232.67': true, '172.18.0.1': true, '10.99.0.1': true },
    packet = {
      answers: [{ name: 'playpex.local', type: 'A', data: '10.80.232.68' }, { name: 'playpex.local', type: 'A', data: '172.18.0.1' }, { name: 's', type: 'SRV', data: {} }],
      additionals: [{ name: 'playpex.local', type: 'A', data: '10.99.0.1' }, { name: 'other.local', type: 'A', data: '192.0.2.5' }]
    },
    copy = mdnsSocket.forNetwork(packet, wifi, mine);
  assert.deepEqual(copy.answers.map(function (rr) { return rr.data; }), ['10.80.232.68', {}]);
  // a Docker bridge's or a VPN's address never reaches the Wi-Fi; another device's record is left alone
  assert.deepEqual(copy.additionals.map(function (rr) { return rr.data; }), ['192.0.2.5']);
  assert.equal(packet.answers.length, 3, 'the packet itself is not changed');
});
