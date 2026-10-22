#!/usr/bin/env node
'use strict';

// Builds playpex-torrentd (Go 1.26+, no cgo: static binaries).
//
//   node engines/torrentd/build.js          this machine → <cache>/engines/torrentd, where the
//                                           server finds it (npm run build:torrentd)
//   node engines/torrentd/build.js --all    every platform → engines/torrentd/dist/ (what the
//                                           release workflow publishes, .github/workflows/torrentd.yml)
//   node engines/torrentd/build.js --pin    after a release: downloads its binaries, hashes them and
//                                           writes their URL + SHA-256 into release.json

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  execFileSync = require('child_process').execFileSync;

var DIR = __dirname,
  release = require('../../apps/server/lib/torrents/engines/torrentd/release.json'),
  TARGETS = {
    'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'], 'linux-arm': ['linux', 'arm'],
    'darwin-x64': ['darwin', 'amd64'], 'darwin-arm64': ['darwin', 'arm64'],
    'win32-x64': ['windows', 'amd64'], 'win32-arm64': ['windows', 'arm64']
  };

function build(key, out) {
  var t = TARGETS[key];
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w -X main.version=' + release.version, '-o', out, '.'], {
    cwd: DIR,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { CGO_ENABLED: '0', GOOS: t[0], GOARCH: t[1], GOARM: t[1] === 'arm' ? '7' : '' })
  });
  return out;
}

function assetName(key) {
  return 'playpex-torrentd-' + release.version + '-' + key + (key.indexOf('win32') === 0 ? '.exe' : '');
}

function assetUrl(key) {
  return 'https://github.com/IhebBelhadj/Playpex/releases/download/torrentd-v' + release.version + '/' + assetName(key);
}

function download(url, redirects) {
  return new Promise(function (resolve, reject) {
    require('https').get(url, { headers: { 'User-Agent': 'playpex-build' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' → HTTP ' + res.statusCode));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

if (process.argv.indexOf('--pin') !== -1) {
  var file = path.join(DIR, '..', '..', 'apps', 'server', 'lib', 'torrents', 'engines', 'torrentd', 'release.json'),
    manifest = JSON.parse(fs.readFileSync(file, 'utf8')),
    pinned = {};
  Object.keys(TARGETS).reduce(function (chain, key) {
    return chain.then(function () {
      return download(assetUrl(key)).then(function (buffer) {
        pinned[key] = { url: assetUrl(key), sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
        console.log(key + ' ' + pinned[key].sha256);
      });
    });
  }, Promise.resolve()).then(function () {
    manifest.builds = pinned;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log('release.json pinned to torrentd-v' + release.version);
  }, function (err) {
    console.error(err.message + ' (is torrentd-v' + release.version + ' published?)');
    process.exit(1);
  });
} else if (process.argv.indexOf('--all') !== -1) {
  Object.keys(TARGETS).forEach(function (key) {
    var out = build(key, path.join(DIR, 'dist', assetName(key)));
    console.log(key + ' → dist/' + path.basename(out) + ' ' + crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
  });
} else {
  var key = process.platform + '-' + process.arch;
  if (!TARGETS[key]) {
    console.error('no Go target for ' + key);
    process.exit(1);
  }
  var target = path.join(require('../../apps/server/lib/paths').cache, 'engines', 'torrentd');
  fs.mkdirSync(target, { recursive: true });
  var bin = build(key, path.join(target, 'playpex-torrentd' + (process.platform === 'win32' ? '.exe' : '')));
  fs.writeFileSync(path.join(target, 'installed.json'), JSON.stringify({
    id: 'torrentd', version: release.version, source: 'local build', builtAt: new Date().toISOString()
  }, null, 2) + '\n');
  console.log('playpex-torrentd ' + release.version + ' → ' + bin);
}
