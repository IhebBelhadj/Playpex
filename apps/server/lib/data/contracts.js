'use strict';

// Data access layer contract. Services depend only on these shapes, never on
// Drizzle or SQL. To replace the database, write another implementation of the
// repositories below (see ./drizzle for the current one) and return it from
// createRepositories() in ./index.js.
//
// Rules every implementation follows
//   - methods return Promises of plain objects (no ORM entities, no query builders)
//   - "not found" resolves to null (or false for removals), it never rejects
//   - a duplicate key rejects with errors.DuplicateError (./errors.js)
//   - dates are Date objects; genreIds are arrays; preferences is an object
//   - deleting a profile deletes all of its rows in the other repositories
//
// This file only holds documentation (JSDoc types for editors).

/**
 * @typedef {'movie'|'tv'} MediaType
 *
 * @typedef {{ mediaType: MediaType, tmdbId: number }} MediaRef
 *   A title. For progress/history, season and episode are 0 for movies.
 *
 * @typedef {MediaRef & { season: number, episode: number }} EpisodeKey
 *
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name          unique, case-insensitive
 * @property {string|null} avatar
 * @property {boolean} isKid
 * @property {string|null} pinHash
 * @property {string|null} pinSalt
 * @property {object} preferences
 * @property {Date} createdAt
 * @property {Date|null} lastUsedAt
 *
 * @typedef {MediaRef & { profileId: string, title: string|null, posterPath: string|null, backdropPath: string|null, addedAt: Date }} WatchlistItem
 *
 * @typedef {EpisodeKey & {
 *   profileId: string, title: string|null, posterPath: string|null, backdropPath: string|null,
 *   positionS: number, durationS: number, infoHash: string|null, filePath: string|null,
 *   finished: boolean, updatedAt: Date }} Progress
 *
 * @typedef {EpisodeKey & {
 *   id: number, profileId: string, title: string|null, posterPath: string|null,
 *   backdropPath: string|null, genreIds: number[],
 *   watchedRatio: number, watchedAt: Date }} HistoryEntry
 *
 * @typedef {MediaRef & { profileId: string, title: string|null, genreIds: number[],
 *   value: -1|1, ratedAt: Date }} Rating
 *
 * @typedef {{ kind: 'profile'|'device', id: string }} SettingsOwner
 *   A profile id, or the client device id a client sends (X-Playpex-Device)
 *
 * @typedef {{ key: string, value: *, updatedAt: Date }} SettingEntry
 *   value is any JSON value (never null: a missing row is the default)
 */

/**
 * @typedef {object} ProfilesRepository
 * @property {function(): Promise<Profile[]>} list                         oldest first
 * @property {function(string): Promise<Profile|null>} findById
 * @property {function(string): Promise<Profile|null>} findByName         case-insensitive
 * @property {function(): Promise<number>} count
 * @property {function(Profile): Promise<Profile>} insert
 * @property {function(string, Partial<Profile>): Promise<Profile|null>} update
 * @property {function(string): Promise<boolean>} remove                  cascades
 *
 * @typedef {object} WatchlistRepository
 * @property {function(string, {mediaType?: MediaType, limit?: number}=): Promise<WatchlistItem[]>} list   newest first
 * @property {function(string, MediaRef): Promise<WatchlistItem|null>} find
 * @property {function(WatchlistItem): Promise<WatchlistItem>} add          keeps the existing row if present
 * @property {function(string, MediaRef): Promise<boolean>} remove
 *
 * @typedef {object} ProgressRepository
 * @property {function(string, EpisodeKey): Promise<Progress|null>} find
 * @property {function(Progress): Promise<Progress>} upsert
 * @property {function(string, {limit?: number}=): Promise<Progress[]>} listRecent      newest first
 * @property {function(string, MediaRef): Promise<Progress[]>} listForTitle            by season, episode
 * @property {function(string, EpisodeKey): Promise<boolean>} remove
 *
 * @typedef {object} HistoryRepository
 * @property {function(Omit<HistoryEntry, 'id'>): Promise<HistoryEntry>} add
 * @property {function(string, {limit?: number, minRatio?: number, mediaType?: MediaType}=): Promise<HistoryEntry[]>} list   newest first
 * @property {function(string): Promise<MediaRef[]>} watchedTitles        distinct titles
 * @property {function(string, MediaRef): Promise<number>} removeForTitle
 *
 * @typedef {object} RatingsRepository
 * @property {function(string, MediaRef): Promise<Rating|null>} find
 * @property {function(Rating): Promise<Rating>} upsert
 * @property {function(string, {value?: -1|1, limit?: number}=): Promise<Rating[]>} list    newest first
 * @property {function(string, MediaRef): Promise<boolean>} remove
 *
 * @typedef {object} SettingsRepository
 * @property {function(SettingsOwner): Promise<SettingEntry[]>} list                       by key
 * @property {function(SettingsOwner, string): Promise<SettingEntry|null>} get
 * @property {function(SettingsOwner, string, *, Date): Promise<void>} set                   upsert; null value deletes the row
 * @property {function(SettingsOwner, Object<string, *>, Date): Promise<void>} setMany       same, all keys at once (atomic)
 * @property {function(SettingsOwner, string): Promise<boolean>} remove
 * @property {function(SettingsOwner): Promise<number>} removeAll                          rows deleted
 *
 * @typedef {object} Repositories
 * @property {ProfilesRepository} profiles
 * @property {WatchlistRepository} watchlist
 * @property {ProgressRepository} progress
 * @property {HistoryRepository} history
 * @property {RatingsRepository} ratings
 * @property {SettingsRepository} settings
 */

module.exports = {};
