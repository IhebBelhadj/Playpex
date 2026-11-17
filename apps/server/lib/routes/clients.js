'use strict';

// GET /api/v1/clients — the web clients this server serves and what /app/
// opens on each kind of device (no auth: nothing secret; docs/web-unified-plan.md §3)

var express = require('express'),
  clients = require('../web/clients');

var router = express.Router();

router.get('/', function (req, res) {
  res.set('Cache-Control', 'no-cache');
  res.json(clients.view());
});

module.exports = router;
