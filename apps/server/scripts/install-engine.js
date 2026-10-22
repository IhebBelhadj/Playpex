#!/usr/bin/env node
'use strict';

// Installs an optional torrent engine (a sidecar program: rqbit,
// playpex-torrentd) from its pinned release, SHA-256 checked, into
// <cache>/engines/<id> where the server finds it. The dashboard does the same
// (Settings › Downloads › Install).
//
//   npm run install:engine -- rqbit
//   npm run install:engine -- rqbit --remove

var engines = require('../lib/torrents/engines'),
  id = process.argv[2];

if (!id || /^-/.test(id)) {
  console.error('usage: install-engine <id> [--remove]   (engines: ' + engines.describe()
    .filter(function (e) { return e.installed !== 'builtin'; }).map(function (e) { return e.id; }).join(', ') + ')');
  process.exit(2);
}

var log = { info: function (m) { console.log(m); }, warn: function (m) { console.warn(m); } };
(process.argv.indexOf('--remove') !== -1 ? engines.uninstall(id).then(function () {
  console.log(id + ' removed');
}) : engines.install(id, { log: log }).then(function (r) {
  console.log(id + ' ' + r.version + ': ' + r.path);
})).catch(function (err) {
  console.error(err.message);
  process.exit(1);
});
