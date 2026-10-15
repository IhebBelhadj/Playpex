'use strict';

// Service layer: business rules over the data access layer. Services only see
// repositories (lib/data/contracts.js), never the database or Drizzle, and throw
// ServiceErrors (./errors.js) with an HTTP-ready `status` for expected failures.

var profilesService = require('./profiles'),
  watchlistService = require('./watchlist'),
  playbackService = require('./playback'),
  ratingsService = require('./ratings'),
  recommendationsService = require('./recommendations');

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ catalog: object, now?: function(): Date }} options
 *   catalog: { recommendations({ mediaType, tmdbId }) → Promise<candidate[]> } (lib/tmdb.js)
 *   now: clock, for tests
 */
function createServices(repositories, options) {
  options = options || {};
  var profiles = profilesService(repositories, { now: options.now }),
    shared = { profiles: profiles, now: options.now };

  return {
    profiles: profiles,
    watchlist: watchlistService(repositories, shared),
    playback: playbackService(repositories, shared),
    ratings: ratingsService(repositories, shared),
    recommendations: recommendationsService(repositories, Object.assign({ catalog: options.catalog }, shared))
  };
}

module.exports = {
  createServices: createServices,
  errors: require('./errors')
};
