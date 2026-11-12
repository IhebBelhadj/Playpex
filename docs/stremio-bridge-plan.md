# Stremio add-on bridge: Stremio add-ons as Playpex plugins

Status: proposed 2026-11-12, **built the same day** (uncommitted). Step 0, the spike, done for every shape but the debrid one (results §12.1). Step 1 is the plugin-layer prerequisites (`docs/plugin-layer-plan.md`). Steps 1b–7 are built, with the deviations listed after the steps (§12.2). Verified on a fake add-on (`test/stremio.test.js`, 13 tests) and against the real add-ons of the spike (Torrentio, OpenSubtitles v3, Anime Kitsu, Cinemeta: install, Play, subtitles, Movies rows, a Kitsu section, title page and episode played from Torrentio). Playpex TV checked the same day with the scenario `apps/tv/scripts/scenarios/stremio.js` (13 checks against real add-ons: Kitsu's section, its posters only through the server's image proxy, its genre filter, a title page whose `kitsu:` id survives the address, an episode opening the source picker with Torrentio's torrents, Cinemeta's rows in Movies; `STREMIO_SECTION=<id> STREMIO_ROWS=<id> npx electron scripts/scenario.js stremio --server <url>`). Not seen yet: Playpex Mobile (needs a phone), and a real debrid account (the redirects are tested on a fake debrid service). Step 8 built the same day too (§12.3), archive streams included (stored rar / zip / tar). Asked by the user after a comparison with Plex, Stremio and Kodi: Playpex's plugin system is safer and better managed than Stremio's add-ons, but has about ten plugins against Stremio's thousands of add-ons. A bridge brings in that ecosystem. A Kodi add-on bridge (a sandboxed Python runtime in a container) was discussed the same day and put off: not in this plan.

This plan **revises decision H of `docs/providers-plan.md`** ("a Stremio add-on bridge: later, as a plugin, if the host API allows it (it needs any host: against the per-host rule)"). §4 and decision B explain how it fits the per-host rule. It builds on the plugin system (`docs/plugins-plan.md`, P0–P6 done), the play pipeline and the Play chooser (`docs/providers-plan.md` §5), HLS sources (`docs/providers-plan.md` §8) and the plugin templates (`docs/plugins/tv.md`). Read those, the root `CLAUDE.md`, `apps/server/CLAUDE.md` and `docs/plugins/security.md` first.

Legal note: Playpex is an educational project; streaming copyrighted content you don't have the rights to may be illegal where you live. The bridge speaks a neutral protocol, as `iptv.*` reads M3U: the core names no add-on, ships no add-on URL and lists no add-on catalogue.

---

## 1. Goals

1. **An add-on URL is all the admin needs.** On the dashboard's Plugins page, "Add a Stremio add-on" takes a manifest URL (`https://…/manifest.json` or `stremio://…`), shows what it offers, and installs it. From then on it behaves like any plugin on every client.
2. **Each add-on is a plugin of its own**: its own row on the Plugins page, its permissions ("Talks to …"), Profiles (shown / hidden), Activity, errors, switch, order, update and removal. The admin manages add-ons the way they manage plugins, nothing new to learn.
3. **Everything an add-on offers that Playpex can play is used**:
   - `stream` → Play's chooser: torrents (`infoHash` + `fileIdx`) in *Torrent*, direct links (debrid, web files) and HLS in *Stream*, YouTube videos as `embed`.
   - `subtitles` → the player's subtitle providers.
   - `catalog` → rows in Movies / TV shows, a section of its own for other types, a search chip.
   - `meta` → title pages for items TMDB doesn't know (channels, anime by Kitsu id, an add-on's own videos).
4. **No client changes.** Bridged add-ons answer through the hooks and templates that exist; Playpex TV and Playpex Mobile draw them as they draw any plugin. Clients never talk to an add-on.
5. **Safer than Stremio itself.** An add-on is data, never code: the adapter that speaks the protocol is ours, runs in the plugin sandbox, checks every answer against a schema and reaches only public addresses. Add-on URLs that carry keys (a configured Torrentio holds a debrid token in its path) are kept as secrets.

Non-goals (v1):
- Stremio's own app features: its account, library, "Continue watching", calendar. Playpex has its own, and Trakt.
- `addon_catalog` (add-ons that list add-ons).
- Usenet and archive streams (`nzbUrl`, `rarUrls`, `zipUrls`, `7zipUrls`, `tgzUrls`, `tarUrls`).
- `externalUrl` streams (they open a web page).
- Hosting or recommending add-ons.
- A Kodi bridge.

## 2. Stremio's add-on protocol, briefly

An add-on is an HTTP service. Its URL ends in `manifest.json`, and every other request is a GET relative to the same base:

| Request | Answers |
|---|---|
| `GET {base}/manifest.json` | `{ id, version, name, description, logo?, background?, types, resources, catalogs, idPrefixes?, behaviorHints? { adult, p2p, configurable, configurationRequired } }`. `resources` holds names or `{ name, types, idPrefixes }` |
| `GET {base}/catalog/{type}/{id}[/{extra}].json` | `{ metas: MetaPreview[] }`. `extra` is `search=…`, `genre=…`, `skip=…` (URL-encoded `key=value&…`) |
| `GET {base}/meta/{type}/{id}.json` | `{ meta: Meta }`, with `videos[]` for series and channels: `{ id, title, season?, episode?, released, thumbnail? }` |
| `GET {base}/stream/{type}/{id}.json` | `{ streams: Stream[] }`. A movie is `tt0111161`, an episode `tt0903747:1:2`, others use the add-on's own prefixes (`kitsu:…`, `yt_id:…`) |
| `GET {base}/subtitles/{type}/{id}[/{extra}].json` | `{ subtitles: [{ id, url, lang }] }`. `extra` is `videoHash`, `videoSize`, `filename` |

