'use strict';

// /api/v1/plugins: what clients get of plugins (docs/plugins-plan.md §4.9).
// Rendering only: setup is the dashboard's (step P4), never a client's.
//
//   GET  /plugins?profile=                  { plugins }: enabled plugins for that profile (kids: no adults plugins)
//   POST /plugins/:id/data/:name?profile=   body { args?, profile? } → { data, effects }: a data handler's answer
//   GET  /plugins/:id/assets/*              a file of the package's assets/ (fixed types, nosniff, SVG without scripts)
//   POST /plugins/meta?profile=             body { title: TitleRef } → { meta: [{ plugin, name, items: MetaItem[] }] }:
//                                           what metadata.title handlers add to a title page (≤ 3 items each)
//   GET  /plugins/notifications?profile=    { notifications }: the profile's plugin notifications this device
//                                           hasn't had yet (lib/plugins/notifications.js; then marked had)

var express = require('express'),
  path = require('path'),
  plugins = require('../plugins'),
  schemas = require('../plugins/schemas'),
  RateLimiter = require('../plugins/ratelimit'),
  sessions = require('../sessions'),
  userData = require('../userData'),
  notifications = require('../plugins/notifications'),
  fail = require('../errors').fail;

var router = express.Router(),
  limiter = new RateLimiter(),
  // per device and plugin: a screen asks a handful of handlers, never hundreds
  RATE = { perSecond: 20, burst: 40, inFlight: 8, maxWaitMs: 2000 },
  TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' },
  CODES = { NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN', INVALID: 'INVALID', RATE_LIMITED: 'TOO_MANY_ATTEMPTS' };

/** The profile a request names (?profile= or body.profile): { id, kids } | null; rejects NOT_FOUND */
function profileOf(req) {
  var id = req.query.profile || (req.body && req.body.profile);
  if (!id) {
    return Promise.resolve(null);
  }
  if (typeof id !== 'string' || id.length > 100) {
    return Promise.reject(Object.assign(new Error('profile must be a profile id'), { code: 'INVALID' }));
  }
  return userData.services().then(function (s) { return s.profiles.get(id); }).then(function (p) {
    return { id: p.id, kids: !!p.isKid };
  });
}

function localeOf(req) {
  var first = String(req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : 'en';
}

function answerError(res, err) {
  if (err.status === 404 || err.code === 'NOT_FOUND') {
    return fail(res, 'NOT_FOUND', err.message);
  }
  var code = CODES[err.code] || (err.code === 'PLUGIN_FAILED' ? 'PLUGIN_FAILED' : 'INTERNAL');
  fail(res, code, code === 'INTERNAL' ? 'Internal error' : err.message);
}

router.get('/', function (req, res) {
  profileOf(req).then(function (profile) {
    var ctx = { profile: profile };
    res.json({
      plugins: plugins.clientView(profile, localeOf(req)),
      // what the profile's plugins provide (docs/providers-plan.md §5.3): Find
      // releases shows only with a release provider
      capabilities: {
        releases: plugins.withHook('releases.providers', ctx).length > 0,
        sources: plugins.withHook('play.collect', ctx).length > 0
      }
    });
  }).catch(function (err) { answerError(res, err); });
});

router.get('/notifications', function (req, res) {
  var device = sessions.device(req);
  if (!req.query.profile) {
    return fail(res, 'INVALID', 'profile is required');
  }
  profileOf(req).then(function (profile) {
    res.json({ notifications: notifications.take(profile.id, device.id) });
  }).catch(function (err) { answerError(res, err); });
});

router.post('/meta', function (req, res) {
  var device = sessions.device(req),
    title = req.body && req.body.title,
    problem = title && typeof title === 'object' ? schemas.apiProblem('titleRef', title) : 'title is required';
  if (problem) {
    return fail(res, 'INVALID', 'title: ' + problem);
  }
  profileOf(req).then(function (profile) {
    return plugins.runHook('metadata.title', { title: title }, {
      profile: profile,
      device: { id: device.id, name: device.name || '' },
      locale: localeOf(req)
    });
  }).then(function (r) {
    res.json({
      meta: r.results.filter(function (x) { return x.output.meta && x.output.meta.length; }).map(function (x) {
        var plugin = plugins.get(x.plugin);
        return { plugin: x.plugin, name: plugin ? plugin.manifest.name : x.plugin, items: x.output.meta };
      })
    });
  }).catch(function (err) { answerError(res, err); });
});

router.post('/:id/data/:name', function (req, res) {
  var device = sessions.device(req),
    body = req.body && typeof req.body === 'object' ? req.body : {},
    release = null;
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(req.params.id) || !/^[a-z][A-Za-z0-9]{0,39}$/.test(req.params.name)) {
    return fail(res, 'NOT_FOUND', 'no such plugin handler');
  }
  if (body.args !== undefined && (body.args === null || typeof body.args !== 'object' || Array.isArray(body.args))) {
    return fail(res, 'INVALID', 'args must be an object');
  }
  limiter.acquire(device.id + ' ' + req.params.id, RATE).then(function (r) {
    release = r;
    return profileOf(req);
  }).then(function (profile) {
    return plugins.data(req.params.id, req.params.name, body.args || {}, {
      profile: profile,
      device: { id: device.id, name: device.name || '' },
      locale: localeOf(req)
    });
  }).then(function (answer) {
    release();
    res.json(answer);
  }, function (err) {
    if (release) {
      release();
    }
    answerError(res, err);
  });
});

router.get('/:id/assets/*', function (req, res) {
  var plugin = plugins.get(req.params.id),
    rel = 'assets/' + req.params[0],
    type = TYPES[path.extname(rel).slice(1).toLowerCase()];
  // only files the package listed when it loaded: no traversal, no other files
  if (!plugin || plugin.state !== 'enabled' || !type || plugin.files.indexOf(rel) === -1) {
    return fail(res, 'NOT_FOUND', 'no such asset');
  }
  res.set({
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
  });
  res.sendFile(path.join(plugin.dir, rel), { dotfiles: 'deny' }, function (err) {
    if (err && !res.headersSent) {
      fail(res, 'NOT_FOUND', 'no such asset');
    }
  });
});

module.exports = router;
