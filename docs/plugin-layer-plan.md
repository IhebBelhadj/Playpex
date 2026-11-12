# Plugin layer: list settings, image proxy, managed plugins

Status: **steps 1–9 built 2026-11-12** (decisions A, B, D–G taken as recommended, C dropped with step 4; the user asked to implement the plan). **Step 1** (images): `lib/plugins/images.js` (`rewrite` of the keys `image` / `backdrop` / `poster` at the client's exits: `POST /plugins/{id}/data/{name}` answers, live programmes (`apiPath`), search results' posters; tokens = base64url of the URL + an HMAC of plugin id + URL with a key derived from `secrets.key` (`secretBox.derive`): stable across restarts, nothing stored, so no `plugin_images` table; `GET /plugins/{id}/images/{token}` fetches through `http.stream` with scope `image`, sniffs JPEG / PNG / WebP / GIF / AVIF, ≤ 5 MB, `<cache>/plugin-images/` 24 h, ≤ 500 MB least recently used first, refusals 404 cached 10 min and logged with their host), `permissions.images`, `image.tmdb.org` always allowed, `GET /plugins` `imagesProxied`, the TV's `asset()` and its releases template resolving `images/…` (Mobile's `pluginImage` already did), live logos the plugin can't stream from go through the proxy too. Deviations: image fields found by key, not by an `x-image` schema annotation; no `check:plugins` rule on recorded answers (the survey found every first-party plugin's code hosts declared; **Velvet's pictures from sites' answers (ThePornDB's picture host and others) aren't declared and will 404 until its manifest lists them: the refusal log line names each host**); the kids rule for pictures isn't applied (an `<img>` carries no profile). Test `test/plugins.images.test.js`. **Step 2** (lists): `type: list` (`fields` / `item`, `$defs/listField`, `listItem`, `listOptions`; `listProblems` in `plugins.js`), `settings.js` (`normalizeList`: ids `e_` + 8 base32, kept; `listProblem` naming the entry), defaults `[]`, `grantingSettings` → list fields, `grants.refresh` per entry, `describe` naming the list, the dashboard's `EntryList` / `ValueList`, `plugins/hello`'s `shelves` and `favourites`, `PluginSettingDefinition` in `openapi.yaml`. Deviation: **no `secret` fields in lists** (secret names can't say `<list>.<field>`; nothing needs it yet). Test `test/plugins.settings.test.js`. **Step 3** (migrations): `contributes.migrate`, `lib/plugins/migrate.js` (`run(id, fromVersion)` after an update's load in `install.js#installStaged`, not after a rollback; `services.plugins.settings.rows`), **M3U 2.0.0** (`playlists` ≤ 20 with `name`, `url`, `guide`, `on`; `groups` a list; channel ids of the other playlists prefixed `<entry id>:`; its `migrate`). Deviation: no `secrets` moves (no plugin needs one). Not done: M3U 2.0 packed and signed into the official repository (the user's release step). Tests in `test/live.test.js`. **Step 4** (kids defaults): built, then dropped by the user the same day (see §5; its migration never released); **Treat as adults** built in its place (§5). **Step 5** (hash): `lib/subtitles/hash.js`, `GET /subtitles/search?ref=` (the TV player sends its ref): name, size and hash (files on disk, finished downloads) into `subtitles.providers` (`hash`) and the core's Stremio OpenSubtitles provider (`videoHash` / `videoSize` / `filename`). Not done: a torrent file still downloading (its first and last 64 KB). Test `test/subtitles.hash.test.js`. **Step 6** (learned hosts): `grants.learn(plugin, url, urls, { scope, from })` (`stream` / `image`, `document` / `answer`, least recently used out past 5000), `match(…, { image })`, `http.stream({ scope: 'image' })`, M3U logos learned as pictures. **Step 7** (trust): `lib/plugins/builtin/` (shipped code hashed at start, `register` for tests), `lib/plugins/corecalls.js`, `playpex.core.call`, a `managed` load refused unless its code is shipped code. Deviation: hashes computed when the server starts rather than at build time (same guarantee: whoever changes the server's own files owns it). Test `test/plugins.trusted.test.js`. **Step 8** (managed): `lib/plugins/managed/` (providers, `inspect` / `reconfigure` / `check` → staged previews installed by token, `refresh` at start and daily, `managed.json`, the input sealed as secret `managed:input`), `install.js` (origin `managed` trusted, `stageFiles` exported, rollback of a managed build), routes `/admin/plugins/managed*`, `/admin/plugins/{id}/managed[/check]`, the dashboard's "Made by Playpex" and Check for updates. Deviation: the refactor reuses `stageFiles` rather than a new "candidate" layer (the same thing, smaller). Test `test/plugins.managed.test.js`. **Step 9**: this status, the author guide, the CLAUDE.md guides. Also fixed: `test/hls.test.js`'s forged token was the real one 1 time in 4096. Verified: the server suite (454 tests), `check:plugins`, the TV and dashboard typecheck; not seen in a browser: the dashboard's list editor and kids select (typechecked only), the TV with proxied pictures (typechecked only). Next: the Stremio bridge (`docs/stremio-bridge-plan.md`, step 0).

