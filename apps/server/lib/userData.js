'use strict';

// Wires the per-profile data stack together:
//
//   services (lib/services)  →  repositories (lib/data)  →  database (lib/db)
//
// The database is opened on first use and shared (lib/auth uses it too); routes call
// `userData.services().then(function (s) { return s.watchlist.list(id); })`.

var database = require('./db'),
  data = require('./data'),
  services = require('./services'),
  tmdb = require('./tmdb'),
  log = require('./logger').child('db');

var ready = null;

function getState() {
  if (!ready) {
    ready = database.open().then(function (connection) {
      return {
        connection: connection,
        services: services.createServices(data.createRepositories(connection.db), { catalog: tmdb })
      };
    });
    ready.catch(function (err) {
      log.error('user database unavailable: ' + err.message, { err: err });
      ready = null;   // retry on the next call
    });
  }
  return ready;
}

/** @returns {Promise<ReturnType<typeof services.createServices>>} */
function getServices() {
  return getState().then(function (state) { return state.services; });
}

// The Drizzle database itself, for modules outside the services (lib/auth)
function getDatabase() {
  return getState().then(function (state) { return state.connection.db; });
}

function close() {
  if (!ready) {
    return Promise.resolve();
  }
  var pending = ready;
  ready = null;
  return pending.then(function (state) { state.connection.close(); }, function () {});
}

module.exports = {
  services: getServices,
  database: getDatabase,
  close: close
};
