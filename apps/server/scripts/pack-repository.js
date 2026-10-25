#!/usr/bin/env node
'use strict';

// Builds (or updates) a plugin repository (docs/plugins/repositories.md): the
// packages of the given plugin folders, then index.json and its signature
// index.json.sig, in one folder to put on any HTTPS host. Versions already in
// the folder's index stay listed (rollbacks, "Install this one"); the same
// version packed again replaces its entry.
//
//   npm run pack:repository -- <plugin folder>… --out <folder> --key <key file>
//       --id <repository id> --name "<name>" --base-url https://<host>/<path>/ [--homepage <url>]
//       [--sign-packages]
//
// --key: a key file made by `npm run pack:plugin -- --keygen <file>`; its
// public key is the repository's (servers pin it when the admin adds the
// repository: keep using the same one). The signed index, with each package's
// sha256, vouches for the packages; --sign-packages also signs each one with
// that key, so a .ppx installs by upload too on a server that trusts the key
// (plugins.publisherKeys) without the repository.
// An adults plugin goes in a repository of its own: the official Playpex
// repository never carries one (servers refuse it there).

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  childProcess = require('child_process'),
  signing = require('@playpex/protocol/signing'),
  schemas = require('../lib/plugins/schemas');

var CWD = process.env.INIT_CWD || process.cwd(),
  PACK = path.join(__dirname, 'pack-plugin.js'),
  OPTIONS = ['out', 'key', 'id', 'name', 'base-url', 'homepage'],
  ICON_TYPES = /\.(svg|png|jpe?g|webp)$/i;

function die(message) {
  console.error(message);
  process.exit(2);
}

function option(name) {
  var i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

var args = process.argv.slice(2),
  folders = args.filter(function (a, i) { return a.indexOf('--') !== 0 && !(i > 0 && OPTIONS.indexOf(args[i - 1].slice(2)) !== -1); })
    .map(function (f) { return path.resolve(CWD, f); }),
  out = option('out') && path.resolve(CWD, option('out')),
  keyFile = option('key') && path.resolve(CWD, option('key')),
  id = option('id'),
  name = option('name'),
  baseUrl = option('base-url'),
  homepage = option('homepage'),
  signPackages = args.indexOf('--sign-packages') !== -1;

if (!folders.length || !out || !keyFile || !id || !name || !baseUrl) {
  die('usage: npm run pack:repository -- <plugin folder>… --out <folder> --key <key file> --id <repository id>\n' +
    '         --name "<name>" --base-url https://<host>/<path>/ [--homepage <url>] [--sign-packages]');
}
if (!/^https:\/\//.test(baseUrl)) {
  die('--base-url must be an https:// URL (where the folder will be served)');
}
baseUrl = baseUrl.replace(/\/?$/, '/');
var pair = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
fs.mkdirSync(out, { recursive: true });

var indexFile = path.join(out, 'index.json'),
  index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { plugins: [] };
if (index.repository && index.repository.key && index.repository.key !== pair.publicKey) {
  die('The index in ' + out + ' is signed with another key (' + signing.fingerprint(index.repository.key) + '): servers that trust ' +
    'it would refuse this one. Use that key, or a new folder.');
}

function changelogOf(dir, version) {
  try {
    var text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
      // the section of this version, else the top of the file
      at = text.search(new RegExp('^#+\\s*v?' + version.replace(/\./g, '\\.') + '\\b', 'm'));
    text = at === -1 ? text : text.slice(at);
    var next = text.slice(1).search(/^#+\s/m);
    return (next === -1 ? text : text.slice(0, next + 1)).trim().slice(0, 4000) || null;
  } catch (e) {
    return null;
  }
}

folders.forEach(function (dir) {
  var manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playpex-plugin.json'), 'utf8'));
  var packed = childProcess.spawnSync(process.execPath, [PACK, dir, '--out', out].concat(signPackages ? ['--key', keyFile] : []), { encoding: 'utf8', env: Object.assign({}, process.env, { INIT_CWD: CWD }) });
  if (packed.status !== 0) {
    die(packed.stderr || packed.stdout);
  }
  var file = manifest.id + '-' + manifest.version + '.ppx',
    bytes = fs.readFileSync(path.join(out, file)),
    entry = index.plugins.filter(function (p) { return p.id === manifest.id; })[0];
  if (!entry) {
    entry = { id: manifest.id, versions: [] };
    index.plugins.push(entry);
  }
  entry.name = manifest.name;
  entry.publisher = manifest.publisher;
  if (manifest.icon && ICON_TYPES.test(manifest.icon)) {
    var icon = manifest.id + '-icon' + path.extname(manifest.icon).toLowerCase();
    fs.copyFileSync(path.join(dir, manifest.icon), path.join(out, icon));
    entry.icon = baseUrl + icon;
  }
  if (manifest.listing) {
    entry.listing = Object.assign({}, manifest.listing);
    // the index takes full URLs: the package's own assets aren't online
    delete entry.listing.screenshots;
    delete entry.listing.fanart;
  }
  var version = {
    version: manifest.version,
    url: baseUrl + file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    releasedAt: new Date().toISOString().slice(0, 10),
    api: manifest.api,
    audience: manifest.audience,
    permissions: manifest.permissions,
    lifecycle: 'stable'
  };
  if (manifest.requires) {
    version.requires = manifest.requires;
  }
  var changelog = changelogOf(dir, manifest.version);
  if (changelog) {
    version.changelog = changelog;
  }
  entry.versions = [version].concat(entry.versions.filter(function (v) { return v.version !== manifest.version; }))
    .sort(function (a, b) { return require('@playpex/protocol/plugins').compareVersions(b.version, a.version); }).slice(0, 50);
  console.log(file + ': ' + manifest.name + ' ' + manifest.version + (manifest.audience === 'adults' ? ' (adults)' : ''));
});

index = {
  format: 1,
  repository: Object.assign({ id: id, name: name, key: pair.publicKey }, homepage ? { homepage: homepage } : {}),
  generatedAt: new Date().toISOString(),
  plugins: index.plugins
};
var problems = schemas.indexProblems(index);
if (problems.length) {
  die('The index doesn\'t follow repository.schema.json:\n  ' + problems.join('\n  '));
}
var text = JSON.stringify(index, null, 2) + '\n';
fs.writeFileSync(indexFile, text);
fs.writeFileSync(indexFile + '.sig', signing.sign(Buffer.from(text), pair.privateKey) + '\n');
console.log(indexFile + ': ' + index.plugins.length + ' plugin(s), signed (' + signing.fingerprint(pair.publicKey) + ')');
console.log('Serve ' + out + ' at ' + baseUrl + ': servers add ' + baseUrl + 'index.json');