It extends the plugin contract of `docs/plugins-plan.md` (P0–P6 done) to **SERVER_PLUGIN_API 1.5**. All changes add to the contract except the image rule of §3, which tightens it (decision B). Read `docs/plugins/` (manifest, server, tv, security), `apps/server/CLAUDE.md` and the root `CLAUDE.md` first.

---

## 1. Goals

1. **List settings.** A setting can hold any number of entries, either plain values (a list of words) or records with fields (a playlist with its guide). The admin adds, removes and reorders them on the dashboard, within the manifest's `maxItems`. Each entry keeps a stable id. A `url` field with `grantsHost` grants each entry's host.
2. **Settings carried across updates.** A plugin update can rename or restructure its settings with a migration handler, so admins never lose what they typed. M3U 2.0 moves its ten keys into one list this way.
3. **Clients never fetch a plugin's images from third-party hosts.** Every image URL a plugin answers is rewritten to the server's image proxy, fetched as the plugin with the address rules on every hop, checked to be an image, and cached. This closes a gap that exists today (§2).
4. ~~**Kids profiles get a default per plugin.**~~ **Dropped 2026-11-12 by the user** (built, then taken out): Playpex isn't made for children, so a household letting children use it sets up their profiles itself (hiding plugins per profile, as before, on a plugin's Profiles tab), and admins shouldn't have to change a default on every plugin.
5. **Subtitle providers can match by the file's hash.** `subtitles.providers` receives the OpenSubtitles hash when the server can compute it.
6. **Hosts learned from answers the server fetched itself.** `grants.learn` today serves only `iptv.m3u` documents. It becomes a general rule with a provenance and a scope (`stream` or `image`).
7. **Trusted code and core-only host calls.** Code shipped with the server, verified by hash at load, may use host calls no package can.
8. **Managed plugins.** A plugin can be generated by the core rather than unpacked from a `.ppx`: a built-in provider gives its manifest and files. It goes through the same staging, permission diff, consent, update and rollback as a package.

