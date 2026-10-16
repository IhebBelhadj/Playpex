'use strict';

var orm = require('drizzle-orm'),
  db = require('../../db'),
  errors = require('../errors');

// Queries resolve to arrays (portable across Drizzle dialects, unlike sqlite's .get())
function first(rows) {
  return rows.length ? rows[0] : null;
}

function translate(message) {
  return function (err) {
    throw db.isUniqueViolation(err) ? errors.DuplicateError(message, err) : err;
  };
}

function titleWhere(table, profileId, ref) {
  return orm.and(
    orm.eq(table.profileId, profileId),
    orm.eq(table.mediaType, ref.mediaType),
    orm.eq(table.tmdbId, ref.tmdbId)
  );
}

function episodeWhere(table, profileId, key) {
  return orm.and(
    titleWhere(table, profileId, key),
    orm.eq(table.season, key.season || 0),
    orm.eq(table.episode, key.episode || 0)
  );
}

module.exports = {
  first: first,
  translate: translate,
  titleWhere: titleWhere,
  episodeWhere: episodeWhere
};
