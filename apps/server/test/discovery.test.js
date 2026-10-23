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
    server.settings.update({ general: { serverName: NAME } });
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
  return ask(protocol.DISCOVERY.QUERY).then(function (answer) {
    assert.deepEqual(answer, {
      id: info.id, name: NAME, port: info.port,
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
    assert.equal(service.host, 'playpex-' + info.id.slice(0, 8) + '.local');
    return waitState(function (s) { return s.mdns.state === 'advertising'; });
  }).then(function (s) {
    assert.equal(s.enabled, true);
    assert.equal(s.mdns.name, NAME);
  });
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
    server.settings.update({ general: { serverName: NAME } });
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
