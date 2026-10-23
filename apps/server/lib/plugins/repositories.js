'use strict';

// Plugin repositories (docs/plugins-plan.md §6.1, §6.2, §6.4; author guide
// docs/plugins/repositories.md): signed indexes the admin trusts once, the
// Browse catalog, installs with their dependencies, updates by policy and the
// lifecycle flags. Packages from a repository are trusted because the index
// listing them is signed by the key pinned for that repository and their
// sha256 matches (./install.js#stage with origin `repository`).
//
//   start({ official, startDelayMs, intervalMs }) / stop()   from ./index.js; `official`: tests only
//   list() · preview(url) · add(url, key) · remove(id) · setEnabled(id, on) · acceptKey(id, key)
//   refresh(id?) → list()           fetch the indexes (ETag), then check the installed plugins' updates
//   catalog({ q, category }) → { plugins }   every plugin of the enabled repositories (Browse)
//   stage(repositoryId, pluginId, version?) → the preview of that package (./install.js)
//   resolve(manifest, repositoryId) → [Dependency]   what `requires` needs, deepest first
//   updates() · applyUpdates()      the Updates tab, "Update all" (those asking for nothing new)
//   lifecycle(row) · pendingUpdate(id) · nameOf(id)   what ./install.js#describe shows
//
// Rules:
//   • The index is checked with the key pinned when the admin added it; one
//     signed by another key is refused (the last good index stays) and the key
//     waits as `pendingKey` until the admin accepts it.
//   • A repository that fails keeps its last good index (shown stale with the
//     error). Fetched every 24 h (± 10 %), 5 min after start, and on "Check now";
//     HTTPS only, public addresses (./http.js), 4 MB indexes, 20 MB packages.
//   • Origin pinning: a plugin updates only from the repository it came from.
//   • The built-in official repository never carries an `audience: adults`
//     plugin: such an entry is left out of its index (`refused`), and a
//     package from it whose manifest says adults is refused at install.

var fs = require('fs'),
  path = require('path'),
  crypto = require('crypto'),
  signing = require('@playpex/protocol/signing'),
  protocol = require('@playpex/protocol/plugins'),
  http = require('./http'),
  schemas = require('./schemas'),
  OFFICIAL = require('./official'),
  paths = require('../paths'),
  settings = require('../settings'),
  userData = require('../userData'),
  log = require('../logger').child('plugins');

var INDEX_MAX = 4 * 1024 * 1024,
  PACKAGE_MAX = 20 * 1024 * 1024,
  DAY_MS = 24 * 60 * 60 * 1000,
  START_DELAY_MS = 5 * 60 * 1000,
  POLICIES = ['auto', 'notify', 'never'],
  // the server's own fetches: any public HTTPS host (an index's packages may live elsewhere, a GitHub release redirects)
  FETCHER = { id: 'repositories', anyHost: true, permissions: { network: [] } };

var config = { official: null, startDelayMs: START_DELAY_MS, intervalMs: DAY_MS },
  indexes = {},       // repository id → the last good index
  pending = {},       // plugin id → { version, needsConsent, added, error, at }: what the last update check did
  timer = null,
  running = Promise.resolve();

function failure(code, message, extra) {
  var err = new Error(message);
  err.code = code;
  return Object.assign(err, extra || {});
}

function services() {
  return userData.services();
}

function install() {
  return require('./install');
}

function official() {
  return config.official || (OFFICIAL.url && OFFICIAL.key ? OFFICIAL : null);
}

function cacheDir() {
  return path.join(paths.config, 'plugins', 'cache', 'repositories');
}

function iso(d) {
  return d instanceof Date ? d.toISOString() : d || null;
}

// ── fetching and checking an index ──────────────────────────────────────────

function checkUrl(url) {
  var u;
  try {
    u = new URL(String(url || '').trim());
  } catch (e) {
    throw failure('INVALID', 'not a URL');
  }
  if (u.protocol !== 'https:') {
    throw failure('INVALID', 'a repository is an https:// URL');
  }
  return u.toString();
}

