'use strict';

// /api/v1/devices/me: a paired device describes itself right after pairing
// (docs/server-separation-plan.md §6.3, §6.5): name, platform, its own device
// id, and what it can decode (capabilities, used by the playback decision of
// step 3b). Local clients (loopback) aren't paired and have no record.

var express = require('express'),
  auth = require('../auth'),
  errors = require('../errors');

var router = express.Router();

function answer(res, promise) {
  promise.then(function (device) {
    if (!device) {
      return errors.fail(res, 'NOT_FOUND', 'No such device');
    }
    res.json(device);
  }, function (err) {
    errors.fail(res, err.code && err.code !== 'INTERNAL' ? err.code : 'INTERNAL', err.code ? err.message : 'Internal error');
  });
}

function pairedOnly(req, res, next) {
  if (!req.auth || req.auth.kind !== 'device') {
    return errors.fail(res, 'NOT_FOUND', 'Only paired devices have a record (this client is ' +
      (req.auth ? req.auth.kind : 'unknown') + ')');
  }
  next();
}

router.get('/me', pairedOnly, function (req, res) {
  answer(res, auth.getDevice(req.auth.device.id));
});

// body: { name?, platform?, deviceId?, capabilities? } (null clears a field)
router.put('/me', pairedOnly, function (req, res) {
  answer(res, auth.describeDevice(req.auth.device.id, req.body));
});

module.exports = router;
