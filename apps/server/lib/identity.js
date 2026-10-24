'use strict';

// Who this server is: <config>/server.json { id } (a UUID made on the first
// start, never changed), plus its name and versions. Clients recognise a
// server by its id, not by its address, so DHCP changes don't break pairing
// (docs/server-separation-plan.md §6.2).

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  paths = require('./paths'),
  settings = require('./settings');

var FILE = path.join(paths.config, 'server.json');

// Bumped only on breaking API changes; clients send theirs (plan §6.1).
// The protocol's, so the server's answers and its version checks agree
var API_VERSION = require('@playpex/protocol').API_VERSION,
  MIN_API_VERSION = require('@playpex/protocol').MIN_API_VERSION;

var id = null;

function load() {
  if (id) {
    return id;
  }
  try {
    var data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (typeof data.id === 'string' && data.id) {
      id = data.id;
      return id;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      require('./logger').child('server').warn('server.json unreadable, making a new server id', { err: e });
    }
  }
  id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ id: id }, null, 2) + '\n');
  return id;
}

function info() {
  return {
    id: load(),
    name: settings.get('general.serverName'),
    version: require('../package.json').version,
    apiVersion: API_VERSION,
    minApiVersion: MIN_API_VERSION
  };
}

module.exports = {
  API_VERSION: API_VERSION,
  load: load,
  info: info
};
