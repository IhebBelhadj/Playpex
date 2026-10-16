# Streaming Server (`src/server/streamingServer`) — Agent Guide

Local Node/Express server (CommonJS, ES5-style `var`/callbacks/promises) that the Angular UI talks to. It is **not a separate process** in production: `src/electron.js` does `require('./server/streamingServer/server')`, so it runs inside the Electron main process (Electron 44 → Node 24). An uncaught exception here crashes the whole app. Standalone: `node src/server/streamingServer/server.js` (or `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron …` for Electron's Node).

The torrent part (`store`/`engine`/`socket`/`progressbar`/`serialize`) follows the structure of `peerflix-server`; a standalone copy lives in the author's Playpex-backend repo (linked in the root README). Dependencies are declared in the **root** `package.json`.

## Files

| File | Role |
|---|---|
| `server.js` | Entry. Sets `dns.setDefaultResultOrder('ipv4first')` first (DHT/UDP trackers are IPv4-only; without it the DHT never bootstraps on IPv6/NAT64 networks). Express app from `lib/api.js` + `cors()`, socket.io via `lib/socket.js`. Listens on `STREAMER_PORT \|\| 9000`, moving up a port on EADDRINUSE. **Exports `{ ready }`**: a promise of the port actually bound; `electron.js` passes it to the UI. Second server on `REMOTE_PORT \|\| 9500` (`lib/remoteSocketManager.js`). |
| `lib/api.js` | **All HTTP routes**: torrents + byte-range file streaming, YTS proxy, TV episode torrents, release lists, subtitles, YouTube. |
| `lib/releases.js` | "Find releases" lists (`browse`, `providers`) per kind `adult` / `movie` / `tv`: `PROVIDERS` table, paging, quality/playable filters, most seeded first. See **Release lists** below. |
| `lib/present.js` | Release name → display fields: `adult(name)` (`title, studio, year`, porn naming) and `release(name, kind)` (`title, year, studio: null` + for `tv` `season, episode, pack`). |
| `lib/providers/yts.js` | YTS API: `MIRRORS` (`movies-api.accel.li` first; yts.mx is dead), `get(endpoint, params)` (used by the `/api/movies` proxy), `browse()` for the movie release list. |
| `lib/providers/piratebay.js` | apibay.org (The Pirate Bay's JSON API): `searchAdult`, `browse(keywords, {lists, searchCategory, categories})` (+ `browseAdult`). |
| `lib/episodes.js` | `findEpisodeTorrents(imdbId, title, season, episode)`: queries providers in parallel, keeps exact episode / single-season pack matches, dedupes by hash (merging trackers), ranks. |
| `lib/providers/eztv.js` | EZTV official API (`/api/get-torrents?imdb_id=`), all pages fetched once per show and cached 30 min; mirrors `eztvx.to`, `eztv.wf`, `eztv.tf`. Episode `0` = season pack. `browse(keywords, imdbId, page)`: a show's torrents (paged locally) or, without `imdbId`, the site's latest uploads. |
| `lib/providers/therarbg.js` | TheRARBG (RARBG's successor) JSON search `/get-posts/?keywords=…&format=json` — fields `n` name, `h` hash, `s` size, `se` **seeders** (the site's own dropdown mislabels it), `c` category. Two queries: `"<title> SxxEyy"` and `"<title> Sxx"` (packs). Mirrors `therarbg.to`, `therarbg.com`. `browse(keywords, category, page)` for the release lists (categories `XXX`, `Movies`, `TV`). |
| `lib/imdb.js` | IMDb ratings from IMDb's GraphQL API (`caching.graphql.imdb.com`, fallback `api.graphql.imdb.com`; no key, but browser-like headers or it answers 403): `title(id)`, `episodes(id)` (250 per page, ≤ 8 pages, grouped by season; season rating = mean of the rated episodes). Cached 6 h per id, in-flight requests shared, failures not kept. IMDb only allows limited non-commercial use (the API's `disclaimer`). |
| `lib/trackers.js` | Default public trackers (UDP + HTTP(S)) and `build(hash, name, magnets)` → one magnet with all trackers. |
| `lib/subtitles/index.js` | Subtitle provider registry: `list()`, `search(providerId, query, languages)`, `file(providerId, ref, lang)` → WebVTT (decodes legacy code pages, SRT→VTT). |
| `lib/subtitles/languages.js` | Normalizes `eng`/`pob`/`en`/`English` → ISO 639-1 + name + Windows code page; language filter parsing. |
| `lib/subtitles/providers/*.js` | `stremio-opensubtitles` (keyless, movies + episodes), `yify` (keyless, movies; zip via `yauzl`), `opensubtitles` (official API, `OPENSUBTITLES_API_KEY`), `wyzie` (`WYZIE_API_KEY`; written from its API docs, **not tested with a real key**). |
| `lib/youtube.js` | Trailer streaming via `youtubei.js` (iOS client), chunked range proxy to googlevideo. **Broken past ~1 MB** (see Gotchas). |
| `lib/paths.js` | Per-OS data locations (never inside the app — packaged apps are read-only): `config` (Linux `~/.config/Playpex`, macOS `~/Library/Application Support/Playpex`, Windows `%APPDATA%\Playpex`), `cache` (`~/.cache/Playpex`, `~/Library/Caches/Playpex`, `%LOCALAPPDATA%\Playpex\Cache`), `downloads` = `<cache>/torrent_data`. Overrides: `PLAYPEX_CONFIG_DIR`, `PLAYPEX_CACHE_DIR`. |
| `lib/store.js` | In-memory torrent registry (`EventEmitter`): `add`, `get`, `remove`, `list`, `load`. Adds `lib/trackers.js` to every torrent's trackers (also as the engine's `trackers` option). Persists hashes to `<config>/torrents.json`; optional engine options merged from `<config>/config.json`. SIGINT/SIGTERM destroy engines then exit. |
| `lib/engine.js` | `torrent-stream` factory; downloads to `<cache>/torrent_data/` (metadata cache in `<cache>/torrent-stream/`); on `ready` auto-selects the largest file (the stream endpoint narrows the selection); free BitTorrent port from 6881. |
| `lib/socket.js` | socket.io v2 events (`stats`, `download`, `ready`, …). **The UI doesn't use it**; it polls HTTP. |
| `lib/remoteSocketManager.js`, `lib/util.js` | Stub for a phone remote; unused helpers. |
| `lib/stats.js`, `lib/progressbar.js` | Torrent stats / piece-bitfield → progress runs. |
| `lib/routes/profiles.js`, `lib/routes/library.js`, `lib/routes/handle.js` | `/api/profiles` and `/api/profiles/:profileId/…` routers (mounted at the end of `lib/api.js`); `handle(work)` = shared JSON/error adapter. |
| `lib/db/`, `lib/data/`, `lib/services/`, `lib/userData.js`, `lib/tmdb.js` | Per-profile user data (profiles, watchlist, resume points, history, ratings, recommendations) — see **User data** below. |
| `torrents/` | **Legacy** location of state and downloads (before `lib/paths.js`); no longer written. `torrent_data/` is git-ignored — never force-add. |

