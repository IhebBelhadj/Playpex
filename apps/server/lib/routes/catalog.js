'use strict';

// /api/v1/catalog — movies, shows, seasons, people and search as clients browse
// them (lib/catalog.js: TMDB behind the server, our own shapes; docs/providers-plan.md §7.1)
//   GET /catalog                                       provider, image base, language
//   GET /catalog/genres/:mediaType
//   GET /catalog/lists/:mediaType/:list?page=          popular, top_rated, trending, …
//   GET /catalog/discover/:mediaType?sort=&genres=&…   by filters
//   GET /catalog/search/:kind?q=&page=                 multi | movie | tv | person
//   GET /catalog/titles/:mediaType/:tmdbId             a title's page (+ /credits, /similar)
//   GET /catalog/titles/:mediaType/:tmdbId/extras?profile=   what metadata providers (plugins) add to it
//   GET /catalog/titles/tv/:tmdbId/seasons/:season     a season and its episodes
//   GET /catalog/people/:personId/credits              a person's movies and shows

var express = require('express'),
  handle = require('./handle'),
  catalog = require('../catalog'),
  sessions = require('../sessions'),
  invalid = require('../services/errors').invalid;

var router = express.Router();

router.get('/', handle(function () {
  return catalog.info();
}));

router.get('/genres/:mediaType', handle(function (s, req) {
  return catalog.genres(req.params.mediaType);
}));

router.get('/lists/:mediaType/:list', handle(function (s, req) {
  return catalog.list(req.params.mediaType, req.params.list, req.query);
}));

router.get('/discover/:mediaType', handle(function (s, req) {
  return catalog.discover(req.params.mediaType, req.query);
}));

router.get('/search/:kind', handle(function (s, req) {
  return catalog.search(req.params.kind, req.query);
}));

router.get('/titles/:mediaType/:tmdbId', handle(function (s, req) {
  return catalog.details(req.params.mediaType, req.params.tmdbId);
}));

router.get('/titles/:mediaType/:tmdbId/credits', handle(function (s, req) {
  return catalog.credits(req.params.mediaType, req.params.tmdbId);
}));

router.get('/titles/:mediaType/:tmdbId/similar', handle(function (s, req) {
  return catalog.similar(req.params.mediaType, req.params.tmdbId, req.query);
}));

// the plugins' context: the profile watching (kids: no adults plugins; a profile
// the admin hid a plugin from: not that one), this device, its language
function context(s, req) {
  var id = req.query.profile, device = sessions.device(req),
    locale = String(req.get('Accept-Language') || '').split(',')[0].split(';')[0].trim();
  var ctx = { profile: null, device: { id: device.id, name: device.name || '' },
    locale: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale) ? locale : 'en' };
  if (id === undefined || id === '') {
    return Promise.resolve(ctx);
  }
  if (typeof id !== 'string' || id.length > 100) {
    return Promise.reject(invalid('profile must be a profile id'));
  }
  return s.profiles.get(id).then(function (p) {
    ctx.profile = { id: p.id, kids: !!p.isKid };
    return ctx;
  });
}

router.get('/titles/:mediaType/:tmdbId/extras', handle(function (s, req) {
  return context(s, req).then(function (ctx) {
    return catalog.extras(req.params.mediaType, req.params.tmdbId, ctx);
  });
}));

router.get('/titles/tv/:tmdbId/seasons/:season', handle(function (s, req) {
  return catalog.season(req.params.tmdbId, req.params.season);
}));

router.get('/people/:personId/credits', handle(function (s, req) {
  return catalog.personCredits(req.params.personId);
}));

module.exports = router;
