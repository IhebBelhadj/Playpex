# Plugins: packages, extension points, middleware, sandboxing (plan)

Status (2026-10-22): **proposed, nothing built** beyond what the navigation and UI plans delivered (`defineScreen` with menu entries, slots and `defineContribution`, the compiled-in example `plugins-dev/hello/`, `docs/tv-plugins.md`). Read `docs/tv-plugins.md`, `docs/navigation-system-plan.md` §8 and `docs/ui-system-plan.md` §5.6 / §12 first. The play pipeline this plan hooks into is `docs/media-server-plan.md` §6.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.

## 1. Goals

1. **Third parties extend Playpex without forking it**: a section in the menu, screens, action tiles next to Play / Trailer, rows, meta, settings, and server-side behaviour.
2. **Middleware**: a plugin can change what a core feature does, not just add buttons: add sources to Play, reorder or filter them, add release providers, subtitle providers, metadata. Users see a plugin's options in Settings and decide.
3. **The 18+ section becomes a plugin** that the admin installs from the dashboard. The core keeps no 18+ code; the plugin uses only the public plugin API (the proof that the API is enough).
4. **A malicious plugin can't harm the machine**: no file system, no processes, no secrets, no other plugin's data, network only to the hosts it declared, nothing on the TV beyond what the core renders for it.

