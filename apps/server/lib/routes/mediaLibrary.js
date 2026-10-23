'use strict';

// /api/v1/library — the server's media library as clients browse it
// (lib/library/view.js, docs/media-server-plan.md §5.5). `?profile=` is the
// profile watching: a kids profile never sees adults-only folders.
//   GET /library/home                          movies, shows, recently added, folders of other videos
//   GET /library/titles/:mediaType/:tmdbId     a movie's / a show's files on this server (episodes)
//   GET /library/folders/:folderId?path=       one level of a folder's other videos

var express = require('express'),
  handle = require('./handle'),
  view = require('../library/view'),
  invalid = require('../services/errors').invalid;

var router = express.Router();

// { kid } of the profile named by ?profile= (404 for an unknown one; none: not a kid's)
function viewer(s, req) {
  var id = req.query.profile;
  if (id === undefined || id === '') {
    return Promise.resolve({ kid: false });
  }
  if (typeof id !== 'string') {
    return Promise.reject(invalid('profile must be a profile id'));
  }
  return s.profiles.get(id).then(function (profile) {
    return { kid: !!profile.isKid };
  });
}

router.get('/home', handle(function (s, req) {
  return viewer(s, req).then(function (options) {
    return view.home(s, options);
  });
}));

router.get('/titles/:mediaType/:tmdbId', handle(function (s, req) {
  return viewer(s, req).then(function (options) {
    return view.title(s, req.params.mediaType, req.params.tmdbId, options);
  });
}));

router.get('/folders/:folderId', handle(function (s, req) {
  return viewer(s, req).then(function (options) {
    return view.folder(s, req.params.folderId, req.query.path === undefined ? '' : req.query.path, options);
  });
}));

module.exports = router;
