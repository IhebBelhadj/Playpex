'use strict';

// /api/v1/live: live TV from plugins (docs/providers-plan.md §8, step 9; lib/live)
//
//   GET  /live?profile=                                  { providers }: plugins with channels for the profile
//   GET  /live/:pluginId/channels?profile=&group=&q=     { plugin, name, guide, channels, groups, updatedAt, error }
//   GET  /live/:pluginId/guide?profile=&channels=a,b&from=&to=   { from, to, programmes }
//   POST /live/:pluginId/channels/:channelId/play?profile=       { channel, source }: a media ref to play (tracking none)
//   GET  /live/:pluginId/logos/:token                    a channel's logo, fetched as the plugin

var express = require('express'),
  live = require('../live'),
  sessions = require('../sessions'),
  userData = require('../userData'),
  fail = require('../errors').fail;

var router = express.Router(),
  CODES = { NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN', INVALID: 'INVALID', PLUGIN_FAILED: 'PLUGIN_FAILED' };

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

function contextOf(req) {
  var device = sessions.device(req);
  return profileOf(req).then(function (profile) {
    return { profile: profile, device: { id: device.id, name: device.name || '' }, locale: localeOf(req) };
  });
}

function answer(res, work) {
  Promise.resolve().then(work).then(function (value) {
    res.json(value);
  }, function (err) {
    if (err.status === 404) {
      return fail(res, 'NOT_FOUND', err.message);
    }
    var code = CODES[err.code];
    fail(res, code || 'INTERNAL', code ? err.message : 'Internal error');
  });
}

// Every word of `q` starts a word of the channel's name, number or group ("42" isn't "142")
function matches(q) {
  var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return function (c) {
    var hay = (c.name + ' ' + c.number + ' ' + (c.group || '')).toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return words.every(function (w) { return hay.some(function (h) { return h.indexOf(w) === 0; }); });
  };
}

router.get('/', function (req, res) {
  answer(res, function () {
    return contextOf(req).then(function (ctx) { return { providers: live.providers(ctx) }; });
  });
});

router.get('/:pluginId/channels', function (req, res) {
  answer(res, function () {
    return contextOf(req).then(function (ctx) {
      return live.channels(req.params.pluginId, ctx);
    }).then(function (r) {
      var list = r.channels;
      if (req.query.group) {
        list = list.filter(function (c) { return c.group === req.query.group; });
      }
      if (req.query.q) {
        list = list.filter(matches(req.query.q));
      }
      return Object.assign({}, r, { channels: list });
    });
  });
});

router.get('/:pluginId/guide', function (req, res) {
  var ids = String(req.query.channels || '').split(',').filter(Boolean);
  answer(res, function () {
    return contextOf(req).then(function (ctx) {
      return live.guide(req.params.pluginId, ids, req.query.from, req.query.to, ctx);
    });
  });
});

router.post('/:pluginId/channels/:channelId/play', function (req, res) {
  answer(res, function () {
    return contextOf(req).then(function (ctx) {
      return live.play(req.params.pluginId, req.params.channelId, ctx);
    });
  });
});

router.get('/:pluginId/logos/:token', function (req, res) {
  live.logo(req, res, req.params.pluginId, req.params.token);
});

module.exports = router;
