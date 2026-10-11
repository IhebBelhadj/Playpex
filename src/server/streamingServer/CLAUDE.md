# Streaming Server (`src/server/streamingServer`) — Agent Guide

Local Node/Express server (CommonJS, ES5-style `var`/callbacks/promises) that the Angular UI talks to. It is **not a separate process** in production: `src/electron.js` does `require('./server/streamingServer/server')`, so it runs inside the Electron main process (Electron 44 → Node 24). An uncaught exception here crashes the whole app. Standalone: `node src/server/streamingServer/server.js` (or `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron …` for Electron's Node).

The torrent part (`store`/`engine`/`socket`/`progressbar`/`serialize`) follows the structure of `peerflix-server`; a standalone copy lives in the author's Playpex-backend repo (linked in the root README). Dependencies are declared in the **root** `package.json`.

## Files

| File | Role |
|---|---|
| `server.js` | Entry. Express app from `lib/api.js` + `serve-static` on `torrents/` + `cors()`, socket.io via `lib/socket.js`. Listens on `STREAMER_PORT \|\| 9000`, moving up a port on EADDRINUSE. **Exports `{ ready }`**: a promise of the port actually bound; `electron.js` passes it to the UI. Second server on `REMOTE_PORT \|\| 9500` (`lib/remoteSocketManager.js`). |
| `lib/api.js` | **All HTTP routes**: torrents + byte-range file streaming, YTS proxy, TV episode torrents, subtitles, YouTube. |
| `lib/episodes.js` | `findEpisodeTorrents(imdbId, title, season, episode)`: queries providers in parallel, keeps exact episode / single-season pack matches, dedupes by hash (merging trackers), ranks. |
| `lib/providers/eztv.js` | EZTV official API (`/api/get-torrents?imdb_id=`), all pages fetched once per show and cached 30 min; mirrors `eztvx.to`, `eztv.wf`, `eztv.tf`. Episode `0` = season pack. |
| `lib/providers/therarbg.js` | TheRARBG (RARBG's successor) JSON search `/get-posts/?keywords=…&format=json` — fields `n` name, `h` hash, `s` size, `se` **seeders** (the site's own dropdown mislabels it), `c` category. Two queries: `"<title> SxxEyy"` and `"<title> Sxx"` (packs). Mirrors `therarbg.to`, `therarbg.com`. |
| `lib/trackers.js` | Default public trackers (UDP + HTTP(S)) and `build(hash, name, magnets)` → one magnet with all trackers. |
| `lib/subtitles/index.js` | Subtitle provider registry: `list()`, `search(providerId, query, languages)`, `file(providerId, ref, lang)` → WebVTT (decodes legacy code pages, SRT→VTT). |
| `lib/subtitles/languages.js` | Normalizes `eng`/`pob`/`en`/`English` → ISO 639-1 + name + Windows code page; language filter parsing. |
| `lib/subtitles/providers/*.js` | `stremio-opensubtitles` (keyless, movies + episodes), `yify` (keyless, movies; zip via `yauzl`), `opensubtitles` (official API, `OPENSUBTITLES_API_KEY`), `wyzie` (`WYZIE_API_KEY`; written from its API docs, **not tested with a real key**). |
| `lib/youtube.js` | Trailer streaming via `youtubei.js` (iOS client), chunked range proxy to googlevideo. **Broken past ~1 MB** (see Gotchas). |
| `lib/store.js` | In-memory torrent registry (`EventEmitter`): `add`, `get`, `remove`, `list`, `load`. Persists hashes to `torrents/config/torrents.json`; optional engine options from `torrents/config/config.json`. SIGINT/SIGTERM destroy engines then exit. |
| `lib/engine.js` | `torrent-stream` factory; downloads to `torrents/torrent_data/`; on `ready` auto-selects the largest file (the stream endpoint narrows the selection); free BitTorrent port from 6881. |
| `lib/socket.js` | socket.io v2 events (`stats`, `download`, `ready`, …). **The UI doesn't use it**; it polls HTTP. |
| `lib/remoteSocketManager.js`, `lib/util.js` | Stub for a phone remote; unused helpers. |
| `lib/stats.js`, `lib/progressbar.js` | Torrent stats / piece-bitfield → progress runs. |
| `torrents/config/torrents.json` | Runtime state — don't commit casually. |
| `torrents/torrent_data/` | Downloads (GBs). Git-ignored; **never force-add**. |

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
| `GET /torrents/:infoHash/stats` | `stats()` output (peers, speed, traffic). |
| `GET\|HEAD /torrents/:infoHash/files/:path` | **The streaming endpoint.** Selects only this file (deselects the rest — season packs), starts `prefetchTail` (last 2 MB, where MKV keeps its index), parses `Range`, responds `206` and `pump(file.createReadStream(range), res)`. Socket timeout 1 h. |

Serialized torrent: `{ infoHash, name, length, interested, ready, files: [{ name, path, link, length, offset, selected }], progress }`. `serve-static` also exposes everything under `torrents/`.

### Movies (YTS)
| Path | Notes |
|---|---|
| `GET /api/movies?…`, `GET /api/movies/:imdb_id` | `list_movies.json` / `movie_details.json` via `YTS_MIRRORS` (`movies-api.accel.li` first; yts.mx is dead). UI reads `data.movie.torrents/rating/runtime/mpa_rating/yt_trailer_code`. |

### TV episodes
| Path | Notes |
|---|---|
| `GET /api/shows/:imdb_id/torrents?title=&season=&episode=` | `{ torrents: [...], providerErrors }`, best first. Torrent: `{ provider, name, hash, magnet, seeds, size, quality, codec, audio, playable, pack }`. 400 without season/episode. |

Ranking (`episodes.js#compare`): `playable` video (no HEVC/10-bit/XviD/4K) → `audio` (AAC/Opus/MP3 > untagged > Dolby/DTS, which Chromium can't decode) → ≥10 seeders → single episode before pack → resolution (1080p > 720p > 480p/SD > 2160p) → seeders. Matching (`matchKind`): normalized name must start with the show title, optional year and country (`US|UK|AU|NZ|CA`), then `SxxEyy` with no episode range after it (or `Sxx` / `Season x` for a pack, never multi-season). Both rules are unit-checkable by evaluating the module source in Node.

### Subtitles
| Path | Notes |
|---|---|
| `GET /api/subtitles/providers` | `[{ id, name, description, supports: {movie, episode}, enabled }]` — `enabled` false when a key is missing. |
| `GET /api/subtitles/search?provider=&imdb_id=tt…&season=&episode=&languages=en,ar` | `{ provider, subtitles: [{ provider, ref, language (639-1), languageName, name }], unsupported? }`. Without `provider`: first enabled one. |
| `GET /api/subtitles/file?provider=&ref=&lang=` | `text/vtt`. `ref` is provider-specific and validated (allowed hosts / id formats) before fetching — no open proxy. |

Adding a subtitle provider: write `lib/subtitles/providers/<id>.js` exporting `id, name, description, supports, isConfigured(), search(query) → [{ref, language, name}], fetch(ref) → {buffer, format}` and add it to `PROVIDERS` in `lib/subtitles/index.js` (order = order of the player's tabs; first enabled = default).

Adding a torrent provider: module with `search(...)` returning `{ provider, name, hash (lowercase), magnet, seeds, size }`, wired into `findEpisodeTorrents`; matching/ranking/dedupe are applied centrally.

### YouTube
| Path | Notes |
|---|---|
| `ALL /youtube/:videoId?type=video\|audio&quality=<itag>` (UI form), `ALL /youtube/:videoId/:type` | Resolves formats with `youtubei.js` (iOS client, info cached 1 h), fetches googlevideo in ≤4 MB chunks to satisfy any `Range`. 404 on any failure. |

## Lifecycle of a torrent

```
POST /torrents {link}
  └─ store.add → read-torrent(link) → engine(torrent, {path: torrents/torrent_data})
       ├─ save() → torrents/config/torrents.json
       └─ engine 'ready' → largest file selected → GET /torrents/:hash now lists files
GET /torrents/:hash/files/:path (Range) → only this file selected + tail prefetch → pieces prioritised → pump
DELETE /torrents/:hash → engine.destroy() + remove() (deletes data) → save()
```

On startup the saved hash list is read but **resume is commented out** in `store.js`.

## Gotchas
- **Trailers**: YouTube enforces proof-of-origin. Every approach tested in Oct 2026 stops at ~1 MB (403): `youtubei.js` clients (iOS works only for the first chunk), PO tokens minted with `bgutils-js` in jsdom and in a real hidden Chromium window, and SABR via `googlevideo` ("attestation required"). `ytdl-core` and `@distube/ytdl-core` are dead. Realistic fix: official IFrame player in the UI.
- **Swarm reality**: provider seed counts are often stale; streams can sit at 0 kB/s with few peers. An MKV whose index sits at the end used to take ~55 s to start on a slow swarm; `prefetchTail` addresses that.
- Chromium can't decode Dolby/DTS audio (see root CLAUDE.md); there is no transcoding here.
- `torrent-stream`, `socket.io@2`, `read-torrent` are old but working.
- Never hard-code the port in the UI; it comes from `server.ready` via `?streamer=`.
