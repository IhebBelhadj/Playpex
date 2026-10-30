# Dashboard (`apps/dashboard`) — Agent Guide

The Playpex Media Server's admin web UI (plan §7, step 5): desktop web and phones, **not** the 10-foot TV UI. Started from Vite's `react-ts` template, with shadcn/ui on top.

**Stack**: React 19, TypeScript 6, Vite 8, Tailwind CSS 4, **shadcn/ui** (style `radix-nova`, `radix-ui` primitives, Lucide icons; restyled, see Look), Jost (`@fontsource-variable/jost`: the open Futura of Playpex TV's titles), TanStack Query 5 (server state), React Router 8 (library mode, `createBrowserRouter`), **openapi-fetch** typed from `@playpex/protocol/types/api` (generated from `packages/protocol/openapi.yaml`), sonner (toasts); for `/docs` only: react-markdown + remark-gfm, Scalar (`@scalar/api-reference-react`, pinned). Lint: oxlint (`npm run lint`).

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
                        library file's sheet), /downloads (?hash= opens a download's sheet; ?filter=direct: direct downloads), /search (Search), /storage (→ /library, its query kept), /logs,
                        /settings[/:tab] (tabs = settings groups + desktop app (desktop host only) + account), /plugins, /plugins/:pluginId,
                        /profiles, /about; /watch/:ref (the player, RequireAdmin without AppLayout: the whole window)
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
                        phones), on phones `PhoneList`: a long press (450 ms, the finger still) selects like a phone app, taps then add / take
                        out, `SelectionBar` (Start, Pause, Label, Remove, ⋯ = the row menu for the selection, Select all) replaces the filter;
                        Escape (Android's Back in the app) clears it, Remove / Label dialogs, a .torrent dropped on the page → the Add dialog
src/components/download-rules.tsx  RulesDialog: a download's (or several's) seeding goal (ratio / minutes, empty = the server's) and speed
                        limits (KB/s; engines with torrentLimits) → PATCH /downloads/{h}; from the row menu and General
src/components/add-download.tsx  the Add dialog: POST /downloads/preview (a link, debounced, or a .torrent) → its files to choose, the download
                        already kept; label, Start now / Add paused → POST /downloads (multipart `files` as JSON). Remounted per opening (key); `link`: a
                        magnet to start from (Search); "No link yet? Search for one" → /search
src/lib/search.ts       Search's data (docs/search-plan.md): useSearchSources(kind) (release providers per kind, both for everything, key
                        `release-providers`; stream plugins GET /search/providers, key `search-providers`; live plugins GET /live, key `live`),
                        usePaged (every source at once, page 1, more pages per source on demand, merged and deduped), useTorrentSearch (GET
                        /releases/browse, key `release-search`), useStreamSearch (GET /search/sources, key `stream-search`), useCatalogSearch (GET
                        /catalog/search/{multi|movie|tv}, key `catalog-search`), useLiveSearch (GET /live/{plugin}/channels?q=, key `live-search`),
                        isLink (a URL, magnet or info hash: read it), holds / squash (the dashboard's own lists matched like the server's)
src/lib/direct.ts       useDirectDownloads (GET /downloads/direct, key `direct-downloads`; patched by `direct.updated`, `direct.removed`),
                        useDirectActions (add a ref, start, pause, remove with its file)
src/pages/search.tsx    /search (?q=&kind=all|movie|tv&view=all|server|titles|streams|torrents|live; keyed by kind + q: a new search starts with no
                        filters; redesigned 2026-10-26 "title first"): the field (no kind switch above it; Enter or its Search / Read link button), one
                        sentence on the sources (SourcesSummary: a popover lists each with its state and a switch to leave it out), underline tabs
                        for the groups that found something (a select on narrow screens) with the kind select at the row's end; Top results = On
                        this server (3), Movies & shows (one row of posters, never a sideways scroller), then "Watch now" (streams that play without a
                        torrent, 4) and "Download" (torrents by seeds, 4) side by side, Live TV (4); Streams and Torrents tabs: a FilterBar (selects)
                        above the list, "Show n near matches"; Streams leaves out a both-kind plugin's torrents (its Torrents list has them); the
                        torrent table from RAIL_WIDTH, rows below. Before a search: what is asked, recent searches (localStorage
                        `playpex.dashboard.recentSearches`), a hint when no source plugin is installed. A link in the field → components/search/link.tsx
