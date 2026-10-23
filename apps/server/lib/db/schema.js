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
  // Deprecated (settings plan §6): its `adult` part was moved to
  // profile_settings by migration 0004; dropped in a later release
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
  // or a file of the library (media_files.id; no foreign key: the position
  // outlives a file that went away)
  fileId: text('file_id'),
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

// ── settings (docs/settings-plan.md) ────────────────────────────────────────
// User settings, one row per key (keys and defaults: @playpex/protocol
// settings.js). A missing row = the key's default. Values are JSON.

// Per-profile settings ('subtitles.provider', 'adult.layout', …); deleted with the profile.
var profileSettings = sqliteTable('profile_settings', {
  profileId: profileId(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    primaryKey({ columns: [table.profileId, table.key] })
  ];
});

// Per-device settings ('display.uiScale', 'player.volume', …), keyed by the id
// the client sends (X-Playpex-Device; a paired device's client_device_id).
// Loopback clients have no `devices` row, so no foreign key.
var deviceSettings = sqliteTable('device_settings', {
  deviceId: text('device_id').notNull(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    primaryKey({ columns: [table.deviceId, table.key] })
  ];
});

// ── downloads (lib/torrents, docs/media-server-plan.md §4.2) ─────────────────
// Every torrent the server knows, running or not. Our record, whatever the
// engine: with the cached .torrent (<config>/torrents/<hash>.torrent) it is
// enough to add the torrent to any engine again.

var DOWNLOAD_STATES = ['queued', 'downloading', 'seeding', 'paused', 'completed', 'checking', 'error'],
  DOWNLOAD_INTENTS = ['stream', 'download'];

var downloads = sqliteTable('downloads', {
  infoHash: text('info_hash').primaryKey(),       // lowercase hex
  name: text('name'),                              // null until the metadata arrived
  magnet: text('magnet'),
  torrentFile: text('torrent_file'),               // path of the cached .torrent
  state: text('state', { enum: DOWNLOAD_STATES }).notNull(),
  intent: text('intent', { enum: DOWNLOAD_INTENTS }).notNull(),
  error: text('error'),
  saveDir: text('save_dir').notNull(),             // the download dir when it was added
  selectedFiles: text('selected_files', { mode: 'json' }),   // file paths; null = every file
  sizeBytes: integer('size_bytes'),                // of the selected files
  doneBytes: integer('done_bytes').notNull().default(0),
  uploadedBytes: integer('uploaded_bytes').notNull().default(0),
  addedBy: text('added_by'),                       // a device id, or 'admin'
  profileId: text('profile_id'),                   // no FK: a download outlives a profile
  titleRef: text('title_ref', { mode: 'json' }),   // { mediaType, tmdbId, season, episode, title }
  removeWhenWatched: integer('remove_when_watched', { mode: 'boolean' }).notNull().default(false),
  addedAt: timestamp('added_at').notNull(),
  completedAt: timestamp('completed_at'),
  lastActiveAt: timestamp('last_active_at')
}, function (table) {
  return [
    check('downloads_state_check', sql`${table.state} IN ('queued', 'downloading', 'seeding', 'paused', 'completed', 'checking', 'error')`),
    check('downloads_intent_check', sql`${table.intent} IN ('stream', 'download')`)
  ];
});

// ── media library (lib/media, docs/media-server-plan.md §5) ─────────────────
// Folders of video files the admin added, the files found in them, and what
// each file is (a movie or an episode). Files are addressed by their id (media
// ref `f_<id>`), never by a path from a client: the path is the folder's plus
// `rel_path`, checked to stay inside the folder (lib/media).

var FOLDER_KINDS = ['movies', 'shows', 'mixed', 'other'],
  AUDIENCES = ['everyone', 'adults'],
  FILE_STATES = ['ok', 'missing', 'unmatched', 'ignored'],
  ITEM_KINDS = ['movie', 'episode'],
  MATCHED_BY = ['auto', 'nfo', 'admin'];

var libraryFolders = sqliteTable('library_folders', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),           // its realpath when added
  kind: text('kind', { enum: FOLDER_KINDS }).notNull(),
  audience: text('audience', { enum: AUDIENCES }).notNull().default('everyone'),
  dlna: integer('dlna', { mode: 'boolean' }).notNull().default(false),
  status: text('status').notNull().default('ok'),  // ok · scanning · missing · error: <message>
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),   // the download dir
  addedAt: timestamp('added_at').notNull(),
  lastScanAt: timestamp('last_scan_at')
}, function (table) {
  return [
    check('library_folders_kind_check', sql`${table.kind} IN ('movies', 'shows', 'mixed', 'other')`),
    check('library_folders_audience_check', sql`${table.audience} IN ('everyone', 'adults')`)
  ];
});

