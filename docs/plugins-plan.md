# Plugins: packages, extension points, middleware, sandboxing (plan)

Status (2026-10-22; revised 2026-10-23: events, scheduled work, writes, source kinds, account linking, player markers, rate limits, a second reference plugin; unsigned packages only in developer mode; one audience rule; the 18+ end state with the player: no 18+ code in the core, a generic `tracking` policy, §7.1b; and again 2026-10-23: **setup only in the dashboard, clean clients** (goal 7), **repositories** and the rest taken from Kodi (§6, §11): dependencies, update policies, lifecycle, `play.resolve`, `library.match`, notifications, richer settings, translations): **P0, P0b, P2 and P3 done 2026-10-23, and P4's install part** (upload / URL / GitHub, preview, trust, enable, remove, rollback one back: `lib/plugins/install.js`, `/admin/plugins*`, the dashboard's Plugins page, `npm run pack:plugin`) (the contract, revised: dashboard-only setup, repositories, Kodi features; the sandbox host `apps/server/lib/plugins/` with the client routes; the hooks in Play, release lists, subtitles, the player and the library: `lib/play/plugins.js`, `lib/plugins/remote.js` (`r_…` refs), `POST /play/start`, `/play/markers`, `/plugins/meta`, the TV's picker, questions and "Skip intro"); **next P1 (TV templates), P3b (events, schedules, writes, links, notifications)** (the contract: `packages/protocol/plugin.schema.json`, `plugin-api.schema.json`, `plugins.js` / `plugins.d.ts` (`SERVER_PLUGIN_API` 1, `checkManifest`, `describePermissions`, `hostAllowed`, `LIMITS`), the reference manifests `plugins/adult/` and `plugins/trakt/`, `apps/server/test/plugins.contract.test.js`, the author guide `docs/plugins/`); P1–P7 not started; before that, nothing built beyond what the navigation and UI plans delivered (`defineScreen` with menu entries, slots and `defineContribution`, the compiled-in example `plugins-dev/hello/`, `docs/tv-plugins.md`). Read `docs/tv-plugins.md`, `docs/navigation-system-plan.md` §8 and `docs/ui-system-plan.md` §5.6 / §12 first. The play pipeline this plan hooks into is `docs/media-server-plan.md` §6.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.

## 1. Goals

1. **Third parties extend Playpex without forking it**: a section in the menu, screens, action tiles next to Play / Trailer, rows, meta, settings, and server-side behaviour.
2. **Middleware**: a plugin can change what a core feature does, not just add buttons: add sources to Play, reorder or filter them, add release providers, subtitle providers, metadata. Users see a plugin's options in Settings and decide.
3. **Plugins react and automate**, not only answer when asked: they observe what happens (playback, downloads, the library: §4.4), run on a schedule (§4.5), and, with permission, write the user's data (watch list, watched, downloads: §4.6). Scrobblers (Trakt, Simkl), notifications and "download the next episode" are the most common plugins of other media centres; they need exactly this.
4. **Sources beyond magnets**: a plugin's source can be an HTTPS stream (a debrid service, a NAS over WebDAV), played through the server like any other (§4.7); an account is linked with a code on the TV (§4.8), not by pasting keys.
5. **The 18+ section becomes a plugin** that the admin installs from the dashboard. The core keeps no 18+ code; the plugin uses only the public plugin API. Because 18+ has the core's own shape (a catalog plus torrents), it proves less than it seems: a **second reference plugin of another shape**, a Trakt scrobbler (§7.3), proves events, linking, writes and schedules.
6. **A malicious plugin can't harm the machine**: no file system, no processes, no secrets, no other plugin's data, network only to the hosts it declared, nothing on the TV beyond what the core renders for it.
7. **Setup lives in the server's dashboard; clients stay clean** (2026-10-23). Finding, installing, updating, enabling, configuring, granting, linking accounts and watching what a plugin does all happen on the dashboard's **Plugins** page (§6). Clients (Playpex TV and any other) have **no plugin management UI at all**: no Settings › Plugins, no permission prompts, no linking codes, no plugin errors. They only show what enabled plugins contribute for the current profile, drawn by their own templates: a menu section, screens, rows and tiles on core pages, sources in the picker, markers in the player, a toast.
8. **Repositories** (2026-10-23, from Kodi, §6.1): the admin adds repository URLs; the dashboard browses their signed indexes, installs with dependencies, checks for updates and installs them by policy. The official Playpex repository is built in.

Non-goals: paid plugins, plugins *of* the dashboard's own UI (a plugin's setup is rendered by the dashboard from its manifest, §6.3), plugin UI code running in the TV app in the first version (§5.4), **new media kinds** (music, podcasts, live TV with a programme guide, anime by absolute numbering as its own kind: the core knows movies, shows, episodes and other videos; a plugin maps what it has onto those, e.g. a `library.match` handler mapping absolute episode numbers to TMDB seasons, §4.3), inbound webhooks (nothing outside reaches a plugin; it polls on a schedule), skins / themes (the UI system's look is the core's), code libraries shared between plugins (Kodi's `script.module.*`: plugins bundle their libraries; plugins depend on each other only for what they *do*, §6.2), context menus on any card (Kodi's context items: a remote has no context key; title pages' action slots cover it).

## 2. Threat model

A plugin is code from someone we don't trust. What it must not reach:

| Asset | Where it lives | Risk if a plugin runs as normal code |
|---|---|---|
| The machine | server process (Node, the user's account) | read / write any file, spawn processes, install malware |
| Secrets | `<config>/auth.json` (server secret), `settings.json` (API keys), `playpex.db` (device tokens, PIN hashes), TV `client.json` (device tokens) | take over the server, impersonate devices, steal API keys |
| The LAN | the server's network position | scan / attack routers, NAS, cameras (SSRF) |
| User data | watch history, profiles, kids flags | leak what people watch |
| The TV client | renderer: `window.playpex` (power, connection, pairing), the shell adds the device token to every request to the server | shut the machine down, switch server, call the API as the device |
| Kids | profile `isKid` | show adult content to children |

Consequences for the design: plugin code never runs in the server's Node context nor in the TV's renderer; it runs in a sandbox that has **no ambient authority** and gets each capability through the host, checked against its manifest. Install is an admin decision with the permissions shown. The core, not the plugin, enforces audiences (kids).

## 3. Shape of a plugin

A **package** `<id>-<version>.ppx` (a zip; `yauzl` is already a dependency):

```
playpex-plugin.json      manifest
server.js                the plugin's code, one bundled file (esbuild), runs in the sandbox (§4)
assets/                  icons (SVG), images, screenshots; served by the host at /plugins/<id>/assets/*
i18n/<locale>.json       optional: translations of the manifest's and the plugin's strings (Kodi's strings.po)
CHANGELOG.md             optional: shown by the dashboard on install and update (Kodi's <news>)
signature                optional: ed25519 over the manifest + files' hashes (§6)
```

```jsonc
{
  "id": "adult",                         // [a-z][a-z0-9-]{1,31}; the namespace of everything it defines
  "name": "18+",
  "version": "1.0.0",
  "publisher": { "name": "Playpex", "key": "ed25519:…" },
  "api": { "server": "^1", "nav": "^1", "ui": "^1" },       // ranges of SERVER_PLUGIN_API, NAV_API_VERSION, UI_API_VERSION
  "audience": "adults",                  // everyone | adults: never offered to kids profiles, never over DLNA
  "listing": {                           // what the dashboard's catalog shows (Kodi's xbmc.addon.metadata)
    "summary": "Adult films: a catalog and releases ranked by seeders.",
    "description": "…", "disclaimer": "…", "license": "MIT",
    "source": "https://github.com/…", "categories": ["catalog", "sources"],
    "screenshots": ["assets/shot-1.jpg"], "fanart": "assets/fanart.jpg"
  },
  "requires": [ { "id": "debrid-resolver", "version": "^1", "optional": true } ],   // §6.2
  "permissions": {
    "network": ["apibay.org", "therarbg.to", "api.theporndb.net", "api.themoviedb.org"],
    "storage": "10MB",                   // its own key/value store
    "secrets": ["theporndbApiKey"],      // values the admin enters, given to this plugin only
    "play": true,                        // may hand play requests (magnets) to the core
    "hooks": ["play.collect", "releases.providers"]
  },
  "contributes": {
    "sections": [ { "screen": "browse", "menu": { "label": "18+", "icon": "assets/seal.svg", "order": 50 } } ],
    "screens":  [ { "name": "browse", "template": "catalog", "data": "browse" },
                  { "name": "title",  "template": "title",   "data": "title" },
                  { "name": "releases", "template": "releases", "data": "releases" } ],
    "slots":    [ { "slot": "core.search.filters", "data": "searchFilter" } ],
    "settings": [ { "key": "layout", "scope": "profile", "type": "choice", "label": "Layout",
                    "options": [["posters","Posters"],["compact","List"]], "default": "posters" } ],
    "chrome":   { "accent": "adult" }
  }
}
```

Everything in `contributes` is **data**: the core reads it without running plugin code. Only `"data"` names point into `server.js`, which answers through the host.

The **permissions** a manifest can ask for, each shown to the admin in words at install (§6):

| Permission | Grants | Shown as |
|---|---|---|
| `network: [hosts]` | `http.request` to those hosts (§4.2) | "Talks to apibay.org, …" |
| `storage: "<size>"` | its own key/value store | "Keeps up to 10 MB of its own data" |
| `secrets: [names]` | values the admin enters | "Asks for: ThePornDB API key" |
| `play: true` | hands play requests to the core (effects, §5.3) | "Can start playback" |
| `sources: ["magnet", "http"]` | the kinds of source its `play.collect` may return (§4.7); `http` also needs the stream's hosts in `network` | "Adds torrents / streams from the web to Play" |
| `hooks: [names]` | middleware stages (§4.3) | "Changes the sources of Play", … |
| `events: [families]` | observing `playback`, `downloads`, `library`, `watchlist` (§4.4) | "Sees what you watch" (`playback`), … |
| `schedule: true` | jobs on a timer (§4.5) | "Runs in the background" |
| `write: [scopes]` | `watchlist`, `watched` (progress + history), `ratings`, `downloads` (§4.6) | "Can change your watch list", "Can add downloads", … |
| `link: [names]` | account linking flows (§4.8) | "Links your Trakt account" |
| `library: true` | reading the library's metadata (§4.2) | "Sees what's on this server" |
| `files: true` | the names (relative paths) of library files, for `library.match` (§4.3); never their content or full path | "Sees the names of your video files" |
| `notify: true` | `notify.send` (§4.10): short messages to the profiles' clients | "Can show you notifications" |

`events.playback` and every `write` scope are **personal**: besides the admin's grant at install, each profile is switched on for them **in the dashboard** (Plugins › <name> › Profiles, off until switched on; decision G, revised), and a profile that isn't is never seen by the plugin's events nor written by it.

**Strings** a user reads (labels, settings, listing) may be `"@key"` references into `i18n/<locale>.json` (`en` required when any is used); the dashboard and clients pick the locale, a missing key falls back to `en`. Handlers get `ctx.locale` and `playpex.i18n.t(key, vars)` for their own strings.

## 4. Server side: the sandbox

### 4.1 Runtime

Each enabled plugin runs `server.js` in a **QuickJS interpreter compiled to WebAssembly** (`quickjs-emscripten`), one runtime per plugin, inside a worker thread of the server (decision A):
- no `require`, no `process`, no `fs`, no `fetch`, no timers except the host's: the only globals are the language and the `playpex` host object (§4.2). WASM memory can't reach the host's.
- **limits** per runtime: memory (`setMemoryLimit`, 64 MB default), stack, CPU per call (an interrupt handler stops a call after 2 s of execution; the host call it was serving answers its timeout), concurrent calls (4).
- a runtime that crashes, runs out of memory or times out repeatedly is **disabled** (state `failed`, dashboard shows why), the rest of the server is unaffected.
- npm libraries that are plain JS (parsers, `cheerio`-like HTML parsing) work when bundled into `server.js`; Node built-ins don't exist. HTML parsing in an interpreter is the costly part: P2 measures a real page (an apibay / TheRARBG answer) against the 2 s CPU limit before the limit is fixed.
- **Async host calls are promises, not asyncify**: the host API returns promises the host creates in the runtime (`newPromise`, resolved when the worker's real call ends; the job queue pumped with `executePendingJobs`). The asyncify build of `quickjs-emscripten` allows only one suspended call per module, which can't serve 4 concurrent calls, and is slower; the sync build with host promises serves them all.

### 4.2 Host API (`SERVER_PLUGIN_API` 1)

Async functions on `playpex`, each checked against the manifest and logged with the plugin id:

| API | Capability |
|---|---|
| `http.request({ url, method, headers, body, responseType })` | HTTPS only, host must match `permissions.network` (exact or `*.domain`), **resolved addresses must be public** (no loopback, private, link-local, multicast; checked after DNS and on every redirect: SSRF), 10 s timeout, 8 MB response cap, no cookies jar shared with anything, no `Authorization` the plugin didn't set. `responseType` `text` (default) · `json` · `bytes` (a `Uint8Array`: `.torrent` files, archives; a request `body` may be bytes too). **Rate limited** per plugin and host (default 2 requests/s, burst 10, at most 4 in flight; a manifest may ask for less, never more): over the limit the call waits, past 10 s waiting it fails with `RATE_LIMITED`. A plugin hammering a site would get the user's IP banned, so this is not optional |
| `store.get / set / delete / list(prefix)` | its own rows in `plugin_store` (quota from the manifest) |
| `secrets.get(name)` | values the admin entered for names in `permissions.secrets` (encrypted at rest like other keys) |
| `settings.get(key, ctx)` | its own settings (`plugin.<id>.<key>`, settings plan §4), for the request's profile (server scope when the context has none) |
| `tmdb.*` (read-only subset), `imdb.title/episodes`, `library.find(ref)` | core data a plugin may read; `library` needs `permissions.library` |
| `i18n.t(key, vars)` | its own strings in `ctx.locale` (§3) |
| `notify.send(profileIds \| 'all', { text, tone })` | notifications (§4.10), needs `permissions.notify` |
| `plugins.call(id, name, args)` | a data handler another plugin **exports** (§6.2), only plugins named in its `requires` |
| `log.info / warn / error` | into the server log, tagged |
| `hooks.on(name, handler)` | middleware (§4.3), only names in `permissions.hooks` |
| `events.on(name, handler)` | observing the core (§4.4), only families in `permissions.events` |
| `schedule.every(name, interval, handler)` / `schedule.cancel(name)` | background jobs (§4.5), needs `permissions.schedule` |
| `watchlist.*`, `watched.*`, `ratings.*`, `downloads.add / list` | writing the user's data (§4.6), only scopes in `permissions.write`, only for profiles granted them (§3) |
| `link.start(name) / status(name) / clear(name)` | account linking (§4.8), only names in `permissions.link` |
| `data(name, handler)` | answers for the screens / slots / actions named in `contributes` (§5) |

Never available: the DB, other plugins (but their declared exports), devices, auth, settings.json, the file system (library files are served by the core by media ref, the plugin only sees metadata), process / OS info, arbitrary ports.

Every handler gets a **context** built by the host: `{ profile: { id, kids }, device: { id, name }, locale }` (no tokens, no names of other profiles). For `audience: adults` plugins, requests from kids profiles never reach the plugin at all.

### 4.3 Hooks (middleware)

Named stages of core features, each with a JSON schema for input / output, an order, a timeout and a failure rule (a failing handler is skipped, never fails the feature):

| Hook | Input → output | Used for |
|---|---|---|
| `play.collect` | title (kind, tmdb / imdb ids, season / episode) → `Source[]` | add sources: another torrent site, a debrid service, a NAS index |
| `play.rank` | `Source[]` + the profile's options → `Source[]` (reordered / filtered, each with a reason) | "always 1080p", "prefer small files", "never HEVC" |
| `play.before` | the chosen source → `continue` · `ask(question)` · `refuse(reason)` | confirmations, parental rules |
| `releases.providers` | kind + query + filters → releases page | release lists (Find releases, the 18+ list) |
| `subtitles.providers` | ids + languages → subtitles (URLs on declared hosts, fetched by the core) | subtitle sites |
| `metadata.title` | title ids → `MetaItem[]` / extra fields | another score, tags |
| `player.markers` | the playing title (ids, season / episode, duration, the file's name and size) → `Marker[]`: `{ kind: 'intro' \| 'recap' \| 'credits' \| 'chapter', start, end, label? }` | skip intro / recap ("Skip intro" button drawn by the core's player), credits (Up next starts there instead of the last 40 s), chapters on the timeline |
| `play.resolve` (2026-10-23, Kodi's resolvers) | `check`: info hashes of the collected torrent sources → which ones it can serve (`{ hash: { cached, label } }`, one batched call per Play); `resolve`: the chosen magnet / torrent source (+ the file) → an `http` source, or null | **debrid** (Real-Debrid, AllDebrid, Premiumize: a torrent their cache already has plays at once over HTTPS, no swarm, no download on the server). The picker shows "Cached on Real-Debrid" from `check`; `resolve` runs only when the user picks that source, and its `http` source plays through the `r_…` proxy (§4.7). Needs `sources: ['http']`. Any plugin's or the core's torrent sources can be resolved: resolvers and source plugins don't need to know each other |
| `library.match` (2026-10-23, Kodi's per-source scrapers) | a library file the core parsed: `{ relPath, parse, nfo ids, folder kind }` → an identity on the core's kinds (`movie` + tmdbId · `episode` + show tmdbId, season, episode) or null | anime by absolute numbering, a site's own naming, a language's titles. The admin picks it per library folder (dashboard › Library › folder › "Information provider": Playpex (TMDB, default) or a plugin's matcher), like Kodi's scraper per source; the core keeps its rules as the fallback when the plugin answers null, and the admin's own match always wins. Needs `files: true` |
| `metadata.artwork` (later, P7) | title ids → logos, clear art, other posters | fanart.tv-like artwork providers |

The core's own features are written as handlers of the same stages (the library, YTS, EZTV / TheRARBG in `docs/media-server-plan.md` §6), so the pipeline is exercised every day. A plugin can't remove the core's handlers; it can only add, and in `play.rank` reorder or drop sources with a reason the picker shows ("Hidden by <plugin>: HEVC").

**Options** are how the admin steers middleware: a plugin's `contributes.settings` are rendered by the **dashboard** from the manifest (Plugins › <name> › Settings: `server` scope; › Profiles › <profile>: `profile` scope, one column per profile). Clients never show them (goal 7). Handlers read them with `settings.get`. Borrowed from Kodi's `settings.xml` (2026-10-23): settings are grouped (`group`), have a `level` (`basic`, default, or `advanced`: hidden behind "Show advanced"), may depend on another (`visibleIf: { key, equals }`, `enabledIf`), and a setting of type **`action`** is a button calling a data handler with the effects it answers shown in the dashboard ("Test connection", "Clear cache", "Sync now").

### 4.4 Events (observe only)

Hooks change what a feature does; **events** tell a plugin what happened, after the fact. A handler can't change or delay anything (the core doesn't wait for it), its failure is logged and counted, nothing more. Delivery is **at most once, in order per plugin** (a queue of 100 per plugin; when full, the oldest are dropped and the next event carries `dropped: n`); a plugin that must not miss anything reconciles on a schedule (§4.5), as scrobblers do anyway.

| Family | Events | Payload (besides the context: profile, device) |
|---|---|---|
| `playback` | `playback.started`, `playback.progress` (every 60 s, with the keepalive, and on pause / seek), `playback.paused`, `playback.ended` (left, with the last position), `playback.finished` (≥ 90 %, the rule "watched" uses) | title ref (kind, tmdb / imdb ids, season / episode), position, duration, source kind (file / download / torrent / plugin) — never the magnet, path or ref |
| `downloads` | `download.added`, `download.completed`, `download.removed` | title ref, name, size, state |
| `library` | `library.changed` (titles added / removed, by title ref) | title refs |
| `watchlist` | `watchlist.added`, `watchlist.removed`, `watched.set`, `watched.cleared`, `rating.set` (made by the user or by another plugin, with `by`) | title ref, rating |

`playback` events of a profile reach a plugin only if the admin granted it for that profile (§3); kids profiles never reach `audience: adults` plugins; nothing watched in an `adults` plugin's screens is ever sent as an event to other plugins (the core's rule "nothing watched there is saved to the profile" holds for events too). Events are the core's own internal bus (`lib/events`, the one the WebSocket `/events` already reads), filtered by the host, so the core can't forget to emit one for plugins.

### 4.5 Scheduled work

`schedule.every('sync', '15m', handler)`: the host calls `handler(ctx)` on that interval while the plugin is enabled (minimum 5 min; jitter of 10 %; never two runs of the same job at once; a run that is still going when the next is due skips it). The first run comes one interval after start, unless `{ atStart: true }` (then 1 min after the server is up, after the library's first scan). Jobs survive restarts (they're declared again when `server.js` loads) and stop with the plugin. A job's context has **no profile**: it acts for each profile granted its personal permissions, through `ctx.profiles()` (ids and kids flags of those profiles only). Each run counts against the CPU limit like any call (2 s of CPU, waiting for HTTP doesn't count; a run's total wall time is capped at 5 min). The dashboard shows each job's last run, duration and error.

### 4.6 Writes

With `permissions.write`, a plugin writes the user's data through the core's services (so every rule of the core applies: kids, adults-only, events), only for profiles granted them (§3):

| Scope | Calls |
|---|---|
| `watchlist` | `watchlist.add(profileId, titleRef)`, `remove`, `list` |
| `watched` | `watched.set(profileId, titleRef, { at })` (history + watched mark), `clear`, `progress.set(profileId, titleRef, position, duration)` (resume points: only if newer than the core's) |
| `ratings` | `ratings.set(profileId, titleRef, value)`, `clear` |
| `downloads` | `downloads.add({ magnet \| url, title })` (the core's admission rules and `downloads.maxActive` apply; added by `plugin:<id>`), `downloads.list()` (its own only) |

Every write is recorded with `by: 'plugin:<id>'` (the dashboard's plugin activity, the TV's "Marked watched by Trakt" where a mark shows its origin) and emitted as an event with `by`, so two syncing plugins don't loop on each other's writes (a plugin's own writes never come back to it). Never available: deleting profiles, history wholesale, other plugins' downloads, anything of a profile not granted the scope. `audience: adults` plugins have no `write` scopes but `downloads` (their titles aren't the profile's).

### 4.7 Sources

`play.collect` returns `Source`s of the kinds in `permissions.sources`:

| Kind | What the plugin gives | How it plays |
|---|---|---|
| `magnet` | a magnet or info hash (+ the file's index or name) | as the core's torrents: `POST /torrents`, leases, pause on leave |
| `http` | an HTTPS URL to a file (a debrid service's link, a WebDAV file), its size, container, codecs if known, headers to send (e.g. a token: kept on the server) | a new media ref kind `r_…` (`docs/media-server-plan.md` step 3 has `t_` torrents and `f_` files): `GET /media/r_…` is **proxied by the server**, with `Range` passed through, the URL's host checked against the plugin's `network` and the SSRF rules on every request and redirect; the client never sees the URL. ffprobe and the AC-3 → AAC transcode work on it as on a file. A ref expires with its source (1 h, refreshed by `play.collect` again on Resume) |
| `hls` (later, P7) | an HTTPS `.m3u8` | the server rewrites the playlists so segments go through the same proxy; needs `hls.js` in the player (Chromium plays no HLS by itself). Not before a real plugin asks |

Sources from plugins go through `play.rank` / `play.before` like the core's, carry the plugin's `notes` (the picker shows "From Real-Debrid"), and are never autoplayed over a file on this server.

### 4.8 Account linking

Services like Trakt, Real-Debrid or Simkl link an account with a **device code** (the same RFC 8628 flow the TV uses to pair). A manifest declares the flow, the host runs it, the plugin never sees the user typing anything:

```jsonc
"link": [{ "name": "trakt", "label": "Trakt", "scope": "profile",          // profile | server
           "deviceCode": { "codeUrl": "https://api.trakt.tv/oauth/device/code",
                           "tokenUrl": "https://api.trakt.tv/oauth/device/token",
                           "clientIdSecret": "traktClientId", "clientSecretSecret": "traktClientSecret" } }]
```

On the **dashboard** (Plugins › <name> › Accounts: one row per profile for `profile` scope, one for `server` scope; never on a client, goal 7), "Link" shows the code, the URL and a QR (the person whose account it is enters the code on their phone, as with any TV app), the host polls the token URL, stores the tokens with the plugin's secrets (per profile for `profile` scope) and refreshes them; the plugin reads them with `link.status(name, profileId)` → `{ linked, accessToken, expiresAt }` and sends them itself (its `network` must name the API's host). Services without a device flow declare a link with `custom: '<data name>'` instead of `deviceCode`: on "Link" the dashboard calls that handler, which answers `{ code, url, qr?, poll: '<data name>' }` (or a form: fields to fill, e.g. an API key a service shows on its account page), and the dashboard shows it and calls `poll` every 5 s until it answers `done` or `failed`. Unlink deletes the tokens. A client that needs a linked account it doesn't have just shows the plugin's empty state ("Not linked yet: ask the server's admin"), written by the plugin's handler.

### 4.9 Routes

The host mounts `/api/v1/plugins/{id}/data/{name}` (POST, JSON in / out ≤ 1 MB) for the `data` handlers, behind the usual auth (`requireClient`), with the context of §4.2, rate limited per device. Plugin assets at `/api/v1/plugins/{id}/assets/*` (static, from the package, `Content-Type` from a fixed list, `X-Content-Type-Options: nosniff`, SVG served with a CSP that blocks scripts). `GET /api/v1/plugins?profile=` lists, for clients, only what they render: the plugins enabled **for that profile** with their screens, sections, slots, chrome and asset base (filtered for kids profiles); never permissions, settings, links, repositories or states (that's `/admin/plugins*`, §6.3). A plugin disabled, broken or failed is simply absent.

### 4.10 Notifications

`notify.send(profileIds | 'all', { text, tone, key? })` (needs `notify`; Kodi services' notifications): a short message (≤ 120 characters, `info` / `success` / `error`) the clients of those profiles show as a toast the next time they're open, sent as the event `plugin.notification` on the events socket and kept 24 h for clients that weren't connected (one per `key`, the newest wins). Rate limited (10 per hour per plugin and profile); never to kids profiles for `adults` plugins; the dashboard's plugin activity counts them. Used for "Downloaded: The Bear S03E02", "Trakt: 3 titles added to your watch list".

## 5. TV side: declarative, rendered by the core

### 5.1 Why declarative

Plugin JS in the TV renderer would have the device's token (the shell adds it to every request to the server), `window.playpex` (power, connection, pairing) and the DOM of every page. So in this plan **no plugin code runs in the TV**: a plugin describes screens and contributions, the server-side plugin supplies the data, and the core renders them with its own layouts and primitives. That also gives every future client (and the dashboard) the plugin for free, and keeps the look and the movement consistent.

### 5.2 Screen templates

The core adds a few generic screens, built from the UI system's layouts, that a manifest can instantiate (`plugin.<id>.<name>`, path `p/<id>/<name>`, as `defineScreen` already requires):

| Template | Built from | Data handler answers | Covers |
|---|---|---|---|
| `catalog` | `px-section-layout`, toolbar (search field, filters button), `px-title-info` of the focused card, `px-card-row`s (paged) | rows (`RowModel` with paged sources), title info per card, filter groups | 18+ posters, any catalog |
| `title` | `px-detail-layout`, `px-title-info`, `px-action-bar`, rows | `TitleInfoModel`, actions, rows | 18+ title page |
| `releases` | `px-rail-layout`: rail (back link, search, source / quality chips, switches), the release list | release rows, providers, filters | Find releases-like lists, the 18+ list |
| `list` | `px-section-layout` + a `pxGrid` of `px-option`s | items with label / meta / intent | simple menus, folders |

No `settings` template (removed 2026-10-23, goal 7): a plugin's options are set in the dashboard. A choice that changes what one screen shows (the 18+ posters / list layout, a sort) is offered **on that screen** as one of its filters (the toolbar's filter groups, remembered per profile like any filter), which is content, not setup.

These are generalisations of screens the core already has (the 18+ browse / title pages, `ReleasesPageComponent`, the watch list), so step P1 is mostly extracting them.

### 5.3 Effects

A data handler or an action never runs code in the TV; it answers **effects** the core performs: `open(intent)` (a plugin or core screen), `play(request)` (needs `permissions.play`; the core's player, so leases and progress rules apply; `tracking: 'none'` is forced for `audience: adults` plugins, §7.1), `toast(text, tone)`, `refresh(slot | screen)`, `confirm(question) → then effect`, `download(request)` (needs `write: ['downloads']`; the core's Download flow and its toast). An action model gets `call: '<data name>'` besides `intent` / `run`, so a tile next to Play / Trailer calls the plugin and the core performs what comes back.

**Audience, one rule.** For packaged plugins the manifest's `audience` is the only mechanism: the remote adapter (§5.5) marks every screen, slot contribution and menu entry of an `audience: adults` plugin `adult: true`, so kids profiles get none of it, and the server never sends such a plugin a kids profile's request or event. A plugin can't declare a single contribution adult inside an `everyone` plugin: a plugin with both kinds of content is an `adults` plugin, or two plugins. The per-contribution `adult: true` of `defineContribution` stays only in the compiled API (§5.5), for the core's own contributions while 18+ is still in the core.

### 5.4 Custom UI (later, decision B)

If a plugin needs its own UI, the only acceptable form is a **sandboxed iframe** (`sandbox="allow-scripts"`, opaque origin, a strict CSP, no `window.playpex`) talking to the core over `postMessage` with the same effects, and the Electron shell must stop adding the device token to its requests (`apps/tv/electron/auth.js` filters by URL today; it would have to filter by frame). Focus and keys across the iframe boundary are their own problem. Not in this plan's steps.

### 5.5 The compiled API stays

`defineScreen` / `defineContribution` (`nav/public-api.ts`, `ui/public-api.ts`) remain the core's own way in and the API the templates use. They are **not** the third-party plugin API: a packaged plugin is a manifest plus `server.js` and never ships Angular code (decision B); `docs/tv-plugins.md` (compiled-in Angular plugins) describes the core's internal extension API and development plugins, and says so at its top. The TV gets a **remote plugin adapter** (`src/app/plugins/remote.ts`): on start (and on `plugin.*` events) it reads `GET /plugins`, defines each manifest's screens with the template components and its slot contributions as functions that call `/plugins/{id}/data/{name}`; uninstalling removes them (`CONTRIBUTIONS.remove`, a registry `undefine` for screens: new, with `router.resetConfig`).

## 6. Install, trust, updates: the dashboard

Everything about a plugin's life is the admin's, on the dashboard's **Plugins** page (goal 7); clients only ever see the result (§4.9). This section borrows Kodi's add-on manager (repositories, dependencies, update policies, origin pinning, lifecycle flags, rollback to any version, changelogs), with signatures Kodi doesn't have.

### 6.1 Repositories

A **repository** is an HTTPS URL to a signed index (Kodi's `addons.xml` + its repository add-on, as plain data):

```jsonc
// https://plugins.example.org/index.json   (+ index.json.sig: ed25519 over the file's bytes)
{
  "repository": { "id": "example", "name": "Example plugins", "key": "ed25519:…", "homepage": "https://…" },
  "generatedAt": "2026-10-23T10:00:00Z",
  "plugins": [{
    "id": "trakt", "name": "Trakt", "listing": { … },                 // the manifest's listing, for the catalog
    "versions": [{
      "version": "1.2.0", "url": "https://…/trakt-1.2.0.ppx", "sha256": "…", "size": 48213,
      "api": { "server": "^1", "nav": "^1", "ui": "^1" }, "audience": "everyone",
      "permissions": { … }, "requires": [ … ],                       // the manifest's, to show before downloading
      "lifecycle": "stable",                                          // stable | deprecated (+ "replacedBy") | broken (+ "reason")
      "releasedAt": "2026-10-20", "changelog": "…"
    }]
  }]
}
```

- **Built in**: the official Playpex repository (its URL to decide before P4b, e.g. a static site with the signed index; its key ships with the server; holds the first-party 18+ and Trakt plugins). The admin can turn it off, never edit its key.
- **Adding one**: Plugins › Repositories › Add, paste the URL; the dashboard fetches the index, shows its name and **key fingerprint**, and the admin trusts it (trust on first use: the key is pinned; a later index signed by another key is refused until the admin accepts the new key, with a warning). A repository can also be installed from a `.ppx` of type `repository` (a manifest with `repository` instead of `server.js`), as Kodi does, so a publisher can ship "add my repo" as one file.
- **Trust**: a package from a repository is trusted when the index that lists it is signed by the pinned key **and** the package's sha256 matches (the index is the signature: per-package signatures become optional). An uploaded `.ppx` (no repository) needs its own signature by a trusted publisher key, or developer mode (decision C).
- **Origin pinning** (Kodi 19's "update from: origin repository"): a plugin remembers the repository it came from and is updated only from there. Another repository offering the same id can't take it over; the admin can move a plugin to another origin explicitly (shown as a new install: permissions, publisher, key).
- **Refresh**: indexes are fetched every 24 h (jitter), on the dashboard's "Check now", and at start after 5 min; cached with `ETag`; a repository that fails keeps its last good index (shown as stale with the error). Fetched by the server's own HTTP client (HTTPS only, public addresses, 4 MB cap).
- **Catalog**: Plugins › Browse lists every plugin of the enabled repositories (search, categories from `listing.categories`: catalog, sources, subtitles, metadata, library, tracking, notifications…, audience filter, "installed" marks); a plugin's page shows its listing (summary, description, screenshots, disclaimer, license, source link), the publisher and repository, the versions with changelogs, **every permission in words** and what it needs (`requires`). Plugins that don't fit this server (API ranges) are listed greyed with the reason.

### 6.2 Dependencies

`requires: [{ id, version, optional? }]` (Kodi's `<requires><import>`), for what plugins **do**, not shared code (plugins bundle their libraries; no `script.module`): a source plugin that works best with a debrid resolver, a list plugin built on a linked account another plugin manages.

- **Install resolves them** from the plugin's repository first, then the other enabled ones (same id, compatible version, trusted); the dashboard shows the whole set with the permissions of each before one consent. Missing required ones block the install; missing optional ones are offered.
- **Calls between plugins** only through **exports**: a plugin lists data handlers in `exports: [names]`; a plugin that `requires` it may call them with `playpex.plugins.call(id, name, args)`. The call runs in the callee's sandbox with the callee's permissions and the caller's context (profile), and goes through the callee's audience rule; the caller gets the answer, nothing else. Never a way to borrow another plugin's permissions (decision I).
- Disabling or removing a plugin others require asks first (and lists them); a required plugin disabled → its dependents are disabled with the reason; optional → they keep working without it.

### 6.3 The Plugins page

| Tab | What |
|---|---|
| **Installed** | each plugin: icon, name, version, origin, state (`enabled`, `disabled`, `update available`, `needs consent` (an update grew its permissions), `deprecated`, `broken`, `failed` (the sandbox stopped it: why)), enable switch |
| **Browse** | the repositories' catalog (§6.1) |
| **Updates** | available updates with their changelogs and permission differences; "Update all" (those without new permissions) |
| **Repositories** | the list (name, URL, key fingerprint, last refresh, error), add / remove / enable, "Check now" |
| **Developer** | developer mode (decision C), upload a `.ppx`, publisher keys trusted for uploads, reload a plugin from a folder (`<config>/plugins-dev/<id>/`, unsigned, developer mode only) |

A plugin's own page: **Overview** (listing, version, origin, `requires` / required by, changelog), **Permissions** (granted, in words; a grown set to accept), **Settings** (`server` scope, rendered from `contributes.settings`: groups, levels, conditions, `action` buttons), **Profiles** (per profile: enabled, the personal permissions (`events.playback`, `write.*`), its `profile`-scope settings; kids profiles absent for `adults` plugins, and the admin can hide any plugin from kids), **Accounts** (links, §4.8), **Activity** (requests per host, rate-limit waits, writes per scope, events received / dropped, notifications, jobs with last run / duration / error, errors, CPU time; its log lines filtered from Logs), **Versions** (install any version the origin lists, the previous one kept locally for an offline rollback), and **Remove** / **Clear data**.

### 6.4 Updates, lifecycle, removal

- **Update policy** (Kodi's "Updates: install automatically / notify / never"): server-wide `plugins.updates` = `auto` (default) · `notify` · `never`, overridable per plugin (Kodi's per add-on auto-update). `auto` installs only updates with **no new permissions**; a version whose permissions grow (a new host, a new hook, events, a write scope, notify) is downloaded and waits in Updates as `needs consent`, the running version stays. A grown personal permission stays off for every profile until the admin switches it on in Profiles.
- **Lifecycle** from the index: `deprecated` shows a warning and the replacement (`replacedBy`, one click to install it and move its settings when it declares `migratesFrom`); `broken` disables the plugin with the reason (the admin can't re-enable it until a fixed version arrives) and offers that version when it does. An index that drops a plugin leaves the installed copy alone (shown as "no longer in its repository").
- **Rollback**: the previous version stays in `<config>/plugins/<id>/` (one back); any older version the origin lists can be installed from Versions (its permissions shown like an update).
- **Removal** deletes its store, secrets, linked accounts, jobs, settings rows and notifications; its downloads / progress / watch list rows stay (they are the user's; they keep `by: plugin:<id>`).
- **Admin only**, always: no client route installs, enables, configures, grants or links anything (`/admin/plugins*`, `requireAdmin`).

### 6.5 Storage and audit

- `<config>/plugins/<id>/<version>/` (unpacked, read-only for the host; current + previous), `<config>/plugins/cache/` (downloaded packages, repository indexes).
- Tables: `plugin_repositories` (`id`, `url`, `name`, `key` (pinned), `enabled`, `builtin`, `etag`, `fetched_at`, `error`), `plugins` (`id`, `version`, `hash`, `origin` (repository id or `upload` / `dev`), `enabled`, `state`, `granted` permissions JSON, `update_policy`, `installed_at`, `updated_at`), `plugin_store`, `plugin_secrets` (with linked accounts' tokens, per profile), `plugin_profiles` (per profile: enabled, granted personal permissions), `plugin_jobs` (last run, duration, error), `plugin_notifications` (pending, 24 h).
- Audit: every host call that crosses a permission (network host, play, secrets, writes, events received, notifications, calls to exports) is countable per plugin and shown in Activity.

## 7. The 18+ section as a plugin

### 7.1 What moves (inventory, 2026-10-22; player and core pages added 2026-10-23)

| Side | Today in the core | In the plugin |
|---|---|---|
| TV screens | `adult-browse/`, `adult-title/`, `releases-page` kind `adult`, routes `core.adult.*`, `requires: ['adult']`, menu entry, `chrome.accent 'adult'` | three template screens (`catalog`, `title`, `releases`), menu section, `chrome.accent` from the manifest; the audience rule replaces the `adult` requirement |
| TV services | `adult.service.ts`, the `adult` parts of `releases.service.ts`, `torrent.service.ts` (`findAdultTorrents`), `torrent-picker`, `playback` (`adult: true`), search's 18+ chip (`search-page`), Settings › 18+ group, `AdultGuard` (`profile.guard.ts`), the `adult` requirement of `nav/screen.ts` | data handlers; the search chip through a new slot `core.search.filters`; the posters / list layout becomes a filter of the plugin's `catalog` screen (remembered per profile), the metadata provider a `profile` setting and the ThePornDB key a `server` secret, both in the dashboard (goal 7: no Settings › 18+ group on the TV any more); the plugin's play effects carry the generic `tracking: 'none'` policy (below), set by the core for `audience: adults` plugins |
| TV player | `PlaybackRequest.adult` (`playback.service.ts`, `episode-playback.service.ts`) and its four checks in `player-page.component.ts`: no resume point read, no progress / history saved, no title (`media`) sent with the keepalive (so the download isn't named), no Up next | **no `adult` in the player at all.** The player gets a generic, content-neutral policy on `PlaybackRequest`: `tracking: 'full' \| 'none'` (`none`: no resume read, no progress / history / watched, no title on the keepalive, no Up next, no `playback.*` events to plugins, not in Continue watching or the dashboard's Activity title). The core sets `tracking: 'none'` on every `play` effect of an `audience: adults` plugin, whatever the plugin asks; any plugin may ask for it for its own plays (a "private" source). The player plays the plugin's source exactly like a core one (magnet → `POST /torrents`, leases, pause on leave, transcode, subtitles, the picker's `scenes` become generic source `notes`) |
| TV core pages | `movie-options`, `show-options`, `episode-page`: `isAdult` (TMDB `adult` titles opened on core pages: their own torrents, Find releases kind `adult`, no watch list / library state); `movies.service.ts#search(…, includeAdult)`; `torrent-picker` 18+ shape; comments naming `adult-browse` in `movement/` and `ui/layouts/` | removed: core pages never get an adult title (every TMDB call of the core keeps `include_adult=false`; the search's 18+ results come from the plugin's `core.search.filters` contribution and open the plugin's `title` screen, never `movie-options`); the comments get neutral examples |
| Server | `lib/adult.js`, `lib/adultMeta/` (TMDB studios, ThePornDB), `lib/routes/adultMeta.js`, `releases.js` kind `adult`, the XXX categories of `providers/piratebay.js` / `therarbg.js`, `services/profiles.js` / `services/settings.js` / `recommendations.js` adult bits, `tmdb.js` adult search, `present.js` | `server.js`: its own HTTP calls to apibay / TheRARBG / TMDB / ThePornDB (declared hosts), `data` handlers for the screens, `releases.providers` + `play.collect` hooks |
| Server, around the player | `lib/routes/server.js` (`adult: true` feature flag), `lib/api.js` (`/adult/torrents`, `/adult/providers`, `/adult/browse`, `/adult/meta`), `episodes.js`'s helpers shared with `adult.js`, the keepalive's title rule | removed; the keepalive / progress routes follow `tracking` (a lease taken by a `none` play carries no title and saves nothing), so the server needs no 18+ rule either |
| Protocol | `/adult/*` operations, `releases` kind `adult`, settings keys `adult.layout`, `adult.metadataProvider`, `profile.preferences.adult` | gone from `openapi.yaml`; `adult.layout` becomes the catalog screen's remembered filter, `adult.metadataProvider` the setting `plugin.adult.metadataProvider` (both migrated once); preferences dropped |

The core keeps The Pirate Bay / TheRARBG providers for movies and shows ("Find releases"); the plugin has its own small clients for the XXX categories.

**What stays in the core, on purpose** (not the 18+ section, so `check:plugins` allows it by name): the library's **adults-only folders** (`library_folders.audience`, `lib/media`, `lib/play/handlers.js`, `lib/library/view.js`, `lib/dlna/tree.js`: an admin's audience rule for files on disk, enforced for kids profiles and DLNA), the profiles' **kids** flag, `include_adult=false` on the core's TMDB calls (a filter that keeps adult titles out), the `audience` machinery of plugins, the `adult` accent token (`chrome.accent` names it; any `adults` plugin may use it) and old migrations (history, never edited).

### 7.1b The end state

At the end of P5:

- **Without the plugin** there is no trace of the 18+ section anywhere: no menu entry, no route, no Settings group, no search chip, no `/adult/*` operation in `openapi.yaml` or the server, nothing about adult titles in the movie / show / episode pages, the source picker or the **player**. `check:plugins` fails on `adult` / `18+` / `xxx` in core code outside the list above.
- **With the plugin installed** (and enabled for the profile, never for kids), everything comes back as it is today: the menu section ("18+", its icon, the wine accent), the posters and compact layouts, the title page, the release list, the search chip, the layout switch on the catalog's toolbar, its settings in the dashboard (Plugins › 18+: metadata provider per profile, the ThePornDB key), and **playback in the TV player**: Play on a plugin title opens the source picker with the plugin's torrents, the core player plays them with every player feature (scrubbing, the download bar, subtitles, transcode, Back releasing the lease), and nothing is remembered (`tracking: 'none'`), as today.
- **Removing or disabling it** takes all of that away again at once (`plugin.*` events: the TV's remote adapter undefines the screens, the menu entry, the contributions; a player already open on a plugin source finishes, the next Play can't start one).

### 7.2 Order

1. First, in the core: replace `PlaybackRequest.adult` with the generic `tracking` policy (§7.1, the player and the keepalive / progress routes), and stop opening adult titles on the core's movie / show / episode pages (the 18+ screens open their own title page already). Then the player and the core pages have no 18+ code before anything moves.
2. While the loader doesn't exist, move the 18+ code into **`plugins/adult/`** in the repo, written against the public APIs only (TV: templates + `defineScreen` / `defineContribution` as `plugins-dev/hello` does; server: a host-API shim that runs the same `server.js` in-process). Core files stop importing anything 18+; a lint rule (`check:plugins`) fails on `adult` in core code.
3. When the sandbox and loader exist (P2–P3), the same `plugins/adult/` builds to `adult-1.0.0.ppx`, signed with the Playpex key; the server stops shipping the in-process shim. Existing installs: a data migration installs the plugin automatically **only if** some profile had used the 18+ section, otherwise it's offered on the Plugins page.

### 7.3 The second reference plugin: Trakt

18+ checks the shape the core already has (a catalog, release lists, torrents). A **Trakt plugin** (`plugins/trakt/`, first-party, signed) checks the rest of the API, and is the plugin people ask media centres for first:

| It needs | API |
|---|---|
| Link a Trakt account per profile | `link` (device code, §4.8), dashboard › Plugins › Trakt › Accounts |
| Scrobble: start / pause / stop with progress | `events.playback` (§4.4) |
| Import the Trakt watch list and watched history, export Playpex's | `schedule` (§4.5) + `write: ['watchlist', 'watched', 'ratings']` (§4.6), loop-free through `by` |
| "Trakt: trending", "Up next on Trakt" rows | slot contributions (`core.movies.rows`, `core.shows.rows`) from `data` handlers |
| The Trakt rating on title pages | `metadata.title` |
| Options: scrobble on / off, sync interval, what to sync, "Sync now" | `contributes.settings` (an `action` for Sync now), in the dashboard |
| "Trakt: 3 titles added to your watch list" | `notify` (§4.10) |

A smaller **test plugin of a debrid shape** (an HTTPS source on a local test host, behind a fake "linked account") checks `sources: ['http']` and the `r_…` proxy in P3's verification; a real debrid plugin is left to third parties.

If either reference plugin needs something the API doesn't have, the API changes, not the plugin (no private core calls, `check:plugins` covers `plugins/trakt/` too).

## 8. Steps

| # | Step | Verify |
|---|---|---|
| P0 ✅ | **Contract** (done 2026-10-23; decisions taken there: `secret` settings are server scope and listed in `permissions.secrets`; hosts are names only, no IP literals or local names; `play.rank` answers `{ order, hide }`; slot answers in `$defs/slots`, `core.search.filters` answers `{ chip, rows }`): `SERVER_PLUGIN_API`, manifest JSON schema in `packages/protocol` (`plugin.schema.json`, types: permissions of §3, `link`), hook schemas, event payloads, `Source` kinds, `Marker`, effects; `docs/tv-plugins.md` grows into `docs/plugins/` (author guide: manifest, permissions, host API, hooks, events, schedules, writes, linking, templates, effects, security rules) | schema tests: the 18+ and Trakt manifests validate, bad ids / undeclared hooks / private hosts / `http` sources without the host in `network` refused |
| P0b ✅ | **Contract revision** (done 2026-10-23; also `signing.js` (ed25519 keys `ed25519:<base64>`, sign / verify / fingerprint) and `satisfiesVersion` for `requires`; `play.resolve` is one hook with `check` / `resolve` modes; custom links answer a code or a form (`$defs/linkStart`)): manifest `listing`, `requires`, `exports`, `migratesFrom`, `i18n`; permissions `files`, `notify`; hooks `play.resolve`, `library.match`; settings `group`, `level`, `visibleIf` / `enabledIf`, type `action`, no `device` scope; links `custom`; remove the `settings` template and the `showCode` effect; the repository index schema (`repository.schema.json`) and the `repository` package type; reference manifests updated (18+ layout as a filter); `docs/plugins/` updated (+ `repositories.md`) | schema tests as P0, plus: a signed index validates and its signature checks (a changed byte or another key fails), an index with a package missing its sha256 / an `http:` URL / a `broken` version without reason is refused; repository packages carry nothing but their repository; settings conditions, actions, links (device code xor custom), new hooks' permissions, `@key` strings, dependency ranges. Cycles across `requires` and calls to plugins not in `requires` need several manifests: P4b's resolver and P2's host test them |
| P1 | **Templates** in the TV: extract `catalog`, `title`, `releases`, `list` from the 18+ / releases / watch list pages; slot `core.search.filters`; action `call` + effects; registry `undefine` + `router.resetConfig`; the remote adapter (reading manifests from a local fixture first) | the hello example rebuilt as a declarative plugin renders the same screens; screenshots of the 18+ pages unchanged when rendered by templates |
| P2 ✅ | **Sandbox host** (`lib/plugins/`; done 2026-10-23: `quickjs-emscripten-core` + the `release-sync` variant, one worker thread per plugin; host promises, interrupt deadline per stretch of plugin code, 64 MB, 512 KB stack, 4 calls, 3 strikes in 10 min → `failed`; `http.js` resolves once, checks every address against the special-purpose ranges and connects to that address, port 443 only, redirects checked again, `Authorization` / `Cookie` dropped across hosts; tables `plugin_store`, `plugin_secrets`, `plugin_settings` (migration `0009_plugins`); plugins load from `<config>/plugins-dev/<id>/` with `plugins.developerMode` (install is P4); the host API parts of later steps answer `NOT_AVAILABLE`. **CPU measured** on a real TheRARBG results page (147 KB HTML): `parse5` bundled with esbuild parses and walks it in ~260 ms in QuickJS (V8: ~26 ms), a regex pass 7 ms: the 2 s limit stands): QuickJS runtimes in a worker (host promises, §4.1), limits, host API with permission checks (SSRF-safe HTTP with `bytes` and **rate limits**, store, secrets, settings, log), hooks registry, `/plugins/{id}/data/*`, assets, `GET /plugins`, `plugin.*` events; the CPU limit measured on a real HTML page | a hostile test plugin (reads files, loops forever, allocates 1 GB, calls `127.0.0.1` / `192.168.x` / a DNS name resolving to them / a redirect to them, an undeclared host, `play` without permission, 100 requests/s to one host) is stopped or throttled every time and the server keeps serving; 4 concurrent calls of one plugin all answer (`apps/server/test/plugins.sandbox.test.js`: an HTTPS test server on 127.0.0.2 with a throwaway openssl certificate and a fake resolver) |
| P3 ✅ | **Play pipeline hooks** (done 2026-10-23: `lib/play/plugins.js` is the pipeline's collect handler `plugins` and runs `play.resolve` check (one call per Play, 3 s; `resolver` + badge `cached`, ranked with the plugin streams before other torrents), `play.rank` after the core's ranking (each plugin in id order; hidden sources leave with `hidden: [{id, label, by, reason}]`) and, through the new **`POST /play/start`** (`{request, source, confirmed?}`; the sources answer is kept 30 min), `play.before` (first refusal, else first question; the client asks, then starts again with `confirmed`) and `play.resolve` resolve (failure → the torrent itself, with a note); `http` sources become `r_<32 hex>` refs (`lib/plugins/remote.js`: in memory, an hour after the last use; size from a one-byte range when not given; streamed by `lib/plugins/http.js#stream`, the same checks on every hop, no size cap or decompression; 200 to a range from 0 truncated, from elsewhere refused) of PlaySource type `plugin`, also in play effects (`{kind: 'media', ref}`); a plugin's magnets keep only hash and name, trackers are the server's (a tracker list could make the torrent client reach addresses the sandbox may not); `releases.providers` → sources `plugin:<id>` of the movie / tv lists (hook kinds `movie` / `show`; no adults plugins: those lists have no profile); `subtitles.providers` → providers `plugin:<id>` (opaque refs kept 6 h, fetched as the plugin; `.srt`, `.vtt`, `.ass` / `.ssa` converted); `metadata.title` → `POST /plugins/meta`; `player.markers` → `POST /play/markers`, the TV's "Skip intro" / "Skip recap" (OK, Back dismisses) and Up next from the credits (at most 10 min); `library.match` → `library_folders.matcher` (migration `0010_folder_matcher`), `PATCH /admin/library/folders/{id}` `{matcher}` rescans every file the admin didn't match, `GET /admin/library` lists `matchers`; plugin matches are stored as `auto` (the `matched_by` CHECK stays), the core's rules when the plugin answers null. The manifest rule "sources need play.collect" became "sources need play.collect, play.resolve, play or write: downloads", so a resolver alone needs no collect hook. Finished the same day: the dashboard's "Information provider" select on a library folder, `metadata.title` items on the TV's meta lines (`PluginMetaService`, a `core.title.meta` contribution of the core), Up next from the credits checked in the real app. Not done: HLS (P7). Tests: `apps/server/test/plugins.play.test.js` (13: the hooks, the proxy with exact ranges, a redirect to loopback refused mid-stream, the resolver, ask / refuse, effects, markers, meta, releases, subtitles, the matcher with the admin's match winning, ffprobe + the AC-3 → AAC transcode through `/media/r_…`); `apps/tv/scripts/scenarios/plugin-play.js` (the picker's "Hidden by …", the plugin's question, "Skip intro" and OK skipping it, in the real app)): `play.collect`: `play.collect` / `rank` / `before` / `resolve`, `releases.providers`, `subtitles.providers`, `metadata.title` wired into `lib/play/` (media-server plan §6), `library.match` into `lib/library/match.js` with the per-folder information provider; `Source` kinds `magnet` and `http` with the `r_…` media ref proxy; `player.markers` with the player's "Skip intro" and credits-based Up next | a test plugin adds a source and hides HEVC; the picker shows its reasons; a throwing handler changes nothing; the debrid-shaped test plugin's `http` source plays, seeks and transcodes AC-3 through `/media/r_…` and the client never sees its URL; a redirect to a private address is refused mid-stream; a test plugin's intro marker shows "Skip intro" at the right time; a fake resolver marks one torrent "Cached" and plays it as `http` when picked; a folder set to a test matcher maps an absolute-numbered file onto its season and episode, and the admin's match still wins |
| P3b | **Events, schedules, writes, linking, notifications** (§4.4–4.8, §4.10): the host's filtered view of the core's event bus, per-profile grants, `schedule`, the write scopes through the core's services with `by`, the device-code and `custom` linking flows (run from the dashboard), `notify.send` + `plugin.notification` with the TV's toast | a test plugin receives `playback.*` only for granted profiles, never a kids profile's for an adults plugin; a full queue drops with `dropped: n`; a job runs on its interval, survives a restart, never overlaps itself; writes appear with `by` and don't come back to their writer; a profile not granted the scope is never written; linking against a fake device-code server stores and refreshes the token; a notification reaches only the named profiles' clients, once, and is kept for a client that connects within 24 h |
| P4 | **Install & trust** (§6.3–6.5): package format, signature check, developer mode, `/admin/plugins*`, the dashboard's Plugins page (Installed, Developer; a plugin's Overview, Permissions, Settings rendered from the manifest, Profiles, Accounts, Activity, Versions, Remove / Clear data), `GET /plugins?profile=` for clients; **no plugin management in the TV** | install from an upload / update with more permissions (waits as `needs consent`; a grown personal permission stays off for every profile) / rollback / remove cleans its rows (store, secrets, links, jobs, notifications) and keeps the user's; unsigned refused outside developer mode; a kids profile's `GET /plugins` never lists an adults plugin; the TV build has no plugin settings, permission or linking screen (`check:plugins` looks for them) |
| | *Done early (2026-10-23, at the user's request): installing a package from an **upload or a URL** (a direct link, or a GitHub repository / release page: the release's `.ppx` / `.zip` asset, else its source zip, the plugin found at the root or in one sub folder) in two steps, preview (name, version, publisher, permissions in words, changelog, signer, install / update / downgrade) then install by token (`lib/plugins/install.js`, `/admin/plugins/packages*`); the trust rule above (a `signature` by a key in `plugins.publisherKeys`, else developer mode, checked again at install); `<config>/plugins/<id>/` with the replaced version in `.previous/<id>/` (put back when the new one doesn't start); the `plugins` table (migration `0011_plugins_installed`); enable / disable / remove (its store, secrets, settings; folders it matched go back to TMDB), reload of a developer copy; the dashboard's Plugins page (Installed, Install dialog, Trust: developer mode + trusted keys); `npm run pack:plugin` (pack, `--keygen`, `--key`). Tests: `apps/server/test/plugins.install.test.js`. Still P4: consent for grown permissions on update, Versions / rollback button, a plugin's own page (Settings, Profiles, Accounts, Activity), per-profile grants, `check:plugins`.* | | |
| P4b | **Repositories** (§6.1, §6.2, §6.4): indexes (fetch, signature, pinned key, ETag cache, stale on failure), the built-in official repository, Browse / Updates / Repositories tabs, dependency resolution and `exports` calls, origin pinning, update policies (`auto` / `notify` / `never`, per plugin), lifecycle (`deprecated` → replacement, `broken` → disabled), install any listed version | against local test repositories (HTTPS on loopback, allowed for tests only): install with a required and an optional dependency in one consent; an update with the same permissions installs by itself under `auto`, one with a new host waits; a second repository offering the same id is ignored for updates (origin); an index re-signed with another key is refused until accepted; `broken` disables, a fixed version re-enables; removing a required plugin lists its dependents first |
| P5 | **18+ out of the core** (§7): `plugins/adult/` built against the APIs, then packaged, signed and published in the official repository; core 18+ code, routes, settings and protocol operations removed; migration §7.1b holds: with no plugin, a build and a server with no 18+ code (`check:plugins` over `apps/tv/src`, `apps/server/lib`, `packages/protocol`; the player's source has no `adult`); with the plugin installed, a scenario in Electron goes menu 18+ → browse (both layouts) → title → Play → source picker → the core player plays, scrubs and leaves, and afterwards no resume point, history row, Continue watching entry or download title exists for that play; a kids profile sees none of it; removing the plugin removes the section, its menu entry, settings and search chip while the app runs |
| P6 | **Trakt** (§7.3): `plugins/trakt/` against the APIs only, packaged, signed and published in the official repository | link a profile; a playback scrobbles start / pause / stop (against Trakt's staging API or a recorded fake); a watch list item added on Trakt appears after a sync and one added in Playpex reaches Trakt, with no loop; a second profile not granted it sends nothing; removing the plugin unlinks and stops the jobs |
| P7 | (later) custom UI in sandboxed iframes, `hls` sources, plugin-provided subtitle / metadata for DLNA, `metadata.artwork`, plugin titles in the library (Kodi's `.strm`: a plugin's catalog, e.g. a debrid cloud, shown in the Library section) | |

P0b first (P1 and P2 are written against it); then P1 and P2 can go in parallel; P3 and P3b need P2 (P3 also `docs/media-server-plan.md` step 6) and can go in parallel; P4 needs P2; P4b needs P4; P5 needs P1–P4b (it ships through the official repository); P6 needs P1, P3b and P4b, and can go in parallel with P5.

## 9. Decisions

- **A. Server sandbox**: **QuickJS in WASM** (`quickjs-emscripten`; no ambient authority at all, exact limits, every capability is ours; costs: an interpreter, slower than V8, no Node libraries) / a Node child process with the **permission model** (`--permission`: no fs / child processes / workers / addons unless allowed; full npm; but it doesn't restrict the network per host (to check against the Node version in use), so SSRF needs a proxy, and a V8 escape is a machine escape) / `isolated-vm` (V8 isolates; native addon, a pain for Electron packaging, maintenance mode) / no code, declarative providers only (JSON mappings of HTTP APIs; safest, too weak for scraping). *Recommended: QuickJS*: plugins here are I/O glue (HTTP + parsing), where an interpreter is fast enough, and it's the only option where "the plugin can only do what we hand it" holds by construction.
- **B. Plugin UI in the TV**: declarative templates only / + sandboxed iframes later / plugin Angular modules loaded at run time (full power, full risk: they'd have the device token and `window.playpex`). *Recommended: templates now, iframes later if a real plugin needs them; never in-renderer modules for third parties.*
- **C. Unsigned plugins**: allowed after a warning / refused / allowed only in a "developer mode" setting. *Recommended: developer mode*: off by default, so a normal install only takes signed packages, and authors can still test (§6 is written for it). With repositories (2026-10-23), "signed" means listed in a trusted repository's signed index with a matching sha256, or an uploaded package signed by a trusted publisher key.
- **D. Where plugins run for remote clients**: on the server only (every client gets them) / per client. *Recommended: server only*: clients just render.
- **E. 18+ on existing installs**: auto-install if used / always offer / never. *Recommended: auto-install if some profile used it*, so nobody loses the section on update.
- **F. Events: delivery**: at most once with a bounded queue / at least once with a persisted outbox per plugin. *Recommended: at most once*: an outbox is a table, retries and a promise the core must keep for code it doesn't trust; scrobblers reconcile on a schedule anyway, and `dropped: n` tells a plugin when to.
- **G. Personal permissions** (`events.playback`, `write`): the admin's grant at install is enough / each profile also opts in. *Was: each profile opts in on its TV.* **Revised 2026-10-23** (goal 7, setup only in the dashboard): granted **per profile by the admin in the dashboard** (Plugins › <name> › Profiles), off for every profile until switched on, and never implied by the install grant. The cost: the household member whose viewing is sent isn't asked on their own screen; the admin is. If that matters later, a profile could get a one-time notice on the TV (content, not setup: "Trakt now sees what you watch on this profile") without bringing settings back to clients.
- **I. Plugins depending on plugins** (2026-10-23): none / install-time dependencies only / dependencies + calls to declared `exports`. *Recommended: dependencies + exports*: a resolver or an account plugin is only useful if others can use it; calls run in the callee's sandbox with its own permissions, so nothing is borrowed. No shared code modules (Kodi's `script.module.*`): bundling costs a few kB and avoids version hell.
- **J. Update policy default** (2026-10-23): `auto` / `notify` / `never`. *Recommended: `auto` for updates with unchanged permissions*, consent for the rest: fixes (a site changed its HTML) must arrive without the admin, more power must not.
- **K. Repository trust** (2026-10-23): per-package signatures only / signed indexes with a pinned key (trust on first use) / a central list of approved repositories. *Recommended: signed indexes + pinned key*, plus origin pinning per plugin: the admin decides once per repository, the key change is loud, and nobody but the origin updates a plugin.
- **H. Second reference plugin**: Trakt / a debrid source / a subtitle provider moved out of the core. *Recommended: Trakt* (events, linking, writes, schedules: everything 18+ doesn't exercise), plus a debrid-shaped test plugin for `http` sources; a subtitle provider is a `subtitles.providers` handler, close to what 18+ already checks.

## 10. Open questions

- **Player overlays** beyond markers (a plugin's own panel over the video, a settings tab in the player): markers (§4.3) cover skip intro, credits and chapters without UI code; a template-based player tab is possible, free overlays aren't templates.
- Should a first-party plugin ship default secrets (Trakt's client id / secret) in its package, or must the admin register an app? Shipping them is simpler and public in any case for desktop OAuth apps; the admin can override them.
- Plugins on the dashboard: settings, `action` buttons and links cover setup (§6.3); does a plugin ever need its own admin page (a debrid account's usage, a sync log) beyond Activity? If so, the `list` template rendered by the dashboard.
- Where the official repository lives (a static site with the signed index and packages; GitHub releases like the `tv-channel` updater feed?) and who holds its key.
- Should the TV show a plugin's notice once when a personal permission is granted for its profile (decision G)?

## 11. What we took from Kodi (2026-10-23)

Kodi's add-on system is the closest mature design for a media centre (comparison from its documented behaviour, not a study of its code):

| Kodi | Here |
|---|---|
| `addon.xml` with extension points (`xbmc.python.pluginsource`, `xbmc.service`, `xbmc.subtitle.module`, `xbmc.metadata.scraper.*`, `kodi.context.item`, `xbmc.addon.repository`) | the manifest's `contributes`, `hooks`, `events` / `schedule`; context items → action slots |
| Repository add-ons + `addons.xml` (md5 checksums), several repositories | §6.1, with **signed** indexes and pinned keys (Kodi only checks checksums) |
| "Update official add-ons from: origin repository" (Kodi 19) | origin pinning (§6.1) |
| `<requires><import>` dependencies, resolved from repositories | `requires` (§6.2), for behaviour, not code |
| `script.module.*` shared Python libraries | not taken: bundling (§1 non-goals) |
| Auto-update: install / notify / never, per add-on | `plugins.updates` + per plugin (§6.4), consent when permissions grow |
| `lifecyclestate` broken / deprecated in repositories | `lifecycle` (§6.4) |
| Install a previous version (Versions) | Versions (§6.3) |
| `xbmc.addon.metadata`: summary, description, disclaimer, license, source, news, screenshots, fanart | `listing` + `CHANGELOG.md` (§3) |
| `settings.xml`: categories, levels, conditions, action buttons | settings `group`, `level`, `visibleIf` / `enabledIf`, `action` (§4.3) |
| `strings.po` translations | `i18n/<locale>.json` (§3) |
| Scraper chosen per library source | `library.match`, the information provider per folder (§4.3) |
| ResolveURL / debrid resolvers used by source add-ons | `play.resolve` (§4.3) |
| Service add-ons' notifications | `notify` (§4.10) |
| Plugin content in the library via `.strm` | later (P7) |
| Python with full access, "Unknown sources" as the only gate | **not taken**: the QuickJS sandbox, permissions in words, signatures (§2, §4.1, decision A) |
| Add-on settings dialogs on the TV | **not taken**: setup is the dashboard's, clients stay clean (goal 7) |
| Skins, PVR, music, games, web interfaces | not taken (§1 non-goals) |