/** { bytes, sig, etag } or { notModified: true } */
function fetchIndex(url, etag) {
  return http.request(FETCHER, {
    url: url, responseType: 'bytes', headers: etag ? { 'If-None-Match': etag } : {}
  }).then(function (r) {
    var status = r.value.status;
    if (status === 304 && etag) {
      return { notModified: true };
    }
    if (status !== 200) {
      throw failure('UPSTREAM', 'the index answered HTTP ' + status);
    }
    if (r.bytes.length > INDEX_MAX) {
      throw failure('INVALID', 'the index is larger than 4 MB');
    }
    return http.request(FETCHER, { url: url + '.sig', responseType: 'text' }).then(function (s) {
      if (s.value.status !== 200) {
        throw failure('UPSTREAM', 'its signature (' + url + '.sig) answered HTTP ' + s.value.status);
      }
      return { bytes: r.bytes, sig: String(s.value.body || '').trim(), etag: r.value.headers.etag || null };
    });
  }, function (err) {
    throw err.code && ['INVALID', 'UPSTREAM'].indexOf(err.code) !== -1 ? err : failure('UPSTREAM', 'the index couldn\'t be fetched: ' + err.message);
  });
}

function parse(bytes) {
  var index;
  try {
    index = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (e) {
    throw failure('INVALID', 'the index isn\'t JSON');
  }
  var problems = schemas.indexProblems(index);
  if (problems.length) {
    throw failure('INVALID', 'the index doesn\'t follow repository.schema.json: ' + problems.join('; '));
  }
  return index;
}

/**
 * The index of a repository we trust, checked with its pinned key. Another
 * key that signed it (named in the index) → KEY_CHANGED with `key`.
 */
function verified(row, bytes, sig) {
  var index = parse(bytes);
  if (!signing.verify(bytes, sig, row.key)) {
    var named = index.repository.key;
    if (named !== row.key && signing.verify(bytes, sig, named)) {
      throw failure('KEY_CHANGED', 'the index is now signed by another key (' + signing.fingerprint(named) +
        '): accept it to use this repository again', { key: named });
    }
    throw failure('BAD_SIGNATURE', 'the index\'s signature doesn\'t check with the key trusted for this repository');
  }
  if (index.repository.id !== row.id) {
    throw failure('INVALID', 'the index is now repository ' + index.repository.id + ', not ' + row.id);
  }
  return index;
}

function writeCache(id, bytes, sig) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(), id + '.json'), bytes);
  fs.writeFileSync(path.join(cacheDir(), id + '.json.sig'), sig);
}

function readCache(row) {
  try {
    var bytes = fs.readFileSync(path.join(cacheDir(), row.id + '.json')),
      sig = fs.readFileSync(path.join(cacheDir(), row.id + '.json.sig'), 'utf8');
    indexes[row.id] = verified(row, bytes, sig);
  } catch (e) {
    delete indexes[row.id];
  }
}

function dropCache(id) {
  delete indexes[id];
  ['.json', '.json.sig'].forEach(function (ext) {
    fs.rmSync(path.join(cacheDir(), id + ext), { force: true });
  });
}

/** Fetches one repository's index; a failure keeps the last good one and is written on the row */
function refreshOne(row) {
  var at = new Date();
  return fetchIndex(row.url, indexes[row.id] ? row.etag : null).then(function (r) {
    if (r.notModified) {
      return { fetchedAt: at, checkedAt: at, error: null };
    }
    var index = verified(row, r.bytes, r.sig);
    writeCache(row.id, r.bytes, r.sig);
    indexes[row.id] = index;
    return { name: index.repository.name, etag: r.etag, fetchedAt: at, checkedAt: at, error: null, pendingKey: null };
  }).catch(function (err) {
    log.warn('plugin repository ' + row.id + ': ' + err.message, { code: err.code });
    return { checkedAt: at, error: err.message, pendingKey: err.code === 'KEY_CHANGED' ? err.key : row.pendingKey };
  }).then(function (patch) {
    return services().then(function (s) { return s.plugins.repositories.save(Object.assign({}, row, patch)); });
  });
}

// ── what an index offers ────────────────────────────────────────────────────

function isAdults(entry) {
  return entry.versions.some(function (v) { return v.audience === 'adults'; });
}

/** Its plugins: { entries, refused } (the official repository refuses adults plugins) */
function offered(row) {
  var index = indexes[row.id], out = { entries: [], refused: [] };
  if (!index) {
    return out;
  }
  index.plugins.forEach(function (entry) {
    if (row.builtin && isAdults(entry)) {
      out.refused.push({ id: entry.id, name: entry.name, reason: 'The official repository doesn\'t carry adults plugins' });
    } else {
      out.entries.push(entry);
    }
  });
  return out;
}

