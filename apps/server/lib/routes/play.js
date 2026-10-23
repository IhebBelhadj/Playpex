'use strict';

// /api/v1/play — the play pipeline (lib/play, docs/media-server-plan.md §6,
// plugins: docs/plugins-plan.md §4.3):
// POST /play/sources { kind, tmdbId, imdbId?, title, year?, season?, episode?, profileId? }
//   → { request, sources: Source[], hidden: [{ id, label, plugin, by, reason }],
//       policy: { autoplay: <source id> | null }, errors: [{ handler, message }] }
// POST /play/start { request, source, confirmed? }
//   → { action: 'play', source } | { action: 'ask', question, yes, no, by } | { action: 'refuse', reason, by }
// POST /play/markers { …the title, duration, fileName?, size? } → { markers: [{ plugin, kind, start, end?, label? }] }

var express = require('express'),
  handle = require('./handle'),
  sessions = require('../sessions'),
  play = require('../play');

var router = express.Router();

// Who asks: the plugins' context (their device, their language)
function caller(req) {
  var device = sessions.device(req),
    first = String(req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim();
  return {
    device: { id: device.id, name: device.name || '' },
    locale: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : 'en'
  };
}

router.post('/sources', handle(function (s, req) {
  return play.sources(req.body, s, caller(req));
}));

router.post('/start', handle(function (s, req) {
  return play.start(req.body);
}));

router.post('/markers', handle(function (s, req) {
  return play.markers(req.body, s, caller(req));
}));

module.exports = router;
