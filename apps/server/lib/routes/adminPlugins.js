'use strict';

// /api/v1/admin/plugins (docs/plugins-plan.md §6.3): the dashboard's Plugins
// page. Installing is two steps, so the admin sees what a package is and
// what it may do before it runs: a package (an upload, or a URL: a direct
// link or a GitHub repository / release) is staged and previewed, then
// installed by its token. Mounted by lib/routes/admin.js after requireAdmin.
//
//   GET    /admin/plugins                       { plugins, developerMode, publisherKeys: [{ key, fingerprint }], devDir, pluginsDir }
//   POST   /admin/plugins/packages              multipart `file` (.ppx / .zip) or { url } → the preview (lib/plugins/install.js#stage)
//   POST   /admin/plugins/packages/:token/install   → the installed plugin
//   DELETE /admin/plugins/packages/:token       forget a preview
//   PATCH  /admin/plugins/:id                   { enabled } (an installed plugin)
//   POST   /admin/plugins/:id/reload            a developer copy, from its folder again
//   DELETE /admin/plugins/:id?data=keep|delete  remove an installed plugin (default: its data too)
//   GET    /admin/plugins/:id/settings          its options (lib/plugins/settings.js): definitions, server values,
//                                               which secrets are set, the profiles' values
//   PUT    /admin/plugins/:id/settings          { profile?, values: { key: value | null } } → the same
//   POST   /admin/plugins/:id/settings/:key/run an `action` setting → { data, effects }
//   PUT    /admin/plugins/:id/grants            { profile, permission, granted } a personal permission → its settings
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
    HOST_NOT_ALLOWED: 'UPSTREAM', ADDRESS_NOT_ALLOWED: 'UPSTREAM', RATE_LIMITED: 'TOO_MANY_ATTEMPTS', TIMEOUT: 'UPSTREAM' };

function answer(res, work) {
  Promise.resolve().then(work).then(function (value) {
    res.json(value);
  }, function (err) {
    var code = CODES[err.code];
    if (!code) {
      log.error('admin plugins: ' + err.message, { err: err });
      return errors.fail(res, 'INTERNAL', 'Internal error');
    }
    errors.fail(res, code, err.message, err.errors ? { errors: err.errors } : undefined);
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
  answer(res, function () { return install.commit(req.params.token); });
});

router.delete('/plugins/packages/:token', function (req, res) {
  answer(res, function () { return { ok: install.discard(req.params.token) }; });
});

router.patch('/plugins/:id', function (req, res) {
  answer(res, function () {
    var body = req.body || {};
    if (typeof body.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be true or false'), { code: 'INVALID' });
    }
    return install.setEnabled(req.params.id, body.enabled);
  });
});

router.post('/plugins/:id/reload', function (req, res) {
  answer(res, function () { return install.reload(req.params.id); });
});

router.delete('/plugins/:id', function (req, res) {
  answer(res, function () { return install.remove(req.params.id, { keepData: req.query.data === 'keep' }); });
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
