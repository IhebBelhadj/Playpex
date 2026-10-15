'use strict';

// Errors services throw for expected failures. `status` is the HTTP status a
// route should answer with; anything without it is a 500.

var STATUS = {
  INVALID: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_ATTEMPTS: 429
};

function ServiceError(code, message) {
  var err = new Error(message);
  err.name = 'ServiceError';
  err.code = code;
  err.status = STATUS[code] || 500;
  return err;
}

function isServiceError(err) {
  return !!err && err.name === 'ServiceError';
}

module.exports = {
  ServiceError: ServiceError,
  isServiceError: isServiceError,
  invalid: function (message) { return ServiceError('INVALID', message); },
  notFound: function (message) { return ServiceError('NOT_FOUND', message); },
  conflict: function (message) { return ServiceError('CONFLICT', message); },
  forbidden: function (message) { return ServiceError('FORBIDDEN', message); },
  tooManyAttempts: function (message) { return ServiceError('TOO_MANY_ATTEMPTS', message); }
};