- **Types:** `movie`, `series`, `channel`, `tv`, plus any custom string.
- **Answers may carry `cacheMaxAge`, `staleRevalidate` and `staleError`** (seconds).
- **A `Stream` is exactly one of:**
  - `url` (with `behaviorHints.proxyHeaders.request` for the headers it needs)
  - `infoHash` + `fileIdx?` + `sources?` (`tracker:udp://…`, `dht:…`)
  - `ytId`
  - `externalUrl`
  - and the archive kinds left out in §1
- **Every `Stream` also has** `name`, `title` / `description` (free text: quality, size, seeds as emoji lines) and `behaviorHints` (`bingeGroup`, `filename`, `videoSize`, `videoHash`, `notWebReady`, `countryWhitelist`).
- **Configurable add-ons** put their configuration in the URL path (`https://host/<config>/manifest.json`). Their `{base}/configure` page builds that URL.

## 3. Where things are today (2026-11-12)

| Area | Today | File |
|---|---|---|
| Plugin instances | packages (`.ppx`) from repositories, uploads, GitHub, or `<config>/plugins-dev/`; one QuickJS sandbox per plugin in a worker | `apps/server/lib/plugins/index.js`, `install.js`, `sandbox.js` |
| Per-host rule | `permissions.network` (HTTPS, 443), `url` settings with `grantsHost` / `streamHosts` (hosts learned from a document the host fetched itself, `grants.learn`), core principals with `anyHost` / `openStream` (`links`, `repositories`) | `lib/plugins/http.js#target`, `grants.js` |
| Sources | `magnet` (+ `fileIndex`), `http` (`r_` refs with headers), `hls` (`h_`), `live` (`l_`), `embed` (YouTube) | `packages/protocol/plugin-api.schema.json`, `lib/plugins/remote.js`, `lib/media/hls.js` |
| Ranking | every plugin's torrents ranked together by name and seeders; groups server / stream / torrent | `lib/play/plugins.js#ranked`, `lib/media/names.js` |
| Rows, sections, search | `catalog` / `title` / `list` templates, slots `core.movies.rows`, `core.shows.rows`, `core.search.filters`; Card images must be HTTPS on a declared host | `docs/plugins/tv.md` |
| A Stremio add-on in the core | OpenSubtitles v3 (`opensubtitles-v3.strem.io`) as a subtitle provider, hand-written | `lib/subtitles/providers/stremio-opensubtitles.js` |
| Torrentio | ported by hand inside The Crew (its own repository) | `plugins/thecrew/server.js` |
| Rules | `check:plugins`: no torrent site's host in core code | `apps/tv/scripts/check-plugins.js` |

## 4. How it fits together (decision A)

```
dashboard: Add a Stremio add-on (URL) ─► POST /admin/plugins/managed/stremio/inspect ─► preview ─► install
                                                                                         │
                       ┌─────────────────────────── Playpex Media Server ────────────────┼───────┐
                       │ lib/plugins/stremio/                                            ▼       │
                       │   addons.js    fetch + check the add-on's manifest, the URL kept as a   │
                       │                secret, re-read daily (updates, §5.3)                     │
                       │   manifest.js  the add-on's manifest → a Playpex plugin manifest         │
                       │                (id, audience, network, sources, hooks, screens, slots)   │
                       │   adapter/     one script, ours, loaded into every bridged plugin's      │
                       │                sandbox: hooks → protocol requests → Playpex shapes       │
                       │   host call    playpex.stremio.get(resource, type, id, extra)           │
                       │                (the add-on's base from its secret; cached per           │
                       │                cacheMaxAge; answers checked against stremio.schema.json; │
                       │                learns the hosts of the URLs it answered, §9)             │
                       │ lib/plugins/index.js loads them beside packages (origin: 'stremio')      │
                       └──────────────────────────────────────────────────────────────────────────┘
       hooks: play.collect · subtitles.providers · screens / slots (catalog, meta)
                       ▲
 TV / Mobile ──────────┘ unchanged: GET /plugins, /play/sources, /plugins/{id}/screens/…
```

- **A bridged add-on is a plugin instance whose code is ours** (`lib/plugins/stremio/adapter/server.js`, shipped with the server, versioned with it) **and whose manifest is synthesized** from the add-on's manifest (§5.2).
- **Hooks, sandboxing, timeouts, Activity, the profile rules, the dashboard's plugin page and the TV's plugin adapter all apply unchanged.**
- **The adapter is trusted like core code, not signed like a package.** It is part of the server. What the add-on sends back is untrusted data, read only through the host call, which checks it against a schema.

## 5. Installing and managing add-ons

