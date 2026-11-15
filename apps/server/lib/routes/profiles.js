'use strict';

// /api/v1/profiles: the "Who's watching?" screen and the profile editor.
// Thin HTTP adapter over lib/services/profiles.js; every request is answered
// (ServiceError → its status, anything else → 500).

var express = require('express'),
  handle = require('./handle'),
  errors = require('../services/errors');

var router = express.Router();

// { profiles: [...], lastUsedId }
router.get('/', handle(function (s) {
  return Promise.all([s.profiles.list(), s.profiles.lastUsed()]).then(function (r) {
    return { profiles: r[0], lastUsedId: r[1] ? r[1].id : null, maxProfiles: s.profiles.MAX_PROFILES };
  });
}));

router.post('/', handle(function (s, req) {
  return s.profiles.create(req.body);
}, 201));

router.get('/:id', handle(function (s, req) {
  return s.profiles.get(req.params.id);
}));

// body: { name?, avatar?, isKid?, preferences? }
router.put('/:id', handle(function (s, req) {
  return s.profiles.update(req.params.id, req.body);
}));

router.delete('/:id', handle(function (s, req) {
  return s.profiles.remove(req.params.id).then(function () { return { ok: true }; });
}));

// body: { pin? } → the profile, 403 wrong PIN, 429 locked out
// (the device that opened it may cast as it: lib/cast)
router.post('/:id/unlock', handle(function (s, req) {
  return s.profiles.unlock(req.params.id, req.body && req.body.pin).then(function (profile) {
    require('../cast').unlocked(require('../sessions').device(req).id, profile.id);
    return profile;
  });
}));

// A client reloaded (a browser's refresh, Electron's Ctrl+R) and opens the
// profile it was on again: no PIN → the profile; a PIN → only when this device
// opened it within the last 12 h (lib/cast keeps those), else 403 FORBIDDEN
router.post('/:id/resume', handle(function (s, req) {
  return s.profiles.get(req.params.id).then(function (profile) {
    if (profile.hasPin && !require('../cast').isUnlocked(require('../sessions').device(req).id, profile.id)) {
      throw errors.forbidden('Enter the PIN again');
    }
    return profile;
  });
}));

// body: { pin } sets / changes the PIN, { pin: null } removes it
router.put('/:id/pin', handle(function (s, req) {
  return s.profiles.setPin(req.params.id, req.body ? req.body.pin : null);
}));

module.exports = router;
