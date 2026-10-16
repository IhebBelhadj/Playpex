'use strict';

// /api/v1/admin: the dashboard's routes (docs/server-separation-plan.md §6.3,
// §7). Everything needs the admin's cookie session (sign in with
// POST /api/v1/auth/sign-in/username), except the first-run setup, which is
// open from the server machine until the admin has a password.

var express = require('express'),
  fs = require('fs'),
  path = require('path'),
  auth = require('../auth'),
  authHttp = require('../auth/http'),
  sessions = require('../sessions'),
  settings = require('../settings'),
  logger = require('../logger'),
  system = require('../system'),
  storage = require('../storage'),
  host = require('../host'),
  discovery = require('../discovery'),
  paths = require('../paths'),
  net = require('net'),
  errors = require('../errors'),
  log = require('../logger').child('auth');

var router = express.Router();

// Answers a promise of a result: JSON, or { error, code } from err.code
function answer(res, promise) {
  promise.then(function (result) {
    res.json(result);
  }, function (err) {
    if (!err.code || !require('@playpex/protocol').ERROR_CODES[err.code] || err.code === 'INTERNAL') {
      log.error('admin route failed: ' + err.message, { err: err });
      return errors.fail(res, 'INTERNAL', 'Internal error');
    }
    errors.fail(res, err.code, err.message);
  });
}

// ── first-run setup ────────────────────────────────────────────────────────

// { needed, local }: needed until the admin has a password; local = this
// request comes from the server machine (where the setup is allowed)
router.get('/setup', function (req, res) {
  answer(res, auth.setupNeeded().then(function (needed) { return { needed: needed, local: auth.isLoopback(req) }; }));
});

// body: { username, password }. From the server machine, once.
router.post('/setup', authHttp.localOnly, function (req, res) {
  answer(res, auth.setupNeeded().then(function (needed) {
    if (!needed) {
      var err = new Error('The admin account exists already; sign in to change it');
      err.code = 'CONFLICT';
      throw err;
    }
    var body = req.body || {};
    return auth.setAdmin(body.username, body.password);
  }));
});

router.use(authHttp.requireAdmin);

// body: { currentPassword, newPassword }. Signs out every admin session.
router.put('/password', function (req, res) {
  var body = req.body || {};
  answer(res, auth.changePassword(body.currentPassword, body.newPassword));
});

// ── pairing requests ───────────────────────────────────────────────────────

router.get('/pairing', function (req, res) {
  answer(res, auth.pendingRequests().then(function (requests) { return { requests: requests }; }));
});

router.post('/pairing/:code/approve', function (req, res) {
  answer(res, auth.approve(req.params.code));
});

router.post('/pairing/:code/deny', function (req, res) {
  answer(res, auth.deny(req.params.code));
});

// ── paired devices ─────────────────────────────────────────────────────────

router.get('/devices', function (req, res) {
  answer(res, auth.listDevices().then(function (devices) {
    return { devices: require('../events').markOnline(devices) };
  }));
});