### 5.1 Adding one
- **Paste the URL.** The dashboard's Plugins page gets "Add a Stremio add-on" (beside Upload / From a URL / GitHub). The admin pastes a manifest URL; `stremio://` becomes `https://`.
- **Read the manifest.** `POST /admin/plugins/managed/stremio/inspect { input: url }` fetches it as a core principal with the SSRF rules: public addresses only, every hop checked, 256 KB at most.
- **Show the preview:**
  - name, logo, version, description
  - what it adds: Play sources (torrents / streams), subtitles, catalogs with their types
  - "Talks to <host>"
  - adults (`behaviorHints.adult`)
  - "Peer-to-peer" (`behaviorHints.p2p`)
  - what Playpex won't use (resources or types it can't map, counted)
- **Configure first when needed.** `configurationRequired` or `configurable` shows "Configure on <host>", which opens `{base}/configure` in a new tab. The admin pastes the URL the page gives (§5.3).
- **Install.** `POST /admin/plugins/managed/stremio { input: url }` installs it:
  - **Plugin id:** `st-` + a slug of the add-on's id, ≤ 24 characters, + 4 hex characters of a hash of the add-on id (`st-torrentio-3fa1`). Two copies of the same add-on with different configurations get different ids (the hash covers the configuration's hash too).
  - **The full URL is a server secret of that plugin** (§9), never shown again except as "<host>/… (configured)".
- **Defaults:** enabled, shown on every profile, like any plugin (decision E).

