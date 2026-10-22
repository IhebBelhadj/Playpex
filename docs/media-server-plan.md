# Playpex Media Server: torrent client, media library, DLNA (plan)

Status (2026-10-22): **proposed, nothing built**; decision B taken (the torrent engine moves to rqbit, Rust, §4.6). Read the root `CLAUDE.md`, `apps/server/CLAUDE.md` and `docs/server-separation-plan.md` first; this plan assumes the versioned API (`packages/protocol/openapi.yaml`), the routes → services → data → db layers and the dashboard. Its sibling, `docs/plugins-plan.md`, builds on §6 (the play pipeline) of this one.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. The library and DLNA parts serve the user's own files.

## 1. Goals

1. **A real torrent client in the server**, on a maintained Rust engine (rqbit) instead of `torrent-stream`. Downloads are kept, listed and managed in the dashboard (like uTorrent Web). A client leaving the player **pauses** the torrent (no download, no upload); nothing is deleted unless the admin removes it. The admin can start a download to finish it before watching.
2. **A media library.** The admin adds folders of video files; the server indexes them, matches them to TMDB movies / shows / episodes, reads their media info, and serves them over the same streaming endpoints as torrents.
3. **Play from disk first.** Playing a title that is on disk (a library file, or a finished download) uses the file, no torrent. One server endpoint answers "what can I play for this title" (§6), and that endpoint is where plugins plug in later.
4. **DLNA / UPnP AV.** TVs, consoles and players on the LAN browse and play the library without Playpex TV.

Non-goals: music and photos (the library is video); transcoding for DLNA renderers in the first version; remote access outside the LAN; replacing TMDB as the catalog.

## 2. Where we are (facts, 2026-10-22)

- **Engine**: `torrent-stream` 1.2 (`lib/engine.js`, `lib/store.js`). `store.add` creates an engine (largest file selected), `torrents.json` is a flat array of hashes, **resume on start is off** (`store.js:113`), and `store.load(hash)` exists but nothing calls it. torrent-stream offers `swarm.pause()/resume()`, `uploads: 0` (no upload slots), per-file `select()/deselect()`, `destroy()` (data kept) and `remove()` (data deleted). It has no persisted state, no rate limits and no fast resume: a new engine on existing data re-verifies its pieces.
- **Leases** (`lib/sessions.js`): one lease per device and torrent (`acquire` from the media routes, `keepalive` every 60 s, `DELETE /torrents/:hash` releases). After the last lease, 30 s of grace, then `end()`: `storage.deleteAfterWatching` (default **true**) → `store.remove` (data deleted), else `store.close`; either way the hash leaves `torrents.json`. The reaper drops leases idle > 10 min with no open stream and ends torrents nobody holds. Limits: `streaming.maxTorrents` 4, `maxTranscodes` 2.
- **Pause / resume** routes (`POST /torrents/:hash/pause|resume`) and the tray's pause-all only call `swarm.pause/resume`: in memory, lost on restart.
- **Media routes** are torrent-shaped: `/torrents/{hash}/files|probe|keyframe|transcode/{path}`. ffprobe / ffmpeg read through the server's own byte-range URL (`?internal=<secret>`). Progress rows store `infoHash` + `filePath`.
- **Dashboard**: Activity (leases, "orphan" torrents), Storage (download dir entries, delete, clear, the `deleteAfterWatching` switch). No page adds, pauses or inspects torrents.
- **Nothing** exists for library scanning, file watching, filename parsing, DLNA / SSDP. Discovery already has a UDP responder and mDNS (`lib/discovery.js`, `packages/protocol/mdns.js`), reusable for SSDP's multicast plumbing.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Download** | A torrent the server knows, persisted in the DB with a **state**, whether it is running or not. Replaces `torrents.json`. |
| **State** | `queued` · `downloading` · `seeding` · `paused` · `completed` (stopped, all data) · `checking` · `error`. Only `downloading` / `seeding` / `checking` have a live engine. |
| **Intent** | Why it runs: `stream` (a client is watching; it pauses when the last client leaves) or `download` (the admin, or a "Download" action, wants it finished; it keeps going without clients). |
| **Library folder** | A directory the admin added, with a kind (`movies` · `shows` · `mixed` · `other`) and an audience (`everyone` · `adults`: never shown to kids profiles or over DLNA unless allowed). |
| **Media file** | A video file on disk, from a library folder or a finished download: path, size, mtime, media info (ffprobe), parse result, match. Addressed by an opaque **file id**, never by its path. |
| **Media item** | What a file is: a movie (TMDB id) or an episode (show TMDB id + season + episode), or unmatched. One item can have several files (1080p + 4K). |
| **Source** | One way to play a title: a media file, a download's file, or a torrent from a provider. The play pipeline (§6) returns a ranked list of them. |
| **Media ref** | The id the streaming routes take: `f_<fileId>` (disk) or `t_<infoHash>_<pathHash>` (a torrent file). Lets probe / transcode / keyframe / stream be one set of routes. |