// What a file is: a movie (tmdb_id) or an episode (show_tmdb_id + season +
// episode). One item can have several files (1080p + 4K).
var mediaItems = sqliteTable('media_items', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ITEM_KINDS }).notNull(),
  tmdbId: integer('tmdb_id'),                      // the movie's, or the episode's
  showTmdbId: integer('show_tmdb_id'),
  season: integer('season'),
  episode: integer('episode'),
  imdbId: text('imdb_id'),
  title: text('title'),                            // the movie's, or the show's
  episodeTitle: text('episode_title'),
  year: integer('year'),
  artwork: text('artwork', { mode: 'json' }),      // { posterPath, backdropPath, stillPath }
  matchedBy: text('matched_by', { enum: MATCHED_BY }).notNull()
}, function (table) {
  return [
    index('media_items_movie').on(table.kind, table.tmdbId),
    index('media_items_episode').on(table.showTmdbId, table.season, table.episode),
    check('media_items_kind_check', sql`${table.kind} IN ('movie', 'episode')`),
    check('media_items_matched_by_check', sql`${table.matchedBy} IN ('auto', 'nfo', 'admin')`)
  ];
});

var mediaFiles = sqliteTable('media_files', {
  id: text('id').primaryKey(),
  folderId: text('folder_id').notNull().references(function () {
    return libraryFolders.id;
  }, { onDelete: 'cascade' }),
  relPath: text('rel_path').notNull(),             // inside the folder, '/' separated
  size: integer('size').notNull(),
  mtime: timestamp('mtime').notNull(),
  probe: text('probe', { mode: 'json' }),          // ffprobe's answer (lib/transcode.js#probe)
  parse: text('parse', { mode: 'json' }),          // what the name says (title, year, season, episode…)
  itemId: text('item_id').references(function () {
    return mediaItems.id;
  }, { onDelete: 'set null' }),
  state: text('state', { enum: FILE_STATES }).notNull().default('unmatched'),
  // how item_id was chosen (null: never matched); 'admin' survives rescans
  matchedBy: text('matched_by', { enum: MATCHED_BY }),
  subtitles: text('subtitles', { mode: 'json' }),  // sidecar files: [{ relPath, language, forced }]
  addedAt: timestamp('added_at').notNull(),
  missingSince: timestamp('missing_since')         // kept 7 days (an unplugged drive)
}, function (table) {
  return [
    uniqueIndex('media_files_folder_path').on(table.folderId, table.relPath),
    index('media_files_item').on(table.itemId),
    check('media_files_state_check', sql`${table.state} IN ('ok', 'missing', 'unmatched', 'ignored')`)
  ];
});

// ── auth (Better Auth, lib/auth) ─────────────────────────────────────────────
// Tables of Better Auth's core and device-authorization plugin, in its field
// names (the JS keys must match them; lib/auth maps its models onto these).
// One user: the server's admin. Paired devices are sessions of that user,
// made by the RFC 8628 device flow, with a row in `devices`.

var authUser = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Better Auth needs one; the admin gets a placeholder (admin@playpex.local)
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
});

function authUserId() {
  return text('user_id').notNull().references(function () {
    return authUser.id;
  }, { onDelete: 'cascade' });
}

var authSession = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: authUserId(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    index('auth_session_user_idx').on(table.userId)
  ];
});

// Credentials: the admin's password hash (providerId 'credential')
var authAccount = sqliteTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: authUserId(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    index('auth_account_user_idx').on(table.userId)
  ];
});

var authVerification = sqliteTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (table) {
  return [
    index('auth_verification_identifier_idx').on(table.identifier)
  ];
});

// Pending / approved / denied pairing requests (RFC 8628 device codes)
var authDeviceCode = sqliteTable('auth_device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  userId: text('user_id'),
  expiresAt: timestamp('expires_at').notNull(),
  status: text('status').notNull(),
  lastPolledAt: timestamp('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
  // Ours, filled right after Better Auth creates the row (lib/auth): who
  // asked, for the admin's list of pending requests
  address: text('address'),
  client: text('client'),
  requestedAt: timestamp('requested_at')
});

// A paired device = one auth session made by the device flow. Revoking it
// deletes the session, and this row with it.
var devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().unique().references(function () {
    return authSession.id;
  }, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  // What the client says about itself (PUT /devices/me)
  name: text('name'),
  platform: text('platform'),
  client: text('client'),             // <name>/<version> from X-Playpex-Client
  clientDeviceId: text('client_device_id'),
  capabilities: text('capabilities', { mode: 'json' }),
  address: text('address'),           // last address it was seen from
  lastProfileId: text('last_profile_id'),
  createdAt: timestamp('created_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull()
});

module.exports = {
  MEDIA_TYPES: MEDIA_TYPES,
  DOWNLOAD_STATES: DOWNLOAD_STATES,
  DOWNLOAD_INTENTS: DOWNLOAD_INTENTS,
  FOLDER_KINDS: FOLDER_KINDS,
  AUDIENCES: AUDIENCES,
  FILE_STATES: FILE_STATES,
  profiles: profiles,
  watchlist: watchlist,
  progress: progress,
  history: history,
  ratings: ratings,
  profileSettings: profileSettings,
  deviceSettings: deviceSettings,
  downloads: downloads,
  libraryFolders: libraryFolders,
  mediaItems: mediaItems,
  mediaFiles: mediaFiles,
  authUser: authUser,
  authSession: authSession,
  authAccount: authAccount,
  authVerification: authVerification,
  authDeviceCode: authDeviceCode,
  devices: devices
};
