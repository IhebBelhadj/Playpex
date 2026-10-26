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
  storageBrowser = require('../storageBrowser'),
  torrents = require('../torrents/client'),
  host = require('../host'),
  discovery = require('../discovery'),
  dlna = require('../dlna'),
  userData = require('../userData'),
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

// The media library and the folder browser (lib/routes/adminLibrary.js)
router.use(require('./adminLibrary'));

// Installed plugins: install from an upload or a URL, enable, remove (lib/routes/adminPlugins.js)
router.use(require('./adminPlugins'));

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

// { kind: 'headless' | 'desktop', desktop }: desktop is the
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
  return Object.assign(settings.publicView(), {
    file: settings.FILE,
    logLevels: settings.LOG_LEVELS,
    // the torrent engines to choose from (downloads.engine), and the one running
    engines: require('../torrents/engines').describe(),
    engine: torrents.info().engine
  });
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
  if (['general.serverName', 'network.discovery', 'network.hostname'].some(function (k) { return result.changed.indexOf(k) !== -1; })) {
    discovery.refresh();
  }
  // the DLNA server: on / off, its port, the name TVs show
  if (result.changed.some(function (k) { return k.indexOf('dlna.') === 0 || k === 'general.serverName'; })) {
    dlna.refresh();
  }
  // limits, seeding rules, "pause all": the torrent client applies them now
  torrents.settingsChanged(result.changed);
  log.info('settings changed: ' + result.changed.join(', '));
  res.json(Object.assign({}, result, { settings: settingsView() }));
});

// ── DLNA (lib/dlna) ───────────────────────────────────────────────────────────

// The DLNA server's state, the folders it may serve and the renderers that
// used it in the last day; folders are switched with PATCH /admin/library/folders/{id} { dlna }
router.get('/dlna', function (req, res) {
  answer(res, Promise.all([userData.services(), dlna.snapshot()]).then(function (r) {
    var snapshot = r[1];
    return Promise.all([r[0].library.folders(), r[0].library.counts()]).then(function (f) {
      var counts = f[1];
      return Object.assign(dlna.status(), {
        port: settings.get('dlna.port'),
        folders: f[0].map(function (folder) {
          var c = counts[folder.id] || {};
          return {
            id: folder.id,
            path: folder.path,
            name: folder.builtin ? 'Downloads' : path.basename(folder.path) || folder.path,
            kind: folder.kind,
            audience: folder.audience,
            builtin: !!folder.builtin,
            dlna: !!folder.dlna,
            files: (c.ok || 0) + (c.unmatched || 0)
          };
        }),
        shown: {
          files: snapshot.count,
          movies: snapshot.movies.length,
          shows: Object.keys(snapshot.shows).length
        }
      });
    });
  }));
});

// ── torrent engines (optional downloads: lib/torrents/engines/sidecar.js) ────

// Installs a sidecar engine's pinned release → the engines (as in the settings view)
router.post('/engines/:id/install', function (req, res) {
  var engines = require('../torrents/engines');
  answer(res, engines.install(req.params.id, { log: logger.child('torrent') }).then(function () {
    return { engines: engines.describe() };
  }, function (err) {
    if (!err.code || err.code === 'NOT_SUPPORTED' || err.code === 'INVALID' || err.code === 'NOT_FOUND') {
      throw err;
    }
    // a download or checksum failure
    var e = new Error('Could not install ' + req.params.id + ': ' + err.message);
    e.code = 'UPSTREAM';
    throw e;
  }));
});

// Removes an installed engine (not the one running)
router.delete('/engines/:id', function (req, res) {
  var engines = require('../torrents/engines');
  if (torrents.info().engine === req.params.id) {
    return errors.fail(res, 'CONFLICT', req.params.id + ' is running: choose another engine and restart first');
  }
  answer(res, engines.uninstall(req.params.id).then(function () {
    return { engines: engines.describe() };
  }));
});

// body: { port }. Whether the server could listen on it right now (its own
// current port counts as free).
// What a pasted link is, and what a page links to (lib/links/inspect.js, docs/search-plan.md §4)
router.post('/links/inspect', function (req, res) {
  var url = req.body && typeof req.body.url === 'string' ? req.body.url.slice(0, 4096) : '';
  if (!url.trim()) {
    return errors.fail(res, 'INVALID', 'url: a link');
  }
  require('../links/inspect').inspect(url).then(function (result) {
    res.json(result);
  }).catch(function (err) {
    errors.failed(res, err);
  });
});

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

// ?level=&area=&plugin=<id>&since=<ISO time>&limit= → the ring buffer (last 2 000
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
      plugin: q.plugin || undefined,
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
  answer(res, storage.list());
});

// Every entry no running torrent uses
router.post('/storage/clear', function (req, res) {
  answer(res, storage.clear());
});

router.delete('/storage/items/:name', function (req, res) {
  answer(res, storage.remove(req.params.name));
});

// body: { dir } → whether it can be the download directory
// The file browser (docs/dashboard-plan.md §6): places, one level of one, delete, the largest folders
router.get('/storage/places', function (req, res) {
  answer(res, storageBrowser.places());
});

router.get('/storage/browse', function (req, res) {
  answer(res, storageBrowser.browse({ place: req.query.place, path: req.query.path, sort: req.query.sort, q: req.query.q }));
});

router.delete('/storage/entries', function (req, res) {
  answer(res, storageBrowser.remove(req.body));
});

router.get('/storage/largest', function (req, res) {
  answer(res, storageBrowser.largest(req.query.place));
});

// ?place=&path= → a subtitle file there as WebVTT (the dashboard's player adds it)
router.get('/storage/subtitle', function (req, res) {
  storageBrowser.subtitle({ place: req.query.place, path: req.query.path }).then(function (vtt) {
    res.type('text/vtt').send(vtt);
  }, function (err) {
    answer(res, Promise.reject(err));
  });
});

router.post('/storage/check', function (req, res) {
  answer(res, storage.checkDir(req.body && req.body.dir));
});

module.exports = router;
