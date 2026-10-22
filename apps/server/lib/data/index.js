'use strict';

// Data access layer entry point. The only place that picks a repository
// implementation; see ./contracts.js for what an implementation must provide.

var profiles = require('./drizzle/profiles'),
  watchlist = require('./drizzle/watchlist'),
  progress = require('./drizzle/progress'),
  history = require('./drizzle/history'),
  ratings = require('./drizzle/ratings'),
  settings = require('./drizzle/settings'),
  downloads = require('./drizzle/downloads');

/**
 * @param {object} db a Drizzle database (lib/db open().db)
 * @returns {import('./contracts').Repositories}
 */
function createRepositories(db) {
  return {
    profiles: profiles(db),
    watchlist: watchlist(db),
    progress: progress(db),
    history: history(db),
    ratings: ratings(db),
    settings: settings(db),
    downloads: downloads(db)
  };
}

module.exports = {
  createRepositories: createRepositories,
  errors: require('./errors')
};
