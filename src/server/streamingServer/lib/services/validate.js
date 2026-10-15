'use strict';

// Input checks shared by the services. Each returns a normalized copy or throws
// an INVALID ServiceError.

var errors = require('./errors');

var MEDIA_TYPES = ['movie', 'tv'];

function positiveInt(value, field) {
  var n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw errors.invalid(field + ' must be a positive integer');
  }
  return n;
}

function nonNegativeInt(value, field) {
  var n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw errors.invalid(field + ' must be a non-negative integer');
  }
  return n;
}

function nonNegativeNumber(value, field) {
  var n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw errors.invalid(field + ' must be a non-negative number');
  }
  return n;
}

function mediaType(value) {
  if (MEDIA_TYPES.indexOf(value) === -1) {
    throw errors.invalid('mediaType must be one of ' + MEDIA_TYPES.join(', '));
  }
  return value;
}

/** { mediaType, tmdbId } */
function mediaRef(input) {
  input = input || {};
  return { mediaType: mediaType(input.mediaType), tmdbId: positiveInt(input.tmdbId, 'tmdbId') };
}

/** { mediaType, tmdbId, season, episode }; movies are always 0/0, episodes need both */
function episodeKey(input) {
  var ref = mediaRef(input);
  if (ref.mediaType === 'movie') {
    ref.season = 0;
    ref.episode = 0;
  } else {
    ref.season = nonNegativeInt(input.season, 'season');   // 0 = specials
    ref.episode = positiveInt(input.episode, 'episode');
  }
  return ref;
}

function optionalString(value, field, max) {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > (max || 500)) {
    throw errors.invalid(field + ' must be a string of at most ' + (max || 500) + ' characters');
  }
  return value;
}

function genreIds(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw errors.invalid('genreIds must be an array of integers');
  }
  return value.map(function (id) { return positiveInt(id, 'genreIds[]'); });
}

function limit(value, fallback, max) {
  if (value == null) {
    return fallback;
  }
  return Math.min(positiveInt(value, 'limit'), max);
}

module.exports = {
  MEDIA_TYPES: MEDIA_TYPES,
  positiveInt: positiveInt,
  nonNegativeNumber: nonNegativeNumber,
  mediaType: mediaType,
  mediaRef: mediaRef,
  episodeKey: episodeKey,
  optionalString: optionalString,
  genreIds: genreIds,
  limit: limit
};