## HTTP API (`lib/api.js`)

Every upstream-backed route answers on failure (`502` + JSON `error`) — keep it that way; a hanging request leaves the UI spinning forever.

### Torrents
| Method & path | Behavior |
|---|---|
| `GET /torrents` | List serialized torrents. |
| `POST /torrents` body `{link}` | Magnet, .torrent URL, or bare 32/40-char hash. Returns `{infoHash}` (lowercase). Idempotent per hash. |
| `POST /upload` (multipart `file`) | Add from an uploaded .torrent. |
| `GET /torrents/:infoHash` | Serialized torrent; **only `{infoHash}` until metadata arrives** (the UI polls). |
| `POST /torrents/:infoHash/start/:index?` / `stop/:index?`, `GET …/deselect` | Select/deselect files. |
| `POST /torrents/:infoHash/pause` / `resume` | Swarm pause/resume. |
| `DELETE /torrents/:infoHash` | Destroy engine **and delete its data**; update the state file. |
| `GET /torrents/:infoHash/stats` | `stats()` output: `metadata` (bool), `peers`, `speed`, `traffic`, `eta` (null until metadata). Safe before metadata arrives; the player polls it while loading/buffering. |
| `GET\|HEAD /torrents/:infoHash/files/:path` | **The streaming endpoint.** Selects only this file (deselects the rest — season packs), starts `prefetchTail` (last 2 MB, where MKV keeps its index), parses `Range`, responds `206` and `pump(file.createReadStream(range), res)`. Socket timeout 1 h. |

Serialized torrent: `{ infoHash, name, length, interested, ready, files: [{ name, path, link, length, offset, selected }], progress }`.

