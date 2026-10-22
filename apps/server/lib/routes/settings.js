'use strict';

// /api/v1/settings and /api/v1/profiles/:profileId/settings: user settings
// (docs/settings-plan.md). Thin adapter over lib/services/settings.js.
//
// Which device: a paired client is the device its token names (its own
// device id, sent once with PUT /devices/me; a different X-Playpex-Device is
// ignored, so one device can't write another's settings). Anyone else (a
// client on the server machine, the admin) is its X-Playpex-Device header or
// ?device=; without one the service answers 400 DEVICE_REQUIRED.

var express = require('express'),
  protocol = require('@playpex/protocol'),
  handle = require('./handle');

var router = express.Router();

function deviceId(req) {
  if (req.auth && req.auth.kind === 'device') {
    return req.auth.device.clientDeviceId || req.auth.device.id;
  }
  var id = req.get(protocol.DEVICE_HEADER) || req.query[protocol.DEVICE_PARAM];
  return typeof id === 'string' ? id : null;
}

// ?profile=<id>&definitions=1 → { device, profile, definitions? }
router.get('/settings', handle(function (s, req) {
  return s.settings.get({
    deviceId: deviceId(req),
    profileId: typeof req.query.profile === 'string' && req.query.profile ? req.query.profile : null,
    definitions: req.query.definitions === '1'
  });
}));

// body { key: value | null } → the device's effective settings
router.patch('/settings/device', handle(function (s, req) {
  return s.settings.updateDevice(deviceId(req), req.body);
}));

router.delete('/settings/device', handle(function (s, req) {
  return s.settings.resetDevice(deviceId(req));
}));

// body { key: value | null } → the profile's effective settings
router.patch('/profiles/:profileId/settings', handle(function (s, req) {
  return s.settings.updateProfile(req.params.profileId, req.body);
}));

module.exports = router;
