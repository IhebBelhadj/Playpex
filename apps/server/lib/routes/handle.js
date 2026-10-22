'use strict';

// Express adapter for the service layer: runs work(services, req) and always
// answers — the result as JSON, a ServiceError as { error, code } with its
// status, anything else as 500.

var userData = require('../userData'),
  log = require('../logger').child('http');

module.exports = function handle(work, successStatus) {
  return function (req, res) {
    userData.services().then(function (services) {
      return work(services, req);
    }).then(function (result) {
      res.status(successStatus || 200).json(result);
    }, function (err) {
      if (!err.status) {
        log.error(req.method + ' ' + req.path + ' failed', { err: err });
      }
      var body = {
        error: err.status ? err.message : 'Internal error',
        code: err.code || 'INTERNAL'
      };
      if (err.status && Array.isArray(err.errors)) {
        body.errors = err.errors;   // INVALID settings: one message per bad key
      }
      res.status(err.status || 500).json(body);
    });
  };
};
