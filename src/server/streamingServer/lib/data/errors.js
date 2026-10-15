'use strict';

// Errors the data layer reports in a database-independent way.

function DuplicateError(message, cause) {
  var err = new Error(message || 'Duplicate key');
  err.name = 'DuplicateError';
  err.cause = cause;
  return err;
}

function isDuplicate(err) {
  return !!err && err.name === 'DuplicateError';
}

module.exports = {
  DuplicateError: DuplicateError,
  isDuplicate: isDuplicate
};
