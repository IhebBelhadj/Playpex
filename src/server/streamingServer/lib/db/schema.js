'use strict';

// Database definition (Drizzle, SQLite dialect). This file and driver.js are the
// only places that know which database is used; repositories in lib/data import
// the tables from here, services never do.
//
// After changing this file run `npm run db:generate` to write a new migration
// into ./migrations (applied automatically when the database is opened).
//
// Conventions
//   - ids are text UUIDs (crypto.randomUUID), so data can later be merged or synced
//   - a title is identified by (media_type, tmdb_id); media_type is 'movie' | 'tv'
//   - movies use season = episode = 0 in per-episode tables
//   - timestamps are stored as epoch milliseconds and read back as Date
//   - every per-profile row is deleted with its profile (ON DELETE CASCADE)

var core = require('drizzle-orm/sqlite-core'),
  orm = require('drizzle-orm');

var sqliteTable = core.sqliteTable,
  text = core.text,
  integer = core.integer,
  real = core.real,
  primaryKey = core.primaryKey,
  index = core.index,
  uniqueIndex = core.uniqueIndex,
  check = core.check,
  sql = orm.sql;

var MEDIA_TYPES = ['movie', 'tv'];

function timestamp(name) {
  return integer(name, { mode: 'timestamp_ms' });
}

function profileId() {
  return text('profile_id').notNull().references(function () {
    return profiles.id;
  }, { onDelete: 'cascade' });
}

var profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  isKid: integer('is_kid', { mode: 'boolean' }).notNull().default(false),
  // Optional PIN (scrypt). Both null = profile is not locked.
  pinHash: text('pin_hash'),
  pinSalt: text('pin_salt'),
  // Free-form per-profile settings (subtitle provider/languages, ...)
  preferences: text('preferences', { mode: 'json' }).notNull().$defaultFn(function () { return {}; }),
  createdAt: timestamp('created_at').notNull(),
  lastUsedAt: timestamp('last_used_at')
}, function (table) {
  return [
    uniqueIndex('profiles_name_unique').on(sql`lower(${table.name})`)
  ];
});

var watchlist = sqliteTable('watchlist', {
  profileId: profileId(),
  mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull(),
  tmdbId: integer('tmdb_id').notNull(),
  // Denormalized so rows can be rendered without a TMDB round-trip
  title: text('title'),
  posterPath: text('poster_path'),
  backdropPath: text('backdrop_path'),
  addedAt: timestamp('added_at').notNull()
}, function (table) {
  return [
    primaryKey({ columns: [table.profileId, table.mediaType, table.tmdbId] }),
    index('watchlist_profile_added_idx').on(table.profileId, table.addedAt)
  ];
});

// Last known playback position, one row per movie / episode.
var progress = sqliteTable('progress', {
  profileId: profileId(),
  mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull(),
  tmdbId: integer('tmdb_id').notNull(),
  season: integer('season').notNull().default(0),
  episode: integer('episode').notNull().default(0),
  title: text('title'),
  posterPath: text('poster_path'),
  backdropPath: text('backdrop_path'),
  positionS: real('position_s').notNull(),
  durationS: real('duration_s').notNull(),
  // The release that was playing: different releases have different cuts
  infoHash: text('info_hash'),
  filePath: text('file_path'),
  finished: integer('finished', { mode: 'boolean' }).notNull().default(false),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    primaryKey({ columns: [table.profileId, table.mediaType, table.tmdbId, table.season, table.episode] }),
    index('progress_profile_updated_idx').on(table.profileId, table.updatedAt)
  ];
});

// Append-only log of finished views; feeds recommendations.
var history = sqliteTable('history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: profileId(),
  mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull(),
  tmdbId: integer('tmdb_id').notNull(),
  season: integer('season').notNull().default(0),
  episode: integer('episode').notNull().default(0),
  title: text('title'),
  posterPath: text('poster_path'),
  backdropPath: text('backdrop_path'),
  genreIds: text('genre_ids', { mode: 'json' }).notNull().$defaultFn(function () { return []; }),
  watchedRatio: real('watched_ratio').notNull(),
  watchedAt: timestamp('watched_at').notNull()
}, function (table) {
  return [
    index('history_profile_watched_idx').on(table.profileId, table.watchedAt),
    index('history_profile_title_idx').on(table.profileId, table.mediaType, table.tmdbId)
  ];
});

// Thumbs up (1) / down (-1) per title.
var ratings = sqliteTable('ratings', {
  profileId: profileId(),
  mediaType: text('media_type', { enum: MEDIA_TYPES }).notNull(),
  tmdbId: integer('tmdb_id').notNull(),
  title: text('title'),
  genreIds: text('genre_ids', { mode: 'json' }).notNull().$defaultFn(function () { return []; }),
  value: integer('value').notNull(),
  ratedAt: timestamp('rated_at').notNull()
}, function (table) {
  return [
    primaryKey({ columns: [table.profileId, table.mediaType, table.tmdbId] }),
    check('ratings_value_check', sql`${table.value} in (-1, 1)`)
  ];
});

module.exports = {
  MEDIA_TYPES: MEDIA_TYPES,
  profiles: profiles,
  watchlist: watchlist,
  progress: progress,
  history: history,
  ratings: ratings
};