src/components/search/  parts.tsx (Filters / keep / FilterBar for torrents and streams alike, Seeds signal bars, SourcesSummary, SectionHead,
                        useSearchActions: play a ref, download it (POST /downloads/direct), start a torrent, copy), torrents.tsx (TorrentTable: the
                        DataTable, key `playpex.search.columns`; row menu Add…, Add and start, Copy magnet; kept ones → /downloads?hash=), offers.tsx
                        (StreamRows: Play, Download; TorrentRows: the overview and phones), titles.tsx (TitlePosters; TitleSourcesSheet: details,
                        a show's season and episode, POST /play/sources by group, each source played / downloaded / added), server.tsx (ServerResults:
                        library titles → /library?title=, downloads, direct downloads; LiveResults: POST /live/{plugin}/channels/{id}/play → the
                        player), link.tsx (LinkView: POST /admin/links/inspect, key `link-inspect`: what it is, its videos / streams / torrent files
                        / magnets with their actions)
src/components/rail.tsx RailGroup, RailItem (a filter rail: Downloads, Search, Library), useIsDesktop(minWidth = 768); rails show from
                        RAIL_WIDTH (lg, 1024: under it the app's sidebar leaves too little room), a select below
src/components/tab-row.tsx TabRow: a page's tabs inside <Tabs> (Settings, Plugins, a plugin's page): the row where it fits (`from`
                        sm / lg / xl), a select below, never a row cut off at the screen's edge or wrapped in its track
