# Playpex Media Server + separate clients: plan

Status (2026-10-16): **in progress — steps 0, 1 and 2 done** (§11). Revision 2: the server is its own installable product (bundled runtime, background process, tray icon, web dashboard, like Plex Media Server), and clients are separate apps; the Electron TV app is the first of several. All decisions in §12 are taken. Read the root `CLAUDE.md`, `apps/tv/src/app/CLAUDE.md` and `apps/server/CLAUDE.md` first; this plan assumes them. (§2 describes the code before the split, with its old paths.)

## 1. Goal

Split Playpex into **two kinds of products**:

1. **Playpex Media Server**, installed once on an always-on machine:
   - **Self-contained installer**: no Node, ffmpeg or anything else needs to be on the system. The installer ships the runtime, the server, ffmpeg/ffprobe and the dashboard.
   - **Its own executable** ("Playpex Media Server"). Opening it starts the server **in the background**, with no window. A **tray icon** (Windows notification area, macOS menu bar, Linux AppIndicator) shows status and has Open dashboard / Pause / Restart / Quit.
   - **Web dashboard** at `http://<server>:<port>/` in any browser: status, active streams and torrents, connected clients and paired devices, live logs, download directories and storage, settings (ports, sharing, API keys, limits), first-run setup.
   - **Start at login** (Windows/macOS/Linux desktop), and a **headless** edition for Linux boxes/NAS (systemd service, Docker) with the same dashboard.
   - **Discoverable on the LAN**; devices pair with it once.
2. **Clients**, installed separately on each device, talking to the server over a **documented, versioned API**:
   - The current Angular + Electron TV app becomes **Playpex TV**, with no server inside it. It finds servers on the LAN, pairs, and streams.
   - Other clients come later (Android TV, mobile, web). Nothing in the protocol may rely on Electron or Chromium: discovery, pairing, auth, streaming and codec choices must all be implementable on any platform.

Non-goals for this plan: access from outside the LAN (NAT traversal, TLS, relay), one client talking to several servers at once, Windows "service" mode that runs before login (§13), the extra clients themselves.

## 2. Today, and what blocks the split

| Concern | Today | Problem |
|---|---|---|
| Packaging | One Electron app = UI + server (`src/electron.js` requires `server.js`) | No server-only product; the server dies with the UI and needs a display |
| Runtime | Electron's Node in prod; system `node` in dev | Headless install needs a runtime on the system |
| Dependencies | One root `package.json` for Angular 14, Electron, and server deps | Can't build a server-only or client-only package |
| ffmpeg | Must be on the PATH (not bundled) | Users must install it themselves |
| Config | `.env` (repo, dev only) + env vars; packaged builds have no way to set API keys | Server settings need a UI (the dashboard) and persistent storage |
| Logs | `console.log` + `morgan` to stdout | Nothing to show in a dashboard; lost when there's no terminal |
| Server URL in the UI | `server-config.ts` const `http://localhost:<?streamer=>`, used by 11 files | Host hard-wired; can't target another machine |
| Exposure | `listen(port)` on all interfaces, CORS `*`, no auth; state-changing `GET` (`/torrents/:hash/deselect`) | Already open to the whole LAN and to any web page today |
| Power API | Unauthenticated express on `:3344` in `electron.js` | Any web page can shut the PC down; belongs to the client device anyway |
| Torrent lifetime | Player `DELETE`s the torrent when leaving | With several clients, one can kill another's stream; a crashed client leaks a downloading torrent |
| Codec decisions | The Chromium player decides (probe → transcode audio if AC-3/DTS) | Each client platform decodes different codecs; the server should decide per client |
| Catalog | TMDB called by the renderer, key in `movies.service.ts` | Every future client would embed the key (§12 G) |

Good news: the server only needs pure-JS dependencies (`express`, `torrent-stream`, `drizzle-orm`, `axios`, `socket.io`, …), and SQLite comes from Node's built-in `node:sqlite`. **There are no native modules to rebuild per platform**, so the server can be bundled with any Node 24 binary.

## 3. Target architecture

