'use strict';

// Wires the per-profile data stack together:
//
//   services (lib/services)  →  repositories (lib/data)  →  database (lib/db)
//
// The database is opened on first use and shared; routes call
// `userData.services().then(function (s) { return s.watchlist.list(id); })`.

var database = require('./db'),
  data = require('./data'),
  services = require('./services'),
  tmdb = require('./tmdb');

var ready = null;

/** @returns {Promise<ReturnType<typeof services.createServices>>} */
function getServices() {
  if (!ready) {
    ready = database.open().then(function (connection) {
      return {
        connection: connection,
        services: services.createServices(data.createRepositories(connection.db), { catalog: tmdb })
      };
    });
    ready.catch(function (err) {
      console.error('user database unavailable:', err.message);
      ready = null;   // retry on the next call
    });
  }
  return ready.then(function (state) { return state.services; });
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
  close: close
};
