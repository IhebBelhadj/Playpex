'use strict';

// Installing plugin packages (docs/plugins-plan.md §6.3: the Developer tab's
// upload, and a URL; repositories are step P4b). A package is a zip (`.ppx`
// or `.zip`) holding playpex-plugin.json at its root, or inside one folder (a
// GitHub source zip: `repo-1.2.0/…`, or a plugin in a sub folder of a repo).
//
//   fetchPackage(url) → Promise<{ buffer, name }>   a direct link, or a GitHub repo / release
//                                                    page (its release's .ppx / .zip asset, else its source zip)
//   stage(buffer, { origin, source }) → Promise<Preview>
//       read and checked in memory, kept 15 min for the admin to confirm:
//       { token, id, name, version, …, permissions (in words), signer, installable, reason }
//       with `added` / `removed`: its permissions against the installed version's
//   commit(token, { accept }) → Promise<adminView>  <config>/plugins/<id>/ (the version it replaces in
//       .previous/<id>/, with .install.json: where it came from), loaded; a package asking for more
//       than the installed version needs `accept` (the admin saw `added`), else CONFLICT
//   stagePrevious(id) → Promise<Preview>   the version kept in .previous/<id>/, as a package to
//       confirm like any other (rolling back swaps them: rolling back again goes forward)
//   discard(token) · remove(id, { keepData }) · clearData(id) · setEnabled(id, on) · reload(id) (a developer copy)
//   loadInstalled() (start) · list() (the dashboard)
//
// Trust (plan §6.1 decision C): a package signed by a key in the setting
// `plugins.publisherKeys` installs anytime; an unsigned one (or one signed by
// another key) only while `plugins.developerMode` is on. Limits: 20 MB
// download, 64 MB unpacked, 2000 files; no absolute paths, `..`, symlinks.

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  yauzl = require('yauzl'),
  axios = require('axios'),
  signing = require('@playpex/protocol/signing'),
  protocol = require('@playpex/protocol/plugins'),
  plugins = require('./index'),
  schemas = require('./schemas'),
  paths = require('../paths'),
  settings = require('../settings'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

var PACKAGE_MAX = 20 * 1024 * 1024,
  UNPACKED_MAX = 64 * 1024 * 1024,
  FILES_MAX = 2000,
  MANIFEST = 'playpex-plugin.json',
  STAGE_MS = 15 * 60 * 1000,
  ICON_MAX = 256 * 1024,
  CHANGELOG_MAX = 20000,
  // what is kept of a package: its plugin, not a whole repository
  KEEP = /^(playpex-plugin\.json|server\.js|signature|CHANGELOG\.md|README\.md|LICEN[CS]E(\.\w+)?|assets\/.+|i18n\/[^/]+\.json)$/,
  JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/,
  INSTALL_INFO = '.install.json',
  ICON_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

var staged = new Map(),    // token → { at, preview, files, root }
  loadErrors = {};         // id → why an installed plugin didn't load

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function dirOf(id) {
  return path.join(paths.config, 'plugins', id);
}

function previousOf(id) {
  return path.join(paths.config, 'plugins', '.previous', id);
}

function services() {
  return userData.services();
}

// ── reading a zip ───────────────────────────────────────────────────────────

/** Every file of a zip in memory: [{ path, bytes }]; rejects INVALID past the limits or on an unsafe entry */
function unzip(buffer) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, function (err, zip) {
      if (err) {
        return reject(failure('INVALID', 'not a zip file (' + err.message + ')'));
      }
      var files = [], total = 0, done = false;
      function fail(e) {
        if (!done) {
          done = true;
          zip.close();
          reject(e.code ? e : failure('INVALID', 'the zip can\'t be read: ' + e.message));
        }
      }
      zip.on('error', fail);
      zip.on('end', function () {
        if (!done) {
          done = true;
          resolve(files);
        }
      });
      zip.on('entry', function (entry) {
        var name = entry.fileName,
          mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (/\/$/.test(name)) {
          return zip.readEntry();   // a folder
        }
        if (name.indexOf('\\') !== -1 || /^\//.test(name) || /^[A-Za-z]:/.test(name) ||
          name.split('/').some(function (part) { return part === '..' || part === '.' || part === ''; })) {
          return fail(failure('INVALID', 'unsafe path in the zip: ' + name.slice(0, 200)));
        }
        if (mode === 0o120000) {
          return fail(failure('INVALID', name + ' is a symbolic link'));
        }
        if (files.length >= FILES_MAX) {
          return fail(failure('INVALID', 'more than ' + FILES_MAX + ' files'));
        }
        zip.openReadStream(entry, function (e, stream) {
          if (e) {
            return fail(e);
          }
          var chunks = [];
          stream.on('data', function (chunk) {
            total += chunk.length;
            if (total > UNPACKED_MAX) {
              stream.destroy();
              return fail(failure('INVALID', 'more than ' + UNPACKED_MAX / 1024 / 1024 + ' MB unpacked'));
            }
            chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', function () {
            files.push({ path: name, bytes: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * The plugin inside: the shallowest playpex-plugin.json (the package root, or
 * one folder of a source zip); its files relative to that folder
 */
function rootOf(files) {
  var manifests = files.filter(function (f) {
    return !JUNK.test(f.path) && (f.path === MANIFEST || /\/playpex-plugin\.json$/.test(f.path));
  }).map(function (f) { return f.path.slice(0, -MANIFEST.length); });
  if (!manifests.length) {
    throw failure('INVALID', 'no ' + MANIFEST + ' in this zip: is it a Playpex plugin?');
  }
  var depth = function (p) { return p.split('/').length; },
    shallowest = Math.min.apply(null, manifests.map(depth)),
    roots = manifests.filter(function (p) { return depth(p) === shallowest; });
  if (roots.length > 1) {
    throw failure('INVALID', 'several plugins in this zip (' + roots.slice(0, 3).map(function (r) { return r || '/'; }).join(', ') +
      '): install one package at a time');
  }
  var root = roots[0];
  return {
    root: root,
    files: files.filter(function (f) { return f.path.indexOf(root) === 0 && !JUNK.test(f.path); })
      .map(function (f) { return { path: f.path.slice(root.length), bytes: f.bytes }; })
  };
}

function json(file, what) {
  try {
    return JSON.parse(file.bytes.toString('utf8'));
  } catch (e) {
    throw failure('INVALID_MANIFEST', what + ' isn\'t JSON: ' + e.message);
  }
}

// i18n/<locale>.json tables, as the loader reads them
function stringsOf(files) {
  var out = {};
  files.forEach(function (f) {
    var m = /^i18n\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/.exec(f.path);
    if (m) {
      out[m[1]] = json(f, f.path);
    }
  });
  return out;
}

// ── trust ───────────────────────────────────────────────────────────────────

function trustedKeys() {
  return settings.get('plugins.publisherKeys') || [];
}

/** { signer (key or null), trusted, installable, reason } under the current settings */
function trustOf(signer) {
  var trusted = !!signer && trustedKeys().indexOf(signer) !== -1,
    developer = !!settings.get('plugins.developerMode');
  return {
    signer: signer,
    trusted: trusted,
    installable: trusted || developer,
    reason: trusted ? null : developer ? null :
      signer ? 'Signed by a key this server doesn\'t trust (' + signing.fingerprint(signer) + '): add it to the trusted publisher keys, or turn on developer mode' :
        'Not signed: unsigned plugins install only in developer mode'
  };
}

// ── staging ─────────────────────────────────────────────────────────────────

function sweep() {
  var now = Date.now();
  staged.forEach(function (s, token) {
    if (now - s.at > STAGE_MS) {
      staged.delete(token);
    }
  });
}

/**
 * Reads and checks a package; keeps it 15 min for commit().
 * @param {Buffer} buffer
 * @param {{ origin: 'upload'|'url', source: string, resolved?: string }} from
 */
function stage(buffer, from) {
  sweep();
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return Promise.reject(failure('INVALID', 'an empty file'));
  }
  if (buffer.length > PACKAGE_MAX) {
    return Promise.reject(failure('INVALID', 'a package is at most ' + PACKAGE_MAX / 1024 / 1024 + ' MB'));
  }
  return unzip(buffer).then(function (all) {
    return stageFiles(rootOf(all), from, buffer.length);
  });
}

/** The installed manifest of a plugin (its folder, else a running developer copy), or null */
function installedManifest(id) {
  var loaded = plugins.get(id);
  if (loaded) {
    return loaded.manifest;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), MANIFEST), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** { added, removed }: permissions in words, `next` against `current` (null: everything is added) */
function permissionChanges(next, current) {
  var after = protocol.describePermissions(next),
    before = current ? protocol.describePermissions(current) : [],
    texts = function (list) { return list.map(function (x) { return x.key + '\n' + x.text; }); },
    a = texts(after), b = texts(before);
  return {
    added: current ? after.filter(function (x, i) { return b.indexOf(a[i]) === -1; }) : [],
    removed: before.filter(function (x, i) { return a.indexOf(b[i]) === -1; })
  };
}

// a package's files (its root found) → the preview, kept for commit()
function stageFiles(found, from, size) {
  return Promise.resolve().then(function () {
    var signer = signing.packageSigner(found.files),
      files = found.files.filter(function (f) { return KEEP.test(f.path); }),
      byPath = {};
    files.forEach(function (f) { byPath[f.path] = f; });
    var manifest = json(byPath[MANIFEST], MANIFEST);
    if (manifest && manifest.type === 'repository') {
      throw failure('INVALID_MANIFEST', 'a repository package adds a repository (plugins plan step P4b): not installable yet');
    }
    var names = files.map(function (f) { return f.path; }),
      problems = schemas.manifestProblems(manifest, { files: names, strings: stringsOf(files) });
    if (problems.length) {
      throw failure('INVALID_MANIFEST', problems.join('; '));
    }
    if (!byPath['server.js']) {
      throw failure('INVALID', 'no server.js next to ' + MANIFEST);
    }
    if (byPath['server.js'].bytes.length > 5 * 1024 * 1024) {
      throw failure('INVALID', 'server.js is larger than 5 MB');
    }
    return services().then(function (s) {
      return s.plugins.installed.get(manifest.id);
    }).then(function (current) {
      var loaded = plugins.get(manifest.id),
        token = crypto.randomBytes(16).toString('hex'),
        trust = trustOf(signer),
        icon = manifest.icon && byPath[manifest.icon],
        type = icon && ICON_TYPES[path.extname(manifest.icon).slice(1).toLowerCase()],
        changelog = byPath['CHANGELOG.md'],
        changes = permissionChanges(manifest, current ? installedManifest(manifest.id) : null);
      var preview = {
        token: token,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || (manifest.listing && manifest.listing.summary) || null,
        publisher: manifest.publisher || null,
        audience: manifest.audience,
        icon: icon && type && icon.bytes.length <= ICON_MAX ? 'data:' + type + ';base64,' + icon.bytes.toString('base64') : null,
        permissions: protocol.describePermissions(manifest),
        hooks: (manifest.permissions && manifest.permissions.hooks) || [],
        origin: from.origin,
        source: from.source,
        resolved: from.resolved || null,
        root: found.root || null,
        size: size,
        fileCount: files.length,
        changelog: changelog ? changelog.bytes.toString('utf8').slice(0, CHANGELOG_MAX) : null,
        current: current ? current.version : null,
        added: changes.added,
        removed: changes.removed,
        rollback: !!from.rollback,
        change: !current ? 'install' : protocol.compareVersions(manifest.version, current.version) > 0 ? 'update' :
          protocol.compareVersions(manifest.version, current.version) < 0 ? 'downgrade' : 'reinstall',
        conflict: loaded && loaded.origin === 'dev' ? 'A developer copy of ' + manifest.id + ' runs from ' +
          plugins.devDir() + ': remove that folder first' : null,
        signer: signer ? { key: signer, fingerprint: signing.fingerprint(signer), trusted: trust.trusted } : null,
        installable: trust.installable,
        reason: trust.reason,
        expiresAt: new Date(Date.now() + STAGE_MS).toISOString()
      };
      if (preview.conflict) {
        preview.installable = false;
        preview.reason = preview.conflict;
      }
      staged.set(token, { at: Date.now(), preview: preview, files: files, manifest: manifest, from: from });
      return preview;
    });
  });
}

/** Every file under a folder: [{ path, bytes }] (`/`-separated, relative) */
function readTree(dir) {
  var out = [];
  (function walk(rel) {
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).forEach(function (e) {
      var child = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        walk(child);
      } else if (e.isFile()) {
        out.push({ path: child, bytes: fs.readFileSync(path.join(dir, child)) });
      }
    });
  })('');
  return out;
}

/** The version kept by the last update, staged to be put back (a preview like a package's) */
function stagePrevious(id) {
  sweep();
  var dir = previousOf(id), info = {};
  if (!fs.existsSync(path.join(dir, MANIFEST))) {
    return Promise.reject(failure('NOT_FOUND', 'No earlier version of ' + id + ' is kept'));
  }
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_INFO), 'utf8'));
  } catch (e) { /* kept before .install.json existed */ }
  var files = readTree(dir).filter(function (f) { return KEEP.test(f.path); }),
    size = files.reduce(function (n, f) { return n + f.bytes.length; }, 0);
  return stageFiles({ root: '', files: files }, {
    origin: info.origin === 'url' ? 'url' : 'upload',
    source: info.source || dir,
    rollback: true
  }, size).then(function (preview) {
    preview.root = null;
    return preview;
  });
}

/**
 * Forgets everything a plugin kept (its storage, secrets and linked accounts,
 * settings, grants and hidden profiles, notifications), as if just installed;
 * a running plugin starts again on the empty state
 */
function clearData(id) {
  return services().then(function (s) {
    return s.plugins.installed.get(id).then(function (row) {
      var loaded = plugins.get(id);
      if (!row && !loaded) {
        throw failure('NOT_FOUND', 'No plugin ' + id);
      }
      var restart = loaded && loaded.state !== 'disabled' ? { dir: loaded.dir, origin: loaded.origin } : null;
      plugins.unload(id);
      require('./notifications').forget(id);
      return s.plugins.removeAll(id).then(function () {
        log.info('plugin ' + id + ': its data cleared', { plugin: id });
        return restart ? plugins.load(restart.dir, restart.origin).catch(function (err) {
          loadErrors[id] = (err.code ? err.code + ': ' : '') + err.message;
        }) : plugins.refreshHidden(id);
      });
    });
  }).then(function () {
    return view(id);
  });
}

function discard(token) {
  return staged.delete(token);
}

// ── installing ──────────────────────────────────────────────────────────────

function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  files.forEach(function (f) {
    var target = path.join(dir, f.path.split('/').join(path.sep));
    if (path.relative(dir, target).split(path.sep)[0] === '..') {
      throw failure('INVALID', 'unsafe path ' + f.path);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.bytes);
  });
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Installs a staged package (the admin confirmed it); the version it replaces
 * is kept for a rollback. More permissions than the installed version's need
 * `options.accept`: a personal one it adds stays off for every profile anyway.
 */
function commit(token, options) {
  options = options || {};
  sweep();
  var entry = staged.get(token);
  if (!entry) {
    return Promise.reject(failure('NOT_FOUND', 'This package is no longer waiting: upload it again'));
  }
  var p = entry.preview,
    trust = trustOf(entry.preview.signer && entry.preview.signer.key);
  if (p.conflict) {
    return Promise.reject(failure('CONFLICT', p.conflict));
  }
  if (p.added.length && options.accept !== true) {
    return Promise.reject(failure('CONFLICT', p.name + ' ' + p.version + ' asks for more than the installed version (' +
      p.added.map(function (x) { return x.text; }).join('; ') + '): accept them to install it'));
  }
  if (!trust.installable) {
    return Promise.reject(failure('FORBIDDEN', trust.reason));
  }
  staged.delete(token);
  var id = p.id,
    base = path.join(paths.config, 'plugins'),
    incoming = path.join(base, '.staging-' + token),
    target = dirOf(id),
    previous = previousOf(id),
    s, old, hadPrevious = false;
  return services().then(function (svc) {
    s = svc;
    return s.plugins.installed.get(id);
  }).then(function (row) {
    old = row;
    writeFiles(incoming, entry.files);
    plugins.unload(id);
    if (fs.existsSync(target)) {
      rm(previous);
      fs.mkdirSync(path.dirname(previous), { recursive: true });
      fs.renameSync(target, previous);
      hadPrevious = true;
      if (old) {
        // where the kept version came from, for a rollback
        fs.writeFileSync(path.join(previous, INSTALL_INFO), JSON.stringify({
          version: old.version, origin: old.origin, source: old.source
        }));
      }
    }
    fs.renameSync(incoming, target);
    return s.plugins.installed.save({
      id: id, version: p.version, origin: p.origin, source: p.source,
      signer: trust.trusted ? signing.fingerprint(trust.signer) : null
    });
  }).then(function () {
    return s.plugins.installed.get(id);
  }).then(function (row) {
    delete loadErrors[id];
    log.info('plugin ' + id + ' ' + p.version + (p.rollback ? ' put back (rollback)' : ' installed from ' + (p.origin === 'url' ? p.source : 'an upload')) +
      (trust.trusted ? ' (signed)' : ' (unsigned, developer mode)'), { plugin: id });
    if (!row.enabled) {
      return view(id);
    }
    return plugins.load(target, p.origin).then(function () {
      return view(id);
    }, function (err) {
      // the new version doesn't start: the one it replaced comes back
      log.warn('plugin ' + id + ' ' + p.version + ' didn\'t start, rolling back: ' + err.message, { plugin: id });
      plugins.unload(id);
      rm(target);
      var back = Promise.resolve();
      if (hadPrevious) {
        fs.renameSync(previous, target);
        back = s.plugins.installed.save(old).then(function () {
          return old.enabled ? plugins.load(target, old.origin).catch(function () {}) : null;
        });
      } else {
        back = s.plugins.installed.remove(id);
      }
      return back.then(function () {
        throw failure('INVALID', p.name + ' ' + p.version + ' didn\'t start: ' + err.message);
      });
    });
  }, function (err) {
    rm(incoming);
    throw err;
  });
}

/** Removes an installed plugin: its files, its row and (unless keepData) everything it kept */
function remove(id, options) {
  options = options || {};
  return services().then(function (s) {
    return s.plugins.installed.get(id).then(function (row) {
      if (!row) {
        throw failure('NOT_FOUND', 'No installed plugin ' + id);
      }
      plugins.unload(id);
      require('./notifications').forget(id);
      rm(dirOf(id));
      rm(previousOf(id));
      delete loadErrors[id];
      return s.plugins.installed.remove(id).then(function () {
        return options.keepData ? null : s.plugins.removeAll(id);
      }).then(function () {
        // folders it recognised go back to Playpex's own matching
        return s.library.folders();
      }).then(function (folders) {
        return Promise.all(folders.filter(function (f) { return f.matcher === id; }).map(function (f) {
          return s.library.updateFolder(f.id, { matcher: null });
        }));
      }).then(function () {
        log.info('plugin ' + id + ' removed' + (options.keepData ? ' (its data kept)' : ''), { plugin: id });
        return { ok: true };
      });
    });
  });
}

/** Switches an installed plugin on (loads it) or off (stops it, keeps everything) */
function setEnabled(id, on) {
  return services().then(function (s) {
    return s.plugins.installed.setEnabled(id, on);
  }).then(function () {
    plugins.unload(id);
    delete loadErrors[id];
    if (!on) {
      return view(id);
    }
    return services().then(function (s) { return s.plugins.installed.get(id); }).then(function (row) {
      return plugins.load(dirOf(id), row.origin).catch(function (err) {
        loadErrors[id] = (err.code ? err.code + ': ' : '') + err.message;
      });
    }).then(function () { return view(id); });
  });
}

/** Loads a developer copy again from its folder (after the author changed it) */
function reload(id) {
  var plugin = plugins.get(id);
  if (!plugin || plugin.origin !== 'dev') {
    return Promise.reject(failure('NOT_FOUND', 'No developer plugin ' + id));
  }
  var dir = plugin.dir;
  plugins.unload(id);
  return plugins.load(dir, 'dev').catch(function () {}).then(function () { return view(id); });
}

/** Loads every enabled installed plugin (start) */
function loadInstalled() {
  return services().then(function (s) {
    return s.plugins.installed.list();
  }).then(function (rows) {
    return Promise.all(rows.filter(function (r) { return r.enabled; }).map(function (r) {
      if (!fs.existsSync(path.join(dirOf(r.id), MANIFEST))) {
        loadErrors[r.id] = 'its files are missing from ' + dirOf(r.id);
        log.error('plugin ' + r.id + ' not loaded: ' + loadErrors[r.id], { plugin: r.id });
        return null;
      }
      return plugins.load(dirOf(r.id), r.origin).catch(function (err) {
        loadErrors[r.id] = (err.code ? err.code + ': ' : '') + err.message;
      });
    }));
  }, function (err) {
    log.warn('installed plugins not read: ' + err.message);
  });
}

// ── what the dashboard shows ────────────────────────────────────────────────

function iso(d) {
  return d instanceof Date ? d.toISOString() : d || null;
}

function describe(row, loaded) {
  // a plugin that doesn't run (off, or failed to load): its manifest on disk
  var m = loaded ? loaded.manifest : row ? installedManifest(row.id) : null;
  return {
    id: row ? row.id : loaded.id,
    name: m ? m.name : row.id,
    version: row ? row.version : m.version,
    description: m ? m.description || (m.listing && m.listing.summary) || null : null,
    publisher: m ? m.publisher || null : null,
    audience: m ? m.audience : null,
    // served by the assets route, which only knows running plugins
    icon: loaded && m.icon ? '/plugins/' + m.id + '/assets/' + m.icon.replace(/^assets\//, '') : null,
    origin: row ? row.origin : 'dev',
    source: row ? row.source : loaded.dir,
    signer: row ? row.signer : null,
    enabled: row ? row.enabled : true,
    state: row && !row.enabled ? 'disabled' : loaded ? loaded.state : 'failed',
    error: loaded ? loaded.error : row && row.enabled ? loadErrors[row.id] || 'not loaded' : null,
    permissions: m ? protocol.describePermissions(m) : [],
    hooks: m ? ((m.permissions && m.permissions.hooks) || []) : [],
    // how many options it has (Plugins › <name> › Settings); null: its manifest can't be read
    settings: m ? ((m.contributes && m.contributes.settings) || []).length : null,
    // its personal permissions (granted per profile) and account links: its page's Profiles and Accounts
    personal: m ? protocol.describePermissions(m).filter(function (x) { return x.personal; }).length : null,
    links: m ? (m.link || []).length : null,
    jobs: loaded ? require('./scheduler').view(loaded.id) : [],
    registered: loaded ? loaded.registered : null,
    stats: loaded ? Object.assign({}, loaded.stats, { sandbox: loaded.sandbox ? loaded.sandbox.stats : null }) : null,
    previous: row ? fs.existsSync(path.join(previousOf(row.id), MANIFEST)) : false,
    previousVersion: row ? previousVersion(row.id) : null,
    installedAt: row ? iso(row.installedAt) : null,
    updatedAt: row ? iso(row.updatedAt) : null
  };
}

function previousVersion(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(previousOf(id), MANIFEST), 'utf8')).version || null;
  } catch (e) {
    return null;
  }
}

/** One plugin; with `detail` also what its page shows (plan §6.3 Overview): its listing, `requires`, `exports` and changelog */
function view(id, options) {
  return services().then(function (s) { return s.plugins.installed.get(id); }).then(function (row) {
    var loaded = plugins.get(id);
    if (!row && !loaded) {
      throw failure('NOT_FOUND', 'No plugin ' + id);
    }
    var out = describe(row, loaded);
    if (options && options.detail) {
      var dir = loaded ? loaded.dir : dirOf(id),
        m = (loaded ? loaded.manifest : installedManifest(id)) || {},
        changelog = null;
      try {
        changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').slice(0, CHANGELOG_MAX);
      } catch (e) { /* none */ }
      out.listing = m.listing || null;
      out.requires = m.requires || [];
      out.exports = m.exports || [];
      out.changelog = changelog;
    }
    return out;
  });
}

/** Installed plugins (by id) and the developer copies that run */
function list() {
  return services().then(function (s) { return s.plugins.installed.list(); }).then(function (rows) {
    var out = rows.map(function (r) { return describe(r, plugins.get(r.id)); }),
      known = rows.map(function (r) { return r.id; });
    plugins.all().filter(function (p) { return known.indexOf(p.id) === -1; }).forEach(function (p) {
      out.push(describe(null, p));
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  });
}

// ── from a URL ──────────────────────────────────────────────────────────────

var GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/releases(?:\/(?:tag\/([^/?#]+)|latest))?)?\/?(?:[?#].*)?$/,
  HEADERS = { 'User-Agent': 'Playpex-Media-Server' };

function download(url) {
  return axios.get(url, {
    responseType: 'arraybuffer',
    maxContentLength: PACKAGE_MAX,
    maxBodyLength: PACKAGE_MAX,
    maxRedirects: 5,
    timeout: 60000,
    headers: HEADERS
  }).then(function (res) {
    return Buffer.from(res.data);
  }, function (err) {
    var status = err.response && err.response.status;
    throw failure('UPSTREAM', 'couldn\'t download ' + url + ': ' + (status ? 'HTTP ' + status :
      /maxContentLength/.test(err.message) ? 'larger than ' + PACKAGE_MAX / 1024 / 1024 + ' MB' : err.code || err.message));
  });
}

// A GitHub repository or release page → the package to download
function fromGithub(owner, repo, tag) {
  var api = 'https://api.github.com/repos/' + owner + '/' + repo;
  return axios.get(api + (tag ? '/releases/tags/' + encodeURIComponent(tag) : '/releases/latest'), {
    headers: Object.assign({ Accept: 'application/vnd.github+json' }, HEADERS), timeout: 20000
  }).then(function (res) {
    var assets = res.data.assets || [],
      asset = assets.filter(function (a) { return /\.ppx$/i.test(a.name); })[0] || assets.filter(function (a) { return /\.zip$/i.test(a.name); })[0];
    return asset ? { url: asset.browser_download_url, name: asset.name } :
      { url: res.data.zipball_url, name: repo + '-' + (res.data.tag_name || 'release') + ' (source)' };
  }, function (err) {
    var status = err.response && err.response.status;
    if (status === 404 && !tag) {
      // no release: the default branch's source
      return { url: api + '/zipball', name: repo + ' (default branch source)' };
    }
    throw failure('UPSTREAM', 'GitHub: ' + (status === 404 ? 'no release ' + tag + ' in ' + owner + '/' + repo :
      status ? 'HTTP ' + status : err.code || err.message));
  });
}

/** The package a URL names: { buffer, name (what was downloaded) } */
function fetchPackage(url) {
  var u;
  try {
    u = new URL(String(url || '').trim());
  } catch (e) {
    return Promise.reject(failure('INVALID', 'not a URL'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return Promise.reject(failure('INVALID', 'only http(s) URLs'));
  }
  var gh = GITHUB.exec(u.toString());
  var where = gh ? fromGithub(gh[1], gh[2], gh[3] ? decodeURIComponent(gh[3]) : null) :
    Promise.resolve({ url: u.toString(), name: decodeURIComponent(path.basename(u.pathname)) || u.host });
  return where.then(function (found) {
    return download(found.url).then(function (buffer) {
      return { buffer: buffer, name: found.name, url: found.url };
    });
  });
}

module.exports = {
  fetchPackage: fetchPackage,
  stage: stage,
  stagePrevious: stagePrevious,
  clearData: clearData,
  discard: discard,
  commit: commit,
  remove: remove,
  setEnabled: setEnabled,
  reload: reload,
  loadInstalled: loadInstalled,
  list: list,
  view: view,
  dirOf: dirOf,
  // tests
  unzip: unzip,
  rootOf: rootOf,
  GITHUB: GITHUB
};
