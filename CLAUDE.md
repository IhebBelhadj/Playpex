# Playpex — Agent Guide

Playpex is a **desktop "10-foot" (TV-style) movie and TV-series streaming app**: an **Angular 14** UI driven entirely by keyboard / remote via **spatial navigation**, packaged in **Electron 44** (Chromium + Node 24 in the main process), which also boots a **local Node streaming server** that downloads torrents with `torrent-stream` and serves them to an HTML5 `<video>` over HTTP byte-range requests.

Data sources:

| What | Source | How |
|---|---|---|
| Catalog (rows, details, seasons, episodes) | **TMDB** | called directly from the browser |
| Movie torrents, rating, runtime | **YTS** API (`movies-api.accel.li`, mirrors) | proxied by the server |
| TV episode torrents | **EZTV** API + **TheRARBG** (RARBG's successor; RARBG itself shut down in 2023) | aggregated + ranked by the server |
| 18+ section (releases ranked by seeders) | **The Pirate Bay** (apibay.org, default) / **TheRARBG** XXX category | server (`lib/adult.js`); not offered to kids profiles |
| 18+ catalog (posters, performers, studios) | pluggable: **TMDB** (default, adult films via their studios) / **ThePornDB** (key) | server (`lib/adultMeta/`) |
| Subtitles | pluggable providers: OpenSubtitles (keyless, via Stremio addon), YIFY Subtitles, OpenSubtitles.com (key), Wyzie Subs (key) | server; user picks the provider in the player |
| Trailers | YouTube via `youtubei.js` | server — **currently only the first ~1 MB streams**, see gotchas |

Planned work: **[`docs/movement-system-plan.md`](docs/movement-system-plan.md)**: rewrite of focus movement and scrolling (native scroll, mouse wheel, shared directives). Read it before touching row scrolling or `PointerService`.

More detailed guides live next to the code:

| Area | Guide |
|---|---|
| Angular UI (routes, components, services, catalogs, spatial navigation) | [`src/app/CLAUDE.md`](src/app/CLAUDE.md) |
| Local streaming server (HTTP API, torrent engine, providers, subtitles) | [`src/server/streamingServer/CLAUDE.md`](src/server/streamingServer/CLAUDE.md) |

---

## Runtime architecture

```
┌──────────────────────── Electron main process (src/electron.js) ─────────────────────────┐
│  require('./server/streamingServer/server')  ──► starts in the SAME Node process:          │
│     • Express streaming API + socket.io  :9000, or the next free port if 9000 is taken    │
│     • "remote" socket.io server (stub)   :9500  (REMOTE_PORT)                              │
│  express() power API                     :3344  GET /power/:action (quit/sleep/...)        │
│                                                                                           │
│  waits for server.ready (the port it actually bound), then                                │
│  BrowserWindow (fullscreen, frameless) ──loads──► file://…/dist/playpex/index.html?streamer=<port>
└───────────────────────────────────────────────────────────────────────────────────────────┘
                 │ renderer = Angular SPA (src/app); STREAMING_SERVER = http://localhost:<port>
                 ├── TMDB REST (api.themoviedb.org)        ← direct, key in movies.service.ts
                 ├── STREAMING_SERVER/api/movies/:imdb_id  → YTS (movie torrents, rating, runtime)
                 ├── STREAMING_SERVER/api/shows/:imdb_id/torrents?title&season&episode → EZTV + TheRARBG
                 ├── STREAMING_SERVER/torrents …           → add magnet, poll metadata, remove
                 ├── <video src="STREAMING_SERVER/torrents/:hash/files/:path">  ← byte-range stream
                 ├── STREAMING_SERVER/api/subtitles/{providers,search,file}  → WebVTT for <track>
                 ├── STREAMING_SERVER/youtube/:id?type=video|audio  → trailers (youtubei.js)
                 └── http://localhost:3344/power/:action   → Electron quits / OS shutdown
```

`src/app/server-config.ts` reads `?streamer=` once and removes it from the URL **before Angular boots** (the router only strips a trailing `index.html` from `file://` URLs; any query/hash would make the initial route match nothing → `NG04002`, blank app).

### Start: "Who's watching?"
The app opens on `/profiles` (Netflix-style picker, under the splash video). Profiles live in the server's SQLite DB (`/api/profiles`); picking one (PIN if locked) sets `ProfilesService.current` and opens `/movies/list`. Pages that need a profile are guarded. The menu's top item shows the current profile and returns to the picker.

### Play a movie
1. `/movies/list`: `MoviesPageComponent` fills the movie `Catalog` from `categories.ts`; `MoviesSliderComponent` renders rows.
2. Focusing a poster → `Catalog.select()` → TMDB details (`imdb_id`) → YTS via `/api/movies/:imdb_id` → `torrents`, `rating`, `runtime` on `MoviesService.selectedmovie` (shown by `<movie-description>`).
3. Enter → `/movies/movie/:id` (`MovieOptionsComponent`). Play → torrent picker (one row per YTS torrent) → `PlaybackService.playMovie(movie, torrent)` (magnet from the chosen torrent) → `/player`.

### Play a TV episode
1. Menu "Tv shows" → `/shows/list`: same page/slider components with the TV `Catalog` (`showCategories`).
2. Enter on a show → `/shows/show/:id` (`ShowOptionsComponent`): seasons row (focusing one loads its episodes), episodes row.
3. Enter on an episode → `TorrentService.findEpisodeTorrents(imdbId, title, season, episode)` → server returns ranked torrents (single episodes first, season packs as fallback) → torrent picker (ranking order, first marked "Best match") → `PlaybackService.play({…, magnet, season, episode})` → `/player`.

### Player (both)
`PlayerPageComponent` reads `PlaybackService.current`, `POST /torrents` (magnet), polls `GET /torrents/:hash` every 4 s until `files` exist, picks the file (episode: the `SxxEyy` file, also inside packs; movie: best container), sets `<video>.src`. Chromium sends `Range` requests; the server pipes `file.createReadStream(range)` and downloads only that file (plus its tail early, for MKV indexes). Leaving the player (Escape, before or after playback starts) → `DELETE /torrents/:hash` (engine destroyed, data deleted).

---

## Repository map

```
/
├── CLAUDE.md                     ← you are here
├── package.json                  scripts, electron-builder/forge config, deps (Angular + server deps together)
├── angular.json                  single project "Playpex"; output dist/playpex
├── tsconfig*.json                strict: false, noPropertyAccessFromIndexSignature: true (→ obj['key'] style everywhere)
├── karma.conf.js                 default Angular Karma/Jasmine setup
├── electron.txt                  a pasted Electron console log — NOT config, ignore
├── licence.md, favicon.ico, app_icon.svg
└── src/
    ├── electron.js               Electron main: window, power API (:3344), boots streaming server, passes its port
    ├── main.ts / index.html      Angular bootstrap; index.html loads YouTube iframe API, viewport 1440px
    ├── styles.scss               global fonts (Futura, Netflix Sans), custom cursor (`assets/cursor/`), row paddles, removes focus outline
    ├── proxy.config.json         unused dev proxy; not wired in angular.json
    ├── environments/             standard Angular env files (only `production` flag)
    ├── plugins/spacialNavigation.js   vendored js-spatial-navigation (Luke Chang, MPL-2.0) — see src/app/CLAUDE.md
    ├── assets/                   fonts/, icons/ (svg UI icons), imgs/wallpaper.jpg, videos/playpex_splash.mp4
    ├── app/                      Angular application → src/app/CLAUDE.md
    └── server/
        ├── electronModules/remoteWs.js   empty placeholder (future phone-remote)
        └── streamingServer/              local server → its CLAUDE.md
            ├── lib/providers/            EZTV, TheRARBG (episode torrents)
            ├── lib/subtitles/            subtitle provider registry + providers
            └── torrents/                 legacy runtime-data folder, no longer written (see lib/paths.js)
```

---

## Commands

| Goal | Command | Notes |
|---|---|---|
| Install | `npm install` | one `package.json` for UI + server + Electron |
| Full app (what users run) | `npm run electron` | `ng build --base-href ./` then `electron .` |
| Build UI | `npm run build` | must use `--base-href ./` (already in script). In non-interactive shells run `NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null` — the CLI can otherwise sit waiting on a prompt |
| UI only in browser | `npm start` | `ng serve -o` on :4200; needs the server running separately on :9000 |
| Server only | `node src/server/streamingServer/server.js` (or `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron …server.js` to use Electron's Node 24) | :9000 + :9500; `STREAMER_PORT` / `REMOTE_PORT` env vars. No power API |
| DB migration after a schema change | `npm run db:generate` | drizzle-kit; diffs `src/server/streamingServer/lib/db/schema.js` into `lib/db/migrations/` |
| Unit tests | `npm test` | Karma/Jasmine; specs are mostly CLI "should create" stubs that fail on missing providers — compare against a `git stash` baseline before calling something a regression |
| Package installer | `npm run electronBuild` (electron-builder 23) or `npm run make` (forge) | not re-verified since the Electron 44 upgrade |

There is **no linter config** and **no hot reload for Electron** — after UI edits, rebuild (`npm run electron`).

### Configuration (environment variables of the Electron/server process)

`server.js` loads the repo's **`.env`** (git-ignored; template in `.env.example`) with dotenv; real environment variables win. Packaged builds don't ship a `.env`.

| Variable | Effect |
|---|---|
| `OPENSUBTITLES_API_KEY` | enables the official OpenSubtitles.com subtitle provider (free key: opensubtitles.com/en/consumers) |
| `WYZIE_API_KEY` | enables the Wyzie Subs provider (free key: store.wyzie.io/redeem) |
| `STREAMER_PORT`, `REMOTE_PORT` | preferred server ports (default 9000 / 9500) |
| `PLAYPEX_CONFIG_DIR`, `PLAYPEX_CACHE_DIR` | override where state (`torrents.json`, `playpex.db`) and downloads go; defaults are per-OS user dirs, see `lib/paths.js` |
| `THEPORNDB_API_KEY` | enables the ThePornDB metadata provider of the 18+ section |
| `TMDB_API_KEY` | TMDB key for the server (`lib/tmdb.js`, recommendations; default 18+ metadata provider). Set in `.env`; without it recommendations are empty. The UI still uses its own copy in `movies.service.ts` |

---

## Hard-coded values an agent must know

| What | Where |
|---|---|
| Streaming server base URL | **only** `src/app/server-config.ts` (`STREAMING_SERVER`); every service/component imports it — never hard-code `localhost:9000` again |
| Power API `http://localhost:3344` | `power.service.ts`, `electron.js` |
| Remote WS `ws://localhost:5000` (unused; service never injected) | `remoteSocket.service.ts` |
| TMDB API key | `movies.service.ts#tmdb_key`; `categories.ts` URLs use a `<<api_key>>` placeholder; the server reads `TMDB_API_KEY` from `.env` |
| Movie-magnet trackers | `playback.service.ts` (`TRACKERS`) |
| Episode-magnet trackers | `src/server/streamingServer/lib/trackers.js` |
| YTS base URLs | `lib/api.js` `YTS_MIRRORS` (yts.mx stopped answering in 2026) |
| Provider mirrors | `lib/providers/eztv.js`, `lib/providers/therarbg.js` (`MIRRORS`) |

---

## Cross-cutting conventions

- **State = RxJS Subjects / BehaviorSubjects inside root services**, no NgRx. Section state (rows, paging, slider position) lives in a `Catalog` per media type (`src/app/catalog.ts`, held in `MoviesService.catalogs`).
- **Input model**: arrows are handled by the spatial-navigation library; Enter = "click/select", Escape = "back" — all bindings are defined once in `src/app/keymap.ts` (actions → keys). The mouse is mapped onto the same model by `PointerService` (hover = focus, click = select, right click / mouse back button = back, wheel = up/down); pages don't handle the mouse themselves. `AppComponent` turns keys into `NavigationService.addCommand('click'|'back')`; every page subscribes and filters by `router.url`.
- **Direct DOM manipulation**: components use `document.querySelector`, inline `style.transform` (rows never scroll natively), CSS classes like `focused`/`lastSelected`, and **GSAP** timelines. Match this style when editing existing components.
- **Bracket property access** (`data['files']`) is required by `noPropertyAccessFromIndexSignature` for loosely-typed API responses.
- **Listener/subscription hygiene**: store `document`/`window` handlers in a property and remove them in `ngOnDestroy` (`addEventListener` returns `undefined`; never assign its return value). Unsubscribe service subscriptions on destroy.
- **Server modules**: CommonJS, ES5 style (`var`, callbacks/promises). Upstream calls go through axios with a mirror list and must **always answer the client** (502 + JSON error) — never leave a request hanging.
- Persisted state: `<config dir>/playpex.db` (SQLite via Drizzle: profiles, watchlist, resume points, history, ratings — layered `lib/services` → `lib/data` → `lib/db`, see the server guide), `<config dir>/torrents.json` (info hashes; resume-on-start is commented out) and, in the renderer, `localStorage['playpex.subtitleProvider']`. Keep user data in the server DB, not in `localStorage` (it's tied to the `file://` origin, which changes if the app is ever served from `http://localhost`).

## Known gotchas / tech debt (verify before "fixing")

- **Codec limits of Chromium/Electron**: video H.264 (and HEVC where hardware allows), audio **AAC/Opus/MP3 only — no AC-3, E-AC-3/DDP, DTS, TrueHD**. Releases with Dolby/DTS audio play silently; the episode ranker prefers AAC-tagged releases and the player shows a "No sound" banner. A real fix would be server-side audio transcoding (ffmpeg), not implemented. `.avi`/XviD are not playable.
- **Trailers are broken**: YouTube now requires proof-of-origin attestation; `youtubei.js` (iOS client) gets formats but googlevideo returns 403 after the first ~1 MB, even with PO tokens minted by BotGuard in jsdom or in a real Chromium window, and SABR streaming (`googlevideo`) fails with "attestation required" (tested Oct 2026). The robust option is YouTube's official IFrame player (needs the app served from `http://localhost`, YouTube embeds reject `file://`).
- **Provider data is noisy**: TheRARBG seed counts can be months stale; EZTV's IMDb lookup sometimes returns other shows ("Breaking Brad" for Breaking Bad) — `lib/episodes.js` strictly matches `<title> [year] [US|UK…] SxxEyy` to compensate. Older shows often only exist as season packs (mostly huge HEVC/remux).
- Port 9000 may be taken by unrelated software (it was on the dev machine) — the server moves to 9001 and the UI follows via `?streamer=`. Don't reintroduce hard-coded ports.
- Downloads and state live in per-OS user dirs (`src/server/streamingServer/lib/paths.js`: Linux `~/.cache/Playpex/torrent_data` + `~/.config/Playpex/torrents.json`), never inside the app. The old in-repo `torrents/` folder is legacy; `torrent_data/` there is git-ignored — **never force-add it**.
- Component/host elements inside the flex shell need `min-width: 0` (see `movies-page.component.scss`, `show-options.component.scss`), otherwise they grow to the width of their widest row and horizontal row scrolling silently stops working.
- Menu item "Settings" is a placeholder. "18+" (`/adult`) has two layouts — posters (catalog from a metadata provider) and compact (torrent releases by seeders) — chosen per profile in `preferences.adult` (`layout`, `metadataProvider`), meant to be edited from Settings later; nothing watched there is saved to the profile. "Watch list" (`/watchlist`), the watch list / watched buttons and resume are real and per profile. `DescritionViewerComponent` (sic) is an unused stub.
- UI is designed for a fixed 1440px viewport (`index.html`). The mouse works too (`src/app/pointer.service.ts`): the custom cursor hides on any key press and comes back when the mouse moves.

## Legal note
The README states this is an educational project; streaming copyrighted content via torrents may be illegal. Keep that framing in any docs you write.