Non-goals:
- Several plugins sharing one sandbox (measured in the bridge's spike first).
- Trackers from plugins' magnets (the rule stays: the server's own trackers only, `docs/plugins/server.md`).
- Settings in clients (they stay dashboard-only).
- Nested lists (a list inside a list's entry).

## 2. Where things are today (2026-11-12)

| Area | Today | File |
|---|---|---|
| Setting types | `switch`, `choice`, `slider`, `number`, `text`, `url`, `secret`, `action`: one value each | `packages/protocol/plugin.schema.json` `$defs/setting`, `apps/server/lib/plugins/settings.js#problem` |
| Stored values | `plugin_settings (plugin_id, scope, owner_id, key) → value` as JSON (so arrays need no migration); secrets apart (`s.plugins.secrets`) | `apps/server/lib/db/schema.js:506`, `lib/plugins/settings.js` |
| Reading them | `playpex.settings.get(key)` → the value; `playpex.secrets.get(name)` | `lib/plugins/host.js:119-145` |
| Granted hosts | every `url` setting with `grantsHost` (one host each); `streamHosts` hosts learned from the document `iptv.m3u` fetched there | `lib/plugins/grants.js`, `protocol.grantingSettings` / `grantOf` |
| The dashboard's form | one control per setting, grouped by `group` | `apps/dashboard/src/components/plugin-settings.tsx` (453 lines) |
| M3U | `playlist`, `guide`, `playlist2` … `guide5` (5 fixed pairs), `PLAYLISTS` in its code, channels tagged with the pair's number | `plugins/m3u/playpex-plugin.json`, `plugins/m3u/server.js` |
| Plugin images | the TV keeps any `https://` image as it is and loads it from that host (`plugin-client.service.ts:173-178`); the docs say "on a declared host", nothing checks it. Image fields: `card.image`, `titleInfo.backdrop`, `release.image` / `poster`, `channel.logo`, `programme.image`, `playRequest.artwork`, action / notification `icon` (an `assets/…` or a URL) | `apps/tv/src/app/plugins/plugin-client.service.ts`, `plugin-api.schema.json` |
| Kids profiles | `audience: adults` plugins never reach them; otherwise a plugin is shown to every profile but those the admin hid it from (a list of hidden profile ids) | `lib/plugins/index.js#blocked`, `refreshHidden` |
| Subtitle hook input | `{ title, languages, fileName?, size? }` | `docs/plugins/server.md` |
| Learned hosts | `grants.learn(plugin, url, urls)` only for a `streamHosts` setting's document, in memory, ≤ 5000, streams only | `lib/plugins/grants.js` |
| Host API | the same for every plugin, gated by its permissions; core principals (`links`, `repositories`) with `anyHost` / `openStream` never run plugin code | `lib/plugins/host.js`, `http.js#target` |
| Install pipeline | `stage(buffer)` → `stageFiles(found, from, size)` → preview, permission changes → `commit` → `installStaged`; the previous version kept for rollback; trust from a signature (`trustOf(signer)`) or developer mode | `lib/plugins/install.js` |
| Loading | `load(dir, origin)`: any folder with `playpex-plugin.json` + `server.js` | `lib/plugins/index.js:120` |

## 3. Images through the server (decision B)

### 3.1 Rewriting
- **Where.** When a plugin's answer leaves the server, the core rewrites its image URLs. That covers screen data, slot data, effects, release lists, channels and programmes, notifications and `GET /plugins` icons. One function, `lib/plugins/images.js#rewrite(plugin, value, schemaPath)`, walks the answer by the schema's image fields (listed in `plugin-api.schema.json` with a new annotation `"x-image": true`, so a new field can't be forgotten).
- **What it becomes.** `https://…` (and `http://…` on a granted host) becomes `<api>/plugins/{id}/images/{token}`.
  - The token is an HMAC (the server's persistent secret from `auth.json`) of `plugin id + URL`.
  - Tokens are stable across restarts, so clients' HTTP caches keep working.
  - The URL itself is kept in a table, so the token stays short: `plugin_images (token, plugin_id, url, created_at)`, rows unused for 30 days dropped.
- **What stays as it is.** `assets/…` stays the package's asset route. Anything else becomes `null` and is counted in the plugin's Activity ("2 pictures refused: not an address").

### 3.2 Serving
- **Fetching.** `GET /plugins/{id}/images/{token}` (any paired client; a kids profile can't reach an adults plugin's images: the plugin's own rule) fetches with `http.js#stream`, as the plugin: its hosts, the address rules on every hop, at most 5 redirects.
- **The host must be allowed:**
  - in `permissions.network`, or
  - in the new `permissions.images: [hosts]` (shown as "Shows pictures from …"), or
  - granted by a `url` setting, or
  - a learned `image` host (§7).
- **The content must be a picture:**
  - Its first bytes must be JPEG, PNG, WebP, GIF or AVIF (whatever the `Content-Type` says).
  - SVG is refused, because it can carry scripts. Plugins put SVG icons in `assets/`.
  - At most 5 MB.
- **Caching.**
  - Cached on disk in `<cache>/plugin-images/`, 24 h, at most 500 MB (least recently used first), served with `Cache-Control: max-age=86400`.
  - A failure answers 404 with no body, so clients show their placeholder, and is cached for 10 min.
- **Sizes.** `?w=` (342 / 780 / 1280) resizes nothing in v1 and is ignored. Resizing could come later with `sharp`, but nothing asks for it yet.

### 3.3 Clients
- **The TV** (`plugin-client.service.ts#asset`) accepts the server's paths (`/plugins/{id}/images/…`, resolved against `server.api`) and, from API 1.5 on, **drops raw `https://` URLs**. A 1.4 server still sends them, so the TV keeps accepting them from servers older than 1.5 (feature-detected through `GET /plugins` `imagesProxied: true`).
- **Playpex Mobile** does the same (`apps/mobile/src/…/plugins`).
- **The dashboard's plugin pages** use the same routes.

### 3.4 Today's plugins
- **Survey the current plugins.** A one-off script (`apps/server/scripts/plugin-image-hosts.js`) runs every first-party plugin's screens against recordings and lists the image hosts they answer. Each plugin gets those hosts in `permissions.network` or `permissions.images`, and a new version.
  - Velvet, YouTube (`i.ytimg.com`), Trakt (TMDB images: `image.tmdb.org`, which every plugin may use without declaring it, as for `playpex.tmdb.image`), Archive, m3u (channel logos: learned `image` hosts from its playlists, §7).
- **`check:plugins` gains a rule:** a first-party plugin's recorded answers use only declared image hosts.

## 4. List settings (decision A)

### 4.1 In the manifest
```json
{
  "key": "playlists", "scope": "server", "type": "list", "label": "Playlists",
  "description": "Each playlist's channels are added to the lineup, in this order.",
  "itemLabel": "Playlist", "titleField": "name", "minItems": 0, "maxItems": 20,
  "fields": [
    { "key": "name",  "type": "text", "label": "Name", "maxLength": 60 },
    { "key": "url",   "type": "url",  "label": "Playlist address", "grantsHost": true, "streamHosts": true },
    { "key": "guide", "type": "url",  "label": "Guide address (XMLTV)", "grantsHost": true },
    { "key": "on",    "type": "switch", "label": "Use it", "default": true }
  ]
}
```
and a list of plain values:
```json
{ "key": "groups", "scope": "server", "type": "list", "label": "Only these groups",
  "item": { "type": "text", "maxLength": 60 }, "maxItems": 100, "unique": true }
```

- **`fields` or `item`, never both.**
  - `fields` (≤ 10): field definitions written like settings, without `scope` / `group` / `level`. Their types can be `switch`, `choice`, `slider`, `number`, `text`, `url`, `secret`. No `action` and no `list`, since lists don't nest.
  - `item`: one such definition, without `key` / `label`.
- **Inside an entry,** `visibleIf` / `enabledIf` may name the entry's own fields (`{ "field": "kind", "is": "xtream" }`).
- **Sizes.** `maxItems` is required, ≤ 100 (≤ 1000 for `item` lists of `text`). `minItems` defaults to 0. `default` is an array, `[]` when left out.
- **Optional extras:**
  - `unique` (`item` lists): no repeated values.
  - `titleField` (`fields` lists): the field shown as an entry's title on the dashboard (else "<itemLabel> 1, 2, …").
  - `itemLabel`: the label of one entry.
- **Checked by `protocol.checkManifest`:**
  - keys are unique in the list
  - `streamHosts` needs `grantsHost`, as for single settings
  - a `secret` field is declared in `permissions.secrets` as `<list key>.<field key>`

### 4.2 Values and ids
- **What is stored.** A `fields` list's value is `[{ id, …fields }]`. `id` is made by the server when an entry is added (`e_` + 8 random base32 characters) and never changes when the entry is edited or moved, so a plugin can tie state to it (M3U's channel ids, §4.5). An `item` list's value is `[value, …]`.
- **Checking.** `settings.js#problem` checks the whole array: its length, each entry against its field definitions (the existing per-type checks, reused), `unique`, and no unknown fields. Saving an invalid list is refused with each problem's path (`playlists[2].url: …`).
- **Secrets.** A `secret` field never enters the stored array. It is stored in the secrets table as `<list key>.<entry id>.<field key>`, removed with its entry, and shown to the dashboard as "set" / "not set". Handlers read it with `playpex.secrets.get('<list key>.<field key>', { entry: id })`.
- **Reading.** `playpex.settings.get('playlists')` answers the array (secret fields left out). Nothing else changes for plugins.

### 4.3 Granted hosts from lists
- **What counts.** `protocol.grantingSettings` also returns list fields with `grantsHost`. `grants.refresh` reads every entry's value: an entry switched off by a `switch` field named `on` still grants its host while the plugin may fetch it, so only `visibleIf`-hidden fields don't count.
- **Permissions.** The Permissions tab lists each granted host with its entry ("Talks to iptv.example.net (Playlists › Sports)").
- **Stream hosts.** `streamHosts` hosts are learned per entry. Removing an entry forgets what its document listed.

### 4.4 The dashboard
`plugin-settings.tsx` gets a list editor:
- **Each entry is a collapsible card,** titled by its `titleField` or its number. It holds the entry's fields (the existing controls) and a summary line when collapsed (its URL's host, its switch).
- **Add and remove:** an "Add <itemLabel>" button disabled at `maxItems`, and Remove with an Undo toast.
- **Reorder:** drag handles plus Move up / Move down for keyboards.
- **`item` lists** are shown as chips with a field to add one (Enter), each chip removable. Text items longer than 30 characters are shown as rows instead.
- **Saving:** the whole list is saved at once, like the rest of the form. Problems are shown on their entry's field.

### 4.5 Migrations across updates
- **Declaring one.** `contributes.migrate: "<data handler name>"` (1.5). After an update is committed, and before the new version's first hook runs, the core calls it once with `{ fromVersion, server: values, profiles: { <profile id>: values } }` (the old manifest's keys, secrets left out).
- **Its answer** is `{ server?, profiles? }` with values for the new manifest's keys. The core checks them as a save from the dashboard would, drops unknown keys, saves them in one transaction, and logs the result in the plugin's Activity.
- **Failure.** A failing or invalid migration keeps the old values, so a rollback finds them. The plugin starts with its defaults, and the dashboard says "Settings from <old version> not carried over: <reason>".
- **Secrets** are moved by the handler's `secrets: [{ from, to, entry? }]` (names only; the core moves the values, so the handler never reads them).
- **New list entries** answered without ids get one.

### 4.6 M3U 2.0
- **Manifest:** `playlists` as in §4.1, with `maxItems: 20`; `groups` becomes an `item` list (it was comma-separated text); `playlistGuide` stays.
- **Code.** The code reads `playlists`. Channel ids become `<entry id>:<the host's id>` for every playlist but the first one migrated, which keeps its ids as before, so favourites and the guide's cache survive.
- **Migration.** Its `migrate` handler turns `playlist`/`guide` 1–5 into entries, in order, named after their host, and splits `groups`.
- **Release.** Published in the official repository as 2.0.0. The `docs/plugins/manifest.md` example uses it.

## 5. Kids profiles: a default per plugin (dropped), and "Treat as adults" (built instead)
**Dropped 2026-11-12 by the user** (built, then taken out): Playpex isn't made for children, so a household letting children use it sets up their profiles itself (hiding plugins per profile, as before, on a plugin's Profiles tab), and admins shouldn't have to change a default on every plugin.

