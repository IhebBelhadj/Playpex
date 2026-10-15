'use strict';

// Express adapter for the service layer: runs work(services, req) and always
// answers — the result as JSON, a ServiceError as { error, code } with its
// status, anything else as 500.

var userData = require('../userData');

module.exports = function handle(work, successStatus) {
  return function (req, res) {
    userData.services().then(function (services) {
      return work(services, req);
    }).then(function (result) {
      res.status(successStatus || 200).json(result);
    }, function (err) {
      if (!err.status) {
        console.error(req.method + ' ' + req.originalUrl + ' failed:', err);
      }
      res.status(err.status || 500).json({
        error: err.status ? err.message : 'Internal error',
        code: err.code || 'INTERNAL'
      });
    });
  };
};
