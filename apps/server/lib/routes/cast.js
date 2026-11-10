'use strict';

// /api/v1/cast (docs/cast-plan.md §4.1): the screens, casting to one, the
// cast's state and commands. Any client may cast (a paired device, a client
// on this machine, the admin); lib/cast checks what and as whom.

var express = require('express'),
  protocol = require('@playpex/protocol'),
  cast = require('../cast'),
  errors = require('../errors'),
  log = require('../logger').child('http');

var router = express.Router();

function answer(res, work, status) {
  Promise.resolve().then(work).then(function (result) {
    res.status(status || 200).json(result);
  }, function (err) {
    if (err.code && protocol.ERROR_CODES[err.code] && err.code !== 'INTERNAL') {
      return errors.fail(res, err.code, err.message);
    }
    log.error('cast: ' + err.message, { err: err });
    errors.fail(res, 'INTERNAL', 'Internal error');
  });
}

// [CastScreen]: the devices that take casts now
router.get('/screens', function (req, res) {
  answer(res, function () { return cast.screens(req); });
});

// CastRequest → 202 { castId, delivered }
router.post('/screens/:deviceId/play', function (req, res) {
  answer(res, function () { return cast.play(req, String(req.params.deviceId), req.body); }, 202);
});

// The cast's state (its sender, its screen, the admin)
router.get('/:castId', function (req, res) {
  answer(res, function () {
    if (!cast.mayView(req, req.params.castId)) {
      throw Object.assign(new Error('No such cast'), { code: 'NOT_FOUND' });
    }
    return cast.get(req.params.castId);
  });
});

// The screen's state: { state, positionS?, durationS?, error? }
router.post('/:castId/state', function (req, res) {
  answer(res, function () { return cast.report(req, req.params.castId, req.body); });
});

// { action, positionS?, deltaS? } → 202 { delivered }
router.post('/:castId/commands', function (req, res) {
  answer(res, function () { return cast.command(req, req.params.castId, req.body); }, 202);
});

module.exports = router;
