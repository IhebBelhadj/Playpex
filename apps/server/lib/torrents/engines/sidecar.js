'use strict';

// Engines that run as their own program (a sidecar: rqbit, playpex-torrentd)
// are optional downloads, never bundled: the admin installs one from the
// dashboard (Settings › Downloads) or with `npm run install:engine -- <id>`.
// Each has a release manifest (release.json: version, per-platform URL +
// SHA-256, licence file) and lives in <cache>/engines/<id>/.
//
//   sidecar.find(spec)              → { path, source: 'env' | 'installed' | 'path', version? } | null
//   sidecar.install(spec, options)  → Promise<{ path, version }>   downloads, checks, installs
//   sidecar.uninstall(spec)         → Promise                      removes <cache>/engines/<id>
//   sidecar.installable(spec)       → whether a build is pinned for this platform
//   sidecar.version(bin, pattern)   → Promise<'x.y.z' | null>
//
// spec = { id, binary (file name without .exe), envVar (path override), release (manifest),
//          versionArgs, versionPattern }

var fs = require('fs'),
  path = require('path'),
  https = require('https'),
  crypto = require('crypto'),
  spawn = require('child_process').spawn,
  paths = require('../../paths');

var EXE = process.platform === 'win32' ? '.exe' : '',
  installing = {};   // id → Promise (one install at a time per engine)

function dir(spec) {
  return path.join(paths.cache, 'engines', spec.id);
}

function binaryPath(spec) {
  return path.join(dir(spec), spec.binary + EXE);
}

function onPath(name) {
  var dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (var i = 0; i < dirs.length; i++) {
    var file = path.join(dirs[i], name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch (e) {
      // next
    }
  }
  return null;
}

// The installed version, from the stamp the installer writes
function stampedVersion(spec) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(spec), 'installed.json'), 'utf8')).version || null;
  } catch (e) {
    return null;
  }
}

function find(spec) {
  if (spec.envVar && process.env[spec.envVar]) {
    return { path: process.env[spec.envVar], source: 'env' };
  }
  if (fs.existsSync(binaryPath(spec))) {
    return { path: binaryPath(spec), source: 'installed', version: stampedVersion(spec) };
  }
  var found = onPath(spec.binary + EXE);
  return found ? { path: found, source: 'path' } : null;
}

function installable(spec) {
  return !!(spec.release && spec.release.builds && spec.release.builds[process.platform + '-' + process.arch]);
}

function version(bin, args, pattern) {
  return new Promise(function (resolve) {
    var out = '', child;
    try {
      child = spawn(bin, args || ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) {
      return resolve(null);
    }
    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function () { resolve(null); });
    child.on('close', function (code) {
      var m = (pattern || /(\d+\.\d+\.\d+\S*)/).exec(out);
      resolve(code === 0 && m ? m[1] : null);
    });
  });
}

function get(url, redirects) {
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'playpex-server' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) {
          return reject(new Error('too many redirects'));
        }
        return resolve(get(new URL(res.headers.location, url).href, (redirects || 0) + 1));
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

function fetchChecked(entry, what) {
  return get(entry.url).then(function (buffer) {
    var actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(what + ': SHA-256 mismatch (expected ' + entry.sha256 + ', got ' + actual + ')');
    }
    return buffer;
  });
}

/**
 * Downloads the pinned build for this platform into <cache>/engines/<id>.
 * Already installed at that SHA-256 → nothing to do.
 * @param {object} spec
 * @param {{ log?: object }} [options]
 */
function install(spec, options) {
  var log = options && options.log;
  if (installing[spec.id]) {
    return installing[spec.id];
  }
  var key = process.platform + '-' + process.arch,
    build = spec.release && spec.release.builds && spec.release.builds[key],
    target = dir(spec),
    stamp = path.join(target, 'installed.json');
  if (!build) {
    var none = new Error(spec.id + ' has no build for ' + key);
    none.code = 'NOT_SUPPORTED';
    return Promise.reject(none);
  }
  try {
    var current = JSON.parse(fs.readFileSync(stamp, 'utf8'));
    if (current.sha256 === build.sha256 && fs.existsSync(binaryPath(spec))) {
      return Promise.resolve({ path: binaryPath(spec), version: current.version });
    }
  } catch (e) {
    // not installed
  }
  if (log) {
    log.info('installing the ' + spec.id + ' engine ' + spec.release.version + ' (' + key + ')');
  }
  installing[spec.id] = Promise.all([
    fetchChecked(build, spec.id),
    spec.release.licenceFile ? fetchChecked(spec.release.licenceFile, spec.id + ' licence') : Promise.resolve(null)
  ]).then(function (got) {
    var tmp = target + '.part';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, spec.binary + EXE), got[0]);
    fs.chmodSync(path.join(tmp, spec.binary + EXE), 0o755);
    if (got[1]) {
      fs.writeFileSync(path.join(tmp, 'LICENSE-' + spec.id + '.txt'), got[1]);
    }
    fs.writeFileSync(path.join(tmp, 'installed.json'), JSON.stringify({
      id: spec.id, version: spec.release.version, licence: spec.release.licence, source: spec.release.source,
      url: build.url, sha256: build.sha256, installedAt: new Date().toISOString()
    }, null, 2) + '\n');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    if (log) {
      log.info(spec.id + ' engine installed in ' + target);
    }
    return { path: binaryPath(spec), version: spec.release.version };
  });
  var done = function () { delete installing[spec.id]; };
  installing[spec.id].then(done, done);
  return installing[spec.id];
}

function uninstall(spec) {
  return fs.promises.rm(dir(spec), { recursive: true, force: true });
}

module.exports = {
  dir: dir,
  find: find,
  installable: installable,
  install: install,
  uninstall: uninstall,
  version: version
};