## 4. Torrent client

### 4.1 Lifecycle

```
             add (stream)                  add (download) / admin Start
                 │                                   │
                 ▼                                   ▼
   ┌──── downloading (intent stream) ◄──── client plays ──── paused ◄──┐
   │          │ last lease gone + 30 s grace ───────────────────────────┤
   │          │ admin Start → intent download                           │
   │          ▼                                                         │
   │    downloading (intent download) ── all pieces ─► seeding ─ ratio/time reached ─► completed
   │          │ admin Pause ────────────────────────────────────────────┘
   └── admin Remove (keep data / delete data) → gone
```

- **Leaving the player never deletes anything.** The last lease gone (after the 30 s grace, as today) → a `stream` download goes to **`paused`**: the engine is destroyed with its data kept (`store.close`). No peers, no upload, nothing in memory. A `download` intent keeps running without clients.
- **Playing a paused or completed download resumes it** for the player (intent stays what it was): a `completed` one is read straight from disk (§5.4: a finished download is a media file), no engine at all.
- **`storage.deleteAfterWatching` goes away** (decision C): data is removed only by the admin, or by an optional per-download rule "remove when watched" set from the dashboard.
- **Resume on server start**: downloads in `downloading` / `seeding` (intent `download`) are started again, `stream` ones come back `paused`. With torrent-stream a new engine on existing data re-checks pieces (`checking`, shown with progress); rqbit (§4.6) resumes without re-checking.
- **Limits**: `streaming.maxTorrents` becomes **active** torrents (`downloading` + `seeding` + `checking`); paused / completed don't count. New settings: `downloads.maxActive` (queue beyond it: `queued`), `downloads.seedRatio` / `downloads.seedMinutes` (stop seeding at either; 0 = don't seed), `downloads.uploadSlots` (torrent-stream `uploads`), and a global `downloads.paused` (the tray's pause all, now persisted).
- **Files**: a download keeps its file selection (the played file, or the admin's choice in the dashboard; `select()/deselect()` per file, persisted).

### 4.2 Data

New table `downloads` (migration `0005_downloads`; layers as usual: `lib/data/drizzle/downloads.js`, `lib/services/downloads.js`):

| Column | |
|---|---|
| `info_hash` (pk), `name`, `magnet`, `torrent_file` (path of the cached `.torrent`) | |
| `state`, `intent`, `error` | §3 |
| `save_dir` | the download dir at add time (moving the dir doesn't orphan old downloads) |
| `selected_files` (JSON), `size_bytes`, `done_bytes`, `uploaded_bytes` | progress survives restarts |
| `added_by` (device id / `admin`), `profile_id`, `title_ref` (JSON: kind, tmdbId, season, episode; from the player's keepalive) | the dashboard shows "Inception (2010), started on Living room TV" |
| `remove_when_watched`, `added_at`, `completed_at`, `last_active_at` | |

`torrents.json` is imported once (its hashes become `paused` downloads, if their data exists) and no longer written.

### 4.3 Code: the engine port (decoupling)

The torrent engine is a **replaceable part**: switching it (torrent-stream → rqbit now, maybe libtorrent or another later) must be one adapter file, one setting and a test run, with no change to routes, sessions, the dashboard, the protocol or the clients. The design is ports and adapters:

```
routes · sessions.js · media routes · transcode · dashboard API
                    │  (engine-neutral: info hashes, file paths, states)
             lib/torrents/client.js   ← the only user of the port; owns states, intents, queue, rules, the DB
                    │  EnginePort (lib/torrents/port.js: types + docs, no code)
      ┌─────────────┼──────────────┐
engines/rqbit.js  engines/torrent-stream.js  engines/fake.js (tests)
```

**Rules**
1. **One door.** Only `lib/torrents/client.js` imports an engine, and only through `lib/torrents/engines/index.js` (the registry: `{ id, create(options) }` per engine). A check (`npm run check:engines`, in `test:server`) fails if any file outside `lib/torrents/engines/` requires `torrent-stream`, mentions rqbit's API, or requires an engine file directly.
2. **Engine-neutral types only.** Torrents are identified by **info hash** (lowercase hex), files by their **path inside the torrent** (not the engine's index or id), states by **our** names (§3). Adapters translate both ways (an rqbit numeric id, a torrent-stream file object never leaves the adapter). No engine object, stream class, error type or option crosses the port.
3. **We own everything needed to recreate a torrent.** Our DB and `<config>/torrents/<hash>.torrent` (written by `client.js` once metadata is known) hold the magnet, the metainfo, the file selection (by path), the save dir and the state. An engine's own session / resume data is a **cache** it may keep for speed; losing it, or switching engines, never loses a download.
4. **Capabilities, not engine checks.** Each adapter declares what it can do; `client.js` and the dashboard read the flags, never the engine's id:

   | Capability | If missing |
   |---|---|
   | `fastResume` | resume shows `checking` with progress |
   | `pause` (a real pause) | pause = `stop` (engine forgets the torrent, data kept), start = re-add |
   | `rateLimits` | the dashboard hides speed limits |
   | `fileSelection` | all files are downloaded; the files drawer shows them read-only |
   | `streamPriority` | `stream()` still works; seeking may wait longer |
   | `persistentSession` | `client.js` re-adds active torrents on start (it does anyway when reconciling) |

5. **Errors are ours.** Adapters map failures to `EngineError` codes: `NOT_FOUND`, `BAD_TORRENT`, `NO_METADATA_YET`, `DISK`, `UNAVAILABLE` (engine down / restarting), `UNSUPPORTED` (capability missing). `client.js` turns them into the API's errors.
6. **Lifecycle is the engine's own business.** A sidecar (rqbit), a library (torrent-stream) or a remote service hides behind `init()` / `close()` and a `health()`; supervision, ports and passwords stay inside the adapter's folder (`engines/rqbit/supervisor.js`).

**The port** (`lib/torrents/port.js`, JSDoc types, versioned `ENGINE_PORT_VERSION = 1`):

```
id, capabilities
init({ dataDir, stateDir, peerPort, limits, log }) · close() · health() → { ok, detail }
add({ infoHash, magnet?, torrentFile?, savePath, files? (paths), paused }) → { infoHash, name?, files? }   idempotent
metadata(hash) → { name, files: [{ path, size }] } | NO_METADATA_YET
start(hash) · pause(hash) · stop(hash) · remove(hash, { deleteData })
select(hash, paths[])
stats() → Map<hash, { state, doneBytes, sizeBytes, downBps, upBps, peers, seeds, uploadedBytes, pieces? }>   one call for all
stream(hash, path, { start, end }) → Readable           the bytes of that range; prioritises them
setLimits({ downBps, upBps, uploadSlots? })
list() → hashes the engine currently has                for reconciling
on('metadata' | 'done' | 'error', hash, detail)         push where the engine can, else derived by client.js from stats()
```

`stream()` is the only data path: the media routes (§5.4) build the HTTP answer (status, `Content-Range`, MIME) themselves and only ask the port for bytes. rqbit's HTTP stream is wrapped into a `Readable` inside its adapter, so no route ever proxies "to rqbit".

**Conformance suite** (`apps/server/test/engines.test.js`): one set of tests, run against **every** registered adapter (and `fake`): add by magnet and by `.torrent`, idempotent add, metadata, select by path, pause → no traffic, start, stop + re-add keeps data, remove keep / delete, stream a range (exact bytes vs. a known file), stream across a pause, stats shape, errors mapped, `list()` after a restart of the engine. Offline by default with a local seeder (a second engine instance seeding a generated file on loopback); `PLAYPEX_TEST_NETWORK=1` adds a public-domain torrent. A new engine is done when it passes the suite; nothing else needs touching.

**Switching engines** (`downloads.engine`, dashboard Settings › Downloads, needs a restart):
1. pause every active torrent on the old engine and `close()` it;
2. `init()` the new one; for each download in our table, `add()` it with our metainfo, selection and save path, `paused` unless its state was active;
3. capabilities decide what follows (no `fastResume` → `checking`); the old engine's session cache is left in place, so switching back is just as cheap.

Data stays where it is (same save dir, same paths), so no file moves or copies. If the new engine fails `health()` at start, the server starts the previous one, logs why and shows it on the dashboard's Overview.

- `sessions.js` keeps leases, limits and the reaper, but `end()` calls `client.pause(hash)` instead of remove / close; it never sees the engine.
- Events: `download.added`, `download.updated` (state, progress; throttled 2 s, replaces the lease-only `torrent.stats` for downloads), `download.removed`; built by `client.js` from `stats()`, identical whatever the engine.

### 4.4 API (protocol first: `openapi.yaml`, then server, then clients)

| Route | Who | |
|---|---|---|
| `GET /downloads` | client, admin | all downloads with state, progress, speeds, title ref (clients see them read-only: a TV can show "On the server" and its progress) |
| `POST /downloads` `{ magnet \| infoHash \| torrent upload, intent: 'download', files? }` | admin, and clients with the `downloads` grant (decision D) | add without playing |
| `POST /downloads/{hash}/start` · `/pause` · `PUT /downloads/{hash}/files` | admin (+ grant) | |
| `DELETE /downloads/{hash}?data=keep\|delete` | admin | the only way data is deleted |
| `POST /torrents`, `GET /torrents/{hash}`, media routes, `keepalive` | client | unchanged (the player's path); `POST /torrents` on a known hash reuses its download |
| `DELETE /torrents/{hash}` | client | unchanged meaning: **releases this device's lease** (documented: it never deletes data now) |

### 4.5 Dashboard: Downloads page

A new page (between Activity and Storage): a table of downloads (name, state chip, progress bar, ↓/↑ speed, peers, ratio, size, ETA, added by / title), filters by state, **Add** (magnet, `.torrent` file, info hash), per-row Start / Pause / Remove (keep / delete data, confirm), a detail drawer (files with checkboxes + per-file progress, trackers, peers, the "remove when watched" rule), and global pause / resume + speed of the whole server. Live through the events WebSocket. Activity keeps the streams (who watches what); Storage keeps disk usage and links each entry to its download.

The TV app gets **"Download"** as an action on movie and episode pages (a core action through the same slot plumbing as plugins): picks a release like Play, then `POST /downloads`; a toast says it's queued and the page shows progress ("Downloading 43 %" on the tile, then "On this server").

### 4.6 The rqbit engine (Rust)

`torrent-stream` (last release years ago, no fast resume, no rate limits, no uTP, no persisted state, pause that keeps peers) is the weakest part of a server that now keeps downloads for weeks. The engine moves to **[rqbit](https://github.com/ikatson/rqbit)**: a BitTorrent client written in Rust (Apache-2.0; v9.0.1, August 2026), with an HTTP API and a `librqbit` crate. What it brings, checked against its README (2026-10-22):
- **fast resume** (existing data isn't re-hashed on start), real **pause / start**, **forget / delete**, per-torrent **file selection** (update only-files), **download / upload rate limits**;
- **streaming with HTTP range requests** (`/torrents/{id}/stream/{file_idx}`), prioritising the pieces being read, seeking included;
- DHT, PEX, **uTP**, IPv6, UPnP port forwarding, magnet resolution, session persistence, Prometheus metrics; a single static binary per platform.

**How it runs (decision J): as a sidecar.** The server starts the `rqbit` binary as a child process (supervised like ffmpeg: found in the bundle, else `RQBIT_PATH`, else the PATH; restarted on crash with backoff; stopped with the server):
- `rqbit server start <download dir>` with its HTTP API bound to **127.0.0.1 on a free port**, **basic auth** with a random password generated each start (kept in memory, passed by environment), its session persisted under `<config dir>/rqbit/`;
- its **web UI, UPnP media server and mDNS advertising turned off** (our dashboard, our DLNA, our discovery); UPnP port forwarding off by default (a setting); its peer port a setting (`downloads.peerPort`);
- `engines/rqbit/` (adapter + supervisor) maps the port (§4.3) onto its API: add (`POST /torrents`, paused when the intent says so, `only_files`), `pause` / `start` / `forget` / `delete`, `stats`, update only-files, global limits; ids are resolved to info hashes once and cached.
- **Streaming**: the adapter's `stream()` asks rqbit's stream endpoint for the range and returns the body as a `Readable`; the media routes (`GET /media/{ref}`, the old `/torrents/{hash}/files/{path}`) build the HTTP answer as for any engine. A **completed** file is read straight from disk (no engine in the path). The early tail read for MKV indexes stays ours (a second small range request). ffprobe / ffmpeg keep reading through the server's URL.
- **Our DB stays the source of truth** (§4.2: intent, title, rules); rqbit's session only holds engine state. On start, `client.js` reconciles: downloads in our table that rqbit doesn't have are added (paused or not, by state), torrents rqbit has that we don't are forgotten (data kept).
- **Stats and events**: `client.js` polls rqbit's stats every 2 s while something is active (one list call, not one per torrent), feeds `download.updated` and the player's swarm numbers (`stats.js` shape kept, so clients don't change).

**Shipping the binary**:
- desktop server (`apps/server-desktop`): bundled per platform like the LGPL ffmpeg (a pinned version, downloaded by the existing fetch script with SHA-256 checks, `NOTICE` with the Apache-2.0 licence);
- headless (`npm run server`, Docker later): an install step downloads the pinned binary for the platform into `<cache>/bin/` (checksummed), or uses one on the PATH; without one the server falls back to torrent-stream and says so in the dashboard (Overview: "Torrent engine: torrent-stream (rqbit not found)");
- the pinned release must provide the **headless CLI** for Linux x86_64 / aarch64, Windows x64 and macOS (universal or both arches); the release page lists the desktop (Tauri) builds first, so check the CLI assets before pinning, else build them in our CI (`cargo build --release -p rqbit`, cross targets).

**Transition**: setting `downloads.engine` = `rqbit` (default once step 1b passes the conformance suite) / `torrent-stream` (kept as an adapter; whether it stays after a release is a later call, it costs nothing while it passes the suite). Switching follows §4.3.

**Risks**: a mostly single-maintainer project and an API that can change between majors → pin the version, the conformance suite (§4.3) run against the pinned binary on every upgrade, upgrades as deliberate steps; and if rqbit ever goes away, the port means another engine is one adapter away. One more process and one loopback port to supervise: covered by the supervisor and the auth on the port.

## 5. Media library

### 5.1 Folders

- Dashboard › **Library**: add a folder with a server-side folder browser (admin-only `GET /admin/fs?path=`: directories only, no file contents), kind, audience, "include in DLNA", scan now, remove (never deletes files). The download dir is a built-in folder (kind `mixed`), so finished downloads are indexed like anything else.
- Stored in table `library_folders` (`id`, `path` (realpath), `kind`, `audience`, `dlna`, `added_at`, `last_scan_at`, `status`).

### 5.2 Scanning

- **Walk** each folder (async, a worker thread so the event loop stays free), video extensions only (`mkv mp4 m4v avi webm mov ts m2ts wmv`), skip samples (< 100 MB with "sample" in the name), extras folders, hidden files. Symlinks are followed **only when their realpath stays inside a library folder**.
- **Change detection**: `size + mtime` per path; unchanged files aren't re-probed. A watcher (`fs.watch` recursive where the OS supports it, Linux via a periodic rescan every 15 min + on demand; decision E) queues changed folders with a debounce.
- **Parse** names: a filename / folder parser (`parse-torrent-title`-like: title, year, SxxEyy / 1x02 / "Season 2", resolution, source, codec, edition) plus `.nfo` files (Kodi `<uniqueid type="tmdb|imdb">`) and the folder layout (`Show/Season 02/…`). Decision F picks the library.
- **Match** to TMDB with the server's `lib/tmdb.js` (`search/movie` with year, `search/tv`, then the episode from the season), cached; a confidence score; below it the file stays **unmatched** for the admin. IMDb id from NFO or TMDB `external_ids`.
- **Probe** with ffprobe (duration, video codec / resolution / HDR, audio codecs + languages, subtitle streams), stored, so playability ("plays here" / "audio converted" / "won't play") is known before Play, and embedded subtitles can be offered later.
- **Sidecar subtitles** (`movie.en.srt`, `Subs/`) are listed per file; served as WebVTT through the subtitles module.

Tables: `media_files` (`id`, `folder_id`, `rel_path`, `size`, `mtime`, `probe` JSON, `parse` JSON, `item_id`, `state`: ok / missing / unmatched / ignored), `media_items` (`id`, `kind`: movie / episode, `tmdb_id`, `show_tmdb_id`, `season`, `episode`, `imdb_id`, `title`, `year`, `artwork` JSON, `matched_by`: auto / nfo / admin). Missing files are kept 7 days (an unplugged drive doesn't wipe the matches and resume points).

### 5.3 Fixing matches

Dashboard › Library › **Unmatched / All**: search TMDB and pick, set "episode S01E02 of …", ignore. Changes are `matched_by: admin` and survive rescans.

### 5.4 Streaming files

- **Media refs** (§3) and one set of routes: `GET /media/{ref}` (byte ranges, 206), `/media/{ref}/probe`, `/keyframe`, `/transcode?t=`; the torrent routes stay as aliases for API v1 clients. `transcode.js` and the probe cache take a ref; for disk files ffmpeg reads the **file path directly** (no loopback HTTP hop).
- **Path safety**: refs resolve through the DB to `folder.path + rel_path`; the resolved realpath must start with the folder's realpath, or 404. No route takes a path from the client.
- Kids profiles: files of `adults` folders are refused (`403`) when the request's profile is a kid's (the player sends its profile; the lease already carries it).
- Progress: `progress` gets a nullable `file_id` next to `info_hash` / `file_path`, so Resume prefers the same file.

### 5.5 In Playpex TV

- Title pages: an **"On this server"** mark on the meta line (core contribution to `core.title.meta`) and Play uses the file (§6). Episode cards / season chips show which episodes are on disk.
- A **Library** section in the menu (core screen, `px-section-layout`): "Movies on this server", "Shows on this server", "Recently added", and "Other videos" (unmatched + `other` folders, browsable by folder). Settings › Playback gets "Prefer files on this server" (on by default; §6).

## 6. The play pipeline (sources)

Today the client finds sources itself: YTS through `/movies/:imdb`, EZTV + TheRARBG through `/shows/:imdb/torrents`, the 18+ search through `/adult/*`, then builds a magnet. With disk files and plugins that has to move to the server, in one place:

```
POST /play/sources  { kind: 'movie' | 'episode', tmdbId, imdbId?, title, year?, season?, episode?, profileId }
  → { sources: Source[], policy: { autoplay: Source | null } }

Source = { id, type: 'file' | 'download' | 'torrent', label, quality, size, playable: 'yes' | 'audio-converted' | 'no',
           ref? (file / download: a media ref), magnet? / infoHash? (torrent), seeds?, provider, badges[] }
```

Server: `lib/play/` runs **stages** in order, each a list of handlers with an `order`:
1. **collect**: core handlers `library` (files of the item), `downloads` (completed / partial downloads of the title, by `title_ref` or name match), `yts` (movies), `episodes` (EZTV + TheRARBG, the existing ranking); plugins add theirs (`docs/plugins-plan.md`).
2. **rank / filter**: core ranking (disk first if "Prefer files on this server", then playability, quality, seeds); plugins may reorder or drop (`play.rank`).
3. **policy**: whether the client autoplays the top source (a single disk file that plays: yes) or shows the picker.

Each handler has a timeout (4 s for network ones; the answer streams the disk sources first? decision G), errors only drop that handler's sources. The TV's torrent picker becomes a **source picker** (disk sources on top, "On this server" badge; torrent rows as today). `PlaybackRequest` gets `source` (a media ref) besides `magnet`; the player skips `POST /torrents` and the 4 s metadata polling for disk files.

## 7. DLNA / UPnP AV

- A **UPnP AV MediaServer:1** (`lib/dlna/`): SSDP (multicast `239.255.255.250:1900`, `NOTIFY ssdp:alive/byebye` every 30 min with a 1800 s max-age, `M-SEARCH` answers) on the interfaces LAN sharing uses; a device description XML; **ContentDirectory:1** (`Browse` BrowseDirectChildren / BrowseMetadata with paging, DIDL-Lite) and **ConnectionManager:1** (`GetProtocolInfo`); `X_GetFeatureList` / Samsung `X_SetBookmark` ignored safely. Written in-house on `dgram` + express routes (decision H), like `discovery.js`.
- **Tree**: Movies (A–Z, Recently added, by genre), TV shows → seasons → episodes, Folders (the library folders as they are on disk), Downloads (completed). Items carry title, artwork (`upnp:albumArtURI`, the TMDB poster through the server, so the renderer doesn't call TMDB), duration, resolution, size, and sidecar subtitles (`sec:CaptionInfoEx` for Samsung, `<res>` of type `text/srt` for others).
- **Serving**: `<res>` URLs point at a DLNA-only HTTP listener (decision I) with `transferMode.dlna.org: Streaming`, `contentFeatures.dlna.org` (`DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`), correct MIME per container, byte ranges, `HEAD`. No transcoding in v1: renderers that can't play a file say so themselves (later: an ffmpeg profile per renderer, keyed by its `User-Agent` / `X-AV-Client-Info`).
- **Security**: DLNA has no authentication. So it is **off by default** (`dlna.enabled`), only with `network.lanSharing`, serves **only** folders marked "include in DLNA" with audience `everyone` (adults-only folders and anything a plugin marks `adult` never), refuses requests from non-private addresses, binds the HTTP listener to LAN interfaces only, exposes read-only media refs (no write action is implemented: `CreateObject`, `DestroyObject` and the like answer a SOAP fault, UPnP error 401 "Invalid Action"). The device name is the server name; the UDN is derived from the server id (stable).
- Dashboard › Settings › **DLNA**: on / off, which folders, "seen by" (renderers that browsed in the last day, from their SSDP / HTTP requests).

## 8. Steps

| # | Step | Verify |
|---|---|---|
| 1 | **Downloads, server**: `downloads` table + migration + import of `torrents.json`; `lib/torrents/` (the engine port, registry, `check:engines`, the conformance suite with `fake` + the torrent-stream adapter passing it, the client state machine, queue, seeding rules, resume on start); `sessions.end()` → pause; settings `downloads.*`; drop `deleteAfterWatching`; events `download.*`; protocol + contract test | play → leave → state `paused`, no peers (`stats`), data on disk, row survives a restart; Start → downloads to the end without a client → `seeding` → `completed` at the ratio; maxActive queues; tray pause-all persists |
| 1b | **rqbit engine** (§4.6): the `engines/rqbit/` adapter (only this folder and the binary fetch change), the sidecar supervisor (loopback port, random basic-auth password, web UI / UPnP / mDNS off), `stream()` over rqbit's range endpoint, reconcile on start, stats polling; binary fetch for the desktop bundle and the headless install; `downloads.engine` setting + the switch procedure (§4.3) | the conformance suite passes on rqbit; `git diff` of the step touches nothing outside `lib/torrents/engines/`, the binary fetch and settings; switch torrent-stream → rqbit → torrent-stream with 3 downloads (one paused, one active, one completed): states, selections and data intact; pause → no peers and no traffic for 5 min (`ss` / rqbit stats); a 30 GB download resumes after a restart with no re-check; seeking a 4K MKV during download; kill the rqbit process mid-stream → restarted, the player recovers; `ss -ltn` shows rqbit's API only on 127.0.0.1; a wrong password → 401 |
| 2 | **Dashboard Downloads page** + Storage links; TV "Download" action + progress on title pages | add a magnet from the dashboard, select files, pause / start / remove keep / delete; the TV shows "Downloading 43 %" |
| 3 | **Media refs**: `/media/{ref}` routes, transcode / probe / keyframe on refs (disk files read directly), torrent routes as aliases; player on refs | existing torrent playback unchanged (contract test, a scenario); a disk file plays, seeks, transcodes Dolby audio |
| 4 | **Library, server**: folders, scanner (worker), parser, NFO, TMDB match, ffprobe, sidecar subtitles, watcher / rescan, missing-file grace; admin routes | a folder of 50 mixed files: movies and episodes matched (≥ 90 % on cleanly named files), rescan is incremental (unchanged files not probed), a path outside the folder (symlink, `..`) is refused |
| 5 | **Dashboard Library**: folders, folder browser, scan status, unmatched / fix match | fix a wrong match, it survives a rescan |
| 6 | **Play pipeline**: `lib/play/` stages + `POST /play/sources`; the TV's source picker; `PlaybackRequest.source`; "Prefer files on this server" setting; progress `file_id` | a movie on disk plays at once with no torrent request; the picker lists disk + torrents; a finished download plays from disk |
| 7 | **TV Library section** + "On this server" marks | the section lists the library; kids profile doesn't see adults-only folders |
| 8 | **DLNA**: SSDP, description, ContentDirectory, ConnectionManager, DLNA HTTP listener, settings page | VLC (UPnP browser), a Samsung / LG TV and Windows Media Player / BubbleUPnP see the server, browse Movies / Shows / Folders, play with seeking and subtitles; off by default; adults-only content never listed |

Steps 1, 1b and 2 stand alone (the torrent client; 1b can follow 1 directly, before the dashboard page), 3 → 4 → 5 → 6 → 7 is the library path, 8 needs 4. `docs/plugins-plan.md` needs 6.

## 9. Decisions

- **A. Pause on torrent-stream = destroy the engine** (data kept, zero network, no memory) / `swarm.pause()` (keeps peers and memory; torrent-stream still answers some requests). *Recommended: destroy*: it's what "pause completely" means; the cost is a piece check on resume. With rqbit, pause is its own pause (no re-check).
- **B. Engine** — *decided 2026-10-22 by the user: a Rust engine, **rqbit** (§4.6)*. Options weighed: keep `torrent-stream` (unmaintained, no fast resume / rate limits) / WebTorrent (JS, maintained, but no fast resume to rely on and the same single event loop as the API) / `libtorrent` bindings (C++, native addon packaging) / **rqbit** (Rust, fast resume, limits, range streaming, uTP, a static binary). torrent-stream stays an adapter of the same port (§4.3); the engine is a setting, not a dependency of the rest of the server.
- **J. How rqbit runs**: a **sidecar** process driven over its HTTP API on loopback / embedded through a Node native addon wrapping `librqbit` (napi-rs; one process, no port, typed calls, but a Rust toolchain and a per-platform native build in our CI, and an engine crash takes the server down) / its desktop app (no). *Recommended: sidecar*: no native build, a crash is isolated and restarted, the binary is pinned and replaceable; revisit the addon if the HTTP hop shows up in streaming measurements.
- **C. `deleteAfterWatching`**: remove (data deleted only by the admin, or a per-download "remove when watched" rule) / keep as a server-wide option, default off. *Recommended: remove, with the per-download rule.*
- **D. Who can add downloads**: admin only / also paired clients (a TV's "Download" action) / per device grant in Devices. *Recommended: per device grant, on by default for loopback and paired devices, so the TV action works; the admin can turn it off.*
- **E. Watching folders**: `fs.watch` recursive (fine on Windows / macOS; Linux recursive since Node 20 but inotify limits on big trees) / `chokidar` (a dependency, polling fallback for network drives) / periodic rescans only. *Recommended: periodic rescan (15 min) + a scan button + scan on download completion, then `fs.watch` where it's reliable; no dependency.*
- **F. Filename parser**: a maintained npm parser (e.g. `parse-torrent-title` / `@ctrl/video-filename-parser`, to evaluate on a corpus) / our own regexes (`lib/episodes.js` already parses `SxxEyy`). *Recommended: evaluate both on a 300-name corpus kept as a test fixture; take the better one.*
- **G. Sources answer**: one JSON when all handlers are done (≤ timeout) / streamed (NDJSON or the events socket: disk sources first, torrents as they come). *Recommended: one answer first (simpler for every client), streamed later if torrent providers make it slow.*
- **H. DLNA stack**: in-house on `dgram` + express / `node-ssdp` + hand-written ContentDirectory / an external DLNA server (minidlna, Gerbera) fed by our folders. *Recommended: in-house*: the SSDP part is small (we already do UDP discovery), the libraries are unmaintained, and an external daemon breaks the single-install story.
- **I. DLNA HTTP**: a separate listener on its own port (`dlna.port`, default 28472) / paths under the API port exempted from auth. *Recommended: a separate listener*: the API port stays authenticated everywhere, and the DLNA one only knows read-only refs of DLNA folders.

## 10. Open questions

- Downloads for the 18+ section (plugin, `docs/plugins-plan.md`): stored like others, but listed in the dashboard with their `adult` flag and never in the library's DLNA tree; kept or removed when watched by default?
- Storage quotas: stop adding / pause downloads when the disk has < N GB free (the Storage page already reads free space)?
- Hardlink or move finished downloads into a library folder ("organise into Movies/Title (Year)/") or leave them where they are (seeding needs them in place)?
- Multiple servers with the same library (one TMDB match per server, no sync): fine for now?
