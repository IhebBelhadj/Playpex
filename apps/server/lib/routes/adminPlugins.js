'use strict';

// /api/v1/admin/plugins (docs/plugins-plan.md §6.3): the dashboard's Plugins
// page. Installing is two steps, so the admin sees what a package is and
// what it may do before it runs: a package (an upload, or a URL: a direct
// link or a GitHub repository / release) is staged and previewed, then
// installed by its token. Mounted by lib/routes/admin.js after requireAdmin.
//
//   GET    /admin/plugins                       { plugins, developerMode, publisherKeys: [{ key, fingerprint }], devDir, pluginsDir }
//   POST   /admin/plugins/packages              multipart `file` (.ppx / .zip) or { url } → the preview (lib/plugins/install.js#stage)
//   POST   /admin/plugins/packages/:token/install   { accept? } → the installed plugin (`accept`: the
//                                               preview's `added` permissions, else 409 when it has any)
//   DELETE /admin/plugins/packages/:token       forget a preview
//   GET    /admin/plugins/repositories          { repositories, official (configured?), updates (the server's policy) }
//   POST   /admin/plugins/repositories/preview  { url } → what adding it would trust (id, name, key fingerprint)
//   POST   /admin/plugins/repositories          { url, key } (the key the preview showed) → the repository
//   POST   /admin/plugins/repositories/refresh  { id? } "Check now": fetched, then updates checked → { repositories }
//   PATCH  /admin/plugins/repositories/:id      { enabled }
//   DELETE /admin/plugins/repositories/:id      not the official one
//   POST   /admin/plugins/repositories/:id/key  { key } the new key its index is signed with, accepted
//   GET    /admin/plugins/catalog?q=&category=  { plugins } Browse: every plugin of the enabled repositories
//   POST   /admin/plugins/catalog/install       { repository, id, version? } → a preview (with its dependencies)
//   GET    /admin/plugins/updates               { updates, policy } updates from each plugin's origin repository
//   POST   /admin/plugins/updates/apply         "Update all": those asking for no new permissions → { results }
//   GET    /admin/plugins/:id                   one plugin, with its listing, requires, exports, changelog
//   PATCH  /admin/plugins/:id                   { enabled?, updatePolicy? } (an installed plugin)
//   POST   /admin/plugins/:id/rollback          the version kept by the last update → a preview, installed by its token
//   POST   /admin/plugins/:id/clear             forget everything it kept (storage, secrets, accounts, settings, grants)
//   POST   /admin/plugins/:id/reload            a developer copy, from its folder again
//   DELETE /admin/plugins/:id?data=keep|delete&force=1  remove an installed plugin (default: its data too);
//                                               plugins requiring it: 409 with `dependents`, unless force
//   GET    /admin/plugins/:id/settings          its options (lib/plugins/settings.js): definitions, server values,
//                                               which secrets are set, the profiles' values
//   PUT    /admin/plugins/:id/settings          { profile?, values: { key: value | null } } → the same
//   POST   /admin/plugins/:id/settings/:key/run an `action` setting → { data, effects }
//   PUT    /admin/plugins/:id/grants            { profile, permission, granted } a personal permission → its settings
//   PUT    /admin/plugins/:id/profiles          { profile, shown } shown to that profile or hidden from it → its settings
//   GET    /admin/plugins/:id/links             { links: [{ name, label, scope, kind, accounts }] } (lib/plugins/links.js)
//   POST   /admin/plugins/:id/links/:name/start { profile? } → { kind: 'code', code, url, … } | { kind: 'form', form, help }
//   GET    /admin/plugins/:id/links/:name/progress?profile=  { state: pending | done | failed | none, message }
//   POST   /admin/plugins/:id/links/:name/submit { profile?, values } (a custom link's form) → the same
//   DELETE /admin/plugins/:id/links/:name?profile=  unlink

var express = require('express'),
  fs = require('fs'),
  path = require('path'),
  multipart = require('connect-multiparty'),
  signing = require('@playpex/protocol/signing'),
  install = require('../plugins/install'),
  repositories = require('../plugins/repositories'),
  pluginSettings = require('../plugins/settings'),
  links = require('../plugins/links'),
  plugins = require('../plugins'),
  settings = require('../settings'),
  paths = require('../paths'),
  errors = require('../errors'),
  log = require('../logger').child('plugins');