**Treat as adults** (asked by the user the same day, built): an installed plugin's page, Profiles tab, has a switch **Treat as adults** (`PATCH /admin/plugins/{id} {adults}`; column `plugins.adults`, migration `0019_plugin_adults`, kept across updates). On, the loaded manifest says `audience: 'adults'` (`lib/plugins/index.js#refreshAudience`, at load and at once after the switch), so every rule of adults plugins holds: no kids profile (client view, data calls, hooks, events, notifications, links, its Profiles tab), plays with `tracking: 'none'`, no writes but downloads (`writes.js` now reads the audience at each call), cast refused as or to a kids profile. **Stricter only**: `declaredAudience` keeps the manifest's word, and what an adults plugin may get *more* (TMDB's adult titles, `core.js`) follows it, never the switch; turning it off for a plugin whose manifest declares adults is refused (409). Developer copies have no install row: no switch. `AdminPlugin.audience` is what applies, `declaredAudience` / `adultsByAdmin` beside it. Tests in `test/plugins.settings.test.js`.

## 6. The OpenSubtitles hash for subtitle providers
- **The hash** goes in `lib/subtitles/hash.js`: the file's size plus the 64-bit sum of its first and last 64 KB, as hex.
- **When it can be computed:**
  - a file on disk (the library, a finished download)
  - a torrent's file whose first and last 64 KB pieces are already downloaded (the engine fetches the tail early for MKV indexes)
  - otherwise not sent
- **The hook's input** becomes `{ title, languages, fileName?, size?, hash? }` (1.5). The core's own `stremio-opensubtitles` provider sends it too (`videoHash` / `videoSize`), so subtitles match the exact release more often.

## 7. Learned hosts, generalized (decision D)
- **New signature:** `grants.learn(plugin, urls, { from, scope })`.
  - `from` is `{ kind: 'document', setting, entry? }`, as today for `iptv.m3u`, or `{ kind: 'answer', call }`: the answer of a core-only host call (§8). Either way the server itself fetched the URLs.
  - `scope` is `stream` (a source's bytes, never `http.request`) or `image` (§3 only).
- **What callers can do.** A plugin's own code can never make the server learn a host. Only the host functions that fetched the document or answer call `learn`.
- **Limits:** ≤ 5000 hosts per plugin and scope, least recently used first. Kept in memory: a restart forgets them, and the next document or answer teaches them again. `r_` / `h_` refs and image tokens made from them keep working until the restart, then they're made again.
- **`iptv.m3u` also learns its channels' logos** as `image` hosts. This replaces M3U's need to declare logo hosts, which it can't know.
- **The Permissions tab** says "Plays streams from the addresses <its playlist / its answers> list" and "Shows pictures from the addresses … list".

## 8. Trusted code and core-only host calls (decision E)
- **What's trusted.** A plugin is `trusted` when its `server.js` is byte-identical to code the server ships: `apps/server/lib/plugins/builtin/<name>/server.js`, with its SHA-256 recorded at build time in `builtin/index.js`. Checked at every load, so a modified file is untrusted and fails to load as a managed plugin.
- **Core-only calls.** Host functions in `host.js` can be marked `core: true`:
  - `prelude.js` exposes them only to trusted plugins.
  - `host.js` refuses them (`denied`) for others, whatever their manifest says.
  - `checkManifest` refuses packages that name them anywhere.
  - Their calls show in Activity as any host call does.
- **What trust doesn't change:** the sandbox limits, the hook timeouts, the plugin's permissions, the address rules. Trusted code is still sandboxed. It is trusted to tell the truth about provenance, never to reach more.
- **The first core-only call** is `stremio.get` (bridge plan §4). Here it's only the mechanism, with a test-only call `test.echo` in development builds.

## 9. Managed plugins (decision F)
- **Providers.** A built-in **provider** in `lib/plugins/managed/` (`index.js`: a registry; providers `stremio` (bridge plan) and, in tests, `fake`) exposes:
  - `inspect(input) → { manifest, files, summary }`: a preview, nothing written
  - `build(input, previous?) → { manifest, files }`: the plugin's manifest and files, `server.js` taken from `builtin/<name>/`
  - `check(instance) → { manifest, files } | null`: a daily look for a new version
  - `input`: what the admin gave (a URL), stored as a secret of the plugin when the provider says so (`secretInput: true`)
- **Installing.** Managed plugins go through `install.js`, refactored so that a package and a managed plugin both become a **candidate** `{ manifest, files, origin, trust }` and share the rest:
  - `stageFiles` → preview (permissions, `permissionChanges` against the installed version)
  - `commit` → `installStaged` (written to `<config>/plugins/<id>/`, with `managed.json` `{ provider, inputRef, builtAt, codeHash }`; the `plugins` row's `origin` enum gains `managed`, its `source` holds the provider's name, `signer` stays null)
  - previous version kept, rollback, removal, Clear data
- **Trust and loading.** Managed plugins' `trust` is `{ kind: 'builtin', provider }`: no signature and no developer mode needed. At load, `load(dir, 'managed')` checks `codeHash` against the shipped code (§8).
- **Updates.** The provider's `check` runs daily for each instance and on "Check for updates". A new candidate follows the update policy and the consent rules of packages (P4): more permissions wait, fewer apply. A new server version that ships new adapter code rebuilds every instance at start, using the same consent rules.
- **Routes:**
  - `POST /admin/plugins/managed/{provider}/inspect { input }`
  - `POST /admin/plugins/managed/{provider} { input }`
  - `PUT /admin/plugins/{id}/managed { input }` (change it)
  - `openapi.yaml`, with `origin: managed` and `provider` in the admin plugin views
- **The dashboard** shows their origin ("Made by Playpex from <summary>") instead of a publisher's signature. The rest of the plugin page is the same.

## 10. Decisions (to take before building)
- **A. List settings' shape:** records with `fields` plus plain `item` lists / records only / `item` only. *Recommended: both.* M3U needs records (a playlist with its guide), and tags, groups and hosts are plain values that look silly as one-field records.
- **B. Image hosts:**
  - (1) declared only: `network`, new `permissions.images`, granted, learned, TMDB
  - (2) any public host, since it's proxied anyway

  *Recommended: 1.* With any host, a plugin holding personal data (watch history granted to it) could send it in a picture's URL to any host. The per-host rule exists to stop that. The proxy fixes the clients' side either way.
- **C. Kids default:** dropped with §5.
- **D. Learned hosts after a restart:** in memory (taught again) / kept in the DB. *Recommended: in memory.* Kept hosts would outlive the documents that named them.
- **E. Trust by hash of shipped code** / by a flag in the manifest. *Recommended: hash.* A flag could be copied into any package.
- **F. Managed plugins share the package pipeline** (refactor `install.js` around candidates) / get a pipeline of their own. *Recommended: share.* One consent, rollback and update path is what keeps "manage add-ons like plugins" true.
- **G. API version:** all of this in SERVER_PLUGIN_API **1.5** (additions; the image rule applies to 1.5 servers, plugins with undeclared image hosts get their pictures refused there) / 2.0. *Recommended: 1.5.* Every first-party plugin is updated in step 1, and third-party ones lose pictures only, never function. The release notes say so.

## 11. Steps
1. **Images through the server** (§3). Includes:
   - `x-image` annotations, `images.js#rewrite` at every exit, `plugin_images`, the route, caching, sniffing
   - `permissions.images`, TMDB allowed
   - the TV's and Mobile's `asset()` (`imagesProxied`)
   - the image host survey and first-party plugins' new versions, the `check:plugins` rule

   Tests: `test/plugins.images.test.js` (rewriting every field, tokens stable across a restart, a private address and a redirect to one refused, SVG and HTML refused by their bytes, the cache, an adults plugin's image refused to a kids profile). TV scenario `catalog.js` and the plugin screens' screenshots unchanged, with every image request going to the server.
2. **List settings** (§4.1–4.4). The schema, `checkManifest`, `settings.js` checks and secrets per entry, `settings.get`, grants from lists, the dashboard's list editor. Tests: `test/plugins.settings.test.js` (shapes, ids kept on edit and move, limits, secrets per entry removed with it, a granted host per entry, a removed entry's learned hosts forgotten). `plugins/hello` gets one `fields` list and one `item` list. Dashboard screenshots.
3. **Migrations and M3U 2.0** (§4.5–4.6). `contributes.migrate`, run after commit, secrets moved, failures kept. M3U 2.0 with its migration, the official repository. Tests: `test/plugins.migrate.test.js`, `test/live.test.js` with lists (20 playlists, channel ids kept for the first, an entry removed). The TV scenario `guide.js`.
4. ~~**Kids defaults** (§5).~~ Dropped.
5. **Subtitle hash** (§6). `hash.js` (checked against OpenSubtitles' reference values), the hook input, the core provider. Tests on a generated file and a fake-engine torrent with and without its last piece.
6. **Learned hosts** (§7). `learn` with provenance and scope, image hosts from `iptv.m3u` logos, the Permissions lines. Tests: a plugin's own code can't learn, scopes don't leak into `http.request`, the limit.
7. **Trusted code and core-only calls** (§8). `builtin/`, hashes at build, the `core: true` registry, prelude and manifest checks, `test.echo`. Tests: a copied adapter with one changed byte is refused, a package naming a core call is refused.
8. **Managed plugins** (§9). The `install.js` refactor around candidates (packages first, every existing install test passing unchanged), the registry, `managed.json`, the routes, daily checks with consent, the dashboard's origin line, the `fake` provider. Tests: `test/plugins.managed.test.js` (install, update with more permissions waiting, rollback, a server upgrade rebuilding instances, removal, the code hash).
9. **Docs.**
   - `docs/plugins/manifest.md` (list settings, `migrate`, `permissions.images`)
   - `docs/plugins/server.md` (`settings.get` on lists, secrets per entry, `hash`, migrations)
   - `docs/plugins/security.md` (images, learned hosts with provenance, trusted code)
   - `docs/plugins/tv.md` (images go through the server)
   - the CLAUDE.md guides, this plan's status line, the bridge plan's step 1 pointing here

Steps 1–6 stand on their own. Steps 7–8 exist for the bridge and come right before its step 2.

## 12. Open questions
- **Resizing images on the server** (`sharp`, a native module, in the desktop installers): a later step if posters from add-ons turn out heavy. The cache's measurements will tell.
- **Lists in profile settings** (a profile's own list of things): allowed by §4.1, but no plugin asks for one yet. The dashboard's per-profile form shows them the same way.
- **Velvet's image hosts** change with its sites. A host missing from its manifest means missing pictures until its next version: does it need learned `image` hosts from its own pages (a document provenance for `http.request` answers)? Not in v1, since that would let any plugin learn hosts.