src/components/direct-list.tsx  Downloads › Direct downloads (?filter=direct, the rail's "Over HTTP"): files fetched over HTTP: name, kind, a bar
                        (amber running, teal done), sizes, speed, source; Pause / Start / Try again, Play once the library scanned it, Remove (with
                        its file, Confirm)
src/components/download-pane.tsx  DownloadPane: tabs General (facts incl. the swarm, seeding goal and limits; Remove when watched, copy magnet,
                        Check the data again, Announce again, Seeding goal and limits, Export .torrent), Files (selection,
                        per-file strip, Play), and download-tabs.tsx: Peers (GET /downloads/{h}/peers, flags legend), Trackers (…/trackers,
                        add / remove: POST {add | remove}, each one's scrape, Announce again), Pieces (…/pieces: a canvas map, the read-ahead in gold), Speed (…/speed: SVG chart, crosshair); each polls
                        every 2 s while shown (keys download-peers / -trackers / -pieces / -speed + hash); a 501 NOT_SUPPORTED says the
                        engine doesn't report it, with its name
src/lib/player.ts       usePlayer().play({ref, title, detail?, place?, dir?}) → navigates to /watch/<ref>?title=&detail=&place=&dir= (a reload plays it
                        again; place + dir = where the file lives, for "Add subtitles › The server"); placeOf(folderId, relPath)
src/lib/media.ts        DEVICE (`dashboard-<random>`, localStorage `playpex.dashboard.device`), CAPS (what this browser decodes), mediaUrl, release
                        (DELETE /media/{ref}), tmdbImage(path, size), episodeCode
src/pages/watch.tsx     /watch/:ref, the player as a page (like Playpex TV's): the video fills the window, the controls over it hide after 2.5 s
                        of stillness while it plays (a mouse click plays / pauses; a tap shows the controls or hides them, and touch screens get a
                        play / pause button in the middle); always dark (adds `.dark` to <html> while open); GET /media/{ref}/playback with this browser's
                        flags (mkv, hevc, ac3, eac3) → direct src / hls.js (MediaSource; else the browser's own HLS) / why not; seeks inside the
                        stream, else asks again with ?t=; sound tracks (?audio=), speed, volume, PiP, full screen (the page, panel included); keys
                        (Space/K, ←/→ or J/L 10 s, ↑/↓, M, F, C subtitles on/off, S the subtitles panel, G/H timing −/+ 0.25 s, Esc: the panel, else
                        back); keepalive every 60 s; leaving the page releases the file (and on pagehide). "Watch as" (localStorage
                        `playpex.dashboard.watchAs`): progress saved for a profile (PUT /profiles/{id}/progress/…, every 15 s, on pause, on leaving),
                        "Resume at …"; a torrent's file: the downloaded runs on the timeline (GET /downloads/{h}/pieces every 4 s until whole).
                        Subtitles: the chosen track's cues are drawn by the page (the <track> is `hidden`: above the controls while they show, the
                        chosen size; cues moved by the HLS stream's start and the timing chosen)
src/components/subtitle-panel.tsx  the player's subtitles panel (beside the video; over it on phones): Showing (off, the file's own tracks from
                        GET …/tracks, the added ones), Timing, Size (S–XL, localStorage `playpex.dashboard.subtitleSize`); Find online (the title from
                        the playback answer → GET /catalog/titles/… `imdbId` → GET /subtitles/search; a result → GET /subtitles/file), This computer
                        (the file → POST /subtitles/convert), The server (a dialog browsing /admin/storage/browse from the video's folder, subtitle files
                        only → GET /admin/storage/subtitle). Added tracks: WebVTT as blob URLs, while the page is open
src/pages/library.tsx   /library: Library and Storage together. The rail: Titles (?view=titles, the default), To fix (?view=fix), the places
                        (GET /admin/storage/places; ?place=&path=&q=, `downloads` = the download folder's place; a library folder's ⋯: scan, scan
                        and match again, edit, remove), Add a folder; a select on phones. Header: Scan all, Clean up downloads, Add folder; the scan
                        progress. Sheets over any view: ?title=movie:<id> (TitleSheet), ?file=<id> (FileSheet)
src/components/library-titles.tsx  TitlesIndex (GET /library/home, key `library-home`): movies and shows as one poster grid A to Z (a
                        leading article doesn't count; a sticky letter rail to jump from 24 titles, the current letter lit), Everything / Movies / Shows, A to Z / Newest, a filter; other videos'
                        folders → their place. TitleSheet: GET /admin/library/files?title=movie:<id>|tv:<id> (key `library-title`): backdrop, a
                        movie's files, a show's by season and episode; Play, details (?file=), show in its folder
src/components/library-browser.tsx  PlaceBrowser: one level of a place (GET /admin/storage/browse: breadcrumbs, search, order), each row with
                        what it is (`media`: a poster thumb and its title, a folder's when it holds one title, `titles` otherwise; quality, length),
                        click = a folder opens, a library file's sheet, else play; Play, Details and match, Show the download, Copy path, Delete
                        (DELETE /admin/storage/entries); the disk line, Largest folders (GET /admin/storage/largest); CleanUp (POST /admin/storage/clear)
src/components/library-common.tsx  what the Library shares: folder kinds / audiences ("Adults only" offered only once an adults plugin is installed, or kept for a folder that is one), useLibrary (GET /admin/library, patched by library.scan),
                        useScan, useFolderActions, ScanStatus, Add / Edit folder dialogs (the server's folder browser GET /admin/fs, the
                        information provider), MatchCell, Poster
src/components/library-file.tsx  FileSheet (?file=): Play, Show in its folder, the match (fix: TMDB search, forget, ignore), the file, streams,
                        subtitle files
src/components/library-fix.tsx  FileList, the To fix view: unmatched / missing / ignored / all files, by folder, search, paging
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
- **All data through `api` + `unwrap` in React Query** (`queryKey` = the resource: `overview`, `sessions`, `devices`, `pairing`, `settings`, `storage`, `storage-places`, `storage-browse` (+ place, path, sort, q), `storage-largest`, `media-tracks` (+ ref), `subtitle-providers`, `subtitle-search` (+ query), `release-providers` (+ kind), `release-search` (+ kind, q, source, page), `search-providers`, `stream-search` (+ kind, q, source, page), `catalog-search` (+ kind, q), `live`, `live-search` (+ q, plugin), `link-inspect` (+ url), `play-sources` (+ title), `direct-downloads`, `catalog-title` (+ type, id), `download-peers` / `download-trackers` / `download-pieces` / `download-speed` (+ hash), `logs`, `profiles`, `torrents`, `downloads`, `download` (+ hash), `library`, `library-home`, `library-title` (+ movie:<id> / tv:<id>), `library-files` (+ filters), `library-file` (+ id), `library-search`, `fs` (+ path), `host`, `dlna`, `admin-plugins`, `admin-plugin` (+ id), `admin-plugin-settings` (+ id), `admin-plugin-links` (+ id), `plugin-catalog`, `plugin-updates`, `plugin-repositories`; `plugin.changed` invalidates them and `library`; `library.changed` invalidates `library-home`, `library-title`, `storage-browse`). Frequent events patch the cache instead of invalidating it: `download.updated` → `setQueryData(['downloads'])` in `pages/downloads.tsx`; `library.scan` progress → `setQueryData(['library'])` in `components/library-common.tsx` (its end invalidates the library keys). The events socket invalidates by those keys; add yours to `INVALIDATES` in `events.tsx` when a new event topic exists.
- **API first**: a new page needs its route in `openapi.yaml` (+ `npm run generate -w packages/protocol`, server, contract test) before the UI; the types then flow here. Don't hand-write response types.
- Theme tokens only (`bg-card`, `text-muted-foreground`, `text-success`, `text-warning`, `bg-destructive`…, defined in `src/index.css`). `--primary` is the inverted ink (white on black, black on white): primary buttons, a chosen chip. `text-gold` / `bg-gold` (`text-gold-foreground` on it) is the logo's gold: what moves (what a player reads, what's being streamed, a scan running) and what is chosen or on (switches, checkboxes, the active tab's underline, the current page's nav icon, a filter rail's chosen count, chosen chips and the toggle that's on). Never a button's fill. `text-down` / `bg-down` (amber: download speed and progress, the TV's "progress") and `text-up` (teal: upload, seeding, done), `--strip-track`; charts' lines `--chart-down` / `--chart-up` (dataviz-validated). Dark unless the OS prefers light (`index.html` script toggles `.dark`).
- **Numbers**: tables are `tabular-nums` (index.css); numbers right-aligned; no monospace for numbers (hashes, paths, codes keep `font-mono`). State is a word (and the strip's colour), badges only for exceptions.
- `/downloads` and `/library` use the whole width (`WIDE` in layout.tsx); the other pages, Search included, `max-w-6xl`. The column is centred in the space beside the sidebar, and the top bar's contents keep the same column.
- **Look** (true-black flat, chosen 2026-10-26 with the design-taste skill's app sheet): surfaces are set apart by lightness alone (ground `bg-background`, card `bg-card` one step up, a nested panel `bg-muted`), with no border or shadow at rest; 1px rules only inside a surface (table rows, the KPI strip, the shell's frame). One radius family: cards `rounded-xl` (20px), nested panels `rounded-2xl`, controls, chips and nav items `rounded-full`; never a coloured left edge (`border-l`, an inset shadow bar) on a rounded thing: a chosen item is a grey step (`bg-muted`), the nav's active item is its label in full ink with its icon in gold. The shell (layout.tsx): sidebar (grouped nav) and a top bar (quick search → /search, live traffic, the server, sign out) on one ground split by 1px rules. Page tabs are underline tabs on a full-width rule (`TabRow`); small switches are a round segmented track. Section headings sit outside their cards (Overview's rail). No backdrop blur, no gradients but scrims over pictures.
- Destructive actions go through `Confirm` (AlertDialog). Mutations toast their result (`sonner`; `components/ui/sonner.tsx` draws them `unstyled`: a raised slab, the tone only in the icon's colour (success teal, info gold, warning, error), no rich colours, a ✕ on every one to close it). A toast about something that now lives on another page carries an `action` that goes there (`Show` → `/downloads?hash=` / `?filter=direct`, `Open` → a plugin's page, `Browse`, `Review` a pairing): an ink pill at its end.
- `@/` = `src/` (tsconfig `paths`, Vite alias). **After `npx shadcn add`, check the new files' imports**: on init the CLI wrote `import { cn } from "cn"` (an unrelated npm package) instead of `@/lib/utils`; that was fixed by hand.
- Fast-refresh warnings from oxlint (`only-export-components`) are accepted for files exporting hooks next to components.

## Auth model (server side: `apps/server/lib/auth`)
- First run: `GET /admin/setup` → `needed`; the account can only be created from the server machine (`local`), then the wizard signs in and saves a few settings (restarting the server when one needs it).
- Admin session = Better Auth's HttpOnly cookie `playpex.session_token` (per host:port: after the server moves to another port, sign in again there).
- Recovery mode (port taken at start): the server listens on a random loopback port, serves only `/server`, `/admin/*`, `/auth/*` and this UI; `Overview.server.recovery` drives the banner and Settings › General's port field (Check → `POST /admin/settings/check-port`, then Save + Restart).
