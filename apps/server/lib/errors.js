'use strict';

// One error shape for every answer: { error, code } (codes and their statuses:
// @playpex/protocol ERROR_CODES, documented in its openapi.yaml).
//
//   fail(res, 'NOT_FOUND', 'no such torrent')
//   fail(res, 'UPSTREAM', err.message, { torrents: [] })   // extra fields kept for older clients

var ERROR_CODES = require('@playpex/protocol').ERROR_CODES;

var BY_STATUS = { 400: 'INVALID', 401: 'PAIRING_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'TOO_MANY_ATTEMPTS',
  500: 'INTERNAL', 502: 'UPSTREAM', 503: 'PROVIDER_NOT_CONFIGURED' };

function fail(res, code, message, extra) {
  if (res.headersSent) {
    return res.end();
  }
  res.status(ERROR_CODES[code] || 500).json(Object.assign({}, extra, { error: message || code, code: code }));
}

// The code for an error that only carries an HTTP status (providers, services)
function codeForStatus(status) {
  return BY_STATUS[status] || (status >= 500 ? 'INTERNAL' : 'INVALID');
}

module.exports = {
  fail: fail,
  codeForStatus: codeForStatus
};
