'use strict';

// /api/profiles: the "Who's watching?" screen and the profile editor.
// Thin HTTP adapter over lib/services/profiles.js; every request is answered
// (ServiceError → its status, anything else → 500).

var express = require('express'),
  handle = require('./handle');

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
router.post('/:id/unlock', handle(function (s, req) {
  return s.profiles.unlock(req.params.id, req.body && req.body.pin);
}));

// body: { pin } sets / changes the PIN, { pin: null } removes it
router.put('/:id/pin', handle(function (s, req) {
  return s.profiles.setPin(req.params.id, req.body ? req.body.pin : null);
}));

module.exports = router;