### 5.2 The synthesized manifest
| Playpex manifest | From the add-on |
|---|---|
| `id`, `name`, `version`, `description`, `listing.summary`, icon | `id` → §5.1; `name`; `version` (semver kept; a non-semver one mapped to `0.0.<n>`); `description`; `logo` (fetched once, kept as the plugin's icon) |
| `publisher` | `{ name: "<host> (Stremio add-on)" }` |
| `audience` | `adults` when `behaviorHints.adult`, else `everyone` |
| `permissions.network` | the add-on's host (any scheme and port, as a granted host, decision J of the providers plan) |
| `permissions.sources` | `magnet` when it has `stream` (all add-ons may answer `infoHash`), `http`, `hls`, `embed` |
| `permissions.hooks` | `play.collect` when `stream` covers `movie` / `series` with `tt` ids (or no `idPrefixes`); `subtitles.providers` when it has `subtitles` |
| `contributes.screens` | a `catalog` section when it has catalogs the admin puts there (§8.1); `title` (`meta`); `releases` is never used (Stremio has no release lists) |
| `contributes.slots` | `core.movies.rows` / `core.shows.rows` (its `movie` / `series` catalogs placed there), `core.search.filters` (its catalogs with `extra: search`) |
| `contributes.settings` | server settings the adapter reads: per catalog where it shows (§8.1); "Use for Play" / "Use for subtitles" switches; nothing per profile |

The synthesized manifest goes through `protocol.validateManifest` like any package's. A manifest Playpex refuses means the install is refused, with the reason shown.

### 5.3 Updates and configuration changes
- **Re-read daily**, and on "Check for updates". A new `version`, or a change in resources, types or catalogs, synthesizes a new manifest. More permissions (new source kinds, a new host after a redirect, adults) wait for the admin's consent, as package updates do (P4). Fewer apply at once.
- **"Change configuration"** on the plugin's page: paste a new URL from the same host. Same plugin id, data kept.
- **An add-on that stops answering** keeps its plugin, with its health shown (`health.plugin`). After 7 days of failures the dashboard says so; nothing is removed.

### 5.4 Import from Stremio (optional, last step)
"Import my Stremio add-ons": the admin signs in to their Stremio account once, through Stremio's API; the password is never stored. Playpex lists the add-ons installed there with a box each, then installs the chosen ones as in §5.1. Stremio's own default add-ons are left unticked: Cinemeta duplicates TMDB, and OpenSubtitles v3 is already a core subtitle provider.

## 6. Streams in Play

### 6.1 Asking
- **`play.collect`** gets the title `{ kind, imdbId, tmdbId, season?, episode? }` and asks `stream/movie/{imdbId}` or `stream/series/{imdbId}:{s}:{e}`. Add-ons whose `idPrefixes` exclude `tt`, and titles without an IMDb id, are not asked.
- **8 s limit** (the hook's). Bridged add-ons run in parallel, each in its own sandbox. One that's slow or failing shows in its Activity and never delays the chooser past the hook timeout.
- **Caching:** the host call keeps answers by `cacheMaxAge`, at most 6 h for streams, and serves stale answers within `staleRevalidate` while it asks again. Expired answers within `staleError` are served when the add-on fails.

### 6.2 Mapping a Stream
| Stream | Playpex source |
|---|---|
| `infoHash` (+ `fileIdx`, `sources`) | `magnet`: a magnet built with its `tracker:` entries (+ the core's trackers, as for every plugin magnet), `fileIndex` = `fileIdx`; *Torrent* group, ranked with every other plugin's torrents (one per hash, the best seeded) |
| `url` ending `.m3u8` or answering an HLS content type at play | `hls`: *Stream* group |
| any other `url` | `http` with `headers` from `behaviorHints.proxyHeaders.request`; *Stream* group, readiness "Ready" |
| `ytId` | `embed` (YouTube, plugin API 1.3) |
| `externalUrl`, archive kinds, anything else | dropped, counted in Activity ("3 streams Playpex can't play") |

- **Names.** `behaviorHints.filename`, else the first line of `title` / `description`, goes through `playpex.names.parse` / `describe` for quality, codec, audio and whether the client plays it. `behaviorHints.videoSize` gives the size.
- **Seeders.** A seeder count in the text (the `👤 123` convention and its variants) is read for ranking only and marked "(as the add-on says)". It is a convention, not protocol: decision D.
- **Label.** The add-on's `name` (its first line, e.g. "Torrentio\n4K") becomes the source's `via` label.
- **`countryWhitelist`:** streams outside the server's region (`metadata.region`) are dropped.
- **`notWebReady`** is only a hint. The player probes every file and converts audio as today.
- **`bingeGroup`** is kept on the source, to be used later by Up next (§12, step 8).

### 6.3 Playing
- **Nothing new after mapping.** Magnets go to the torrent engine and the player's `chosen` file (the `fileIndex` hint). `http` goes through `r_` refs (the server proxies the bytes, with ranges and the add-on's headers). `hls` goes through `h_` refs.
- **Redirects.** A debrid add-on's `url` usually redirects (`torrentio…/realdebrid/…` → a debrid CDN host). Every hop is checked by `http.js` with the stream hosts of §9.

## 7. Subtitles
- **When it's asked.** `subtitles.providers` (an add-on with `subtitles`) is asked with `subtitles/{type}/{id}/videoHash=…&videoSize=…&filename=….json`. The server knows the size and the file name, and computes the OpenSubtitles hash of a file on disk or of a finished download. Without them it asks with the id only.
- **What comes back.** Answers `{ id, url, lang }` become the provider's entries, fetched through the server and converted to WebVTT as every provider's are. `lang` is ISO 639-2 (`eng`), mapped to the player's languages.
- **The core's `stremio-opensubtitles` provider stays.** It needs no install. Installing the same add-on through the bridge just adds a second provider, which the admin can switch off.

## 8. Catalogs and title pages

### 8.1 Where catalogs show (decision C)
Each catalog of the add-on (`{ type, id, name, extra }`) gets a server setting "Show in", chosen on the add-on's Settings tab:

| Value | Shows as | Default for |
|---|---|---|
| Movies / TV shows | rows after the section's own (`core.movies.rows` / `core.shows.rows`); a catalog with `extra: genre` follows the section's genre filter when its options include that genre | `movie` / `series` catalogs without a required `extra` |
| Its own section | a `catalog` screen (menu entry with the add-on's name and logo): its rows, search (`extra: search`), a Genre filter (`extra: genre` options), paged rows (`skip` = 100 × (page − 1), `last` when fewer than 100 come back) | catalogs of other types (`tv`, `channel`, custom) |
| Search | a chip on the search page (`core.search.filters`) | catalogs with `extra: search` (also shown where they are placed) |
| Hidden | nowhere | catalogs whose only use needs a required `extra` the bridge doesn't know |

- **Limits.** The slot rule allows at most 3 contributions per slot and plugin; the adapter answers all of its catalogs for a slot in one contribution (`Row[]`). Each row's key is `<plugin id>:<catalog id>`.
- **Order:** the add-on's catalog order. The section's own rows come first.

### 8.2 Cards
| MetaPreview | Card |
|---|---|
| `id`, `type` | `key`; `intent`: `tt…` → `core.movie` / `core.show` (its `tmdbId` from `playpex.tmdb.find(imdbId)`, cached; nothing found → the bridged `title` screen), other ids → the bridged `title` screen `{ type, id }` |
| `name`, `releaseInfo` | `title`, `subtitle` |
| `poster`, `posterShape` (`poster` / `landscape` / `square`) | `image` through the server's image proxy (§9, decision B), `variant` |
| `imdbRating` | `rating` |

### 8.3 Title pages for ids TMDB doesn't know
- **The page.** The bridged `title` screen asks `meta/{type}/{id}`:
  - info: `name`, `description`, `genres`, `cast` / `director`, `runtime`, `releaseInfo`, `background`
  - actions: Play (a movie-like item with no `videos`)
  - rows: `videos` grouped by `season` (else one row), newest first for `channel` / `tv`
- **Playing.** Enter on a video asks `stream/{type}/{video.id}` and answers a `play` effect with its sources: one plays at once, several open the source picker.
- **Tracking:** a plugin title ref (`ref`), so resume and history work. An adults add-on gets `tracking: 'none'`, as forced for every adults plugin.

## 9. Security and privacy (decision B)

| Risk | Answer |
|---|---|
| An add-on answers malformed or hostile JSON | the host call checks every answer against `packages/protocol/stremio.schema.json` (sizes: 2 MB per answer, ≤ 500 streams, ≤ 200 metas, ≤ 5000 videos; strings capped); extra fields dropped; out of shape = an error in Activity, never a crash |
| Streams on hosts the manifest couldn't name (debrid CDNs, web hosts) | **stream hosts learned from answers**: the host call, which fetched the answer itself, records the hosts of the `url`s it carried (`grants.learn`, as `iptv.m3u` does for playlists). Those hosts are usable for that plugin's stream bytes only, never for its `http.request`. Public addresses only, every hop and redirect checked. Permissions shows "Plays streams from the addresses it lists" |
| Posters on any host | Card images through a server image proxy (`/plugins/{id}/images/{token}`, an HMAC of the URL as `r_` tokens, the image hosts learned the same way, images only: `image/*`, ≤ 5 MB, cached 24 h); clients never fetch an add-on's host |
| A URL holding a key (a configured add-on's debrid token) | kept as the plugin's server secret (encrypted like other secrets), never in `GET /plugins`, logs, Activity or the dashboard after install (shown as host + "configured"); backups and exports leave it out like other secrets |
| What the add-on learns | the server's IP address and the titles asked for. The install preview says so ("<host> sees what you look for"). Clients' addresses and profiles are never sent |
| Kids profiles | as any plugin: shown unless the admin hides it from a profile (decision E); adults add-ons never reach kids profiles (the audience rule) |
| An add-on turning adults after install | an update that sets `behaviorHints.adult` waits for consent and moves the plugin to `audience: adults` |
| The core naming sites | the core ships no add-on URL and no list; tests use a fake add-on (`test/helpers/stremio-addon.js`); `check:plugins` keeps refusing torrent sites' hosts in core code |

## 10. The dashboard
- **Plugins › Add a Stremio add-on:** a dialog with the URL field, the preview of §5.1, Configure / Install.
- **The add-on's plugin page:** the usual tabs (Overview, Permissions, Settings, Profiles, Activity, Versions). Its Overview shows the add-on's origin ("Stremio add-on at <host>"), "Change configuration" and "Check for updates". Its Settings show each catalog's "Show in" and the Play / subtitles switches.
- **The Plugins list:** a "Stremio" badge on bridged add-ons, and a filter.
- **Overview's "Add sources to play from" notice** offers "Add a Stremio add-on" beside the repositories.

## 11. Decisions (to take before building)
- **A. Where the bridge lives.**
  - (1) One plugin `plugins/stremio`, with a list of add-on URLs in its settings.
  - (2) Each add-on its own synthesized plugin, with our adapter running in the sandbox and the protocol read by a host call in the core.

  *Recommended: 2.* With option 1, the admin would manage add-ons inside one plugin's settings: no per-add-on profiles, Activity, health, consent or audience, and one slow add-on would share another's sandbox. The per-host rule would also need a hole: the plugin couldn't prove where its stream URLs came from. Option 2 puts protocol knowledge in the core, as `iptv.*` did for M3U and XMLTV, and that knowledge is neutral.
- **B. Hosts beyond the add-on's own.**
  - (1) Learned from answers the host fetched itself (streams and images only).
  - (2) `openStream` for bridged plugins (any public host for streams).
  - (3) The add-on's host only.

  *Recommended: 1.* Option 3 breaks every debrid add-on. Option 2 trusts the adapter for provenance, while option 1 only trusts what was verifiably answered.
- **C. Catalogs by default:** `movie` / `series` catalogs as rows in Movies / TV shows, others in a section of their own / everything in its own section / nothing until the admin places it. *Recommended: the first.* It is what Stremio users expect: their add-on's rows on the home screen.
- **D. Seeders from free text:** read the common conventions for ranking, marked as the add-on's / ignore them (rank by quality only). *Recommended: read them.* Torrentio-like add-ons are most of what people install, and ranking without seeders would favour dead torrents.
- **E. Kids profiles:** *Decided 2026-11-12 by the user:* like any plugin (shown unless hidden from a profile). Playpex isn't made for children; a household that lets them use it sets their profiles up itself.
- **F. Non-semver versions and missing ids:** mapped (`0.0.<n>`, an id from the URL's host) / refused. *Recommended: mapped*, so old add-ons still install.
- **G. Import from Stremio (§5.4):** in this plan as its last step / later / never. *Recommended: last step*, because it is the fastest way for a Stremio user to switch. It needs Stremio's API, which is not a documented public one: if it changes, the step goes.

## 12. Steps
0. **Spike.** Install by hand (a test script against `inspect` / the adapter) five add-on shapes:
   - a configured stream add-on with a debrid key (the user's)
   - an unconfigured torrent add-on
   - a subtitles add-on
   - a catalog + meta add-on with non-`tt` ids (anime / Kitsu)
   - a channel / HLS add-on

   Record their answers. Measure: stream answer times, redirects of debrid URLs (hosts, hops), seeders conventions, image hosts. Write down what the schema must allow. Recordings are kept out of the repository where they name torrent sites (local fixtures), as for the providers' parity test.
1. **Plugin-layer prerequisites**: [`docs/plugin-layer-plan.md`](plugin-layer-plan.md) steps 1–8 (image proxy, list settings, subtitle hash, learned hosts with provenance, trusted code and core-only calls, managed plugins). The steps below build on them: the bridge is the `stremio` provider of its §9.
1b. **Contract.** `packages/protocol/stremio.schema.json` (the answers the bridge accepts, §9 sizes); the `stremio` provider on the managed-plugin routes of the plugin-layer plan (`POST /admin/plugins/managed/stremio/inspect`, `POST /admin/plugins/managed/stremio`, `PUT /admin/plugins/{id}/managed` for a new configuration; origin `managed`, provider `stremio`); host call `stremio.get` in `plugin-api.schema.json` (core-only, plugin-layer plan §8); images through that plan's proxy; `npm run generate -w packages/protocol`.
2. **Server: install and manifests.** `lib/plugins/stremio/addons.js` (fetch, `stremio://`, manifest checks, the URL as a secret, daily re-read, consent on more), `manifest.js` (§5.2, through `validateManifest`), loading in `lib/plugins/index.js` (origin `stremio`, no package folder: `<config>/plugins/<id>/stremio.json` holds the add-on's manifest and the synthesized one), removal and rollback (the previous add-on manifest kept); `test/stremio.install.test.js` against the fake add-on.
3. **Server: streams.** The adapter's `play.collect`, the host call with caching (`cacheMaxAge` / `staleRevalidate` / `staleError`), §6.2 mapping, learned stream hosts (`grants.learn` from host-call answers), ranking with seeders; `test/stremio.streams.test.js` (every Stream kind, dropped kinds counted, a debrid redirect to a learned host played as `r_`, a redirect to a private address refused, an oversized answer refused); the TV scenario `play-chooser.js` with the fake add-on (its torrents in *Torrent*, its link in *Stream*).
4. **Server: subtitles.** The adapter's `subtitles.providers`, the OpenSubtitles hash of disk files (`lib/subtitles/hash.js`), language mapping; tests.
5. **Catalogs and meta.** The adapter's slots and screens (§8), "Show in" settings, the `tmdb.find` mapping with its cache, the image proxy with learned image hosts; the TV scenario `catalog.js` and a new `stremio.js` (rows in Movies, its section with search and genre, a Kitsu-like title page, play from a video); Playpex Mobile checked against the same server (no code changes expected).
6. **Dashboard.** The Add dialog and preview, Configure flow, the plugin page's Overview additions and catalog placement, the Stremio badge and filter, the Overview notice's button; screenshots.
7. **Docs.** `docs/plugins/stremio.md` (for admins: adding, configuring, what works and what doesn't; for add-on authors: "your Stremio add-on in Playpex", the mapping tables of §6–§8), `docs/plugins/security.md` (learned hosts from host-call answers), the CLAUDE.md guides, this plan's status line, `docs/providers-plan.md` decision H pointing here.
8. **Later, each on its own:** Import from Stremio (§5.4, decision G); Up next preferring a source of the same `bingeGroup`; Search's stream group asking bridged add-ons' search catalogs; `addon_catalog`; archive kinds (`rarUrls`… read by the server).

### 12.1 Spike results (step 0, 2026-11-12)
The script and its recordings are outside the repository: `~/projects/playpex-spikes/stremio-2026-11-12/` (`spike.js <out dir> [manifest URL…]`, `more.js`; `rec/` one file per answer, `rec/report.json` the measures). They name torrent sites, so they are never committed. The fake add-on of steps 2–5 copies their shapes, not their content. Asked:
- **Torrentio**, unconfigured (torrents).
- **OpenSubtitles v3** (subtitles).
- **Anime Kitsu** (catalogs and meta, `kitsu:` ids).
- **Cinemeta** (`tt` catalogs, for comparison).
- **Radios** (a channel-like add-on of type `music`).
- **Anthony Bourdain Fans** (a series of its own with HLS).
- **Peario** (`externalUrl` only).
- USA TV no longer exists (`ENOTFOUND`).

**Not done yet:** a configured debrid add-on (the user's URL; the script resolves one link of it only, because resolving adds the torrent to the debrid account). Debrid redirect hops and hosts, whether links are tied to the asking IP (§13), and the debrid `url` streams' names remain to be measured.

**Speed and caching.**
- Manifests answer in 60–650 ms.
- Torrentio answers streams in 76–340 ms. Twelve titles in a row gave no refusal and no slowdown.
- Torrentio sends `Cache-Control: max-age=3600, stale-while-revalidate=14400, stale-if-error=604800`, and the same values in its body (`cacheMaxAge`, `staleRevalidate`, `staleError`).
- Kitsu's catalogs: `max-age=43200`. Cinemeta: `max-age=14400`.
- **So:** the body's values first, then the headers, then our defaults (§6.1).

**Sizes.**
- The largest answer was 551 KB: Cinemeta's series catalog, whose 50 metas carry their `videos` (745 thumbnails).
- Torrentio returns at most 500 streams itself (250 KB for 500).
- Catalogs held 20–70 metas.
- **So:** §9's limits hold (2 MB, 500 streams, 200 metas). A catalog's metas lose their `videos`: cards don't need them.

**Torrentio's streams** (the shape most add-ons copy).
- `name` is `"Torrentio\n4k HDR"`: the add-on and a quality line.
- `title` is several lines: the release name, then the file inside a pack, then `👤 <seeders> 💾 <size> ⚙️ <site>`, then an optional line of language flags. Newer add-ons put the same text in `description`; both are read.
- Fields present: `infoHash` on all, `fileIdx` on 60 %, `behaviorHints.filename` (the file in a pack), `behaviorHints.bingeGroup` on 90 %, `sources` (`tracker:…` / `dht:…`) on 15 %. No `videoSize`.
- **So:** decision D is confirmed. Seeders come from `👤 (\d+)`, the size from `💾 ([\d.]+) (GB|MB)`, the site from `⚙️ (.+)`. The release name is the `filename`, else the first line of `title` after the add-on's name.

**Anime and Kitsu ids.**
- Kitsu's ids are `kitsu:<n>`, its videos' ids `kitsu:<n>:<episode>`, of type `anime` (`animeType` TV or movie).
- Its metas carry `imdb_id`, and its videos carry `imdb_id` / `imdbSeason` / `imdbEpisode`. Most anime therefore map to a TMDB title through `tmdb.find` on that IMDb id, not by name.
- Torrentio answers `kitsu:` ids too (281 streams for one episode), and Kitsu itself offers `subtitles` for them.
- **So:** type `anime` is accepted and treated as `series` (a movie when `animeType` says so). The ids an add-on declares are kept as they are and asked as they are.

**Subtitles.**
- OpenSubtitles v3's `lang` is ISO 639-2/B (`eng`, `fre`, `ger`, plus `pob` for Brazilian Portuguese), so a mapping table to our languages is needed.
- Files come from `subs5.strem.io` as `application/x-subrip`, already converted to UTF-8. `SubEncoding` gives the original encoding.
- One file answered 520, so a failing file must not fail the list.
- A made-up `videoHash` with a file name gave the same 80 results in the same order as asking with the id alone. Whether a real hash reorders them is measured with a real file in step 4.

**Image hosts:** `media.kitsu.app`, `assets.fanart.tv`, `images.metahub.space`, `episodes.metahub.space`, `live.metahub.space`, `i.radionomy.com`, `i1.wp.com`. None of them is the add-on's own host, so learned image hosts (decision B) are needed for every catalog add-on.

**Other streams.**
- Radios: type `music`, ids such as `radios:99555531|<base64>` (`|` and `=` in ids), and endless `audio/mpeg` over plain `http://…:80`.
- Bourdain: its `tt` ids have its own metas, and its HLS points at a DailyMotion host that no longer resolves.
- Peario: `externalUrl` only.
- An unknown id answered 404 with 9 KB of HTML.
- **So:**
  - Types Playpex has no place for (`music`, `Dice`, `other`…) are dropped from what an add-on offers.
  - Ids go into paths URL-encoded.
  - `externalUrl` is dropped and counted.
  - A 404 means "no streams", not an error.
  - A dead stream host is a failed source in the chooser, not a failed add-on.
  - Learned stream hosts are **https only**. Plain http stays for hosts the admin granted (decision J of the providers plan), so the radio add-on's streams are dropped and counted.

**Manifests.**
- `resources` come both as strings and as objects with their own `types` / `idPrefixes`.
- Versions like `0.0.15` are semver already.
- `behaviorHints.configurable` / `configurationRequired` say whether a Configure page exists (§5.1).
- Stremio's own public collection (`api.strem.io/addonscollection.json`, 97 add-ons) lists a configured add-on whose path holds a Trakt access token. This confirms that the add-on URL is kept as a secret and never logged or shown (§9).

**What the schema must allow:**
- `resources` as strings or objects.
- Any string as a type, kept only when Playpex has a place for it.
- Ids up to 512 characters with any printable character.
- Streams without `name`, with `title` or `description`, and with unknown fields (dropped).
- Metas with extra fields (`posterShape`, `trailers`, `links`, `popularities`…), kept only for the fields §8.2 uses.
- `cacheMaxAge` / `staleRevalidate` / `staleError` beside `streams`, `metas`, `meta` and `subtitles`.

### 12.2 What was built, and how it differs from the steps above
- **The contract is code, not a JSON Schema.** `packages/protocol/stremio.js` cleans every answer:
  - It keeps the fields Playpex uses, caps strings and lists (§9's sizes), and drops what is out of shape.
  - It also holds `addonUrl` (`stremio://` → https; `configured` when a path comes before manifest.json), `requestPath`, `offers` (id prefixes count for items, never for catalogs), the seeders and size conventions, and ISO 639-2 → 639-1.
  - There is no `stremio.schema.json`: its shapes would have duplicated the cleaners.
- **No separate install route.** Add-ons go through the managed-plugin routes of the plugin-layer plan:
  - `POST /admin/plugins/managed/stremio/inspect { input: { url } }` → a preview (with a `summary` of what the add-on offers), installed by its token as any package.
  - `PUT /admin/plugins/{id}/managed` takes a new configuration (the same add-on: same id).
  - `POST …/managed/check` checks for updates.
  - The URL is the plugin's `managed:input` secret.
- **Three core-only calls** (`lib/plugins/stremio/index.js`) instead of one `stremio.get`:
  - `stremio.addon`: the add-on and the admin's catalog placements.
  - `stremio.get`: an answer; a catalog's metas get their TMDB id through `tmdb.find`, cached.
  - `stremio.streams`: every bridged add-on's streams for an id, for title pages: a Kitsu episode plays from Torrentio. Their hosts are learned for the asking plugin.
- **Fetching** (`lib/plugins/stremio/fetch.js`):
  - The first request is always to the add-on's own address (any port and scheme, as a granted host).
  - Its redirects may go to any public https host: Cinemeta's catalogs live on another host. The spike found this, and the real-add-on trial confirmed it.
  - Answers are cached by `cacheMaxAge`, `staleRevalidate` and `staleError` (at least a day of `staleError`), 64 MB in all.
- **Redirects and HLS parts.**
  - Shipped code may carry options (`builtin/<name>/builtin.json`). The bridge's `openStreams: true` lets a stream's redirects and an HLS playlist's parts go to any public host.
  - This is decision B with one widening: a debrid link redirects to a CDN that no answer names.
  - `http.request` takes an internal `scope` ('stream') so subtitle files can come from hosts an answer named. Plugins' own requests can't pass it.
- **Learned stream hosts are https only.** A plain-http stream from an add-on is dropped (decision J of the providers plan keeps plain http for addresses the admin types).
- **Play.** At most 50 sources (the hook's limit). Links come first in the add-on's order, then torrents by seeders as the add-on says (one per hash), then the core ranks everything. YouTube is used on title pages only: `embed` is for play effects.
- **The manifest** (`lib/plugins/stremio/manifest.js`):
  - Id `st-<slug>-<4 hex>`, the hash over the add-on id and its configured address.
  - Settings `play`, `subtitles`, and per catalog `c<8 hex>`: a choice of its places.
  - A section only when some catalog may go there.
  - The add-on's logo (png / jpeg / webp, ≤ 256 KB) as its icon, else a plain mark.
  - The adapter registers only the hooks its manifest has (found against real add-ons: a subtitles-only add-on must start).
- **Paging.** Stremio's `skip` counts items already shown, so the adapter learns a catalog's page size from its first page (Cinemeta answers 49).
- **Not built:**
  - Countries (`countryWhitelist`): the region isn't passed yet, so these streams are kept.
  - The health notice after 7 days of failures.
  - The Plugins list's Stremio filter: the badge is there.

### 12.3 Step 8 (built 2026-11-12, uncommitted)
- **Import from Stremio** (`lib/plugins/stremio/account.js`, decision G).
  - Routes: `POST /admin/plugins/managed/stremio/import { email, password }` → `{ session, addons }`, then `POST …/import/{session} { keys }` → `{ installed, failed }`.
  - The server signs in to Stremio's account API (`api.strem.io`: `login`, `addonCollectionGet`) and signs out (`logout`) before it answers. The password and Stremio's session are never stored, logged or answered.
  - The add-ons' addresses stay on the server in the import session (15 minutes, used once). The dashboard sees names, hosts and what each offers.
  - Stremio's own add-ons come unticked. Local ones (`127.0.0.1:11470`) and those Playpex can't use can't be ticked.
  - Each chosen add-on installs through the bridge's inspect and install, accepted.
  - Dashboard: the Stremio add-on tab's "Or import the add-ons of my Stremio account" (`components/stremio-import.tsx`).
- **Up next by `bingeGroup`.**
  - Plugin sources carry `bingeGroup` (`plugin-api.schema.json`: magnet, http, hls), and the pipeline's sources too (`PlaySource.bingeGroup`).
  - `PlaySourcesRequest.bingeGroup` ranks that group's sources first, a file on this server still before them (`lib/play/index.js#sameGroupFirst`).
  - Playpex TV (`PlaybackRequest.bingeGroup`, `EpisodePlaybackService.bestSource(next, group)`) and Playpex Mobile (`UpNext`, `findSources`) send the group of what plays.
- **Search.** A bridged add-on with a movie search catalog answers `sources.search`: its first three films, and every bridged add-on's streams for them (`stremio.streams`).
- **`addon_catalog`.**
  - `cleanManifest` keeps `addonCatalogs`, and `clean('addon_catalog')` keeps the add-ons listed.
  - `GET /admin/plugins/{id}/stremio/addons` offers them as an import does, none ticked. A listed address that holds a configuration is someone else's and can't be installed.
  - Dashboard: the plugin page's "Add-ons it lists".
- **Found on the way:**
  - `configured` now means a configuration-like path (a segment with `=` `|` `,` `%` `{`, or of 24+ characters). Before, any path counted, which marked add-ons living under a path (Public Domain Movies) as configured.
  - A server update whose rebuilt add-on asks for more no longer stops it. The add-on is rebuilt at once on the new code with its permissions as they were, and the bigger build waits under Check for updates (`lib/plugins/managed#refresh`).
- **Archive streams**, built after the rest at the user's request:
  - `lib/media/archive.js` reads an archive's headers with ranges and maps its file onto byte ranges of the parts. RAR 4 and RAR 5 in several volumes; zip with stored entries and zip64; tar with GNU long names and pax paths. Zip and tar parts are joined.
  - The file is chosen by `fileMustInclude`, else `fileIdx`, else the largest video that isn't a sample. Compressed or encrypted files are refused (`UNSUPPORTED`).
  - Plugin `http` sources take `archive { format, parts, fileIndex?, fileMustInclude? }` (every part's host checked), and `r_` refs serve them (`lib/plugins/remote.js`: indexed on first use, the Media is the inner file).
  - The bridge maps `rarUrls` / `zipUrls` / `tarUrls`. `7zipUrls` and `tgzUrls` can't be seeked, so they're dropped and counted.
  - Tests: `test/archive.test.js` (RAR 4 / 5 made by `test/helpers/rar-writer.js` and checked with `unrar t`, plus a real `zip -0` and a GNU / pax `tar`; every range against the original) and `test/stremio.test.js` (a rar of three volumes played with ranges through the server).
  - Not done: direct downloads of an archive's file (`remote.source` answers null for them) and Usenet (`nzbUrl`).

## 13. Open questions
- **Stremio's own servers.** Do add-ons hosted on `*.strem.fun` / `*.strem.io` rate-limit a server that asks for every title a household browses? The step-0 spike measures this. Answer: the cache of §6.1, plus asking only when a title page opens rather than on focus. Spike (§12.1): twelve Torrentio titles in a row, no refusal or slowdown; it sends an hour's cache itself.
- **Several configured copies of one add-on** (two debrid accounts): the ids allow it (§5.1). Should the chooser merge their identical torrents? Today's `ranked` keeps one per hash, which is right.
- **Add-ons that need the client's IP** (some debrid services tie links to the IP that asked). The server asks and streams, so the IP is the same. Confirm in the spike.
- **Licence.** Bridged add-ons are third-party services Playpex only talks to, so the licence question is like M3U playlists, not like ported code (The Crew, OpenScrapers). Nothing is copied, so no GPL obligation arises.
