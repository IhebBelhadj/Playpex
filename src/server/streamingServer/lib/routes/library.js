'use strict';

// /api/profiles/:profileId/… — one profile's watch list, playback progress and
// history. Thin adapter over lib/services (watchlist, playback).
//
// A title is /:mediaType/:tmdbId (mediaType 'movie' | 'tv'); episodes add
// ?season=&episode= (or body fields).

var express = require('express'),
  handle = require('./handle');

var router = express.Router({ mergeParams: true });

function ref(req) {
  return { mediaType: req.params.mediaType, tmdbId: req.params.tmdbId };
}

function episodeKey(req) {
  var source = Object.assign({}, req.query, req.body);
  return Object.assign(ref(req), { season: source.season, episode: source.episode });
}

// Everything the "Watch list" page shows, in one call
router.get('/library', handle(function (s, req) {
  var id = req.params.profileId;
  return Promise.all([
    s.playback.continueWatching(id, { limit: 20 }),
    s.watchlist.list(id, { limit: 200 }),
    s.playback.watchedTitles(id, { limit: 100 })
  ]).then(function (r) {
    return { continueWatching: r[0], watchlist: r[1], watched: r[2] };
  });
}));

// ── watch list ──────────────────────────────────────────────────────────────

router.get('/watchlist', handle(function (s, req) {
  return s.watchlist.list(req.params.profileId, { mediaType: req.query.mediaType, limit: req.query.limit });
}));

router.get('/watchlist/:mediaType/:tmdbId', handle(function (s, req) {
  return s.watchlist.contains(req.params.profileId, ref(req)).then(function (inWatchlist) {
    return { inWatchlist: inWatchlist };
  });
}));

// body: { title?, posterPath?, backdropPath? }
router.put('/watchlist/:mediaType/:tmdbId', handle(function (s, req) {
  return s.watchlist.add(req.params.profileId, Object.assign({}, req.body, ref(req)));
}));

router.delete('/watchlist/:mediaType/:tmdbId', handle(function (s, req) {
  return s.watchlist.remove(req.params.profileId, ref(req)).then(function (removed) {
    return { removed: removed };
  });
}));

// ── playback progress ───────────────────────────────────────────────────────

// body: { season?, episode?, positionS, durationS, title?, posterPath?, backdropPath?, genreIds?, infoHash?, filePath? }
router.put('/progress/:mediaType/:tmdbId', handle(function (s, req) {
  return s.playback.saveProgress(req.params.profileId, Object.assign({}, req.body, episodeKey(req)));
}));

// ?season=&episode= → { resume: {positionS, durationS, infoHash, filePath} | null, finished }
router.get('/progress/:mediaType/:tmdbId', handle(function (s, req) {
  return s.playback.getState(req.params.profileId, episodeKey(req));
}));

// Every episode's progress of a show (or the movie's)
router.get('/progress/:mediaType/:tmdbId/episodes', handle(function (s, req) {
  return s.playback.titleProgress(req.params.profileId, ref(req));
}));

// Mark as watched without playing — body: { season?, episode?, title?, posterPath?, backdropPath?, genreIds?, durationS? }
router.put('/watched/:mediaType/:tmdbId', handle(function (s, req) {
  return s.playback.markWatched(req.params.profileId, Object.assign({}, req.body, episodeKey(req)));
}));

router.delete('/watched/:mediaType/:tmdbId', handle(function (s, req) {
  return s.playback.markUnwatched(req.params.profileId, episodeKey(req)).then(function (removed) {
    return { removed: removed };
  });
}));

router.get('/history', handle(function (s, req) {
  return s.playback.history(req.params.profileId, { mediaType: req.query.mediaType, limit: req.query.limit });
}));

module.exports = router;