```
┌──────────────────────────────── Playpex Media Server (installed on the server machine) ─────────────────────────────┐
│                                                                                                                     │
│  Desktop edition (Win/macOS/Linux desktop)          Headless edition (Linux/NAS/Docker)                              │
│  ┌──────────────────────────────────────┐           ┌──────────────────────────────────┐                             │
│  │ "Playpex Media Server" executable     │           │ systemd unit / docker entrypoint │                             │
│  │ supervisor (Electron main, no window) │           │ runtime/bin/node                 │                             │
│  │  tray · start at login · single inst. │           └───────────────┬──────────────────┘                             │
│  │  auto-update · restart on crash       │                           │                                                │
│  └───────────────┬──────────────────────┘                           │                                                │
│                  │ utilityProcess (Node 24 inside Electron)          │                                                │
│                  ▼                                                   ▼                                                │
│  ┌──────────────────────────────── server core (same code in both editions) ─────────────────────────────────────┐  │
│  │ HTTP :28470 /api/v1/*  (clients)   /  (dashboard SPA)   /api/v1/admin/*  (dashboard)   ws  /api/v1/events      │  │
│  │ auth (admin session · device tokens) · settings.json · logger (files + ring buffer)                            │  │
│  │ torrents (leases, reaper, limits) · providers · subtitles · ffmpeg (bundled) · SQLite playpex.db               │  │
│  │ discovery advertiser: mDNS _playpex._tcp + UDP responder :28471                                                │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ HTTP API + byte-range streams, mDNS/UDP                          ▲ browser
        │                                                                  │
 ┌──────┴───────────── Playpex TV (Electron client) ─────┐   ┌────────────┴──────────┐   future: Android TV, mobile, web
 │ main: discovery, client.json, auth header, power IPC │   │ any browser:          │   clients (same protocol)
 │ renderer: Angular TV UI, /connect page               │   │ server dashboard      │
 └──────────────────────────────────────────────────────┘   └───────────────────────┘
```

Principles:
1. **One server core**, run by two thin hosts (desktop supervisor, headless launcher). The core never imports Electron.
2. **The API is the product boundary.** Everything a client needs is under `/api/v1`, described by an OpenAPI spec in `packages/protocol`. No client may depend on server internals.
3. **The dashboard is just another client** of the server (admin routes, admin session). It is served by the server itself, so it works on headless installs and from any machine.
4. **Secure by default**: LAN access needs a paired device or an admin login; no state-changing `GET`; Host-header check against DNS rebinding.
5. **Every step leaves something working**, like the movement-system migration. The current all-in-one app keeps running until the TV client is separated (step 9).

## 4. Repository layout (npm workspaces)

```
/
├── package.json                 workspaces: apps/*, packages/*; root scripts only
├── apps/
│   ├── server/                  server core (was src/server/streamingServer), CommonJS, pure Node
│   │   ├── server.js, lib/ …      lib/ keeps its layout (routes/, db/, providers/, subtitles/); discovery, auth, logger, settings go in lib/ too
│   │   ├── public/                built dashboard (generated, git-ignored)
│   │   └── bin/playpex-server.js  headless entry (start/stop, signals)
│   ├── server-desktop/          Electron supervisor: tray, autostart, updater, installers (electron-builder)
│   ├── dashboard/               dashboard SPA (§7), builds into apps/server/public
│   └── tv/                      the Angular 14 app (src/) + its Electron shell (electron/main.js; still boots the server until step 9), installer "Playpex TV"
├── packages/
│   ├── protocol/                OpenAPI spec, TS types of every API shape, discovery/pairing constants, apiVersion
│   └── client-sdk/              small TS SDK: base URL + token, typed calls, media URL builder, error mapping
├── build/                       scripts: fetch-node-runtime, fetch-ffmpeg (pinned versions + SHA-256), packaging
└── docs/                        plans, API guide for client authors (generated from the spec + prose)
```

