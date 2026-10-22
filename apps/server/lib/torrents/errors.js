'use strict';

// Errors of the engine port (./port.js). Adapters turn their engine's
// failures into these codes; lib/torrents/client.js turns them into API
// errors (lib/errors.js codes).

var CODES = {
  NOT_FOUND: 'NOT_FOUND',               // the engine doesn't have this torrent / file
  BAD_TORRENT: 'BAD_TORRENT',           // unreadable magnet / metainfo
  NO_METADATA_YET: 'NO_METADATA_YET',   // asked for files before the metadata arrived
  DISK: 'DISK',                         // reading / writing the data failed
  UNAVAILABLE: 'UNAVAILABLE',           // the engine is down or restarting
  UNSUPPORTED: 'UNSUPPORTED'            // a capability the engine lacks
};

function EngineError(code, message, cause) {
  var err = new Error(message);
  err.name = 'EngineError';
  err.code = CODES[code] ? code : CODES.UNAVAILABLE;
  if (cause) {
    err.cause = cause;
  }
  return err;
}

function isEngineError(err) {
  return !!err && err.name === 'EngineError';
}

module.exports = {
  CODES: CODES,
  EngineError: EngineError,
  isEngineError: isEngineError
};
