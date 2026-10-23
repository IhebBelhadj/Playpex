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

var express = require('express'),
  fs = require('fs'),
  path = require('path'),
  multipart = require('connect-multiparty'),
  signing = require('@playpex/protocol/signing'),
  install = require('../plugins/install'),
  plugins = require('../plugins'),
  settings = require('../settings'),
  paths = require('../paths'),
  errors = require('../errors'),
  log = require('../logger').child('plugins');

var router = express.Router(),
  CODES = { INVALID: 'INVALID', INVALID_MANIFEST: 'INVALID', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT',
    FORBIDDEN: 'FORBIDDEN', UPSTREAM: 'UPSTREAM' };

function answer(res, work) {
  Promise.resolve().then(work).then(function (value) {
    res.json(value);
  }, function (err) {
    var code = CODES[err.code];
    if (!code) {
      log.error('admin plugins: ' + err.message, { err: err });
      return errors.fail(res, 'INTERNAL', 'Internal error');
    }
    errors.fail(res, code, err.message);
  });
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

module.exports = router;
