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
 *   positionS: number, durationS: number, infoHash: string|null, filePath: string|null, fileId: string|null,
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
 *
 * @typedef {object} Download
 *   A torrent the server knows (lib/torrents/client.js), running or not
 * @property {string} infoHash          lowercase hex, 40 characters
 * @property {string|null} name         null until the metadata arrived
 * @property {string|null} magnet
 * @property {string|null} torrentFile  path of the cached .torrent
 * @property {'queued'|'downloading'|'seeding'|'paused'|'completed'|'checking'|'error'} state
 * @property {'stream'|'download'} intent
 * @property {string|null} error
 * @property {string} saveDir
 * @property {string[]|null} selectedFiles   paths inside the torrent; null = every file
 * @property {number|null} sizeBytes    of the selected files
 * @property {number} doneBytes
 * @property {number} uploadedBytes
 * @property {string|null} addedBy      a device id, or 'admin'
 * @property {string|null} profileId
 * @property {object|null} titleRef     { mediaType, tmdbId, season?, episode?, title? }
 * @property {boolean} removeWhenWatched
 * @property {Date} addedAt
 * @property {Date|null} completedAt
 * @property {Date|null} lastActiveAt
 *
 * @typedef {object} LibraryFolder
 *   A folder of video files in the library (docs/media-server-plan.md §5.1)
 * @property {string} id
 * @property {string} path               absolute, its realpath when added
 * @property {'movies'|'shows'|'mixed'|'other'} kind
 * @property {'everyone'|'adults'} audience   adults: never for kids profiles or DLNA
 * @property {boolean} dlna
 * @property {string} status             ok · scanning · missing · error: <message>
 * @property {boolean} builtin           the download dir (added by the server, not removable)
 * @property {string|null} matcher       its information provider: a plugin's id (library.match), null = TMDB
 * @property {Date} addedAt
 * @property {Date|null} lastScanAt
 *
 * @typedef {object} MediaFile
 *   A video file of a library folder (§5.2), addressed by its id (media ref f_<id>)
 * @property {string} id
 * @property {string} folderId
 * @property {string} relPath            inside the folder, '/' separated
 * @property {number} size
 * @property {Date} mtime
 * @property {object|null} probe
 * @property {object|null} parse
 * @property {string|null} itemId
 * @property {'ok'|'missing'|'unmatched'|'ignored'} state
 * @property {'auto'|'nfo'|'admin'|null} matchedBy   how itemId was chosen; admin survives rescans
 * @property {object[]|null} subtitles   sidecar files: [{ relPath, language, forced }]
 * @property {Date} addedAt
 * @property {Date|null} missingSince
 *
 * @typedef {object} MediaItem
 *   What files are: a movie, or an episode of a show (§5.2)
 * @property {string} id
 * @property {'movie'|'episode'} kind
 * @property {number|null} tmdbId         the movie's, or the episode's
 * @property {number|null} showTmdbId
 * @property {number|null} season
 * @property {number|null} episode
 * @property {string|null} imdbId
 * @property {string|null} title          the movie's, or the show's
 * @property {string|null} episodeTitle
 * @property {number|null} year
 * @property {object|null} artwork        { posterPath, backdropPath, stillPath }
 * @property {'auto'|'nfo'|'admin'} matchedBy
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
 * @typedef {object} DownloadsRepository
 * @property {function(): Promise<Download[]>} list                                      oldest first
 * @property {function(string): Promise<Download|null>} find
 * @property {function(Download): Promise<Download|null>} insert                        null if the hash exists
 * @property {function(string, Partial<Download>): Promise<Download|null>} update
 * @property {function(string): Promise<boolean>} remove
 *
 * @typedef {object} LibraryRepository
 * @property {function(): Promise<LibraryFolder[]>} listFolders                          oldest first
 * @property {function(string): Promise<LibraryFolder|null>} findFolder
 * @property {function(LibraryFolder): Promise<LibraryFolder>} insertFolder              DuplicateError for a known path
 * @property {function(string, Partial<LibraryFolder>): Promise<LibraryFolder|null>} updateFolder
 * @property {function(string): Promise<boolean>} removeFolder                           its files too
 * @property {function(string): Promise<MediaFile[]>} listFiles                          of a folder, by path
 * @property {function(string): Promise<MediaFile|null>} findFile
 * @property {function(MediaFile): Promise<MediaFile>} insertFile                        DuplicateError for a known folder + path
 * @property {function(string, Partial<MediaFile>): Promise<MediaFile|null>} updateFile
 * @property {function(string): Promise<boolean>} removeFile
 * @property {function({ folderId?: string, state?: string, q?: string, itemId?: string, limit: number, offset: number }): Promise<{ rows: Array<MediaFile & { item: MediaItem|null }>, total: number }>} queryFiles
 *   newest first; q matches the path
 * @property {function(): Promise<Array<{ folderId: string, state: string, count: number }>>} countFiles
 * @property {function({ audiences: string[], folderId?: string }): Promise<Array<MediaFile & { item: MediaItem|null, folder: { kind: string, path: string, builtin: boolean, dlna: boolean } }>>} listShown
 *   files in state ok / unmatched of folders with these audiences (what clients browse)
 * @property {function({ kind: 'movie'|'tv', tmdbId: number, audiences: string[] }): Promise<Array<{ id: string, season: number|null, episode: number|null }>>} titleFiles
 *   files in state ok of a movie, or of a show's episodes
 * @property {function(Date): Promise<number>} removeMissingBefore   rows missing since before the date
 * @property {function(string): Promise<MediaItem|null>} findItem
 * @property {function({ kind: string, tmdbId?: number, showTmdbId?: number, season?: number, episode?: number }): Promise<MediaItem|null>} findItemFor
 *   a movie by tmdbId, an episode by show + season + episode
 * @property {function(MediaItem): Promise<MediaItem>} insertItem
 * @property {function(string, Partial<MediaItem>): Promise<MediaItem|null>} updateItem
 * @property {function(): Promise<number>} removeOrphanItems         items no file points at
 *
 * @typedef {object} InstalledPlugin     a package installed from an upload or a URL
 * @property {string} id
 * @property {string} version
 * @property {'upload'|'url'} origin
 * @property {string|null} source        the file's name or the URL
 * @property {string|null} signer        the trusted publisher key's fingerprint, null = unsigned
 * @property {boolean} enabled
 * @property {Date} installedAt
 * @property {Date} updatedAt
 *
 * @typedef {object} PluginsRepository   installed packages, and what the plugin sandbox keeps (docs/plugins-plan.md §4.2)
 * @property {function(): Promise<InstalledPlugin[]>} installedList                          by id
 * @property {function(string): Promise<InstalledPlugin|null>} installedGet
 * @property {function(InstalledPlugin): Promise<void>} installedSave                         upsert (keeps installedAt)
 * @property {function(string): Promise<void>} installedRemove
 * @property {function(string, string): Promise<{ key: string, value: *, size: number }|null>} storeGet
 * @property {function(string, string, *, number, Date): Promise<void>} storeSet             upsert
 * @property {function(string, string): Promise<boolean>} storeRemove
 * @property {function(string, string, number): Promise<string[]>} storeKeys                 by key, starting with the prefix
 * @property {function(string): Promise<number>} storeUsage                                  bytes of all its values
 * @property {function(string, string, string): Promise<string|null>} secretGet              profile '' = the server's
 * @property {function(string, string, string, string|null, Date): Promise<void>} secretSet  null deletes
 * @property {function(string, 'server'|'profile', string): Promise<Array<{ key: string, value: * }>>} settingsList
 * @property {function(string, 'server'|'profile', string, string, *, Date): Promise<void>} settingSet   null deletes
 * @property {function(string): Promise<void>} removeAll                                      store, secrets, settings
 *
 * @typedef {object} Repositories
 * @property {ProfilesRepository} profiles
 * @property {WatchlistRepository} watchlist
 * @property {ProgressRepository} progress
 * @property {HistoryRepository} history
 * @property {RatingsRepository} ratings
 * @property {SettingsRepository} settings
 * @property {DownloadsRepository} downloads
 * @property {LibraryRepository} library
 * @property {PluginsRepository} plugins
 */

module.exports = {};
