'use strict';

// Opens the user database and brings it up to date with the migrations in
// ./migrations (written by `npm run db:generate` from ./schema.js).
//
//   <config dir>/playpex.db   (Linux ~/.config/Playpex/playpex.db, see lib/paths.js)

var path = require('path'),
  mkdirp = require('mkdirp'),
  paths = require('../paths'),
  schema = require('./schema'),
  driver = require('./driver');

var MIGRATIONS = path.join(__dirname, 'migrations');

function defaultFile() {
  return path.join(paths.config, 'playpex.db');
}

/**
 * @param {{ file?: string }} [options] file defaults to <config>/playpex.db; ':memory:' for tests
 * @returns {Promise<{ db: object, close: function() }>}
 */
function open(options) {
  var file = (options && options.file) || defaultFile();
  return Promise.resolve().then(function () {
    if (file !== ':memory:') {
      mkdirp.sync(path.dirname(file));
    }
    var connection = driver.open(file, schema);
    return connection.migrate(MIGRATIONS).then(function () {
      return { db: connection.db, close: connection.close };
    }, function (err) {
      connection.close();
      throw err;
    });
  });
}

module.exports = {
  open: open,
  schema: schema,
  isUniqueViolation: driver.isUniqueViolation,
  defaultFile: defaultFile
};