function compatible(v) {
  return !v.api || !v.api.server || protocol.satisfies(v.api.server, protocol.SERVER_PLUGIN_API);
}

function byVersion(a, b) {
  return protocol.compareVersions(b.version, a.version);
}

/** Its newest version this server can run and nobody marked broken, or null */
function newest(entry, range) {
  return entry.versions.slice().sort(byVersion).filter(function (v) {
    return compatible(v) && v.lifecycle !== 'broken' && (!range || protocol.satisfiesVersion(range, v.version));
  })[0] || null;
}

/** An index version as a manifest, for describePermissions (no `link` labels: those come with the package) */
function asManifest(entry, v) {
  return { id: entry.id, name: entry.name, audience: v.audience || 'everyone', permissions: v.permissions || {}, requires: v.requires };
}

function versionView(entry, v) {
  return {
    version: v.version,
    releasedAt: v.releasedAt,
    size: v.size,
    lifecycle: v.lifecycle || 'stable',
    reason: v.reason || null,
    replacedBy: v.replacedBy || null,
    changelog: v.changelog || null,
    audience: v.audience || null,
    compatible: compatible(v),
    permissions: protocol.describePermissions(asManifest(entry, v)),
    requires: v.requires || []
  };
}

function rows() {
  return services().then(function (s) { return s.plugins.repositories.list(); });
}

function enabledRows() {
  return rows().then(function (list) { return list.filter(function (r) { return r.enabled; }); });
}

/** { row, entry } of a plugin in an enabled repository, else NOT_FOUND */
function find(repositoryId, pluginId) {
  return enabledRows().then(function (list) {
    var row = list.filter(function (r) { return r.id === repositoryId; })[0];
    if (!row) {
      throw failure('NOT_FOUND', 'No enabled repository ' + repositoryId);
    }
    var entry = offered(row).entries.filter(function (e) { return e.id === pluginId; })[0];
    if (!entry) {
      throw failure('NOT_FOUND', repositoryId + ' doesn\'t offer ' + pluginId);
    }
    return { row: row, entry: entry };
  });
}

// ── the admin's list ────────────────────────────────────────────────────────

function view(row) {
  var o = offered(row), index = indexes[row.id];
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    homepage: index && index.repository.homepage || null,
    builtin: !!row.builtin,
    enabled: !!row.enabled,
    key: row.key,
    fingerprint: signing.fingerprint(row.key),
    pendingKey: row.pendingKey ? { key: row.pendingKey, fingerprint: signing.fingerprint(row.pendingKey) } : null,
    fetchedAt: iso(row.fetchedAt),
    checkedAt: iso(row.checkedAt),
    generatedAt: index ? index.generatedAt : null,
    error: row.error || null,
    stale: !!row.error && !!index,
    plugins: o.entries.length,
    refused: o.refused,
    addedAt: iso(row.addedAt)
  };
}

function list() {
  return rows().then(function (r) { return r.map(view); });
}