- Each app has its own `package.json` (the server's lists only its runtime deps, so packaging copies a small `node_modules`).
- `apps/tv` keeps Angular 14 untouched for now. The dashboard is a separate app, so it can use a current framework without upgrading the TV UI (§12 D).
- The move is mostly `git mv` (step 0). `CLAUDE.md` files move with their code and their paths are updated.
- `.env` stays at the repo root (dev only); `apps/server/server.js` reads it from there.

## 5. Server core (`apps/server`)

### 5.1 Lifecycle and entry points
- `index.js` (next to `server.js`) exports `start(options) → Promise<{port, urls}>` and `stop()`. Nothing listens on `require`.
- `bin/playpex-server.js`: headless entry. Reads settings and env, calls `start()`, and on SIGINT/SIGTERM stops gracefully (sends the mDNS goodbye, closes HTTP, destroys engines).
- In the desktop edition the supervisor runs this same entry in a `utilityProcess` and receives status over `process.parentPort` messages (`{type:'status', port, streams, clients, …}`, `{type:'log', …}`).
- Uncaught exceptions are logged and the process exits with a code. The supervisor (or systemd/Docker) restarts it, with back-off.

### 5.2 Data locations
Keep `lib/paths.js` and the existing `Playpex` dirs, so today's `playpex.db` and profiles carry over. Add:
- `logs`: Linux `~/.local/state/Playpex/logs` (headless as a system service: `/var/log/playpex`), macOS `~/Library/Logs/Playpex`, Windows `%LOCALAPPDATA%\Playpex\Logs`.
- `downloads`: default `<cache>/torrent_data`, **configurable** in settings (§5.3).
- Headless system service: `/var/lib/playpex` for config and data (`PLAYPEX_CONFIG_DIR` / `PLAYPEX_CACHE_DIR` already exist).

### 5.3 Settings (`settings.json` in the config dir, edited from the dashboard)
Settings are read before the DB opens: port and download dir are needed first. Env vars override them, which Docker needs. The `.env` file stays a dev convenience only.

| Group | Settings |
|---|---|
| General | server name (default hostname), HTTP port (fixed, default **28470**, §5.9), discovery UDP port (28471), language of logs |
| Network | LAN sharing on/off (bind `0.0.0.0` vs `127.0.0.1`), discovery on/off, allowed CORS origins |
| Storage | download directory (writable + free-space check; torrents already running keep their dir), cache size limit, "delete after watching" (today's behavior, default) vs keep for N days |
| Streaming | max concurrent torrents (4), max concurrent transcodes (2), idle timeout (10 min), BitTorrent port range, upload rate limit |
| Providers | TMDB, OpenSubtitles, Wyzie, ThePornDB keys (masked in the UI, never returned in full by the API); enabled sources per kind |
| Security | admin password, pairing code rotation, trusted networks (optional "no pairing on this subnet") |
| Desktop only | start at login, check for updates (the supervisor owns these; the dashboard toggles them through the admin API → IPC) |

`GET/PUT /api/v1/admin/settings`. Changes that need a restart (port, bind) are flagged in the answer, and the dashboard offers "Restart server".

### 5.4 Logging (`lib/logger.js`)
- `pino` writes JSON lines to rotating files (`pino-roll`: daily rotation, 7 files, 10 MB each) and keeps an in-memory **ring buffer** of the last 2 000 entries for the dashboard.
- Replace `console.log` / `morgan` everywhere with child loggers per area (`torrent`, `provider`, `subtitles`, `ffmpeg`, `http`, `auth`, `discovery`). Requests log `deviceId`, method, path and status, never tokens or keys.
- `GET /api/v1/admin/logs?level=&area=&since=` returns the buffer; the events socket streams new lines live; `GET /api/v1/admin/logs/download` returns a zip of the files, useful for bug reports.

### 5.5 ffmpeg
- Ship ffmpeg + ffprobe per platform in the installer (`resources/ffmpeg/`). They are fetched at build time by `build/fetch-ffmpeg` from pinned **LGPL** builds with SHA-256 checks. LGPL is enough for our use (copy video, native `aac` encoder) and avoids GPL redistribution obligations. Licence texts go in the install dir.
- `lib/transcode.js` resolution order: setting → `FFMPEG_PATH` env → bundled → PATH. The dashboard shows which one is used and its version.

### 5.6 Torrent leases, limits, sessions
- Every client request carries its device (from the token, §6). `POST /api/v1/torrents` and every stream request **acquire or refresh a lease** `{hash, deviceId, lastActivity}`.
- `DELETE /api/v1/torrents/:hash` **releases** that device's lease. The engine and its data are destroyed only when no lease is left, after a 30 s grace period (and only if "delete after watching" is on).
- The client player sends `POST /api/v1/torrents/:hash/keepalive` every 60 s while open, so a paused video doesn't look idle. A **reaper** drops leases idle for longer than the idle timeout. This also fixes today's leak when a client crashes.
- Limits: past `maxTorrents` or `maxTranscodes`, the server answers `503 {error, code:'BUSY'}`.
- **Sessions** = what the dashboard's "Activity" shows: device, profile, title, file, play method (direct / audio transcode), position, torrent speed, peers, progress. Built from leases plus a `POST /api/v1/sessions/progress` the player already almost has: today's `PUT …/progress` resume calls can also update the live session. Admins can stop a session from the dashboard.

### 5.7 Discovery advertiser (`lib/discovery.js`)
Discovery only runs when LAN sharing is on, and discovery errors are logged but never crash the server.
1. **mDNS / DNS-SD**: advertise `_playpex._tcp.local` on the port actually bound. TXT record: `id=<server uuid> v=<apiVersion> ver=<version> name=<server name>`. Library: `bonjour-service` (pure JS). Android (NSD), iOS (Bonjour) and desktop clients can all browse this natively.
2. **UDP responder** on `28471`, a fallback for networks or Windows setups that filter multicast. A client broadcasts the datagram `PLAYPEX_DISCOVER 1`, and the server answers unicast with JSON `{id, name, port, apiVersion, version}`. Clients always broadcast to 28471. If it is taken on the server, only this fallback is lost: mDNS and manual entry still work, and the dashboard shows a warning.
3. Firewall: on Windows, the system's own "Allow access" prompt appears the first time the server listens on the LAN, with no installer rules (no admin rights, §8.2). On Linux deb/rpm, the post-install opens the ports if `ufw`/`firewalld` is active.

### 5.8 Network hardening
- Bind `127.0.0.1` when sharing is off, `0.0.0.0` when it's on.
- **Host check**: reject requests whose `Host` isn't localhost, a local IP, `<hostname>.local` or a configured name. This stops DNS-rebinding attacks from web pages.
- CORS allow list: the dashboard is same-origin, so it needs none. Allowed are `null` (TV client on `file://`), dev origins, and configured ones. CORS is not used for authorization.
- No state-changing `GET`: `GET /torrents/:hash/deselect` becomes `POST`.

### 5.9 Fixed port, changeable by the user
**28470/TCP** (HTTP: API, streams, dashboard) and **28471/UDP** (discovery). They sit in an IANA range that has never been assigned (28241–28588, checked against the IANA registry on 2026-10-16). They are below the OS ephemeral ranges (Linux 32768–60999; Windows/Hyper-V 49152+ and its excluded port ranges), so outgoing connections never grab them by accident. They are also clear of common neighbours: 9000 (PHP-FPM, Portainer, SonarQube), 8096 (Jellyfin), 32400 (Plex), 27015 (Steam game servers), 28015–28016 (Rust game servers). BitTorrent keeps its own range (6881+).

- **The port is fixed.** The server no longer slides to the next free port (today's 9000 → 9001 behavior is removed), so bookmarks, manually entered addresses and firewall rules stay valid.
- **If the port is taken at start:**
  - The server does **not** serve clients. It logs `PORT_IN_USE` (with the owning process when the OS tells us: `netstat`/`ss`) and enters **recovery mode**: the admin UI only, on an OS-assigned port, **loopback only**.
  - Desktop: the tray turns to the warning state ("Port 28470 is in use") and "Open dashboard" opens the recovery page: *Settings › Network* with the conflict explained and a port field (with a "Check" button that tries to bind it). Saving restarts the server on the new port.
  - Headless: the error and the recovery URL are printed to the log/journal. The port can also be changed without the dashboard: `playpex-server set-port 28480`, the `PLAYPEX_PORT` env (Docker), or editing `settings.json`.
- **Changing the port** (Settings › Network, any time): validated as 1024–65535, not in the Windows excluded ranges (`netsh int ipv4 show excludedportrange`, readable without admin), and free right now. The change applies after a restart, which the dashboard offers.
- **Clients follow automatically**: discovery advertises the actual port, and a paired client stores the server `id` and re-resolves its address/port via discovery when the saved URL fails. Manual entry in clients defaults to 28470 when no port is typed.
- Windows firewall: the allow-rule is tied to the executable, not the port, so changing the port needs no new prompt.

## 6. Protocol for all clients (`packages/protocol`)

The point of this section: **a new client can be written from the docs alone.**

### 6.1 API v1
- Every route lives under `/api/v1/`: torrents and streams too (`/api/v1/torrents`, `/api/v1/torrents/:hash/files/:path` …), not just today's `/api/*`. Old unversioned routes stay as aliases until the TV client has migrated (step 9), then they are removed.
- One error shape everywhere: `{ error, code }` with stable `code`s (`PAIRING_REQUIRED`, `BUSY`, `NOT_FOUND`, `UPSTREAM`, …).
- **OpenAPI 3.1 spec** (`packages/protocol/openapi.yaml`) is the source of truth. The TS types are generated from it, and so is `docs/api/` (served by the server at `/api/v1/docs`). A contract test checks the running server's responses against the spec.
- `apiVersion` is an integer, bumped only on breaking changes. Clients send `X-Playpex-Client: <name>/<version>; api=1`. The server refuses unsupported versions with `426 {code:'CLIENT_TOO_OLD'|'SERVER_TOO_OLD'}`.

### 6.2 Server info (no auth)
`GET /api/v1/server` → `{ id, name, version, apiVersion, minApiVersion, auth: 'pairing', features: { transcode, subtitles: [...], adult } }`. Clients probe this before pairing and after discovery. `id` is a UUID kept in `server.json`. Clients identify the server by `id`, not by IP, so DHCP changes don't break anything.

### 6.3 Pairing and auth (Plex-style "link a device")
- The server shows a **pairing code**: 6 digits that rotate every 10 minutes and are valid for one pairing each. It appears on the dashboard home page and in the tray menu (desktop). On a TV it can be entered with the remote, using the existing pin-pad.
- Client: `POST /api/v1/pair {code, deviceId, deviceName, platform, capabilities}` → `{ token, server }`. The token is 32 random bytes and is stored only as a SHA-256 hash in a new `devices` table `(id, name, platform, tokenHash, capabilities, createdAt, lastSeenAt, lastProfileId, revokedAt)`. The DB migration is generated with `npm run db:generate`. After 5 wrong codes from one IP, that IP is locked out for 30 s (429).
- Requests: `Authorization: Bearer <token>`. Media elements that can't set headers use `?access_token=` (Electron injects the header instead, §9.2). Without a token → `401 PAIRING_REQUIRED`.
- **Loopback** requests are trusted as an implicit "local" device, so a client on the server machine needs no pairing. The Host check and CORS still apply. Setting: "require pairing on this machine too".
- **Admin** (dashboard): a password is set in the first-run wizard and stored as a scrypt hash. Login sets an HttpOnly, SameSite=Strict session cookie. Admin routes are `/api/v1/admin/*`. A device token never grants admin.
- Profile PINs keep gating profiles inside the client, as today.

### 6.4 Real-time events
`GET /api/v1/events`: one WebSocket (`ws`, plain JSON messages, so any platform can consume it). Topics: `torrent.stats`, `session.*`, `server.status`; admin sessions also get `log`, `device.*`. This replaces the unused socket.io v2 server (`lib/socket.js`). The TV UI's current HTTP polling keeps working; moving it to events is optional.

### 6.5 Playback decision per client (Plex-like direct play / transcode)
Each client declares at pairing what it can decode, and can update it: `capabilities: { containers: ['mp4','mkv','webm'], video: ['h264','hevc?'], audio: ['aac','opus','mp3'], maxHeight: 1080 }`. A Chromium client can't decode AC-3/DTS; an Android TV with ExoPlayer can.
`GET /api/v1/torrents/:hash/files/:path/playback` → `{ method: 'direct'|'audio-transcode', url, duration, tracks }`. The server takes the decision that the TV player makes today (`probe` → `transcode`), using that device's capabilities. Until this exists, the TV client keeps its current logic; it's step 3b, not a blocker.

### 6.6 `packages/client-sdk`
A small TypeScript SDK used by the TV client and future JS clients: `createClient({baseUrl, token})`, typed calls generated from the spec, `mediaUrl(path)` (adds `access_token` where needed), and error mapping (`PAIRING_REQUIRED` → re-pair flow). Discovery isn't in it, because it needs platform APIs; the protocol constants are.

## 7. Dashboard (`apps/dashboard`)

Served at `http://<server>:<port>/`. The tray's "Open dashboard" opens it in the default browser. It's responsive (works on a phone) and has its own design (desktop web, not the 10-foot UI).

| Page | Content |
|---|---|
| **First-run setup** (only on loopback, until done) | server name, admin password, download directory (with free space), LAN sharing on/off, TMDB key (optional, with a link to get one) |
| **Overview** | status, version, uptime, port and LAN URLs, CPU/RAM of the server process, network in/out, disk free per download dir, ffmpeg found/version, provider health (last success/failure per provider), update available |
| **Activity** | live sessions: device, profile, title, play method, position, speed, peers, buffer. Stop session. Torrents without a session (grace period / leaked) |
| **Devices** | current pairing code (and "new code"), paired devices with platform, last seen, online now (open events socket or request in the last 60 s), capabilities. Rename / revoke |
| **Logs** | live tail with level and area filters, pause, search, download zip |
| **Storage** | download directories, size used per torrent, clear cache, "delete after watching" / keep N days |
| **Settings** | every group in §5.3; restart-required notice |
| **Profiles** (read-only first) | profiles on this server, PIN set yes/no, delete profile |
| **About** | versions, licences (ffmpeg LGPL, vendored libs), legal note |

Talks only to `/api/v1/admin/*`, `/api/v1/server` and the events socket. Built into `apps/server/public` and served with long cache headers and an SPA fallback.

## 8. Desktop server edition (`apps/server-desktop`)

### 8.1 The executable
- Electron is used **as a supervisor only**: no `BrowserWindow`. The server core runs in `utilityProcess.fork` (Electron's built-in Node 24, so there's no separate Node to ship). The installed app is "Playpex Media Server".
- `app.requestSingleInstanceLock()`: launching it a second time just opens the dashboard.
- **Tray menu**: status line ("Running · 2 streams · 3 devices" / "Stopped" / "Error"), Open dashboard, Pairing code: 482 913 (click to copy), Open downloads folder, Pause all downloads, Restart server, Start at login ✓, Check for updates, Quit. Tray icons per state; Windows `.ico`, macOS template image, Linux PNG (AppIndicator).
- **Start at login**: `app.setLoginItemSettings({openAtLogin, args:['--hidden']})` on Windows and macOS, and a `~/.config/autostart/*.desktop` entry on Linux. The installer turns it on by default (option in the setup).
- On the first launch it opens the dashboard's setup page in the browser.
- **Crash handling**: if the child exits unexpectedly, the supervisor restarts it with back-off (1 s, 5 s, 30 s). After 5 crashes in 10 min the tray shows Error and "Open logs".
- Auto-update via `electron-updater` (GitHub Releases). It never restarts during an active session: it asks in the tray, and the dashboard shows the update.
- macOS: hide the Dock icon (`app.dock.hide()`).

### 8.2 Installers (electron-builder)
| OS | Format | Notes |
|---|---|---|
| Windows | NSIS **per-user, no admin rights** (`perMachine: false`, no UAC prompt), installs to `%LOCALAPPDATA%\Programs\Playpex Media Server` | everything the install does stays in the user's space: Start-menu shortcut, start at login via `HKCU\…\Run` (`setLoginItemSettings`), data in `%APPDATA%`/`%LOCALAPPDATA%\Playpex`. Auto-updates also install without admin. **No firewall rules from the installer** (they need admin). Windows shows its own "Allow access" prompt the first time the server listens on the LAN; the first-run setup tells the user to tick *Private networks*. If LAN access was refused, the tray/dashboard offer **"Allow through firewall…"**, which runs one elevated `netsh advfirewall` command (UAC prompt only at that moment, only if the user asks). The uninstaller asks whether to keep data |
| macOS | dmg (+ zip for the updater) | signing + notarization needed for Gatekeeper (Apple Developer account); local network permission prompt on macOS 15+ for mDNS |
| Linux desktop | AppImage + deb | tray needs AppIndicator support (GNOME extension); autostart entry |

Bundled in `resources/`: ffmpeg/ffprobe, the server core, its production `node_modules`, the built dashboard.

## 9. Headless edition (Linux servers, NAS, Docker)

- **Tarball / deb / rpm**: contains `runtime/bin/node` (the official Node 24 binary, fetched and checksum-verified at build time by `build/fetch-node-runtime`), the server, production `node_modules`, ffmpeg and the dashboard. `bin/playpex-server` runs `runtime/bin/node apps/server/bin/playpex-server.js`. Nothing comes from the system.
- deb/rpm post-install creates a `playpex` system user, data in `/var/lib/playpex`, and a systemd unit `playpex-server.service` (`Restart=on-failure`). The setup URL is printed at the end of the install.
- **Docker**: `ghcr.io/…/playpex-server`, `node:24-slim` + ffmpeg, volumes `/config` and `/downloads`. `network_mode: host` is recommended for mDNS and incoming BitTorrent connections; in bridge mode, clients use the manual address.
- Headless first-run setup: the dashboard setup page is only allowed from loopback. Headless boxes can't open it locally, so the install prints a one-time **setup token** (also in the log) that unlocks the setup page from the LAN.
- Optional later: a single-file Node SEA build instead of `runtime/` + `node_modules`.

## 10. Playpex TV client (`apps/tv`)

### 10.1 Electron shell (no server)
`apps/tv/electron/`: `main.js` (window, mode), `preload.js` (`contextBridge` → `window.playpex`), `discovery.js` (mDNS browse plus UDP broadcast every 5 s while the picker is open; merged by server `id`, probed with `GET /api/v1/server`), `clientConfig.js` (`client.json` in its own `userData`: `deviceId`, `deviceName`, `lastServerId`, `servers{id → {name, url, token}}`, tokens encrypted with `safeStorage`), `auth.js` (`session.webRequest.onBeforeSendHeaders` adds `Authorization` and `X-Playpex-Client` to every request to the current server origin, including `<video>`, `<track>` and `fetch`, so the player needs no token in its URLs), and `power.js` (quit/sleep/shutdown/restart over IPC; **removes the `:3344` express app**).

### 10.2 Angular changes
- `ServerService` + an `InjectionToken`: `main.ts` resolves the server before bootstrap, from `window.playpex.connection.current()`, falling back to `localStorage` / `?server=` in browser dev. The 11 users of `STREAMING_SERVER` switch to it (`profiles`, `movies`, `adult`, `subtitles`, `library`, `imdb`, `torrent`, `releases` services, `youtube.component`, `player-page`). Calls go through `client-sdk` where it fits.
- **Switching server = store the choice + `location.reload()`**, so all catalogs, profiles and subscriptions start clean.
- `ServerGuard` sends the user to `/connect` when there is no server. The menu gets "Server: <name>". A lost-connection modal (after 3 network failures) offers Retry / Choose server.
- **`/connect` page** (movement system, 10-foot): "On this network" row (discovered servers, the local one first), "Enter address" (`text-keyboard`), "Rescan". Choosing a server that needs pairing opens the pin-pad for the pairing code shown on the server's dashboard/tray. If nothing is found, an explanation is shown: "Install Playpex Media Server on a computer in your home" plus the download URL.
- The player sends a keepalive (§5.6) and, once §6.5 exists, asks the server for the play method instead of deciding itself.
- Installer "Playpex TV" (electron-builder) contains no server deps, no ffmpeg, no torrent code. Its `userData` is separate from the server's dirs.

## 11. Implementation steps

Every step is shippable. The current all-in-one app keeps working until step 9.

| # | Step | Verify |
|---|---|---|
| 0 ✅ | **Monorepo**: npm workspaces, `git mv` into `apps/server`, `apps/tv`, empty `apps/dashboard`, `apps/server-desktop`, `packages/protocol`; split `package.json`s; TV Electron still requires the server via the workspace (temporary) | `npm run electron` unchanged; `npm run -w apps/server start` runs headless |
| 1 ✅ | **Server core basics**: `start/stop` + `bin/playpex-server.js`, `server.json` id, `settings.json` (+ env overrides; `.env` dev only), logger (files + ring buffer, replaces console/morgan), bind/Host check/CORS list, `POST` instead of state-changing `GET`, ffmpeg resolution order | headless start/stop; logs rotate; LAN `curl` refused when sharing off |
| 2 ✅ | **API v1 + protocol package**: `/api/v1` routes (old ones aliased), error codes, `GET /api/v1/server`, OpenAPI spec + generated types + contract test; TV client on `ServerService` + v1 | all TV flows (movie, episode, subtitles, transcode, 18+, watch list) |
| 3 | **Leases, reaper, limits, sessions** (+ 3b capabilities / playback decision, can trail) | two clients on one torrent; killed client cleaned up; `BUSY` on the limit |
| 4 | **Auth**: admin account + session, devices table + migration, pairing codes, tokens, loopback trust, events WebSocket | LAN request w/o token → 401; pair → works; revoke → 401 |
| 5 | **Dashboard MVP**: setup wizard, Overview, Activity, Devices, Logs, Settings, Storage | headless install fully configurable from a browser on another PC |
| 6 | **Desktop server edition**: supervisor + tray + autostart + single instance + crash restart; bundled ffmpeg; NSIS (firewall rules), dmg, AppImage/deb; auto-update | clean Windows VM with no Node/ffmpeg: install → tray → dashboard → play from a client |
| 7 | **Headless edition**: Node runtime fetch, tarball/deb/rpm + systemd, Docker image + compose, setup token | clean Debian VM / Docker: install, set up from LAN |
| 8 | **Discovery**: server advertiser (mDNS + UDP), firewall rules verified, discovery module for the TV client | server on another machine is found; after changing the server's port in Settings, a paired client reconnects by id; UDP fallback with multicast blocked |
| 9 | **TV client separation**: Electron shell without server, preload/IPC, header injection, `/connect` + pairing UI, lost-connection modal, own installer; remove old unversioned routes and `:3344` | fresh client install pairs with a server on the LAN; local server auto-connects without pairing |
| 10 | **Docs**: `docs/api/` client author guide (discovery, pairing, auth, streaming, capabilities), update all `CLAUDE.md` files (architecture, hard-coded values, commands per app) | a reviewer can sketch a client from the docs alone |

Step 0 notes (done 2026-10-16): `src/server/streamingServer` → `apps/server` (`@playpex/server`, `npm run server`), Angular app → `apps/tv/src`, `src/electron.js` → `apps/tv/electron/main.js` (`require('@playpex/server')`), `drizzle.config.js` → `apps/server`. Placeholder packages for `apps/dashboard`, `apps/server-desktop`, `packages/protocol`. Unused deps dropped: `serve-static`, `nodemon`, `ngx-electron`, `spatial-navigation-js`, `electron-compile`, `electron-squirrel-startup`, `electron-prebuilt-compile`. Verified: headless server answers, `ng build`, Electron app loads the UI and the server, movement specs (29), `db:generate` (no diff). Not verified: electron-builder / forge packaging (unverified before too; replaced in steps 6/9).

Step 1 notes (done 2026-10-16): `index.js` (`start`/`stop`), `bin/playpex-server.js` (+ `set-port`), `lib/settings.js`, `lib/logger.js`, `lib/identity.js` + `GET /api/v1/server` (pulled forward from step 2: the TV app uses it to reuse a running server), `lib/middleware.js` (Host check, CORS allow list + refusal of state-changing cross-origin requests), `lib/ffmpeg.js`; `deselect` is `POST`; socket.io servers (:9000 events, :9500 remote stub) no longer started, `morgan`/`cors`/`socket.io` removed from the deps (`lib/socket.js`, `lib/remoteSocketManager.js` deleted after step 2; plan §6.4's `ws` events socket replaces them). Deviations: **own logger instead of pino** (pino's file transports run in worker threads, fragile in packaged Electron/utilityProcess; same features: JSON lines, daily + 10 MB rotation, 7 files, ring buffer); **`lanSharing` defaults to off** until pairing exists (step 4); settings only list what is wired now (each later step adds its own keys); no recovery mode yet (it is a dashboard page, step 5): a taken port makes the headless server exit with `PORT_IN_USE` and a hint, and the TV app reuses a running Playpex server or falls back to a free loopback port. Not done: naming the process that holds the port. Verified headless (Host/Origin checks, loopback-only bind, LAN with `PLAYPEX_LAN_SHARING=1`, `set-port`, broken `settings.json`, graceful SIGINT, log file, a torrent added/streamed 206/deleted) and the TV app in its three start cases.

Step 2 notes (done 2026-10-16): every route on a `v1` router under `/api/v1` (`/api/v1/torrents`, `/movies`, `/shows/…`, `/imdb/…`, `/releases/…`, `/subtitles/…`, `/adult/…`, `/profiles/…`, `/youtube/…`); old unversioned paths rewritten onto it (`legacyAliases`, removed in step 9); errors always `{error, code}` (`lib/errors.js`, codes in `@playpex/protocol` `ERROR_CODES`, reusing the services' `INVALID`/`NOT_FOUND`/…); actions answer `{ok: true}`; optional `X-Playpex-Client` → 426. `packages/protocol`: `openapi.yaml` (46 paths), `types/api.d.ts` generated with openapi-typescript (committed, TS 4.7-compatible), `index.js` constants. Contract test `apps/server/test/contract.test.js` (node:test + ajv 2020): 36/56 operations offline, + 10 provider routes with `PLAYPEX_TEST_NETWORK=1`, all real 200s matching the spec. TV client: `ServerService` (`url`, `api`, `absolute()`, `info()`), all 11 users switched, `?server=<url>` for browser dev; verified in the app (profile → movie page: only `/api/v1` requests) and the stream/probe path with a public-domain torrent. Not done: serving the API docs at `/api/v1/docs` (step 10 writes the client guide), the TV client sending `X-Playpex-Client` (comes with Electron header injection, step 9; a custom header from `file://` would preflight every request), `packages/client-sdk` (§6.6, with a second JS client).

Rough size: 0–2 medium (mostly moving and renaming), 3–4 medium, 5 large (new app), 6–7 large (packaging, VMs on three OSes, signing), 8 medium, 9 medium, 10 small.

## 12. Decisions (all taken 2026-10-16: the bold option)

- **A. Desktop server host**: **Electron as a windowless supervisor** (Node 24 included, tray/autostart/updater/installers already known, ~100 MB) / bundled Node binary + a small native tray helper (lighter, but tray, updater and installers to build ourselves) / Tauri (Rust) launcher spawning bundled Node (light, adds a Rust toolchain).
- **B. Pairing**: **rotating 6-digit code shown in dashboard/tray, typed on the client** / approve a pending device in the dashboard / static server PIN.
- **C. Loopback trust**: **clients on the server machine need no pairing** / always pair.
- **D. Dashboard stack**: **current Angular (standalone components) in its own workspace** / Svelte or Preact + Vite (smaller, different from the TV app) / plain server-rendered pages.
- **E. Port** — *decided*: fixed **28470/TCP** + **28471/UDP**; no automatic fallback; the user changes it in Settings, the CLI or env when it is taken (§5.9).
- **F. ffmpeg builds**: **LGPL builds** / GPL builds (more encoders, GPL obligations).
- **G. TMDB for clients**: **move catalog calls behind the server (`/api/v1/catalog/*`, key in server settings, cached) in a follow-up after step 9**, so future clients don't embed a key / each client keeps its own key.
- **H. Installer scope on Windows** — *decided*: per-user, no admin rights (§8.2). The Playpex TV client installer follows the same rule.

## 13. Later

- Windows service mode (runs before login, no tray), like Plex's optional service.
- Web client served by the server (also fixes trailers: YouTube's IFrame player needs an `http://` origin).
- Android TV / mobile clients on the same protocol.
- Remote access outside the LAN (recommend an overlay like Tailscale over building relays).
- Keep-and-library mode (downloads kept as a media library, scanned and shown like Plex libraries).

## Legal note
Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Running it as a shared server does not change that.