Non-goals: a public plugin store (a list of URLs comes later), paid plugins, plugins for the dashboard, plugin UI code running in the TV app in the first version (§5.4).

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
assets/                  icons (SVG), images; served by the host at /plugins/<id>/assets/*
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

## 4. Server side: the sandbox

### 4.1 Runtime

Each enabled plugin runs `server.js` in a **QuickJS interpreter compiled to WebAssembly** (`quickjs-emscripten`), one runtime per plugin, inside a worker thread of the server (decision A):
- no `require`, no `process`, no `fs`, no `fetch`, no timers except the host's: the only globals are the language and the `playpex` host object (§4.2). WASM memory can't reach the host's.
- **limits** per runtime: memory (`setMemoryLimit`, 64 MB default), stack, CPU per call (an interrupt handler stops a call after 2 s of execution; the host call it was serving answers its timeout), concurrent calls (4).
- a runtime that crashes, runs out of memory or times out repeatedly is **disabled** (state `failed`, dashboard shows why), the rest of the server is unaffected.
- npm libraries that are plain JS (parsers, `cheerio`-like HTML parsing) work when bundled into `server.js`; Node built-ins don't exist.

### 4.2 Host API (`SERVER_PLUGIN_API` 1)

Async functions on `playpex`, each checked against the manifest and logged with the plugin id:

| API | Capability |
|---|---|
| `http.request({ url, method, headers, body })` | HTTPS only, host must match `permissions.network` (exact or `*.domain`), **resolved addresses must be public** (no loopback, private, link-local, multicast; checked after DNS and on every redirect: SSRF), 10 s timeout, 8 MB response cap, no cookies jar shared with anything, no `Authorization` the plugin didn't set |
| `store.get / set / delete / list(prefix)` | its own rows in `plugin_store` (quota from the manifest) |
| `secrets.get(name)` | values the admin entered for names in `permissions.secrets` (encrypted at rest like other keys) |
| `settings.get(key, ctx)` | its own settings (`plugin.<id>.<key>`, settings plan §4), for the request's profile / device |
| `tmdb.*` (read-only subset), `imdb.title/episodes`, `library.find(ref)` | core data a plugin may read; `library` needs `permissions.library` |
| `log.info / warn / error` | into the server log, tagged |
| `hooks.on(name, handler)` | middleware (§4.3), only names in `permissions.hooks` |
| `data(name, handler)` | answers for the screens / slots / actions named in `contributes` (§5) |

Never available: the DB, other plugins, devices, auth, settings.json, the file system (library files are served by the core by media ref, the plugin only sees metadata), process / OS info, arbitrary ports.

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

The core's own features are written as handlers of the same stages (the library, YTS, EZTV / TheRARBG in `docs/media-server-plan.md` §6), so the pipeline is exercised every day. A plugin can't remove the core's handlers; it can only add, and in `play.rank` reorder or drop sources with a reason the picker shows ("Hidden by <plugin>: HEVC").

**Options** are how users steer middleware: a plugin's `contributes.settings` (switch, choice, slider, text, secret) appear in TV Settings › Plugins › <name> (profile or device scope, rendered by the core from the schema) and in the dashboard (server scope). Handlers read them with `settings.get`.

### 4.4 Routes

The host mounts `/api/v1/plugins/{id}/data/{name}` (POST, JSON in / out ≤ 1 MB) for the `data` handlers, behind the usual auth (`requireClient`), with the context of §4.2, rate limited per device. Plugin assets at `/api/v1/plugins/{id}/assets/*` (static, from the package, `Content-Type` from a fixed list, `X-Content-Type-Options: nosniff`, SVG served with a CSP that blocks scripts). `GET /api/v1/plugins` lists the enabled plugins' manifests (filtered for kids profiles) for clients.

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
| `settings` | Settings' group (from `contributes.settings`) | none | the plugin's options |

These are generalisations of screens the core already has (the 18+ browse / title pages, `ReleasesPageComponent`, the watch list), so step P1 is mostly extracting them.

### 5.3 Effects

A data handler or an action never runs code in the TV; it answers **effects** the core performs: `open(intent)` (a plugin or core screen), `play(request)` (needs `permissions.play`; the core's player, so leases, progress rules, `adult` flags apply), `toast(text, tone)`, `refresh(slot | screen)`, `confirm(question) → then effect`. An action model gets `call: '<data name>'` besides `intent` / `run`, so a tile next to Play / Trailer calls the plugin and the core performs what comes back.

### 5.4 Custom UI (later, decision B)

If a plugin needs its own UI, the only acceptable form is a **sandboxed iframe** (`sandbox="allow-scripts"`, opaque origin, a strict CSP, no `window.playpex`) talking to the core over `postMessage` with the same effects, and the Electron shell must stop adding the device token to its requests (`apps/tv/electron/auth.js` filters by URL today; it would have to filter by frame). Focus and keys across the iframe boundary are their own problem. Not in this plan's steps.

### 5.5 The compiled API stays

`defineScreen` / `defineContribution` (`nav/public-api.ts`, `ui/public-api.ts`) remain the core's own way in and the API the templates use. The TV gets a **remote plugin adapter** (`src/app/plugins/remote.ts`): on start (and on `plugin.*` events) it reads `GET /plugins`, defines each manifest's screens with the template components and its slot contributions as functions that call `/plugins/{id}/data/{name}`; uninstalling removes them (`CONTRIBUTIONS.remove`, a registry `undefine` for screens: new, with `router.resetConfig`).

## 6. Install, trust, updates

- **Admin only**, in the dashboard (**Plugins** page): upload a `.ppx` or paste a URL (HTTPS). The page shows the manifest: what it adds, **every permission** in plain words ("Talks to apibay.org, therarbg.to…", "Adds sources to Play", "Adult content: hidden from kids profiles"), the publisher and whether the signature checks. Install = explicit consent; the package's hash is recorded.
- **Signatures** (decision C): packages signed by a key the admin trusts show "Verified publisher"; the Playpex key ships with the server for first-party plugins (the 18+ plugin). Unsigned packages install only after a second, explicit warning.
- **Updates**: a new version whose permissions grow (a new host, a new hook) is installed disabled until the admin accepts the difference; same permissions → installed, previous version kept for rollback.
- **Enable / disable** per server, and per profile in TV Settings › Plugins (a kids profile never sees `adults` plugins; the admin can also hide any plugin from kids).
- **Removal** deletes its store, secrets and settings rows; its downloads / progress rows stay (they are the user's).
- Storage: `<config>/plugins/<id>/<version>/` (unpacked, read-only for the host), table `plugins` (`id`, `version`, `hash`, `enabled`, `state`, `granted` permissions JSON, `installed_at`), `plugin_store`, `plugin_secrets`.
- Audit: every host call that crosses a permission (network host, play, secrets) is countable per plugin; the dashboard shows the plugin's activity (requests per host, errors, CPU time) like the Logs page.

## 7. The 18+ section as a plugin

### 7.1 What moves (inventory, 2026-10-22)

| Side | Today in the core | In the plugin |
|---|---|---|
| TV screens | `adult-browse/`, `adult-title/`, `releases-page` kind `adult`, routes `core.adult.*`, `requires: ['adult']`, menu entry, `chrome.accent 'adult'` | three template screens (`catalog`, `title`, `releases`), menu section, `chrome.accent` from the manifest; the audience rule replaces the `adult` requirement |
| TV services | `adult.service.ts`, the `adult` parts of `releases.service.ts`, `torrent.service.ts` (`findAdultTorrents`), `torrent-picker`, `playback` (`adult: true`), search's 18+ chip (`search-page`), Settings › 18+ group | data handlers; the search chip through a new slot `core.search.filters`; settings from `contributes.settings`; `adult` play flag set by the core for `audience: adults` plugins |
| Server | `lib/adult.js`, `lib/adultMeta/` (TMDB studios, ThePornDB), `lib/routes/adultMeta.js`, `releases.js` kind `adult`, the XXX categories of `providers/piratebay.js` / `therarbg.js`, `services/profiles.js` / `services/settings.js` / `recommendations.js` adult bits, `tmdb.js` adult search, `present.js` | `server.js`: its own HTTP calls to apibay / TheRARBG / TMDB / ThePornDB (declared hosts), `data` handlers for the screens, `releases.providers` + `play.collect` hooks |
| Protocol | `/adult/*` operations, `releases` kind `adult`, settings keys `adult.layout`, `adult.metadataProvider`, `profile.preferences.adult` | gone from `openapi.yaml`; settings become `plugin.adult.layout` / `.metadataProvider` (migrated once); preferences dropped |

The core keeps The Pirate Bay / TheRARBG providers for movies and shows ("Find releases"); the plugin has its own small clients for the XXX categories.

### 7.2 Order

1. While the loader doesn't exist, move the 18+ code into **`plugins/adult/`** in the repo, written against the public APIs only (TV: templates + `defineScreen` / `defineContribution` as `plugins-dev/hello` does; server: a host-API shim that runs the same `server.js` in-process). Core files stop importing anything 18+; a lint rule (`check:plugins`) fails on `adult` in core code.
2. When the sandbox and loader exist (P2–P3), the same `plugins/adult/` builds to `adult-1.0.0.ppx`, signed with the Playpex key; the server stops shipping the in-process shim. Existing installs: a data migration installs the plugin automatically **only if** some profile had used the 18+ section, otherwise it's offered on the Plugins page.

## 8. Steps

| # | Step | Verify |
|---|---|---|
| P0 | **Contract**: `SERVER_PLUGIN_API`, manifest JSON schema in `packages/protocol` (`plugin.schema.json`, types), hook schemas, effects; `docs/tv-plugins.md` grows into `docs/plugins/` (author guide: manifest, host API, hooks, templates, effects, security rules) | schema tests: the 18+ manifest validates, bad ids / undeclared hooks / private hosts refused |
| P1 | **Templates** in the TV: extract `catalog`, `title`, `releases`, `list`, `settings` from the 18+ / releases / watch list pages; slot `core.search.filters`; action `call` + effects; registry `undefine` + `router.resetConfig`; the remote adapter (reading manifests from a local fixture first) | the hello example rebuilt as a declarative plugin renders the same screens; screenshots of the 18+ pages unchanged when rendered by templates |
| P2 | **Sandbox host** (`lib/plugins/`): QuickJS runtimes in a worker, limits, host API with permission checks (SSRF-safe HTTP, store, secrets, settings, log), hooks registry, `/plugins/{id}/data/*`, assets, `GET /plugins`, `plugin.*` events | a hostile test plugin (reads files, loops forever, allocates 1 GB, calls `127.0.0.1` / `192.168.x` / a DNS name resolving to them / a redirect to them, an undeclared host, `play` without permission) is stopped every time and the server keeps serving |
| P3 | **Play pipeline hooks**: `play.collect` / `rank` / `before`, `releases.providers`, `subtitles.providers`, `metadata.title` wired into `lib/play/` (media-server plan §6) | a test plugin adds a source and hides HEVC; the picker shows its reasons; a throwing handler changes nothing |
| P4 | **Install & trust**: package format, signature check, dashboard Plugins page (install, permissions, enable, update diff, remove, activity), TV Settings › Plugins (per profile, options) | install / update with more permissions (stays disabled) / rollback / remove cleans its rows; unsigned warning; kids profile never lists an adults plugin |
| P5 | **18+ out of the core** (§7): `plugins/adult/` built against the APIs, then packaged and signed; core 18+ code, routes, settings and protocol operations removed; migration | the 18+ section works installed as a package; `check:plugins` finds no 18+ code in the core; removing the plugin removes the section, its menu entry, settings and search chip |
| P6 | (later) custom UI in sandboxed iframes, plugin-provided subtitle / metadata for DLNA, a plugin index | |

P0 → P1 and P2 can go in parallel; P3 needs `docs/media-server-plan.md` step 6; P5 needs P1–P4.

## 9. Decisions

- **A. Server sandbox**: **QuickJS in WASM** (`quickjs-emscripten`; no ambient authority at all, exact limits, every capability is ours; costs: an interpreter, slower than V8, no Node libraries) / a Node child process with the **permission model** (`--permission`: no fs / child processes / workers / addons unless allowed; full npm; but it doesn't restrict the network per host (to check against the Node version in use), so SSRF needs a proxy, and a V8 escape is a machine escape) / `isolated-vm` (V8 isolates; native addon, a pain for Electron packaging, maintenance mode) / no code, declarative providers only (JSON mappings of HTTP APIs; safest, too weak for scraping). *Recommended: QuickJS*: plugins here are I/O glue (HTTP + parsing), where an interpreter is fast enough, and it's the only option where "the plugin can only do what we hand it" holds by construction.
- **B. Plugin UI in the TV**: declarative templates only / + sandboxed iframes later / plugin Angular modules loaded at run time (full power, full risk: they'd have the device token and `window.playpex`). *Recommended: templates now, iframes later if a real plugin needs them; never in-renderer modules for third parties.*
- **C. Unsigned plugins**: allowed after a warning / refused / allowed only in a "developer mode" setting. *Recommended: developer mode*: off by default, so a normal install only takes signed packages, and authors can still test.
- **D. Where plugins run for remote clients**: on the server only (every client gets them) / per client. *Recommended: server only*: clients just render.
- **E. 18+ on existing installs**: auto-install if used / always offer / never. *Recommended: auto-install if some profile used it*, so nobody loses the section on update.

## 10. Open questions

- Should plugins be able to contribute to the **player** (an overlay, a settings tab: e.g. skip-intro markers)? A template-based player tab is possible; overlays over the video aren't templates.
- Rate limits and quotas per plugin for `http.request` (a plugin hammering a site gets the server's IP banned)?
- Plugins on the dashboard (an admin page per plugin, e.g. a debrid account) as templates too?
- A plugin index (a JSON list of signed packages at a URL the admin adds) and automatic update checks: in P4 or later?