var router = express.Router(),
  CODES = { INVALID: 'INVALID', INVALID_MANIFEST: 'INVALID', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT',
    FORBIDDEN: 'FORBIDDEN', UPSTREAM: 'UPSTREAM', PLUGIN_FAILED: 'PLUGIN_FAILED', BAD_ANSWER: 'PLUGIN_FAILED',
    HOST_NOT_ALLOWED: 'UPSTREAM', ADDRESS_NOT_ALLOWED: 'UPSTREAM', RATE_LIMITED: 'TOO_MANY_ATTEMPTS', TIMEOUT: 'UPSTREAM',
    // fetching a repository's index or package (lib/plugins/http.js, lib/plugins/repositories.js)
    HTTPS_ONLY: 'INVALID', PORT_NOT_ALLOWED: 'INVALID', DNS_FAILED: 'UPSTREAM', NETWORK: 'UPSTREAM', RESPONSE_TOO_LARGE: 'UPSTREAM',
    TOO_MANY_REDIRECTS: 'UPSTREAM', BAD_JSON: 'UPSTREAM', BAD_SIGNATURE: 'UPSTREAM', KEY_CHANGED: 'CONFLICT' };

function answer(res, work) {
  Promise.resolve().then(work).then(function (value) {
    res.json(value);
  }, function (err) {
    var code = CODES[err.code];
    if (!code) {
      log.error('admin plugins: ' + err.message, { err: err });
      return errors.fail(res, 'INTERNAL', 'Internal error');
    }
    errors.fail(res, code, err.message, err.errors ? { errors: err.errors } : err.dependents ? { dependents: err.dependents } : undefined);
  });
}

function localeOf(req) {
  var first = String(req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : 'en';
}

function keys() {
  return (settings.get('plugins.publisherKeys') || []).map(function (key) {
    return { key: key, fingerprint: signing.fingerprint(key) };
  });
}

router.get('/plugins', function (req, res) {
  answer(res, function () {
    return install.list().then(function (list) {
      return {
        plugins: list,
        developerMode: !!settings.get('plugins.developerMode'),
        publisherKeys: keys(),
        devDir: plugins.devDir(),
        pluginsDir: path.join(paths.config, 'plugins')
      };
    });
  });
});

// A package to look at before installing: an upload (multipart `file`) or { url }
router.post('/plugins/packages', multipart({ maxFilesSize: 20 * 1024 * 1024 }), function (req, res) {
  answer(res, function () {
    var file = req.files && req.files.file;
    if (file) {
      return fs.promises.readFile(file.path).finally(function () {
        fs.unlink(file.path, function () {});
      }).then(function (buffer) {
        return install.stage(buffer, { origin: 'upload', source: String(file.originalFilename || file.name || 'package.zip').slice(0, 200) });
      });
    }
    var url = req.body && req.body.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw Object.assign(new Error('send a file (multipart `file`) or { url }'), { code: 'INVALID' });
    }
    return install.fetchPackage(url).then(function (found) {
      return install.stage(found.buffer, { origin: 'url', source: url.trim().slice(0, 2000), resolved: found.name });
    });
  });
});

router.post('/plugins/packages/:token/install', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    return install.commit(req.params.token, {
      accept: body.accept === true,
      optional: Array.isArray(body.optional) ? body.optional.filter(function (x) { return typeof x === 'string'; }) : []
    });
  });
});

router.delete('/plugins/packages/:token', function (req, res) {
  answer(res, function () { return { ok: install.discard(req.params.token) }; });
});

// ── repositories (P4b) ──────────────────────────────────────────────────────

router.get('/plugins/repositories', function (req, res) {
  answer(res, function () {
    return repositories.list().then(function (list) {
      return { repositories: list, official: repositories.officialConfigured(), updates: settings.get('plugins.updates') };
    });
  });
});

router.post('/plugins/repositories/preview', function (req, res) {
  answer(res, function () { return repositories.preview((req.body || {}).url); });
});

router.post('/plugins/repositories', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    if (typeof body.key !== 'string') {
      throw Object.assign(new Error('key: the key the preview showed'), { code: 'INVALID' });
    }
    return repositories.add(body.url, body.key);
  });
});

router.post('/plugins/repositories/refresh', function (req, res) {
  answer(res, function () {
    return repositories.refresh((req.body || {}).id || null).then(function (list) { return { repositories: list }; });
  });
});

router.patch('/plugins/repositories/:repoId', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    if (typeof body.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be true or false'), { code: 'INVALID' });
    }
    return repositories.setEnabled(req.params.repoId, body.enabled);
  });
});

