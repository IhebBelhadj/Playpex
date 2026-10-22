'use strict';

// Service layer: business rules over the data access layer. Services only see
// repositories (lib/data/contracts.js), never the database or Drizzle, and throw
// ServiceErrors (./errors.js) with an HTTP-ready `status` for expected failures.

var profilesService = require('./profiles'),
  watchlistService = require('./watchlist'),
  playbackService = require('./playback'),
  ratingsService = require('./ratings'),
  recommendationsService = require('./recommendations'),
  settingsService = require('./settings'),
  downloadsService = require('./downloads');

/**
 * @param {import('../data/contracts').Repositories} repositories
 * @param {{ catalog: object, now?: function(): Date, publish?: function(string, object) }} options
 *   catalog: { recommendations({ mediaType, tmdbId }) → Promise<candidate[]> } (lib/tmdb.js)
 *   now: clock, for tests
 *   publish: events.publish (lib/events.js), for `settings.changed`
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
    recommendations: recommendationsService(repositories, Object.assign({ catalog: options.catalog }, shared)),
    settings: settingsService(repositories, Object.assign({ publish: options.publish }, shared)),
    downloads: downloadsService(repositories, shared)
  };
}

module.exports = {
  createServices: createServices,
  errors: require('./errors')
};