// body: { name }
router.put('/devices/:id', function (req, res) {
  answer(res, auth.renameDevice(req.params.id, req.body && req.body.name).then(function (device) {
    if (!device) {
      var err = new Error('No such device');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return device;
  }));
});

// Revokes the device: its token stops working and its streams are closed
router.delete('/devices/:id', function (req, res) {
  answer(res, auth.revokeDevice(req.params.id).then(function (revoked) {
    if (!revoked) {
      var err = new Error('No such device');
      err.code = 'NOT_FOUND';
      throw err;
    }
    sessions.dropDevice(req.params.id);
    return { ok: true };
  }));
});

// ── overview, restart ──────────────────────────────────────────────────────

router.get('/overview', function (req, res) {
  answer(res, system.overview());
});

// Answers first, then restarts (the answer would be cut otherwise). The
// dashboard reconnects; a new port means a new address.
router.post('/restart', function (req, res) {
  var current = require('../../index').info();
  res.json({ ok: true, port: settings.get('general.port'), currentPort: current ? current.port : null });
  res.on('finish', function () {
    setTimeout(function () {
      require('../../index').restart().catch(function () { /* logged by restart() */ });
    }, 200);
  });
});

// ── the desktop app (apps/server-desktop, plan §8.1) ─────────────────────────

function hostView() {
  return { kind: host.kind(), desktop: host.desktop() };
}

// { kind: 'headless' | 'desktop' | 'embedded', desktop }: desktop is the
// supervisor's state (start at login, updates), null outside the desktop app
router.get('/host', function (req, res) {
  res.json(hostView());
});

// body: { openAtLogin?, checkForUpdates? } (booleans). 501 NOT_SUPPORTED
// outside the desktop app.
router.put('/host', function (req, res) {
  var body = req.body || {}, patch = {};
  ['openAtLogin', 'checkForUpdates'].forEach(function (key) {
    if (body[key] !== undefined) {
      patch[key] = body[key];
    }
  });
  if (Object.keys(patch).some(function (k) { return typeof patch[k] !== 'boolean'; })) {
    return errors.fail(res, 'INVALID', 'openAtLogin and checkForUpdates must be true or false');
  }
  answer(res, host.request('desktop.set', patch).then(hostView));
});

router.post('/host/update/check', function (req, res) {
  answer(res, host.request('update.check').then(hostView));
});

// Restarts the desktop app into the downloaded update. Refused (409) while
// clients are playing, unless body { force: true }: an update never cuts a
// stream by itself.
router.post('/host/update/install', function (req, res) {
  var streams = sessions.count();
  if (streams && !(req.body && req.body.force === true)) {
    return errors.fail(res, 'CONFLICT', streams + ' stream' + (streams > 1 ? 's are' : ' is') +
      ' playing: installing restarts the server');
  }
  answer(res, host.request('update.install').then(function () { return { ok: true }; }));
});

// ── settings ───────────────────────────────────────────────────────────────

function settingsView() {
  return Object.assign(settings.publicView(), { file: settings.FILE, logLevels: settings.LOG_LEVELS });
}

router.get('/settings', function (req, res) {
  res.json(settingsView());
});

// body: a partial settings object ({ general: { port: 28480 } }). Secrets sent
// back masked are kept. 400 INVALID with every problem; nothing saved then.
router.put('/settings', function (req, res) {
  var result;
  try {
    result = settings.update(req.body || {});
  } catch (err) {
    if (err.code === 'INVALID_SETTINGS') {
      return errors.fail(res, 'INVALID', err.message, { errors: err.errors });
    }
    throw err;
  }
  if (result.changed.indexOf('general.logLevel') !== -1) {
    logger.configure({ level: settings.get('general.logLevel') });
  }
  // the name clients see, or discovery itself: advertise again now
  if (result.changed.indexOf('general.serverName') !== -1 || result.changed.indexOf('network.discovery') !== -1) {
    discovery.refresh();
  }
  log.info('settings changed: ' + result.changed.join(', '));
  res.json(Object.assign({}, result, { settings: settingsView() }));
});

// body: { port }. Whether the server could listen on it right now (its own
// current port counts as free).
router.post('/settings/check-port', function (req, res) {
  var port = req.body && req.body.port, problem = settings.validatePort(port),
    current = require('../../index').info();
  if (problem) {
    return errors.fail(res, 'INVALID', problem);
  }
  port = Number(port);
  if (current && current.port === port && !current.recovery) {
    return res.json({ port: port, free: true, current: true, owner: null });
  }
  var probe = net.createServer();
  probe.once('error', function () {
    require('../portOwner')(port).then(function (owner) {
      res.json({ port: port, free: false, current: false, owner: owner });
    });
  });
  probe.listen(port, function () {
    probe.close(function () { res.json({ port: port, free: true, current: false, owner: null }); });
  });
});

// ── logs ───────────────────────────────────────────────────────────────────

// ?level=&area=&since=<ISO time>&limit= → the ring buffer (last 2 000
// entries), oldest first; new ones arrive on the events socket (topic log)
router.get('/logs', function (req, res) {
  var q = req.query, limit = parseInt(q.limit, 10);
  if (q.level && logger.LEVELS.indexOf(q.level) === -1) {
    return errors.fail(res, 'INVALID', 'level must be one of ' + logger.LEVELS.join(', '));
  }
  res.json({
    entries: logger.entries({
      level: q.level || undefined,
      area: q.area || undefined,
      since: q.since || undefined,
      limit: limit > 0 ? limit : undefined
    }),
    levels: logger.LEVELS,
    file: logger.file()
  });
});

// The log files (current + rotated) as one zip, for bug reports
router.get('/logs/download', function (req, res) {
  var dir = paths.logs, yazl = require('yazl'), zip = new yazl.ZipFile();
  fs.promises.readdir(dir).catch(function () { return []; }).then(function (names) {
    names.filter(function (n) { return /^playpex-server.*\.log$/.test(n); }).forEach(function (n) {
      zip.addFile(path.join(dir, n), n);
    });
    zip.end();
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="playpex-logs-' + stamp + '.zip"');
    zip.outputStream.pipe(res);
  });
});

// ── storage ────────────────────────────────────────────────────────────────

router.get('/storage', function (req, res) {
  answer(res, storage.list().then(function (result) {
    return Object.assign(result, { deleteAfterWatching: settings.get('storage.deleteAfterWatching') });
  }));
});

// Every entry no running torrent uses
router.post('/storage/clear', function (req, res) {
  answer(res, storage.clear());
});

router.delete('/storage/items/:name', function (req, res) {
  answer(res, storage.remove(req.params.name));
});

// body: { dir } → whether it can be the download directory
router.post('/storage/check', function (req, res) {
  answer(res, storage.checkDir(req.body && req.body.dir));
});

module.exports = router;
