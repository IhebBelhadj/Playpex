#!/usr/bin/env node
'use strict';

// Fetches the pinned LGPL ffmpeg + ffprobe for a platform (build/ffmpeg.json),
// checks its SHA-256, and puts the two binaries and the licence in
// vendor/ffmpeg/<platform>-<arch>/ (git-ignored). electron-builder copies that
// folder to resources/ffmpeg; main.js points the server at it.
//
//   node build/fetch-ffmpeg.js                          this machine's platform
//   node build/fetch-ffmpeg.js --platform win32 --arch x64
//   node build/fetch-ffmpeg.js --all
//
// Downloads are cached in vendor/cache/. A platform without a pinned build
// (macOS) is reported and skipped, not an error.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = require('./ffmpeg.json');
const CACHE = path.join(ROOT, 'vendor', 'cache');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

function download(url, file, redirects) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'playpex-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) {
          return reject(new Error('too many redirects'));
        }
        return resolve(download(new URL(res.headers.location, url).href, file, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' → HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0, shown = -1;
      const out = fs.createWriteStream(file + '.part');
      res.on('data', chunk => {
        done += chunk.length;
        const pct = total ? Math.floor(done / total * 100 / 10) * 10 : -1;
        if (pct !== shown && process.stdout.isTTY) {
          shown = pct;
          process.stdout.write('\r  ' + (total ? pct + ' %' : Math.round(done / 1e6) + ' MB') + '   ');
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        fs.renameSync(file + '.part', file);
        resolve(file);
      });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// Entries ending in one of `wanted` (bin/ffmpeg, LICENSE.txt…) → { wanted: Buffer path written in dir }
function extractZip(archive, dir, wanted) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
      if (err) {
        return reject(err);
      }
      const found = {};
      zip.on('entry', entry => {
        const match = wanted.find(w => entry.fileName.endsWith('/' + w));
        if (!match) {
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e) {
            return reject(e);
          }
          const out = path.join(dir, path.basename(match));
          stream.pipe(fs.createWriteStream(out)).on('finish', () => {
            found[match] = out;
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(found));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function extractTar(archive, dir, wanted) {
  const tmp = fs.mkdtempSync(path.join(CACHE, 'x-'));
  try {
    const names = execFileSync('tar', ['-tJf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    const members = wanted.map(w => names.find(n => n.endsWith('/' + w))).filter(Boolean);
    execFileSync('tar', ['-xJf', archive, '-C', tmp].concat(members));
    const found = {};
    wanted.forEach(w => {
      const member = members.find(m => m.endsWith('/' + w));
      if (member) {
        const out = path.join(dir, path.basename(w));
        fs.copyFileSync(path.join(tmp, member), out);
        found[w] = out;
      }
    });
    return found;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchOne(key) {
  const build = MANIFEST.builds[key];
  if (!build) {
    console.log('ffmpeg: no pinned LGPL build for ' + key + ', skipped (the server uses its settings or the PATH there)');
    return;
  }
  const dir = path.join(ROOT, 'vendor', 'ffmpeg', key);
  const stamp = path.join(dir, 'VERSION.txt');
  const exe = key.startsWith('win32') ? '.exe' : '';
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').includes(build.sha256) &&
    fs.existsSync(path.join(dir, 'ffmpeg' + exe)) && fs.existsSync(path.join(dir, 'ffprobe' + exe))) {
    console.log('ffmpeg: ' + key + ' already in vendor/ffmpeg (' + MANIFEST.version + ')');
    return;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, path.basename(new URL(build.url).pathname));
  if (!fs.existsSync(archive) || await sha256(archive) !== build.sha256) {
    console.log('ffmpeg: downloading ' + path.basename(archive));
    await download(build.url, archive);
  }
  const actual = await sha256(archive);
  if (actual !== build.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error('ffmpeg: SHA-256 mismatch for ' + path.basename(archive) + ' (expected ' + build.sha256 + ', got ' + actual + ')');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const wanted = ['bin/ffmpeg' + exe, 'bin/ffprobe' + exe, 'LICENSE.txt'];
  const found = archive.endsWith('.zip') ? await extractZip(archive, dir, wanted) : extractTar(archive, dir, wanted);
  ['bin/ffmpeg' + exe, 'bin/ffprobe' + exe].forEach(w => {
    if (!found[w]) {
      throw new Error('ffmpeg: ' + w + ' not found in ' + path.basename(archive));
    }
    fs.chmodSync(found[w], 0o755);
  });
  if (found['LICENSE.txt']) {
    fs.renameSync(found['LICENSE.txt'], path.join(dir, 'LICENSE-ffmpeg.txt'));
  }
  fs.writeFileSync(stamp, [
    'ffmpeg ' + MANIFEST.version + ' (' + MANIFEST.licence + '), ' + MANIFEST.release,
    'archive ' + build.url,
    'sha256 ' + build.sha256,
    'source ' + MANIFEST.source,
    ''
  ].join('\n'));
  console.log('ffmpeg: ' + key + ' → vendor/ffmpeg/' + key);
}

const keys = process.argv.includes('--all') ? Object.keys(MANIFEST.builds) :
  [(arg('platform') || process.platform) + '-' + (arg('arch') || process.arch)];

keys.reduce((p, key) => p.then(() => fetchOne(key)), Promise.resolve()).catch(err => {
  console.error(err.message);
  process.exit(1);
});