/** What adding `url` would trust: its name, id and key (self-signed check), before the admin says yes */
function preview(url) {
  try {
    url = checkUrl(url);
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.all([fetchIndex(url, null), rows()]).then(function (r) {
    var index = parse(r[0].bytes), key = index.repository.key;
    if (!signing.verify(r[0].bytes, r[0].sig, key)) {
      throw failure('INVALID', 'the index\'s signature doesn\'t check with the key it names');
    }
    var same = r[1].filter(function (x) { return x.id === index.repository.id || x.url === url; })[0];
    var off = official();
    return {
      url: url,
      id: index.repository.id,
      name: index.repository.name,
      homepage: index.repository.homepage || null,
      key: key,
      fingerprint: signing.fingerprint(key),
      plugins: index.plugins.length,
      generatedAt: index.generatedAt,
      known: same ? same.id : null,
      problem: same ? 'Already added (' + same.name + ')' :
        off && index.repository.id === off.id ? 'The id ' + off.id + ' is the official repository\'s' : null,
      bytes: r[0].bytes,
      sig: r[0].sig
    };
  });
}

function publicPreview(p) {
  var out = Object.assign({}, p);
  delete out.bytes;
  delete out.sig;
  return out;
}

/** Trusts a repository: `key` is the one the admin saw in the preview */
function add(url, key) {
  return preview(url).then(function (p) {
    if (p.problem) {
      throw failure('CONFLICT', p.problem);
    }
    if (p.key !== key) {
      throw failure('CONFLICT', 'The index is signed by another key than the one you saw (' + p.fingerprint + '): look again');
    }
    var row = { id: p.id, url: p.url, name: p.name, key: p.key, enabled: true, builtin: false, fetchedAt: new Date(),
      checkedAt: new Date(), error: null, pendingKey: null };
    writeCache(p.id, p.bytes, p.sig);
    indexes[p.id] = parse(p.bytes);
    return services().then(function (s) { return s.plugins.repositories.save(row); }).then(function () {
      log.info('plugin repository ' + p.id + ' added (' + p.url + ', key ' + p.fingerprint + ')');
      return services().then(function (s) { return s.plugins.repositories.get(p.id); });
    }).then(view);
  });
}

function row(id) {
  return services().then(function (s) { return s.plugins.repositories.get(id); }).then(function (r) {
    if (!r) {
      throw failure('NOT_FOUND', 'No repository ' + id);
    }
    return r;
  });
}

/** Forgets a repository (its plugins stay installed; they don't update any more) */
function remove(id) {
  return row(id).then(function (r) {
    if (r.builtin) {
      throw failure('CONFLICT', 'The official repository can\'t be removed: turn it off');
    }
    dropCache(id);
    return services().then(function (s) { return s.plugins.repositories.remove(id); });
  }).then(function () {
    log.info('plugin repository ' + id + ' removed');
    return { ok: true };
  });
}

function setEnabled(id, on) {
  return row(id).then(function (r) {
    return services().then(function (s) { return s.plugins.repositories.save(Object.assign({}, r, { enabled: !!on })); });
  }).then(function () { return row(id); }).then(view);
}

/** The key an index is now signed with, accepted: the repository is fetched again with it */
function acceptKey(id, key) {
  return row(id).then(function (r) {
    if (!r.pendingKey || r.pendingKey !== key) {
      throw failure('CONFLICT', 'That isn\'t the key waiting for this repository');
    }
    if (r.builtin) {
      throw failure('CONFLICT', 'The official repository\'s key ships with the server');
    }
    log.warn('plugin repository ' + id + ': new key accepted (' + signing.fingerprint(key) + ')');
    var next = Object.assign({}, r, { key: key, pendingKey: null, etag: null });
    return services().then(function (s) { return s.plugins.repositories.save(next); }).then(function () {
      return refreshOne(next);
    });
  }).then(function () { return row(id); }).then(view);
}

/** Fetches the indexes (one, or every enabled), then checks the installed plugins' updates */
function refresh(id) {
  running = running.catch(function () {}).then(function () {
    return enabledRows().then(function (list) {
      return list.filter(function (r) { return !id || r.id === id; }).reduce(function (p, r) {
        return p.then(function () { return refreshOne(r); });
      }, Promise.resolve());
    }).then(checkUpdates);
  });
  return running.then(list);
}

// ── Browse ──────────────────────────────────────────────────────────────────

function installedRows() {
  return services().then(function (s) { return s.plugins.installed.list(); });
}

function catalog(filter) {
  filter = filter || {};
  var q = String(filter.q || '').trim().toLowerCase();
  return Promise.all([enabledRows(), installedRows()]).then(function (r) {
    var installed = {};
    r[1].forEach(function (x) { installed[x.id] = x; });
    var items = [];
    r[0].forEach(function (repo) {
      offered(repo).entries.forEach(function (entry) {
        var latest = newest(entry), mine = installed[entry.id], listing = entry.listing || {};
        if (q && (entry.name + ' ' + entry.id + ' ' + (listing.summary || '')).toLowerCase().indexOf(q) === -1) {
          return;
        }
        if (filter.category && (listing.categories || []).indexOf(filter.category) === -1) {
          return;
        }
        items.push({
          id: entry.id,
          name: entry.name,
          publisher: entry.publisher,
          icon: entry.icon || null,
          listing: listing,
          repository: { id: repo.id, name: repo.name, builtin: !!repo.builtin },
          latest: latest ? versionView(entry, latest) : null,
          versions: entry.versions.slice().sort(byVersion).map(function (v) { return versionView(entry, v); }),
          incompatible: latest ? null : entry.versions.some(compatible) ? 'Every version it offers is marked broken' :
            'Needs a newer Playpex Media Server (plugin API ' + protocol.SERVER_PLUGIN_API + ')',
          installed: mine ? { version: mine.version, repository: mine.repository || null, origin: mine.origin } : null,
          update: !!(mine && latest && mine.repository === repo.id && protocol.compareVersions(latest.version, mine.version) > 0)
        });
      });
    });
    return { plugins: items.sort(function (a, b) { return a.name.localeCompare(b.name) || a.repository.name.localeCompare(b.repository.name); }) };
  });
}

// ── packages ────────────────────────────────────────────────────────────────

/** The .ppx a version names, its size and sha256 checked against the index */
function download(v) {
  return http.stream(FETCHER, { url: v.url }).then(function (res) {
    if (res.status !== 200) {
      res.abort();
      throw failure('UPSTREAM', 'the package answered HTTP ' + res.status);
    }
    return new Promise(function (ok, fail) {
      var chunks = [], size = 0;
      res.body.on('data', function (chunk) {
        size += chunk.length;
        if (size > Math.min(PACKAGE_MAX, v.size)) {
          res.abort();
          fail(failure('INVALID', 'the package is larger than its index says'));
        }
        chunks.push(chunk);
      });
      res.body.on('end', function () { ok(Buffer.concat(chunks)); });
      res.body.on('error', function (err) { fail(failure('UPSTREAM', 'the package download failed: ' + err.message)); });
    });
  }, function (err) {
    throw err.code === 'UPSTREAM' ? err : failure('UPSTREAM', 'the package couldn\'t be downloaded: ' + err.message);
  }).then(function (buffer) {
    var sha = crypto.createHash('sha256').update(buffer).digest('hex');
    if (sha !== v.sha256 || buffer.length !== v.size) {
      throw failure('INVALID', 'the package doesn\'t match its index (sha256 / size): not installed');
    }
    return buffer;
  });
}

/** Downloads a version of a plugin of a repository and stages it (./install.js): its preview */
function stage(repositoryId, pluginId, version) {
  return find(repositoryId, pluginId).then(function (f) {
    var v = version ? f.entry.versions.filter(function (x) { return x.version === version; })[0] : newest(f.entry);
    if (!v) {
      throw failure('NOT_FOUND', version ? pluginId + ' ' + version + ' isn\'t in ' + repositoryId : 'No version of ' + pluginId + ' runs here');
    }
    if (!compatible(v)) {
      throw failure('CONFLICT', pluginId + ' ' + v.version + ' needs a newer Playpex Media Server');
    }
    return download(v).then(function (buffer) {
      return install().stage(buffer, {
        origin: 'repository',
        repository: f.row.id,
        repositoryName: f.row.name,
        official: !!f.row.builtin,
        source: v.url,
        expect: { id: pluginId, version: v.version, lifecycle: v.lifecycle || 'stable', reason: v.reason || null }
      });
    });
  });
}

/**
 * The plugins `manifest.requires` needs, deepest first: installed ones that fit
 * are `installed`; the others from `repositoryId` first, then any enabled
 * repository ({ id, name, version, repository, optional, permissions }); none
 * offering a fitting version → `missing`
 */
function resolve(manifest, repositoryId) {
  return Promise.all([enabledRows(), installedRows()]).then(function (r) {
    var repos = r[0].slice().sort(function (a, b) { return (b.id === repositoryId) - (a.id === repositoryId); }),
      installed = {}, out = [], seen = {};
    r[1].forEach(function (x) { installed[x.id] = x; });
    (function walk(requires, optional) {
      (requires || []).forEach(function (req) {
        if (seen[req.id] || req.id === manifest.id) {
          return;
        }
        seen[req.id] = true;
        var here = installed[req.id];
        if (here && protocol.satisfiesVersion(req.version, here.version)) {
          out.push({ id: req.id, name: req.id, version: here.version, range: req.version, optional: !!(optional || req.optional),
            installed: true, missing: false, repository: here.repository || null, permissions: [] });
          return;
        }
        var found = null;
        repos.some(function (repo) {
          return offered(repo).entries.some(function (entry) {
            var v = entry.id === req.id && newest(entry, req.version);
            if (v) {
              found = { repo: repo, entry: entry, v: v };
            }
            return !!v;
          });
        });
        if (!found) {
          out.push({ id: req.id, name: req.id, version: null, range: req.version, optional: !!(optional || req.optional),
            installed: false, missing: true, repository: null, permissions: [] });
          return;
        }
        walk(found.v.requires, optional || req.optional);
        out.push({
          id: req.id, name: found.entry.name, version: found.v.version, range: req.version, optional: !!(optional || req.optional),
          installed: false, missing: false, repository: found.repo.id, repositoryName: found.repo.name, update: !!here,
          permissions: protocol.describePermissions(asManifest(found.entry, found.v))
        });
      });
    })(manifest.requires, false);
    return out;
  });
}

// ── updates and lifecycle ───────────────────────────────────────────────────

function policyOf(row) {
  return row.updatePolicy || settings.get('plugins.updates') || 'auto';
}

/** The entry of an installed plugin in its origin repository, or null */
function originEntry(row) {
  var repo = row.repository && indexes[row.repository];
  return repo ? repo.plugins.filter(function (e) { return e.id === row.id; })[0] || null : null;
}

/** Its version's flags in its origin repository: { state, reason, replacedBy, listed } or null (not from one) */
function lifecycle(row) {
  if (!row || row.origin !== 'repository' || !indexes[row.repository]) {
    return null;
  }
  var entry = originEntry(row),
    v = entry && entry.versions.filter(function (x) { return x.version === row.version; })[0];
  return {
    state: v ? v.lifecycle || 'stable' : 'stable',
    reason: v && v.reason || null,
    replacedBy: v && v.replacedBy || null,
    listed: !!entry
  };
}

function pendingUpdate(id) {
  return pending[id] || null;
}

function nameOf(id) {
  var index = indexes[id];
  return index ? index.repository.name : null;
}

/** Updates of plugins installed from a repository, from their origin only */
function updates() {
  return installedRows().then(function (list) {
    return list.filter(function (r) { return r.origin === 'repository'; }).map(function (r) {
      var entry = originEntry(r), latest = entry && newest(entry);
      if (!latest || protocol.compareVersions(latest.version, r.version) <= 0) {
        return null;
      }
      var current = install().installedManifest(r.id),
        added = install().permissionChanges(asManifest(entry, latest), current).added,
        newer = entry.versions.filter(function (v) { return protocol.compareVersions(v.version, r.version) > 0 && v.changelog; })
          .sort(byVersion).map(function (v) { return '## ' + v.version + '\n' + v.changelog; }).join('\n\n');
      return {
        id: r.id,
        name: current ? current.name : r.id,
        repository: { id: r.repository, name: nameOf(r.repository) },
        installed: r.version,
        version: latest.version,
        changelog: newer || null,
        added: added,
        policy: policyOf(r),
        fixes: (lifecycle(r) || {}).state === 'broken',
        state: pending[r.id] || null
      };
    }).filter(Boolean);
  });
}

/** Installs one update if it asks for nothing new; { id, version, installed, reason? } */
function tryUpdate(u) {
  if (u.added.length) {
    return Promise.resolve({ id: u.id, version: u.version, installed: false, reason: 'asks for more: ' + u.added.map(function (a) { return a.text; }).join('; ') });
  }
  return stage(u.repository.id, u.id, u.version).then(function (p) {
    var blocker = p.added.length ? 'asks for more: ' + p.added.map(function (a) { return a.text; }).join('; ') :
      !p.installable ? p.reason :
        p.dependencies.some(function (d) { return !d.installed && !d.optional; }) ? 'needs plugins that aren\'t installed' : null;
    if (blocker) {
      install().discard(p.token);
      return { id: u.id, version: u.version, installed: false, reason: blocker };
    }
    return install().commit(p.token, {}).then(function () {
      return { id: u.id, version: u.version, installed: true };
    });
  }).catch(function (err) {
    return { id: u.id, version: u.version, installed: false, reason: err.message };
  });
}

/** "Update all": every update asking for no new permissions, whatever the policy */
function applyUpdates() {
  return updates().then(function (list) {
    return list.reduce(function (p, u) {
      return p.then(function (done) {
        return tryUpdate(u).then(function (r) { return done.concat([r]); });
      });
    }, Promise.resolve([]));
  }).then(function (results) {
    results.forEach(remember);
    return { results: results };
  });
}

function remember(r) {
  if (r.installed) {
    delete pending[r.id];
  } else {
    pending[r.id] = { version: r.version, needsConsent: /^asks for more/.test(r.reason), reason: r.reason, at: new Date().toISOString() };
  }
}

/**
 * After the indexes changed: a version marked broken is switched off (held);
 * under `auto`, updates asking for nothing new install by themselves (a fix
 * of a broken version turns it back on), the others wait for the admin
 */
function checkUpdates() {
  return installedRows().then(function (list) {
    var holds = list.filter(function (r) {
      var l = lifecycle(r);
      return l && l.state === 'broken' && r.enabled;
    }).reduce(function (p, r) {
      var reason = 'broken: ' + (lifecycle(r).reason || 'its repository marked this version broken');
      return p.then(function () {
        log.warn('plugin ' + r.id + ' ' + r.version + ' switched off: ' + reason, { plugin: r.id });
        return install().hold(r.id, reason);
      });
    }, Promise.resolve());
    return holds.then(updates);
  }).then(function (list) {
    return list.reduce(function (p, u) {
      if (u.policy !== 'auto') {
        return p;
      }
      return p.then(function () {
        return tryUpdate(u).then(function (r) {
          remember(r);
          if (r.installed) {
            log.info('plugin ' + u.id + ' updated to ' + u.version + ' (auto)', { plugin: u.id });
          }
        });
      });
    }, Promise.resolve());
  }).catch(function (err) {
    log.warn('plugin updates not checked: ' + err.message);
  });
}

// ── life ────────────────────────────────────────────────────────────────────

/** The built-in official repository's row, from what ships with the server */
function ensureOfficial() {
  var off = official();
  return rows().then(function (list) {
    var mine = list.filter(function (r) { return r.builtin; })[0];
    if (!off) {
      return mine ? services().then(function (s) { dropCache(mine.id); return s.plugins.repositories.remove(mine.id); }) : null;
    }
    var next = Object.assign({}, mine && mine.id === off.id ? mine : { enabled: true }, {
      id: off.id, url: off.url, name: off.name || 'Playpex', key: off.key, builtin: true
    });
    if (mine && mine.id !== off.id) {
      dropCache(mine.id);
    }
    return services().then(function (s) {
      return (mine && mine.id !== off.id ? s.plugins.repositories.remove(mine.id) : Promise.resolve()).then(function () {
        return s.plugins.repositories.save(next);
      });
    });
  });
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(function () {
    refresh().catch(function () {}).then(function () {
      schedule(config.intervalMs * (0.9 + Math.random() * 0.2));
    });
  }, ms);
  if (timer.unref) {
    timer.unref();
  }
}

/** Reads the cached indexes, then fetches them startDelayMs later and every intervalMs (false: never by itself) */
function start(options) {
  config = Object.assign({ official: null, startDelayMs: START_DELAY_MS, intervalMs: DAY_MS }, options || {});
  indexes = {};
  pending = {};
  return ensureOfficial().then(rows).then(function (list) {
    list.forEach(readCache);
    if (config.startDelayMs !== false) {
      schedule(config.startDelayMs);
    }
  }).catch(function (err) {
    log.warn('plugin repositories not read: ' + err.message);
  });
}

function stop() {
  clearTimeout(timer);
  timer = null;
  return running.catch(function () {});
}

module.exports = {
  start: start,
  stop: stop,
  list: list,
  preview: function (url) { return preview(url).then(publicPreview); },
  add: add,
  remove: remove,
  setEnabled: setEnabled,
  acceptKey: acceptKey,
  refresh: refresh,
  catalog: catalog,
  stage: stage,
  resolve: resolve,
  updates: updates,
  applyUpdates: applyUpdates,
  lifecycle: lifecycle,
  pendingUpdate: pendingUpdate,
  nameOf: nameOf,
  officialConfigured: function () {
    var off = official();
    return off ? { id: off.id, name: off.name, url: off.url } : null;
  },
  isBuiltin: function (id) {
    var off = official();
    return !!off && off.id === id;
  },
  POLICIES: POLICIES
};