### Movies (YTS)
| Path | Notes |
|---|---|
| `GET /api/movies?…`, `GET /api/movies/:imdb_id` | `list_movies.json` / `movie_details.json` via `lib/providers/yts.js` (`MIRRORS`: `movies-api.accel.li` first; yts.mx is dead). UI reads `data.movie.torrents/rating/runtime/mpa_rating/yt_trailer_code`. |

### TV episodes
| Path | Notes |
|---|---|
| `GET /api/shows/:imdb_id/torrents?title=&season=&episode=` | `{ torrents: [...], providerErrors }`, best first. Torrent: `{ provider, name, hash, magnet, seeds, size, quality, codec, audio, playable, pack }`. 400 without season/episode. |

Ranking (`episodes.js#compare`): `playable` video (no HEVC/10-bit/XviD/4K) → `audio` (AAC/Opus/MP3 > untagged > Dolby/DTS, which Chromium can't decode) → ≥10 seeders → single episode before pack → resolution (1080p > 720p > 480p/SD > 2160p) → seeders. Matching (`matchKind`): normalized name must start with the show title, optional year and country (`US|UK|AU|NZ|CA`), then `SxxEyy` with no episode range after it (or `Sxx` / `Season x` for a pack, never multi-season). Both rules are unit-checkable by evaluating the module source in Node.

### IMDb ratings (`lib/imdb.js`)
| Path | Notes |
|---|---|
| `GET /api/imdb/:id` | `{ id, rating, votes }` (`rating` null when unrated) |
| `GET /api/imdb/:id/episodes` | `{ id, rating, votes, seasons: [{ season, rating, rated, episodes: [{ episode, id, rating, votes }] }] }` — episodes IMDb lists without a season / episode number are left out |
Not an IMDb id → 400 `{error}`; upstream failure → 502 `{error}`.

### 18+ (`lib/adult.js`, providers `lib/providers/piratebay.js` + `therarbg.js`)
| Path | Notes |
|---|---|
| `GET /api/adult/torrents?title=&year=` | torrents for one TMDB `adult: true` movie (movie page Play); matched by title (+year) in the release name, ranked like episodes |
| `GET /api/adult/providers`, `GET /api/adult/browse?…` | = `/api/releases/{providers,browse}` with `kind=adult` (kept for the 18+ section; `adult.browse`/`browseProviders` are wrappers over `lib/releases.js`) |

### Release lists (`lib/releases.js`) — movies, TV shows, 18+
"Find releases": one source's releases for a kind, **most seeded first**, with quality / playable filters, keywords and paging for paged sources.
| Path | Notes |
|---|---|
| `GET /api/releases/providers?kind=movie\|tv\|adult` | `[{ id, name, paged, default }]`, first = default. Unknown kind → 400 `{error}` |
| `GET /api/releases/browse?kind=&provider=&q=&quality=2160p\|1080p\|720p\|SD&playable=1&page=&imdb=tt…` | `{ provider, page, hasMore, torrents }`. Unknown provider → the kind's default. `imdb` is optional context (EZTV). 400 `{error, torrents: []}` for an unknown kind, 502 `{error, torrents: []}` on upstream failure |

Each torrent: `provider, name, hash, magnet, seeds, peers, size, added` (unix s, 0 if unknown) + `describe()` (`quality, codec, audio, playable`) + presented `title, year, studio` (`studio` only for 18+, else null) + `scenes` (18+ split scenes, else false); kind `tv` adds `season` / `episode` (numbers or null) and `pack` (season / multi-season / complete pack without one episode). Presenters in `lib/present.js`; fields a provider sets itself (YTS `title`/`year`) win over the parsed ones. `playable=1` keeps `playable && audio !== 'unsupported'`; `SD` also keeps `480p`. A paged source reads up to 3 pages per call to keep ≥ 20 results after filtering (`page` in the answer = last page read; ask for `page + 1` next). Non-paged sources answer `page > 1` with an empty list.

Sources (`PROVIDERS` in `releases.js`; add one there — `list({q, quality, page, imdb}) → {results, hasMore}`):
| kind | id (first = default) | paged | How |
|---|---|---|---|
| adult | `piratebay` | no | no query → `precompiled/data_top100_<cat>.json` (500 all, 505 HD, 507 4K by quality), query → `q.php` (≤ 100), porn film subcats only |
| adult | `therarbg` | yes | `/get-posts/[keywords:<q>:]order:-se:category:XXX/?format=json&page=n`, 50 per page |
| movie | `piratebay` | no | top-100 lists of 201 Movies / 207 HD / 211 UHD (by quality; "any" merges the three, de-duplicated), query → `q.php` cat 200 keeping 201/207/211 (not 202 DVDR, 209 3D) |
| movie | `therarbg` | yes | category `Movies` |
| movie | `yts` | yes | `list_movies.json?sort_by=download_count&limit=50[&query_term][&quality]`, every torrent of each movie (no 3D) flattened; name built as `Title (Year) [1080p] [BluRay] [x264] [AAC 5.1] [YTS]` so `describe()` classifies it. **YTS `sort_by=seeds\|peers` is broken** (returns the newest uploads, 0 seeders) and seeds are capped at 100 |
| tv | `piratebay` | no | 205 TV / 208 HD / 212 UHD, same scheme |
| tv | `therarbg` | yes | category `TV` |
| tv | `eztv` | yes | `imdb` given → that show's torrents (cached 30 min; `q` words must all appear in the name), 100 per page; no `imdb` → the site's latest uploads (`/api/get-torrents?limit=100&page=n`; EZTV has no keyword search, `q` only filters each page) |

Don't put the resolution in TheRARBG keywords: it then ranks by name, not seeders. EZTV's IMDb lookup can return another show (tt0903747 Breaking Bad → only "Breaking Brad" releases, checked Oct 2026), so `q=Breaking Bad` there gives an empty list.

### 18+ catalog (`lib/adultMeta/`, routes `lib/routes/adultMeta.js`)
Metadata for the poster layout from **pluggable providers** (contract at the top of `lib/adultMeta/index.js`; add a module to `PROVIDERS`). Every provider answers the same shapes with full image URLs: `Item { id, title, year, releaseDate, overview, poster, backdrop, rating, studio }`, `Title` = Item + `{ runtime, performers: [{name, photo}], director, studios, browsableStudio }`, `Page { items, page, totalPages }`.
| Path | Notes |
|---|---|
| `GET /api/adult/meta/providers` | `[{ id, name, description, enabled, default, periods, sorts }]` — `enabled` false without its key; default = first enabled |
| `GET /api/adult/meta/:provider/home` | `{ provider, rows: [{ key, title }] }`; `:provider` = `default` for the server's default |
| `GET …/:provider/rows/:key?page=` · `…/discover?studio=&period=&sort=popular\|newest\|rated&page=` · `…/search?q=&period=&page=` | Page |
| `GET …/:provider/studios` · `…/titles/:id` | `[{ id, name }]` · Title |
Errors: unknown provider 404, provider without key 503, upstream 502 — always `{ error }`.
- **`tmdb`** (default; `TMDB_API_KEY`): TMDB has adult films (posters, cast, studios as production companies) but no adult filter or genres. Lists = `discover/movie?include_adult=true&with_companies=<studios>` (`STUDIOS`: curated company ids, checked Oct 2026; first 10 = home rows), only `adult` results, no poster-less ones in rows. Search: TMDB ranks every regular result first, so page n reads 2 TMDB pages from `regular total / 20 + 1` (two count queries, include_adult false/true).
- **`theporndb`** (`THEPORNDB_API_KEY`), checked with a key (Oct 2026): `/movies` only sorts by `orderBy=recently_released|recently_created` (others → 422), so `sorts: ['newest']` and the UI builds no Popular / Top rated rows for it. `recently_released` starts with scraped titles dated in the future (3024-…) and ignores `date_from/date_to`: items dated after today or without a cover are dropped; periods use `year=` (This year / Last year). `site_id` takes **one** site, so "New releases" merges page n of the 10 home studios (`SITES`, curated site ids). Covers: `image` / `posters.*` are the portrait front cover (no landscape art: the cover is also the backdrop); performer photos from `parent.face`. Search = `q` (relevance order) + `year`.

### Subtitles
| Path | Notes |
|---|---|
| `GET /api/subtitles/providers` | `[{ id, name, description, supports: {movie, episode}, enabled }]` — `enabled` false when a key is missing. |
| `GET /api/subtitles/search?provider=&imdb_id=tt…&season=&episode=&languages=en,ar` | `{ provider, subtitles: [{ provider, ref, language (639-1), languageName, name }], unsupported? }`. Without `provider`: first enabled one. |
| `GET /api/subtitles/file?provider=&ref=&lang=` | `text/vtt`. `ref` is provider-specific and validated (allowed hosts / id formats) before fetching — no open proxy. |

Adding a subtitle provider: write `lib/subtitles/providers/<id>.js` exporting `id, name, description, supports, isConfigured(), search(query) → [{ref, language, name}], fetch(ref) → {buffer, format}` and add it to `PROVIDERS` in `lib/subtitles/index.js` (order = order of the player's tabs; first enabled = default).

Adding a torrent provider: module with `search(...)` returning `{ provider, name, hash (lowercase), magnet, seeds, size }`, wired into `findEpisodeTorrents`; matching/ranking/dedupe are applied centrally.

### Profiles (`lib/routes/profiles.js` → `services.profiles`)
| Method & path | Behavior |
|---|---|
| `GET /api/profiles` | `{ profiles: [...], lastUsedId, maxProfiles }` |
| `POST /api/profiles` body `{name, avatar?, isKid?, pin?}` | 201 + profile; 409 duplicate name / too many |
| `GET\|PUT\|DELETE /api/profiles/:id` | PUT body `{name?, avatar?, isKid?, preferences?}` (preferences merged); DELETE cascades to all the profile's data |
| `POST /api/profiles/:id/unlock` body `{pin?}` | the profile (and records it as last used); 403 wrong PIN, 429 after 5 failures (30 s) |
| `PUT /api/profiles/:id/pin` body `{pin}` / `{pin: null}` | set / remove the lock |

### Library of a profile (`lib/routes/library.js` → `services.watchlist` / `services.playback`)
Title = `/:mediaType/:tmdbId` (`movie`|`tv`); episodes add `season`/`episode` (query or body). Writes carry `title, posterPath, backdropPath, genreIds?` so rows render without TMDB; a write without them keeps what is stored.
| Method & path | Behavior |
|---|---|
| `GET /api/profiles/:pid/library` | `{ continueWatching, watchlist, watched }` — everything the Watch list page shows. `watched` = one entry per title (latest episode, `episodesWatched`) |
| `GET /api/profiles/:pid/watchlist` · `GET\|PUT\|DELETE …/watchlist/:mediaType/:tmdbId` | list · `{inWatchlist}` · add (idempotent) · `{removed}` |
| `PUT …/progress/:mediaType/:tmdbId` body `{positionS, durationS, season?, episode?, infoHash?, filePath?, …artwork}` | save position; `{progress, finished, justFinished}` (first finish → history) |
| `GET …/progress/:mediaType/:tmdbId?season&episode` | `{ resume: {positionS, durationS, infoHash, filePath} \| null, finished }` |
| `GET …/progress/:mediaType/:tmdbId/episodes` | every episode's `{season, episode, ratio, finished}` |
| `PUT\|DELETE …/watched/:mediaType/:tmdbId` | mark watched (logged in history) / forget the progress row (history kept) |
| `GET …/history` | raw finished views, newest first |

Profile JSON: `{ id, name, avatar, isKid, hasPin, preferences, createdAt, lastUsedAt }`. Errors: `{ error, code }` with the ServiceError status (500 + `INTERNAL` otherwise). CORS allows `PUT`, not `PATCH`. **No auth**: any local process (or web page via CORS `*`) can call these; the PIN only gates the UI.

### YouTube
| Path | Notes |
|---|---|
| `ALL /youtube/:videoId?type=video\|audio&quality=<itag>` (UI form), `ALL /youtube/:videoId/:type` | Resolves formats with `youtubei.js` (iOS client, info cached 1 h), fetches googlevideo in ≤4 MB chunks to satisfy any `Range`. 404 on any failure. |

## User data (profiles, watchlist, resume, recommendations)

Three layers; each only imports the one below it:

```
lib/services/   business rules, validation, ServiceError {code, status}   ← routes call these
     │ repositories only (contract: lib/data/contracts.js)
lib/data/       data access layer: createRepositories(db) → {profiles, watchlist, progress, history, ratings}
     │          current implementation: lib/data/drizzle/*.js
lib/db/         schema.js (Drizzle tables) · driver.js (node:sqlite ↔ Drizzle) · index.js (open + migrate) · migrations/
```

- `server.js` loads the repo's `.env` (dotenv) before anything else; `lib/tmdb.js` needs `TMDB_API_KEY` from it.
- **Database**: SQLite file `<config>/playpex.db` (Linux `~/.config/Playpex/playpex.db`), Node's built-in `node:sqlite` (no native module) through Drizzle's `sqlite-proxy` adapter (Drizzle 0.45 has no node:sqlite driver). Opened lazily by `lib/userData.js` (`userData.services()` → Promise of the services), migrations applied on open.
- **Schema change**: edit `lib/db/schema.js`, run `npm run db:generate` (drizzle-kit, config in `/drizzle.config.js`), commit the new file in `lib/db/migrations/`. Never edit an applied migration.
- **Replacing the database**: another SQLite driver (better-sqlite3, libsql) → only `driver.js`. Another engine → new schema/driver in `lib/db` and a repository implementation satisfying `contracts.js`, selected in `lib/data/index.js`. Repositories return plain objects, `null` for not found, and reject with `data/errors.DuplicateError` on unique violations; they use array results + `util.first` instead of SQLite-only `.get()`.
- **Don't use `db.transaction()`**: with the async proxy over a sync driver, other requests can run between BEGIN and COMMIT. Use `db.batch([...])`, which the driver runs in one BEGIN/COMMIT without yielding.
- **Services** (`createServices(repositories, {catalog, now})`):
  - `profiles`: list/get/create/update/remove, optional 4–6 digit PIN (scrypt; `setPin`, `unlock` with 5-failure / 30 s lockout), `lastUsed`. Max 8 profiles, names unique case-insensitively. Public shape has `hasPin`, never the hash. Removing a profile cascades to all its rows. The PIN only gates the UI; the DB is not encrypted.
  - `watchlist`: list/contains/add/remove/toggle.
  - `playback`: `saveProgress` (finished at ≥ 90 %, first finish appends to history), `getResume` (null under 5 % or finished; includes `infoHash`/`filePath` of the release), `continueWatching` (`kind: 'resume'|'next'` — for `'next'` the UI resolves the following episode), `titleProgress`, `markWatched`/`markUnwatched`, `history`.
  - `ratings`: thumbs up/down (`1`/`-1`).
  - `recommendations.forProfile`: seeds = finished views + likes (recency half-life 45 d), TMDB `/recommendations` per seed (`lib/tmdb.js`, cached 6 h), scored and genre-boosted, excluding watched/in-progress/disliked/adult; kid profiles keep Animation/Family/Kids. Empty with no history.
- Titles are `(mediaType 'movie'|'tv', tmdbId)`; movies use season = episode = 0.
- **HTTP**: profiles and the library (watchlist, progress, history) are exposed (`lib/routes/*.js`, `handle(work)` → JSON, `err.status` or 500). Ratings / recommendations routes are still to add (same pattern).
- **Migrations so far**: `0000_init`, `0001_artwork` (backdrop/poster columns on watchlist, progress, history).

## Lifecycle of a torrent

```
POST /torrents {link}
  └─ store.add → read-torrent(link) → engine(torrent, {path: <cache>/torrent_data, tmp: <cache>, trackers})
       ├─ save() → <config>/torrents.json
       └─ engine 'ready' → largest file selected → GET /torrents/:hash now lists files
GET /torrents/:hash/files/:path (Range) → only this file selected + tail prefetch → pieces prioritised → pump
DELETE /torrents/:hash → engine.destroy() + remove() (deletes data) → save()
```

On startup the saved hash list is read but **resume is commented out** in `store.js`.

## Gotchas
- **Trailers**: YouTube enforces proof-of-origin. Every approach tested in Oct 2026 stops at ~1 MB (403): `youtubei.js` clients (iOS works only for the first chunk), PO tokens minted with `bgutils-js` in jsdom and in a real hidden Chromium window, and SABR via `googlevideo` ("attestation required"). `ytdl-core` and `@distube/ytdl-core` are dead. Realistic fix: official IFrame player in the UI.
- **Swarm reality**: provider seed counts are often stale; streams can sit at 0 kB/s with few peers. An MKV whose index sits at the end used to take ~55 s to start on a slow swarm; `prefetchTail` addresses that.
- Chromium can't decode Dolby/DTS audio: `lib/transcode.js` + `GET /torrents/:hash/probe/:path` (ffprobe: `{duration, video, audio, transcode}`) and `GET /torrents/:hash/transcode/:path?t=&audio=` (ffmpeg: video copied, audio → AAC stereo, live Matroska — fMP4 lost the audio/video gap after `-ss` and drifted by seconds; not byte-seekable, so every seek restarts it at `t` = the keyframe from `GET /torrents/:hash/keyframe/:path?t=` with `-noaccurate_seek`, so video and audio start together). Binaries from `FFMPEG_PATH`/`FFPROBE_PATH` or the PATH; not bundled in installers yet.
- `torrent-stream`, `socket.io@2`, `read-torrent` are old but working.
- Never hard-code the port in the UI; it comes from `server.ready` via `?streamer=`.
