'use strict';

// /api/v1/play — the play pipeline (lib/play, docs/media-server-plan.md §6):
// POST /play/sources { kind, tmdbId, imdbId?, title, year?, season?, episode?, profileId? }
//   → { sources: Source[], policy: { autoplay: <source id> | null }, errors: [{ handler, message }] }

var express = require('express'),
  handle = require('./handle'),
  play = require('../play');

var router = express.Router();

router.post('/sources', handle(function (s, req) {
  return play.sources(req.body, s);
}));

module.exports = router;
