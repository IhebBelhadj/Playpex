# Dashboard (`apps/dashboard`) — Agent Guide

The Playpex Media Server's admin web UI (plan §7, step 5): desktop web and phones, **not** the 10-foot TV UI. Started from Vite's `react-ts` template, with shadcn/ui on top.

**Stack**: React 19, TypeScript 6, Vite 8, Tailwind CSS 4, **shadcn/ui** (style `radix-nova`, `radix-ui` primitives, Lucide icons, Geist font), TanStack Query 5 (server state), React Router 8 (library mode, `createBrowserRouter`), **openapi-fetch** typed from `@playpex/protocol/types/api` (generated from `packages/protocol/openapi.yaml`), sonner (toasts); for `/docs` only: react-markdown + remark-gfm, Scalar (`@scalar/api-reference-react`, pinned). Lint: oxlint (`npm run lint`).

## Run / build
| Goal | Command (repo root) |
|---|---|
| Develop | `npm run server` in one terminal, `npm run dashboard` in another → Vite on :5173 with hot reload. `vite.config.ts` proxies `/api` (and the events WebSocket) to `PLAYPEX_SERVER` (default `http://localhost:28470`) and rewrites `Origin` to the server's, so cookies, the CORS/Origin checks and Better Auth's CSRF check behave as in production (same origin). Proxied requests come from loopback, so the setup wizard works |
| Build | `npm run build:dashboard` (= `tsc -b && vite build`) → **`apps/server/public`** (git-ignored, emptied first). The server serves it at `/` (`lib/api.js`: `/assets` immutable 1 year, other files 1 h, every GET path without a dot outside `/api` → `index.html`, `no-cache`). Without a build, `/` answers a 404 hint |
| Typecheck / lint | `npx tsc -b`, `npm run lint -w apps/dashboard` |

