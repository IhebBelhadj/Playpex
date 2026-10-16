'use strict';

// GET /api/v1/server — who this server is, no auth (docs/server-separation-plan.md §6.2).
// Clients probe it after discovery and before pairing; the TV app also uses
// it to recognise a Playpex server already running on the port.

var express = require('express'),
  identity = require('../identity'),
  ffmpeg = require('../ffmpeg'),
  subtitles = require('../subtitles');

var router = express.Router();

router.get('/', function (req, res) {
  ffmpeg.info().then(function (ff) {
    res.json(Object.assign(identity.info(), {
      auth: 'pairing',   // LAN clients pair (RFC 8628, lib/auth); loopback ones needn't
      features: {
        transcode: ff.available,
        subtitles: subtitles.list().filter(function (p) { return p.enabled; }).map(function (p) { return p.id; }),
        adult: true
      }
    }));
  });
});

module.exports = router;
