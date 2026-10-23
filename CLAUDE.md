# Playpex — Agent Guide

Playpex is a **desktop "10-foot" (TV-style) movie and TV-series streaming app** in two products: **Playpex Media Server** (a Node streaming server and torrent client, on `torrent-stream` behind a replaceable engine port, that keeps downloads and serves them over HTTP byte-range requests; headless, or the tray app in `apps/server-desktop`) and **Playpex TV**, its first client: an **Angular 14** UI driven entirely by keyboard / remote via **spatial navigation**, packaged in **Electron 44** (Chromium + Node 24 in the main process), which finds a server on this machine or the LAN, pairs with it and plays its streams in an HTML5 `<video>`.

Data sources:

| What | Source | How |
|---|---|---|
| Catalog (rows, details, seasons, episodes) | **TMDB** | called directly from the browser |
| Movie torrents, rating, runtime | **YTS** API (`movies-api.accel.li`, mirrors) | proxied by the server |
| TV episode torrents | **EZTV** API + **TheRARBG** (RARBG's successor; RARBG itself shut down in 2023) | aggregated + ranked by the server |
| 18+ section (releases ranked by seeders) | **The Pirate Bay** (apibay.org, default) / **TheRARBG** XXX category | server (`lib/releases.js`, kind `adult`); not offered to kids profiles |
| "Find releases" lists for movies / shows (ranked by seeders) | movies: **The Pirate Bay** / **TheRARBG** / **YTS**; shows: **The Pirate Bay** / **TheRARBG** / **EZTV** (by IMDb id) | server (`lib/releases.js`, `/api/releases/*`) |
| 18+ catalog (posters, performers, studios) | pluggable: **TMDB** (default, adult films via their studios) / **ThePornDB** (key) | server (`lib/adultMeta/`) |
| IMDb ratings of series, seasons (mean of the episodes) and episodes | IMDb's own GraphQL API (`caching.graphql.imdb.com`, no key; limited non-commercial use only) | server (`lib/imdb.js`, `/api/imdb/*`), cached 6 h |
| Subtitles | pluggable providers: OpenSubtitles (keyless, via Stremio addon), YIFY Subtitles, OpenSubtitles.com (key), Wyzie Subs (key) | server; user picks the provider in the player |
| Trailers | YouTube via `youtubei.js` | server — **currently only the first ~1 MB streams**, see gotchas |

Movement system: **[`docs/movement-system-plan.md`](docs/movement-system-plan.md)** (plan + status) and the "Movement system" section of [`apps/tv/src/app/CLAUDE.md`](apps/tv/src/app/CLAUDE.md): focus movement and positioning through shared directives (`apps/tv/src/app/movement/`), with a per-container motion: `transform` (translated tracks, for category rows of posters) or `scroll` (native scrolling, for everything else). Every page uses it, the player included. Read both before touching focus movement, scrolling or `PointerService`.

Navigation system: **[`docs/navigation-system-plan.md`](docs/navigation-system-plan.md)** (plan, proposed 2026-10-19, nothing built): one navigator owning the history (a stack of screen entries; the router only renders), screens declared once (`defineScreen`: id, path, kind, requirements, chrome, back policy, menu entry) and opened by intent, one back ladder (layers → in-page steps → previous entry → root policy), layers for modals and panels, input sent only to the top owner; the primitives future plugins will use. Read it before changing routes, Back behaviour, modals or `NavigationService`.

UI system: **[`docs/ui-system-plan.md`](docs/ui-system-plan.md)** (plan + status; steps 0–1 done: tokens, units, screenshots; step 2 built, verification unfinished: overlays `px-dialog` / `px-panel` / `Dialogs`; review of 2026-10-22 done: per-device UI scale, type scale, image sizes, `check:ui`): what a screen is built from: design tokens (`apps/tv/src/styles/_tokens.scss`, CSS custom properties), lengths in `dp(n)` (no px: the UI scales with the screen), then shared primitives, layouts and plugin slots (`apps/tv/src/app/ui/`, from step 2). Read its status line and the "UI system" section of [`apps/tv/src/app/CLAUDE.md`](apps/tv/src/app/CLAUDE.md) before styling anything.

Server / client split: **[`docs/server-separation-plan.md`](docs/server-separation-plan.md)** (plan + status, in progress): the server becomes its own product (Playpex Media Server) and the TV app one of several clients over a versioned API (`packages/protocol/openapi.yaml`). Read its status line before working on the server, the API or packaging.

Settings: **[`docs/settings-plan.md`](docs/settings-plan.md)** (plan, proposed 2026-10-22, nothing built): every user setting in `playpex.db` (`profile_settings`, `device_settings` keyed by the client's device id), a key registry in `packages/protocol`, through the usual routes → services → repositories → Drizzle layers; clients keep only a boot cache (`client.json` `uiScale`). Read it before adding a setting or a `localStorage` key.

Media server: **[`docs/media-server-plan.md`](docs/media-server-plan.md)** (plan + status; steps 1, 1b, 1c, 2 done 2026-10-22, step 3 (media refs: `/media/{ref}` for torrent and disk files, the library tables) step 4 (the library's scanner, parser, TMDB matching, admin routes `/admin/library*`) and step 5 (the dashboard's Library page) 2026-10-23; downloads kept in the DB behind an engine port, `lib/torrents/`, three engines the admin picks in Settings › Downloads: torrent-stream (built in, default), rqbit and our Go `engines/torrentd` (optional downloads, never bundled)): downloads kept and managed as a torrent client on the Rust engine rqbit (a supervised sidecar on loopback; leaving the player pauses, never deletes; dashboard Downloads page), a media library of the admin's folders (scanned, matched to TMDB, streamed by media ref), playing from disk first through one sources endpoint (`POST /play/sources`), and a DLNA / UPnP AV server. Read it before touching the torrent lifecycle, `sessions.js`, storage or the play flow.

Plugins: **[`docs/plugins-plan.md`](docs/plugins-plan.md)** (plan, proposed 2026-10-22, nothing built): `.ppx` packages with a manifest and permissions, server code in a QuickJS / WASM sandbox with a host API, middleware hooks (`play.collect` / `rank` / `before`, release / subtitle / metadata providers), declarative TV screens and contributions rendered by core templates (no plugin code in the TV), admin install and signatures, and the 18+ section moved out of the core into a plugin. Read it with `docs/tv-plugins.md` before adding extension points or 18+ code.

More detailed guides live next to the code:

| Area | Guide |
|---|---|
| Angular UI (routes, components, services, catalogs, spatial navigation) | [`apps/tv/src/app/CLAUDE.md`](apps/tv/src/app/CLAUDE.md) |
| Local streaming server (HTTP API, torrent engine, providers, subtitles) | [`apps/server/CLAUDE.md`](apps/server/CLAUDE.md) |

---

## Runtime architecture

```
┌──────── Playpex Media Server (apps/server; headless, or the tray app apps/server-desktop) ────────┐
│  Express API :28470 (fixed; settings.json / PLAYPEX_PORT) · LAN discovery: mDNS _playpex._tcp + UDP :28471 │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ HTTP (loopback: trusted; LAN: Authorization: Bearer <device token>)
┌──────── Playpex TV: Electron main process (apps/tv/electron/) ─────────────────────────────┐
│  connection.js   which server: the last one (found again by id), else one on this machine   │
│  discovery.js    mDNS + UDP + loopback;  pairing.js  RFC 8628 device flow (token stays here) │
│  auth.js         adds Authorization / X-Playpex-Client / X-Playpex-Device to every request   │
│                  to that server, strips Origin and answers CORS (no ?access_token= in URLs)  │
│  localServer.js  starts an installed-but-stopped Playpex Media Server (dev: the repo's one)  │
│  clientConfig.js client.json (userData "Playpex TV"); power.js; updater.js (electron-updater)│
│  BrowserWindow (fullscreen, frameless, preload.js → window.playpex) ──► file://…/dist/playpex/index.html
└───────────────────────────────────────────────────────────────────────────────────────────┘
                 │ renderer = Angular SPA (apps/tv/src/app); ServerService.api = <server>/api/v1 (= <api>)
                 ├── TMDB REST (api.themoviedb.org)        ← direct, key in movies.service.ts
                 ├── <api>/movies/:imdb_id                → YTS (movie torrents, rating, runtime)
                 ├── <api>/shows/:imdb_id/torrents?title&season&episode → EZTV + TheRARBG
                 ├── <api>/torrents …                      → add magnet, poll metadata, remove
                 ├── <video src="<api>/media/:ref">        ← byte-range stream (a torrent's file or a file on disk)
                 ├── <api>/subtitles/{providers,search,file}  → WebVTT for <track>
                 ├── <api>/youtube/:id?type=video|audio    → trailers (youtubei.js)
                 └── window.playpex.power(action)          → Electron quits / OS shutdown (IPC)
```

The API is versioned (`/api/v1`) and described in **`packages/protocol/openapi.yaml`** (the contract for every client; types generated from it, checked by the server's contract test). **Writing or changing a client: read the client author guide [`docs/api/`](docs/api/README.md)** (discovery, pairing, requests, playback, events, errors and versions; plan step 10), also served by every server at `/docs` with the rendered spec at `/docs/reference`. Keep it in sync when the protocol changes. `apps/tv/src/main.ts` awaits `resolveServer()` (`apps/tv/src/app/server-config.ts`: `window.playpex.connection.current()` in Electron, `?server=` / `localStorage` in a browser) **before Angular boots**; no server → `ServerGuard` sends the app to `/connect`. Don't leave a query or hash on the URL at boot (the router only strips a trailing `index.html` from `file://` URLs; anything else makes the initial route match nothing → `NG04002`, blank app).

**Auth** (plan step 4, `apps/server/lib/auth/`, on Better Auth): LAN clients pair with the RFC 8628 device flow (`POST /api/v1/auth/device/code` → show the code → the admin approves → `POST …/device/token` → `Authorization: Bearer`); loopback clients (the TV app on the server machine) are trusted without a token; the dashboard signs in as the admin. Events: WebSocket `/api/v1/events`.

**Dashboard** (plan step 5, `apps/dashboard`, React + Vite + shadcn/ui): the server's admin web UI at `http://<server>:<port>/` (first-run setup, Overview, Activity, Devices + the `/link` pairing page, Library (folders, scans, fixing matches), Downloads, Storage, Logs, Settings, Profiles, About; public: `/docs`, the client author guide and API reference). Built into `apps/server/public` (git-ignored) and served by the server with an SPA fallback; see [`apps/dashboard/CLAUDE.md`](apps/dashboard/CLAUDE.md).

**Desktop server edition** (plan step 6, `apps/server-desktop`): "Playpex Media Server", Electron as a windowless supervisor that runs the same headless entry in a `utilityProcess`, with a tray icon (status, pairing approvals, pause downloads, restart, start at login, updates), crash restarts, electron-updater, bundled LGPL ffmpeg, and installers (NSIS per-user, dmg, AppImage + deb). It talks to the server over `process.parentPort` (`apps/server/lib/host.js`); the dashboard's Settings › Desktop app goes through `/api/v1/admin/host`. See [`apps/server-desktop/CLAUDE.md`](apps/server-desktop/CLAUDE.md).

### Start: which server, then "Who's watching?"
Before the UI loads, the shell resolves the server (`apps/tv/electron/connection.js`): the last one used (at its saved URL, else found again by id), else one on this machine (loopback: no pairing). None usable → `/connect` (`ConnectPageComponent`): servers on the network, "Enter address", "Rescan"; a server on another machine is paired once (code + QR, the admin approves on the dashboard's `/link`, the tray or the CLI); an installed but stopped Playpex Media Server is started. Choosing a server stores it and reloads the app. Later: 3 network failures → "Lost connection" (Retry / Choose server); `401 PAIRING_REQUIRED` (device revoked) or `426` → back to `/connect` with the reason. The menu's "Server" item (above the profile) opens `/connect`.

On the first start on a device, before that, `/display` ("How big should Playpex look?", `DisplayGuard`) asks for the UI size (stored in `client.json` `uiScale`; changed later in Settings).

With a server, the app opens on `/profiles` (Netflix-style picker, under the splash video). Profiles live in the server's SQLite DB (`/api/profiles`); picking one (PIN if locked) sets `ProfilesService.current` and opens `/movies/list`. Pages that need a profile are guarded. The menu's top item shows the current profile and returns to the picker.

### Play a movie
1. `/movies/list`: `MoviesPageComponent` fills the movie `Catalog` from `categories.ts`; `MoviesSliderComponent` renders rows.
2. Focusing a poster → `Catalog.select()` → TMDB details (`imdb_id`) → YTS via `/api/movies/:imdb_id` → `torrents`, `rating`, `runtime` on `MoviesService.selectedmovie` (shown by `<movie-description>`).
3. Enter → `/movies/movie/:id` (`MovieOptionsComponent`). Play → torrent picker (one row per YTS torrent) → `PlaybackService.playMovie(movie, torrent)` (magnet from the chosen torrent) → `/player`.

### Play a TV episode
1. Menu "Tv shows" → `/shows/list`: same page/slider components with the TV `Catalog` (`showCategories`).
2. Enter on a show → `/shows/show/:id` (`ShowOptionsComponent`): seasons row (focusing one loads its episodes), episodes row.
3. Enter on an episode → `/shows/show/:id/season/:s/episode/:e` (`EpisodePageComponent`): its overview, IMDb rating + votes, director / writers, the season's episodes and guest stars; Find releases (that episode); Play →
4. `EpisodePlaybackService.play` → `TorrentService.findEpisodeTorrents(imdbId, title, season, episode)` → server returns ranked torrents (single episodes first, season packs as fallback) → torrent picker (ranking order, first marked "Best match") → `PlaybackService.play({…, magnet, season, episode})` → `/player`. The show page's "Play" button takes the same path for the season's first aired episode.

### Player (both)
`PlayerPageComponent` (route `player/:session`, one session per playback) reads its entry's `PlaybackRequest`, `POST /torrents` (magnet), polls `GET /torrents/:hash` every 4 s until `files` exist, picks the file (episode: the `SxxEyy` file, also inside packs; movie: best container), sets `<video>.src` to its media ref (`<api>/media/{ref}`; the torrent routes are aliases). Chromium sends `Range` requests; the server pipes the engine's stream of that range (or the file from disk once the download is completed) and downloads only that file (plus its tail early, for MKV indexes). Leaving the player (Escape, before or after playback starts) → `DELETE /torrents/:hash?device=` releases this client's **lease**; 30 s after the last client let go the server **pauses** the torrent (a download, kept with its data and the title the keepalive named; nothing is deleted unless the admin removes it), so playing it again resumes it. While open, the player sends `POST /torrents/:hash/keepalive` every 60 s; leases idle for 10 min are reaped (crashed clients). Limits (4 torrents, 2 transcodes) answer 503 `BUSY` (`apps/server/lib/sessions.js`, settings `streaming.*`). In the player: arrows scrub (held: faster; the seek happens once, on release), the timeline shows what's downloaded around the playhead, subtitles have a size and a timing offset, episodes get "Up next" in the last 40 s (the next one replaces the player).

---

## Repository map

```
/                                 npm workspaces (apps/*, packages/*); one install, one node_modules + package-lock.json at the root
├── CLAUDE.md                     ← you are here
├── package.json                  workspaces + root scripts that delegate to the apps (no deps of its own)
├── .env / .env.example           server secrets (TMDB_API_KEY, …), read by apps/server/server.js
├── docs/                         movement-system-plan.md, server-separation-plan.md (the split into server + clients, in progress),
│                                 api/ (the client author guide: README + discovery, auth, playback, profiles, events, errors-and-versions)
├── electron.txt                  a pasted Electron console log — NOT config, ignore
├── licence.md
├── apps/
│   ├── server/                   @playpex/server — local streaming server → its CLAUDE.md
│   │   ├── index.js              core: start() / stop() (nothing listens on require); package.json lists only server deps
│   │   ├── bin/playpex-server.js headless entry (npm run server; set-port)
│   │   ├── drizzle.config.js     drizzle-kit config (npm run db:generate)
│   │   ├── lib/providers/        YTS, EZTV, TheRARBG, The Pirate Bay
│   │   ├── lib/subtitles/        subtitle provider registry + providers
│   │   ├── lib/torrents/         the torrent client (downloads) + the engine port, engines/ (torrent-stream, rqbit, torrentd, fake)
│   │   └── torrents/             legacy runtime-data folder, no longer written (see lib/paths.js)
│   ├── tv/                       @playpex/tv — "Playpex TV": Angular 14 UI + its Electron shell, a client of the server (plan step 9)
│   │   ├── package.json          main-process deps only (Angular & co. are devDependencies: bundled into dist/), electron-builder 26 config
│   │   ├── angular.json          single project "Playpex"; output apps/tv/dist/playpex
│   │   ├── tsconfig*.json        strict: false, noPropertyAccessFromIndexSignature: true (→ obj['key'] style everywhere)
│   │   ├── karma.conf.js         default Angular Karma/Jasmine setup
│   │   ├── favicon.ico, app_icon.svg, build/icon.png (installer icon, from app_icon.svg)
│   │   ├── electron/main.js      Electron main: window, IPC handlers for window.playpex, single instance
│   │   ├── electron/preload.js   window.playpex (types: src/app/desktop.ts); tokens never cross it
│   │   ├── electron/connection.js which server, resolved before the UI loads (last one by id, else this machine's)
│   │   ├── electron/discovery.js finds Playpex servers on the LAN (mDNS + UDP + loopback, merged by server id)
│   │   ├── electron/pairing.js   RFC 8628 device flow + PUT /devices/me (name, codecs)
│   │   ├── electron/auth.js      header injection + CORS for the current server (webRequest)
│   │   ├── electron/clientConfig.js client.json: deviceId, servers {id → name, url, token (safeStorage, else plain)}
│   │   ├── electron/localServer.js finds / starts Playpex Media Server on this machine (desktop-app.json record)
│   │   ├── electron/power.js, updater.js  power menu over IPC; electron-updater (generic provider, tv-channel)
│   │   ├── electron/remoteWs.js  empty placeholder (future phone-remote)
│   │   └── src/
│   │       ├── main.ts / index.html   Angular bootstrap; index.html loads YouTube iframe API
│   │       ├── styles.scss       design tokens (`@use 'tokens'`), fonts (Futura, Netflix Sans), the root font size every dp() scales with, custom cursor (`assets/cursor/`), removes focus outline (row chevrons: `app/row-arrows/`)
│   │       ├── styles/           UI system tokens: _tokens.scss (CSS custom properties), _px.scss (dp(), mixins; `@use 'px' as *;` in components)
│   │       ├── proxy.config.json unused dev proxy; not wired in angular.json
│   │       ├── environments/     standard Angular env files (only `production` flag)
│   │       ├── plugins/spacialNavigation.js   vendored js-spatial-navigation (Luke Chang, MPL-2.0) — see apps/tv/src/app/CLAUDE.md
│   │       ├── assets/           fonts/, icons/ (svg UI icons), imgs/wallpaper.jpg, videos/playpex_splash.mp4
│   │       └── app/              Angular application → apps/tv/src/app/CLAUDE.md
│   ├── dashboard/                @playpex/dashboard — the server's admin web UI (React 19 + Vite + shadcn/ui) → its CLAUDE.md;
│   │                             `npm run build:dashboard` writes apps/server/public (git-ignored), served at the server's root
│   └── server-desktop/           @playpex/server-desktop — "Playpex Media Server": tray supervisor + installers (plan §8) → its CLAUDE.md
├── engines/
│   └── torrentd/                 playpex-torrentd: a Go torrent engine on anacrolix/torrent (sidecar, built for streaming); not an npm
│                                 workspace; `npm run build:torrentd` builds it into <cache>/engines/torrentd, `build.js --all` cross-builds releases
└── packages/
    └── protocol/                 @playpex/protocol — the API contract: openapi.yaml, types/api.d.ts (generated, committed),
                                  index.js constants (API_VERSION, ports, DISCOVERY, ERROR_CODES, client header) used by server and clients,
                                  mdns.js (Node only: mDNS sent on every network interface; server advertiser + TV discovery),
                                  local.js (Node only: the server's config dir, the desktop app's install record, its port; server + TV)
```

---

## Commands

| Goal | Command | Notes |
|---|---|---|
| Install | `npm install` (repo root) | npm workspaces: installs every app; deps are declared per app (`apps/server/package.json`, `apps/tv/package.json`). Add a dep with `npm install <pkg> -w apps/server` |
| TV app (development run) | `npm run electron` | runs in `apps/tv`: `ng build --base-href ./` then `electron .`. It has no server of its own: it uses the last server chosen, else the one on this machine (`npm run server`, the tray app), else `/connect` starts one (in a development run: the repo's headless server as a child, stopped when the app quits; installed: the tray app). State in `~/.config/Playpex TV/client.json`. `npm run electron:last` starts Electron on the last build (`apps/tv/dist/playpex`) without rebuilding; it stops with a message when there's no build |
| Build UI | `npm run build` | must use `--base-href ./` (already in script). In non-interactive shells run, from `apps/tv`, `NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null` — the CLI can otherwise sit waiting on a prompt |
| UI only in browser | `npm start` | `ng serve -o` on :4200; needs the server running separately (`npm run server`, :28470) |
| Server only (headless) | `npm run server` (= `node apps/server/bin/playpex-server.js`; or `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron apps/server/bin/playpex-server.js` to use Electron's Node 24) | :28470 on every interface (`network.lanSharing`, default on): LAN clients must pair (RFC 8628 device flow), loopback clients needn't. `npm run server -- set-port <n>` when the port is taken; `-- admin set <username>` creates the admin (dashboard login); `-- devices pending\|approve <code>\|list\|revoke <id>` (CLI side of the dashboard's Devices page). Port taken by another program → **recovery mode** (dashboard only, on a free loopback port printed in the log; `--no-recovery` exits instead). `npm run electron` finds it on loopback (no pairing) |
| Dashboard | `npm run build:dashboard` (once, and after dashboard edits; then open `http://localhost:28470/`), or `npm run dashboard` for development (Vite on :5173 with hot reload, proxies `/api` + the events socket to `npm run server`; `PLAYPEX_SERVER=<url>` for another server) | first visit from the server machine runs the setup wizard (admin account, server name, download dir, LAN sharing, TMDB key) |
| API contract | `npm run generate -w packages/protocol` after editing `openapi.yaml` (regenerates `types/api.d.ts`); `npm run test:server` = contract test + discovery test (`PLAYPEX_TEST_NETWORK=1` adds provider routes; the discovery test advertises a short-lived "Playpex test" server on your LAN) | change the spec first, then server and clients |
| Optional torrent engines | `npm run install:engine -- rqbit` (pinned release, SHA-256 checked, into `<cache>/engines/rqbit`; `--remove`), `npm run build:torrentd` (Go 1.26+: builds `engines/torrentd` into `<cache>/engines/torrentd`) | or Settings › Downloads › Install in the dashboard; choose one there (`downloads.engine`, restart). Never bundled in the installers. torrentd releases: push a `torrentd-v<version>` tag (`.github/workflows/torrentd.yml` builds and publishes), then `node engines/torrentd/build.js --pin` writes their SHA-256s into its `release.json` |
| DB migration after a schema change | `npm run db:generate` | drizzle-kit; runs in `apps/server`; diffs `lib/db/schema.js` into `lib/db/migrations/` |
| UI stylesheet check | `npm run check:ui` | no colour / font / z-index / px literal outside the tokens, every font size from the type scale (`apps/tv/scripts/check-ui.js`; exceptions: `// ui-check: allow (reason)`) |
| Unit tests | from `apps/tv`: `CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless` (`--include src/app/movement` for the movement specs) | Karma/Jasmine; besides the movement specs, mostly CLI "should create" stubs that fail on missing providers — compare against a `git stash` baseline before calling something a regression |
| Desktop server (tray app) | `npm run server:desktop` (development run); installers: `npm run dist:server-desktop` (this OS; `npm run dist:win -w apps/server-desktop` cross-builds NSIS from Linux) | electron-builder 26, config in `apps/server-desktop/package.json`; fetches the pinned LGPL ffmpeg first. Uses port 28470 like `npm run server`: whichever starts first holds it. Each start records its install location in `<config dir>/desktop-app.json` (the TV app starts it from there) |
| TV UI screenshots | `npm run screens -w apps/tv` (development build into `apps/tv/dist/screens`, then 14 screens + the dev gallery into `apps/tv/.screens/latest`; `npx electron scripts/screens.js --out <dir> --size 1920x1080 --only movie,show` from `apps/tv` to reshoot) | needs a server on this machine; uses Playpex TV's `client.json` (copied). References: `.screens/baseline` (1440 × 810), `baseline-1080` (scale 0.8 + the type scale, 2026-10-22; `--scale` sets the shots' UI scale, default 0.8). Compare by eye for live screens, by pixels for the gallery (`docs/ui-system-plan.md` §9) |
| Package installer (TV app) | `npm run dist:tv` (this OS), `npm run pack -w apps/tv` (unpacked, to inspect), `dist:win` / `dist:linux` / `dist:mac -w apps/tv` | electron-builder 26, config in `apps/tv/package.json` (`build`): "Playpex TV", NSIS per-user, dmg, AppImage + deb, output `apps/tv/release/` (git-ignored). Contains only the UI and the main-process deps (no server, torrent, ffmpeg code: ~8.5 MB asar). Linux unpacked build verified; installers not run yet |

There is **no linter config** and **no hot reload for Electron** — after UI edits, rebuild (`npm run electron`).

### Configuration

The server's settings live in **`<config dir>/settings.json`** (`apps/server/lib/settings.js`: port, LAN sharing, log level, download dir, API keys, ffmpeg paths), edited from the dashboard (Settings). Environment variables override them; `apps/server/index.js` also loads the repo root's **`.env`** (git-ignored; template in `.env.example`) with dotenv, real environment variables winning. Packaged builds don't ship a `.env`. Logs: `<logs dir>/playpex-server.log` (Linux `~/.local/state/Playpex/logs`).

| Variable | Effect |
|---|---|
| `OPENSUBTITLES_API_KEY` | enables the official OpenSubtitles.com subtitle provider (free key: opensubtitles.com/en/consumers) |
| `WYZIE_API_KEY` | enables the Wyzie Subs provider (free key: store.wyzie.io/redeem) |
| `PLAYPEX_PORT` (or `STREAMER_PORT`) | server HTTP port (default **28470**, fixed: if another program holds it, the headless server enters recovery mode, see Commands; env-set values are read-only in the dashboard) |
| `PLAYPEX_LAN_SHARING` | `0` = loopback only; default on (all interfaces; LAN clients pair first, plan step 4) |
| `PLAYPEX_DISCOVERY` | `0` = don't advertise on the LAN (mDNS `_playpex._tcp` + UDP responder on 28471, plan step 8); default on, only with LAN sharing |
| `PLAYPEX_LOG_LEVEL`, `PLAYPEX_DOWNLOAD_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH` | log level (`debug`…`error`), download dir, ffmpeg binaries (else bundled, else the PATH) |
| `PLAYPEX_CONFIG_DIR`, `PLAYPEX_CACHE_DIR`, `PLAYPEX_LOG_DIR` | override where state (`settings.json`, `server.json`, `playpex.db`, `torrents/`), downloads and logs go; defaults are per-OS user dirs, see `lib/paths.js` |
| `THEPORNDB_API_KEY` | enables the ThePornDB metadata provider of the 18+ section |
| `TMDB_API_KEY` | TMDB key for the server (`lib/tmdb.js`, recommendations; default 18+ metadata provider). Set in `.env`; without it recommendations are empty. The UI still uses its own copy in `movies.service.ts` |

---

## Hard-coded values an agent must know

| What | Where |
|---|---|
| Server base URL | resolved once in `apps/tv/src/app/server-config.ts`; every service/component injects `ServerService` (`server.api`) — never hard-code `localhost:<port>` or `/api/v1` |
| Power menu over IPC (`window.playpex.power`) | `power.service.ts`, `apps/tv/electron/power.js` |
| TV client id / client header | `playpex-tv` (`apps/tv/electron/pairing.js` `CLIENT_ID`), `X-Playpex-Client: playpex-tv/<version>; api=1` (`main.js`) |
| TV updater feed (provisional, §12 J) | `apps/tv/package.json` `build.publish`: generic provider on the `tv-channel` GitHub release |
| Remote WS `ws://localhost:5000` (unused; service never injected) | `remoteSocket.service.ts` |
| TMDB API key | `movies.service.ts#tmdb_key`; `categories.ts` URLs use a `<<api_key>>` placeholder; the server reads `TMDB_API_KEY` from `.env` |
| Movie-magnet trackers | `playback.service.ts` (`TRACKERS`) |
| Episode-magnet trackers | `apps/server/lib/trackers.js` |
| YTS base URLs | `lib/providers/yts.js` `MIRRORS` (yts.mx stopped answering in 2026) |
| Provider mirrors | `lib/providers/eztv.js`, `lib/providers/therarbg.js` (`MIRRORS`) |

---

## Cross-cutting conventions

- **State = RxJS Subjects / BehaviorSubjects inside root services**, no NgRx. Section state (rows, paging, slider position) lives in a `Catalog` per media type (`apps/tv/src/app/catalog.ts`, held in `MoviesService.catalogs`).
- **Input model**: arrows go through the spatial-navigation library, and inside movement containers (`pxRow` / `pxStack` / `pxGrid`) the `FocusEngine` moves by index instead; Enter = "click/select", Escape = "back" — all bindings are defined once in `apps/tv/src/app/keymap.ts` (actions → keys). The mouse is mapped onto the same model by `PointerService` (hover = focus, click = select, right click / mouse back button = back; wheel = native scrolling on migrated pages, up/down elsewhere); pages don't handle the mouse themselves. `AppComponent` turns keys into `NavigationService.addCommand('click'|'back')`; every page subscribes and filters by `router.url`.
- **Direct DOM manipulation**: components use `document.querySelector`, CSS classes like `focused`, and **GSAP** timelines. Rows and pages are positioned only by the movement directives (`apps/tv/src/app/movement`): never move content with your own `transform` / `scrollTo` for navigation. Match the surrounding style when editing existing components.
- **Styling = tokens** (`docs/ui-system-plan.md`): colours, fonts, z-index, durations, shadows, gradients, icon filters are `var(--px-…)` from `apps/tv/src/styles/_tokens.scss` (a missing role is added there, not inlined); lengths are `dp(n)`, font sizes the type scale `var(--px-text-*)`, TMDB image bases `tmdbImageBase()` (`npm run check:ui` checks the stylesheets). The 18+ screens set `chrome.accent: 'adult'` (wine `--px-color-accent`). Amber means progress (and "on"), focus is white.
- **Bracket property access** (`data['files']`) is required by `noPropertyAccessFromIndexSignature` for loosely-typed API responses.
- **Listener/subscription hygiene**: store `document`/`window` handlers in a property and remove them in `ngOnDestroy` (`addEventListener` returns `undefined`; never assign its return value). Unsubscribe service subscriptions on destroy.
- **Server modules**: CommonJS, ES5 style (`var`, callbacks/promises). Upstream calls go through axios with a mirror list and must **always answer the client** (502 + JSON error) — never leave a request hanging.
- Persisted state: `<config dir>/playpex.db` (SQLite via Drizzle: profiles, watchlist, resume points, history, ratings — layered `lib/services` → `lib/data` → `lib/db`, see the server guide), the `downloads` table of `playpex.db` + `<config dir>/torrents/<hash>.torrent` (every torrent the server keeps, running or not; the old `torrents.json` is imported once and renamed `torrents.json.imported`), `<config dir>/desktop-app.json` (where the desktop app is installed, written on its every start). The TV app keeps its own state in its userData (`~/.config/Playpex TV`): `client.json` (`deviceId` = this client's id for the server's torrent leases, sent as `X-Playpex-Device` / `?device=`; the servers it knows with their device tokens, encrypted with `safeStorage` or plain text without a keyring; `lastServerId`; `uiScale`, this screen's UI size) and, in the renderer, `localStorage['playpex.subtitleProvider']` (`['playpex.server']` in a browser). Auth state lives in `playpex.db` (Better Auth tables, `devices`) and `<config dir>/auth.json` (the server's secret). Keep user data in the server DB, not in `localStorage` (it's tied to the `file://` origin and to one client).

## Known gotchas / tech debt (verify before "fixing")

- **Codec limits of Chromium/Electron**: video H.264 (and HEVC where hardware allows), audio **AAC/Opus/MP3 only — no AC-3, E-AC-3/DDP, DTS, TrueHD**. Releases with Dolby/DTS audio play silently; the episode ranker prefers AAC-tagged releases and the player shows a "No sound" banner. The player now probes each file and, for such audio, plays the server's ffmpeg stream (video copied, audio → AAC; seeks outside the buffer restart it at an offset — `position()` / `mediaDuration()` in the player). Needs ffmpeg/ffprobe (found by `apps/server/lib/ffmpeg.js`; bundled only in the desktop server's installers, `apps/server-desktop`); without them it falls back to direct play + the banner. `.avi`/XviD are not playable.
- **Trailers are broken**: YouTube now requires proof-of-origin attestation; `youtubei.js` (iOS client) gets formats but googlevideo returns 403 after the first ~1 MB, even with PO tokens minted by BotGuard in jsdom or in a real Chromium window, and SABR streaming (`googlevideo`) fails with "attestation required" (tested Oct 2026). The robust option is YouTube's official IFrame player (needs the app served from `http://localhost`, YouTube embeds reject `file://`).
- **Provider data is noisy**: TheRARBG seed counts can be months stale; EZTV's IMDb lookup sometimes returns other shows ("Breaking Brad" for Breaking Bad) — `lib/episodes.js` strictly matches `<title> [year] [US|UK…] SxxEyy` to compensate. Older shows often only exist as season packs (mostly huge HEVC/remux).
- The server port is fixed (28470) and doesn't slide when taken; the headless server enters recovery mode (dashboard only; `--no-recovery` exits with `PORT_IN_USE`) or exits when another Playpex server holds it. The TV app remembers servers by id, not address: a server that moved (new port, new IP) is found again by discovery. Don't reintroduce hard-coded ports.
- **The TV page sends no `Origin`** to its server: `apps/tv/electron/auth.js` strips it and answers CORS itself, so the server's CORS list doesn't trust `null` / `file://` (any sandboxed iframe sends `null`). Requests to the server made from the renderer only work inside the Electron shell or from `ng serve`'s origin (`http://localhost:4200`).
- Server code logs through `apps/server/lib/logger.js`, not `console.*`.
- Downloads and state live in per-OS user dirs (`apps/server/lib/paths.js`: Linux `~/.cache/Playpex/torrent_data` + `~/.config/Playpex/playpex.db` / `torrents/`), never inside the app. The old in-repo `torrents/` folder is legacy; `torrent_data/` there is git-ignored — **never force-add it**.
- Component/host elements inside the flex shell need `min-width: 0` (see `movies-page.component.scss`, `show-options.component.scss`), otherwise they grow to the width of their widest row and horizontal row scrolling silently stops working.
- "Settings" (`/settings`) holds only Display › Size for now. "18+" (`/adult`) has two layouts — posters (catalog from a metadata provider) and compact (torrent releases by seeders) — chosen per profile in `preferences.adult` (`layout`, `metadataProvider`), meant to be edited from Settings later; nothing watched there is saved to the profile. "Watch list" (`/watchlist`), the watch list / watched buttons and resume are real and per profile. `DescritionViewerComponent` (sic) is an unused stub.
- UI is designed on a 1440 × 810 screen and **scales** with the window: the root font size is 16px there and follows the window (`styles.scss`), times `--px-ui-scale` (per device: `client.json` `uiScale`, chosen on the first start and in Settings, `ui/display.ts`; 0.8 by default), never under 12px, every length is `dp(n)` (n design pixels, in rem; `apps/tv/src/styles/_px.scss`, `dp()` in TS from `app/ui/public-api.ts`). Never write `px` (measured values from the DOM excepted). The mouse works too (`apps/tv/src/app/pointer.service.ts`): the custom cursor hides on any key press and comes back when the mouse moves.

## Legal note
The README states this is an educational project; streaming copyrighted content via torrents may be illegal. Keep that framing in any docs you write.