## Layout
```
src/main.tsx            QueryClient (a 401 anywhere → session cleared → /login), TooltipProvider, Toaster
src/router.tsx          routes: /setup, /login, /docs (public, lazy: DocsLayout → /docs = guide index, /docs/:page = a chapter,
                        /docs/reference = the API reference), then RequireAdmin + AppLayout: / (Overview), /activity, /devices,
                        /link (pairing's verification_uri; ?user_code= from the client's QR code), /library (?file= opens a
                        library file's sheet), /downloads (?hash= opens a download's sheet), /storage, /logs,
                        /settings[/:tab] (tabs = settings groups + desktop app (desktop host only) + account), /plugins, /plugins/:pluginId,
                        /profiles, /about
src/lib/api.ts          `api` (openapi-fetch client, baseUrl /api/v1, cookies), `unwrap()` → data or ApiError
                        ({error,code} / Better Auth {message,code} / RFC {error_description}), schema type aliases
src/lib/auth.ts         useSetupState (GET /admin/setup {needed, local}), useSession (Better Auth get-session),
                        useSignIn / useSignOut
src/lib/events.tsx      EventsProvider: one WebSocket to /api/v1/events (reconnects with back-off); invalidates
                        queries on session.* / device.* / pairing.* / host.*; useEvent(prefix, fn) for pages (Logs: `log`)
src/lib/restart.ts      POST /admin/restart, then waits for the server (or reports its new port)
src/lib/format.ts       bytes, speed, clock, duration, ago (Intl.RelativeTimeFormat)
src/components/layout.tsx  RequireAdmin (→ /setup or /login?next=), AppLayout (sidebar / mobile Sheet, recovery
                        banner, pairing toasts), useOverview, usePairingRequests
src/components/desktop.tsx useHost (GET /admin/host), DesktopCard (Settings › Desktop app, shown only when the
                        server runs in the desktop app), UpdateNotice (Overview: a downloaded update, install)
src/components/sources-notice.tsx SourcesNotice (Overview, while `overview.sources.notice`: no source plugin, the server reads
                        no torrent site: Add a repository (AddRepositoryDialog of plugin-repositories.tsx), Browse plugins,
                        Don't show again = PUT /admin/settings {plugins: {sourcesNotice: false}}; docs/providers-plan.md §4.4)
src/components/metadata-providers.tsx MetadataProviders (Settings › Metadata, under its fields: the plugins with metadata.details /
                        metadata.title from GET /admin/plugins `hooks`, in the server's order; ↑ / ↓ and a switch each, saved at once:
                        PUT /admin/settings {metadata: {order | disabled}}; docs/providers-plan.md §7.2)
src/components/dlna.tsx   DlnaPanel (Settings › DLNA, under its two settings: GET /admin/dlna every 10 s: status, the folders'
                        switches (PATCH /admin/library/folders/{id} {dlna}; adults-only ones disabled), "Seen by")
src/components/common.tsx  PageHeader, Stat, Empty, QueryError, Loading, Spinner, Dot, Confirm (AlertDialog), Mono
src/components/data-table.tsx  DataTable (docs/dashboard-plan.md §4.1): TanStack Table with sorting, a column menu (show / hide / reorder,
                        kept in localStorage under `storageKey`), selection like a file manager (click, Ctrl/Cmd, Shift ranges,
                        checkboxes), `actions(row)` → the ⋯ menu and the right-click menu (RowAction[]), keyboard (↑ ↓ Shift Home End,
                        Enter = onOpen, Space / Delete / P = onKey, Ctrl/Cmd+A, Esc); column `meta`: label, numeric (right-aligned),
                        `from` (a container width: the list's own width hides columns, not the window's), fixed
src/components/swarm-strip.tsx  SwarmStrip: a download's progress from its `pieceMap` (a CSS gradient; `tone` down / up / idle / fault from
                        `toneOf(d)`; no pieces known: waiting stripes while it runs; `marks`: players' read ranges in gold)
src/lib/downloads.ts    useDownloads (patched by download.updated), useDownloadActions (start / pause / recheck / force / move (queue) /
                        reannounce / rules (goals, limits) / label / remove on many hashes, one toast), useEngineCaps (Overview's
                        capabilities: menus offer only what the engine can), stateText ("Forced, waiting"), swarmText ("3 (120)": connected,
                        in the swarm from the scrape), torrentFileUrl, kindOf (Movies / Shows / Other), titleOf, useDeviceNames, magnetOf, videoToPlay
src/pages/downloads.tsx /downloads: the filter rail (?filter= all | a state | kind:movies | label:<name>), DataTable, the toolbar, the status
                        bar (totals, speed limits popover: PUT /admin/settings {downloads: {downLimitKBps, upLimitKBps}}, the disk,
                        Pause all), the detail pane under the list (?hash=, ?tab=; resizable, height in localStorage; a Sheet on
                        phones), Remove / Label dialogs, a .torrent dropped on the page → the Add dialog
src/components/download-rules.tsx  RulesDialog: a download's (or several's) seeding goal (ratio / minutes, empty = the server's) and speed
                        limits (KB/s; engines with torrentLimits) → PATCH /downloads/{h}; from the row menu and General
src/components/add-download.tsx  the Add dialog: POST /downloads/preview (a link, debounced, or a .torrent) → its files to choose, the download
                        already kept; label, Start now / Add paused → POST /downloads (multipart `files` as JSON). Remounted per opening (key)
src/components/download-pane.tsx  DownloadPane: tabs General (facts incl. the swarm, seeding goal and limits; Remove when watched, copy magnet,
                        Check the data again, Announce again, Seeding goal and limits, Export .torrent), Files (selection,
                        per-file strip, Play), and download-tabs.tsx: Peers (GET /downloads/{h}/peers, flags legend), Trackers (…/trackers,
                        add / remove: POST {add | remove}, each one's scrape, Announce again), Pieces (…/pieces: a canvas map, the read-ahead in gold), Speed (…/speed: SVG chart, crosshair); each polls
                        every 2 s while shown (keys download-peers / -trackers / -pieces / -speed + hash); a 501 NOT_SUPPORTED says the
                        engine doesn't report it, with its name
src/components/player.tsx  PlayerProvider (inside RequireAdmin: stays across pages) + usePlayer().play({ref, title, detail}); the dock
                        (Expand → theatre, PiP, full screen); GET /media/{ref}/playback with this browser's flags (mkv, hevc, ac3, eac3)
                        → direct src / hls.js (MediaSource; else the browser's own HLS) / why not; seeks inside the stream, else asks
                        again with ?t=; sound tracks (?audio=), subtitles (GET …/tracks; cues shifted by the stream's start), speed,
                        volume, keys (Space/K, ←/→ 10 s, ↑/↓, M, F, C, Esc); keepalive every 60 s; DELETE /media/{ref} on close / pagehide. "Watch as" (the menu; localStorage
                        `playpex.dashboard.watchAs`): nobody, or a profile: progress saved with the answer's `title` / `download` / `fileId`
                        (PUT /profiles/{id}/progress/…, every 15 s, on pause, on close), "Resume at …" from its GET; a torrent's file: the
                        downloaded runs on the timeline (GET /downloads/{h}/pieces, key download-pieces + hash, every 4 s until whole).
                        Device `dashboard-<random>` (localStorage), shown as "Dashboard (Browser on OS)" in Activity
src/pages/storage.tsx   /storage (?place=&path=&q=): places (GET /admin/storage/places: sizes, disk fill, offline), a folder listing
                        (GET /admin/storage/browse: breadcrumbs, search, order; what each file is; Play, Open in the Library (?file=),
                        Show the download, Copy path, Delete (DELETE /admin/storage/entries)), the disk line, Largest folders
                        (GET /admin/storage/largest), Clean up downloads (POST /admin/storage/clear)
src/components/ui/      shadcn components (generated: `npx shadcn@latest add <name>` from apps/dashboard)
src/pages/*.tsx         one file per page
src/pages/plugins.tsx   Plugins (docs/plugins-plan.md §6.3), tabs in `?tab=`: Installed (icon, state, origin or repository, signed / unsigned,
                        update / held / deprecated, the error, `EnableSwitch`, Open → its page; then "Kept for plugins that aren't
                        installed": `AdminPlugins.kept`, e.g. the 18+ section's settings moved for the plugin `velvet`, Forget →
                        DELETE /admin/plugins/kept/{id}), Browse / Updates / Repositories
                        (components/plugin-repositories.tsx), Developer (developer mode, trusted publisher keys: PUT /admin/settings
                        {plugins}); "Install from a file or link" (a dialog: upload a .ppx / .zip or a link → POST /admin/plugins/packages →
                        the preview → install by token). Library › Edit folder has the "Information provider" select (GET /admin/library `matchers`)
src/components/plugin-repositories.tsx  BrowseTab (GET /admin/plugins/catalog, key ['plugin-catalog', …]: search, kind, cards → a details
                        dialog with versions → POST …/catalog/install → PackagePreview), UpdatesTab (GET /admin/plugins/updates, key
                        ['plugin-updates']: the server's policy (PUT /admin/settings {plugins: {updates}}), Update / "Update all", Check now),
                        RepositoriesTab (GET /admin/plugins/repositories, key ['plugin-repositories']: cards with fingerprint, plugins and
                        what's `refused`, errors / stale, a `pendingKey` to trust, on / off, remove; Add = URL → preview → "Trust and add")
src/pages/plugin.tsx    /plugins/:pluginId, a plugin's own page (GET /admin/plugins/{id}, key ['admin-plugin', id]; refetched every
                        5 s on Activity): Overview (listing, origin, signature, requires, exports, changelog), Permissions, Settings,
                        Profiles, Accounts, Channels (a live plugin's: `components/plugin-channels.tsx`, GET /admin/plugins/{id}/channels, key ['admin-plugin-channels', id]: count, groups, guide, updated / how long, its error, search, group badges, the first 300 rows; Refresh = POST …/channels/refresh), Activity (its counters: `AdminPlugin.stats`; jobs; its log lines GET /admin/logs?plugin=),
                        Versions (its update policy (PATCH {updatePolicy}), the versions its repository lists, the version kept by the
                        last update: POST …/rollback → the preview → install); Overview alerts for `held`, deprecated (its replacement),
                        no longer listed; the menu: Reload (a developer copy), Clear data (POST …/clear), Remove / Remove keep its data
                        (a 409 with `dependents` → "Remove anyway" with force; ApiError.body)
src/components/plugin-common.tsx  what both share: PluginIcon, PluginStateBadge, ORIGIN, every(ms), useRefreshPlugins, and PackagePreview
                        (a staged package as a dialog's content: what it asks for beyond the installed version first (`added`:
                        installing sends `accept: true`, the button says "Accept and update"), the rest, `removed`, changelog, signer,
                        why it can't install + "Turn on developer mode"; a rollback's "Put it back"; a repository's package: its
                        repository instead of a signer, `lifecycle`, `moves` (accepted by installing), `dependencies` (optional ones
                        as checkboxes → `optional`); a repository package: "Trust and add")
src/components/plugin-settings.tsx  a plugin's options rendered from its manifest (GET /admin/plugins/{id}/settings, key
                        ['admin-plugin-settings', id]): PluginServerSettings (its page's Settings) and PluginProfiles (its Profiles:
                        a profile picker, "Use it for <profile>" (PUT …/profiles {shown}), "What it may do for <profile>": a switch per
                        personal permission (PUT …/grants), then its profile settings); groups, "Show advanced", visibleIf / enabledIf
                        against the draft, switch / choice / slider / number / text / url (a monospace address field; `grantsHost`: a line saying it lets the plugin reach that host) / secret (never shown: "Set") / action (POST
                        …/settings/{key}/run, its toasts shown); edits are a draft per scope saved together (PUT; a refusal's
                        `errors` per field: ApiError.fields)
src/components/plugin-accounts.tsx  PluginAccounts (its Accounts): each link's accounts (GET /admin/plugins/{id}/links, key
                        ['admin-plugin-links', id]), Link → a dialog (POST …/start: a code + its URL, polled every 3 s with …/progress;
                        or a custom link's form → …/submit), Unlink (Confirm)
src/pages/docs.tsx      the client author guide: `docs/api/*.md` (repo root) bundled with `import.meta.glob(…?raw)`, rendered
                        with react-markdown (GitHub-style heading ids, `chapter.md#x` links → `/docs/chapter#x`); chapter order
                        in `ORDER`; styles `.doc-prose` in index.css. A new chapter = a new .md file there (+ `ORDER`)
src/pages/docs-reference.tsx  Scalar on `/api/v1/openapi.yaml`, its own lazy chunk (~1.9 MB). Kept offline: telemetry off,
                        `showDeveloperTools: 'never'` (its Share / Deploy upload the spec to scalar.com), agent / MCP off,
                        no web fonts, no proxy
```

## Conventions
- **All data through `api` + `unwrap` in React Query** (`queryKey` = the resource: `overview`, `sessions`, `devices`, `pairing`, `settings`, `storage`, `storage-places`, `storage-browse` (+ place, path, sort, q), `storage-largest`, `media-tracks` (+ ref), `download-peers` / `download-trackers` / `download-pieces` / `download-speed` (+ hash), `logs`, `profiles`, `torrents`, `downloads`, `download` (+ hash), `library`, `library-files` (+ filters), `library-file` (+ id), `library-search`, `fs` (+ path), `host`, `dlna`, `admin-plugins`, `admin-plugin` (+ id), `admin-plugin-settings` (+ id), `admin-plugin-links` (+ id), `plugin-catalog`, `plugin-updates`, `plugin-repositories`; `plugin.changed` invalidates them and `library`). Frequent events patch the cache instead of invalidating it: `download.updated` → `setQueryData(['downloads'])` in `pages/downloads.tsx`; `library.scan` progress → `setQueryData(['library'])` in `pages/library.tsx` (its end invalidates the library keys). The events socket invalidates by those keys; add yours to `INVALIDATES` in `events.tsx` when a new event topic exists.
- **API first**: a new page needs its route in `openapi.yaml` (+ `npm run generate -w packages/protocol`, server, contract test) before the UI; the types then flow here. Don't hand-write response types.
- Theme tokens only (`bg-card`, `text-muted-foreground`, `text-success`, `text-warning`, `bg-destructive`…, defined in `src/index.css`); the accent (`--primary`) is the gold of the Playpex logo: selection, primary buttons, the active filter, what a player reads. `text-down` / `bg-down` (amber: download speed and progress, the TV's "progress") and `text-up` (teal: upload, seeding, done), `--strip-track`; charts' lines `--chart-down` / `--chart-up` (dataviz-validated). Dark unless the OS prefers light (`index.html` script toggles `.dark`).
- **Numbers**: tables are `tabular-nums` (index.css); numbers right-aligned; no monospace for numbers (hashes, paths, codes keep `font-mono`). State is a word (and the strip's colour), badges only for exceptions.
- `/downloads` and `/storage` use the whole width (`WIDE` in layout.tsx); the other pages `max-w-6xl`.
- Destructive actions go through `Confirm` (AlertDialog). Mutations toast their result (`sonner`).
- `@/` = `src/` (tsconfig `paths`, Vite alias). **After `npx shadcn add`, check the new files' imports**: on init the CLI wrote `import { cn } from "cn"` (an unrelated npm package) instead of `@/lib/utils`; that was fixed by hand.
- Fast-refresh warnings from oxlint (`only-export-components`) are accepted for files exporting hooks next to components.

## Auth model (server side: `apps/server/lib/auth`)
- First run: `GET /admin/setup` → `needed`; the account can only be created from the server machine (`local`), then the wizard signs in and saves a few settings (restarting the server when one needs it).
- Admin session = Better Auth's HttpOnly cookie `playpex.session_token` (per host:port: after the server moves to another port, sign in again there).
- Recovery mode (port taken at start): the server listens on a random loopback port, serves only `/server`, `/admin/*`, `/auth/*` and this UI; `Overview.server.recovery` drives the banner and Settings › General's port field (Check → `POST /admin/settings/check-port`, then Save + Restart).