router.delete('/plugins/repositories/:repoId', function (req, res) {
  answer(res, function () { return repositories.remove(req.params.repoId); });
});

router.post('/plugins/repositories/:repoId/key', function (req, res) {
  answer(res, function () { return repositories.acceptKey(req.params.repoId, (req.body || {}).key); });
});

router.get('/plugins/catalog', function (req, res) {
  answer(res, function () {
    return repositories.catalog({ q: req.query.q, category: req.query.category });
  });
});

router.post('/plugins/catalog/install', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    if (typeof body.repository !== 'string' || typeof body.id !== 'string') {
      throw Object.assign(new Error('repository and id'), { code: 'INVALID' });
    }
    return repositories.stage(body.repository, body.id, typeof body.version === 'string' ? body.version : null);
  });
});

router.get('/plugins/updates', function (req, res) {
  answer(res, function () {
    return repositories.updates().then(function (list) { return { updates: list, policy: settings.get('plugins.updates') }; });
  });
});

router.post('/plugins/updates/apply', function (req, res) {
  answer(res, function () { return repositories.applyUpdates(); });
});

// ── one plugin ──────────────────────────────────────────────────────────────

router.get('/plugins/:id', function (req, res) {
  answer(res, function () { return install.view(req.params.id, { detail: true }); });
});

router.patch('/plugins/:id', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    if (body.enabled === undefined && body.updatePolicy === undefined) {
      throw Object.assign(new Error('enabled (true or false) or updatePolicy (auto, notify, never or null)'), { code: 'INVALID' });
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be true or false'), { code: 'INVALID' });
    }
    var first = body.updatePolicy === undefined ? Promise.resolve() :
      install.setUpdatePolicy(req.params.id, body.updatePolicy);
    return first.then(function (v) {
      return body.enabled === undefined ? v : install.setEnabled(req.params.id, body.enabled);
    });
  });
});

router.post('/plugins/:id/reload', function (req, res) {
  answer(res, function () { return install.reload(req.params.id); });
});

router.post('/plugins/:id/rollback', function (req, res) {
  answer(res, function () { return install.stagePrevious(req.params.id); });
});

router.post('/plugins/:id/clear', function (req, res) {
  answer(res, function () { return install.clearData(req.params.id); });
});

router.delete('/plugins/:id', function (req, res) {
  answer(res, function () {
    return install.remove(req.params.id, { keepData: req.query.data === 'keep', force: req.query.force === '1' || req.query.force === 'true' });
  });
});

router.get('/plugins/:id/settings', function (req, res) {
  answer(res, function () { return pluginSettings.view(req.params.id, localeOf(req)); });
});

router.put('/plugins/:id/settings', function (req, res) {
  answer(res, function () { return pluginSettings.update(req.params.id, req.body, localeOf(req)); });
});

router.post('/plugins/:id/settings/:key/run', function (req, res) {
  answer(res, function () { return pluginSettings.run(req.params.id, req.params.key, localeOf(req)); });
});

router.put('/plugins/:id/grants', function (req, res) {
  answer(res, function () { return pluginSettings.grant(req.params.id, req.body, localeOf(req)); });
});

router.put('/plugins/:id/profiles', function (req, res) {
  answer(res, function () { return pluginSettings.show(req.params.id, req.body, localeOf(req)); });
});

function profileParam(req) {
  var p = (req.body && req.body.profile) || req.query.profile;
  return typeof p === 'string' && p ? p : null;
}

router.get('/plugins/:id/links', function (req, res) {
  answer(res, function () { return links.list(req.params.id).then(function (list) { return { links: list }; }); });
});

router.post('/plugins/:id/links/:name/start', function (req, res) {
  answer(res, function () { return links.start(req.params.id, req.params.name, profileParam(req)); });
});

router.get('/plugins/:id/links/:name/progress', function (req, res) {
  answer(res, function () { return links.progress(req.params.id, req.params.name, profileParam(req)); });
});

router.post('/plugins/:id/links/:name/submit', function (req, res) {
  answer(res, function () { return links.submit(req.params.id, req.params.name, profileParam(req), req.body && req.body.values); });
});

router.delete('/plugins/:id/links/:name', function (req, res) {
  answer(res, function () { return links.unlink(req.params.id, req.params.name, profileParam(req)); });
});

module.exports = router;
