#!/usr/bin/env node
'use strict';

// Packs a plugin folder into <id>-<version>.ppx (docs/plugins/README.md), the
// file the dashboard installs (Plugins › Install: upload it, or give its URL,
// e.g. a GitHub release asset). Checks the manifest first, like the server.
//
//   npm run pack:plugin -- <plugin folder> [--out <file or folder>] [--key <key file>]
//   npm run pack:plugin -- --keygen <key file>
//
// --key signs the package with a key file made by --keygen ({ publicKey,
// privateKey }; keep it private). A server whose Settings › Plugins trusts
// that public key installs your signed packages without developer mode.

var fs = require('fs'),
  path = require('path'),
  yazl = require('yazl'),
  signing = require('@playpex/protocol/signing'),
  schemas = require('../lib/plugins/schemas');

var KEEP = /^(playpex-plugin\.json|server\.js|CHANGELOG\.md|README\.md|LICEN[CS]E(\.\w+)?|assets\/.+|i18n\/[^/]+\.json)$/;

// paths as typed where the command ran (npm -w runs this in apps/server)
var CWD = process.env.INIT_CWD || process.cwd();

function option(name) {
  var i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? path.resolve(CWD, process.argv[i + 1]) : null;
}

function die(message) {
  console.error(message);
  process.exit(2);
}

function files(dir) {
  var out = [];
  (function walk(rel) {
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).forEach(function (e) {
      var name = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        walk(name);
      } else if (e.isFile() && KEEP.test(name)) {
        out.push({ path: name, bytes: fs.readFileSync(path.join(dir, name)) });
      }
    });
  })('');
  return out.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
}

var keygen = option('keygen');
if (keygen) {
  if (fs.existsSync(keygen)) {
    die(keygen + ' exists already');
  }
  var pair = signing.generate();
  fs.writeFileSync(keygen, JSON.stringify(pair, null, 2) + '\n', { mode: 0o600 });
  console.log('Key written to ' + keygen + ' (keep it private).');
  console.log('Public key, for the servers that should trust your packages:\n  ' + pair.publicKey);
  console.log('Fingerprint: ' + signing.fingerprint(pair.publicKey));
  process.exit(0);
}

var dir = process.argv.slice(2).filter(function (a, i, all) { return a.indexOf('--') !== 0 && (i === 0 || all[i - 1].indexOf('--') !== 0); })[0];
dir = dir && path.resolve(CWD, dir);
if (!dir || !fs.existsSync(path.join(dir, 'playpex-plugin.json'))) {
  die('usage: npm run pack:plugin -- <folder with playpex-plugin.json> [--out <file>] [--key <key file>]\n' +
    '       npm run pack:plugin -- --keygen <key file>');
}

var list = files(dir),
  names = list.map(function (f) { return f.path; }),
  manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playpex-plugin.json'), 'utf8')),
  strings = {};
list.forEach(function (f) {
  var m = /^i18n\/(.+)\.json$/.exec(f.path);
  if (m) {
    strings[m[1]] = JSON.parse(f.bytes.toString('utf8'));
  }
});
var problems = schemas.manifestProblems(manifest, { files: names, strings: strings });
if (problems.length) {
  die('The manifest has problems:\n  ' + problems.join('\n  '));
}
if (names.indexOf('server.js') === -1) {
  die('No server.js in ' + dir);
}

var keyFile = option('key');
if (keyFile) {
  var key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  list.push({ path: 'signature', bytes: Buffer.from(signing.signPackage(list, key)) });
}

var out = option('out') || CWD,
  file = fs.existsSync(out) && fs.statSync(out).isDirectory() ? path.join(out, manifest.id + '-' + manifest.version + '.ppx') : out,
  zip = new yazl.ZipFile();
list.forEach(function (f) {
  zip.addBuffer(f.bytes, f.path, { mtime: new Date('2000-01-01T00:00:00Z') });
});
zip.end();
zip.outputStream.pipe(fs.createWriteStream(file)).on('close', function () {
  console.log(file + ': ' + manifest.name + ' ' + manifest.version + ', ' + list.length + ' files, ' +
    (keyFile ? 'signed (' + signing.fingerprint(JSON.parse(fs.readFileSync(keyFile, 'utf8')).publicKey) + ')' : 'unsigned'));
});
