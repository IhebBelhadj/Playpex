# The manifest (`playpex-plugin.json`)

Schema: `packages/protocol/plugin.schema.json`; the rules between fields: `checkManifest` in `packages/protocol/plugins.js`. Examples: `plugins/velvet/playpex-plugin.json`, `plugins/trakt/playpex-plugin.json`.

```jsonc
{
  "$schema": "…/plugin.schema.json",
  "id": "trakt",                                   // [a-z][a-z0-9-]{1,31}
  "name": "Trakt",
  "description": "Scrobbles what you watch to Trakt…",
  "version": "1.0.0",                              // semver, no build metadata
  "publisher": { "name": "Playpex", "key": "ed25519:…" },
  "api": { "server": "^1", "nav": "^1", "ui": "^1" },
  "audience": "everyone",                          // everyone | adults
  "icon": "assets/trakt.svg",
  "listing": { … },                                // what the dashboard's catalog shows
  "permissions": { … },
  "link": [ … ],
  "requires": [ … ], "exports": [ … ], "migratesFrom": [ … ],
  "contributes": { … }
}
```

A **repository package** is a manifest with `"type": "repository"` and `"repository": { "url", "key" }` instead of everything from `api` on: installing it adds that repository ([repositories.md](repositories.md)).

## Identity

- **`id`** is your namespace: screens `plugin.<id>.<name>` at `p/<id>/<name>`, settings `plugin.<id>.<key>`, row and action keys `<id>:…`, downloads and writes recorded `by: plugin:<id>`. It never changes between versions.
- **Names** inside the plugin (screens, data handlers, settings, secrets, links) are `[a-z][A-Za-z0-9]{0,39}`.
- **Assets** are paths under `assets/` (`.svg .png .jpg .jpeg .webp`), checked to exist in the package at install.

## Listing

What the dashboard's catalog and your plugin's page show (Kodi's add-on metadata):

```jsonc
"listing": {
  "summary": "Scrobbles what you watch to Trakt…",       // ≤ 150, the catalog's line
  "description": "…",                                     // ≤ 4000
  "disclaimer": "…", "license": "MIT", "source": "https://github.com/…",
  "categories": ["tracking", "notifications"],            // catalog sources streams live resolvers subtitles metadata library tracking notifications tools
  "screenshots": ["assets/shot-1.jpg"], "fanart": "assets/fanart.jpg"
}
```

## Dependencies

`requires: [{ id, version, optional? }]` names plugins yours works with: the dashboard installs them with yours, in one consent. Versions: `1.2.3`, `^1`, `^1.2`, `~1.2`, `1.x`, `>=1.2.0`, `>=1.2.0 <2.0.0`, `*` (pre-releases never match). It's for what plugins **do** (a resolver, an account), not for code: bundle your libraries into `server.js`.

`exports: [names]` lists your data handlers that plugins requiring yours may call (`playpex.plugins.call(id, name, args)`); they run in **your** sandbox with **your** permissions and the caller's context. `migratesFrom: [ids]`: deprecated plugins yours replaces; their settings are copied when the admin switches.

## Audience

`everyone`, or `adults`: then **nothing** of the plugin reaches a kids profile (no menu entry, screen, contribution, setting, request or event), it isn't offered over DLNA, every play it starts is untracked (`tracking: 'none'`), and its only write scope is `downloads`. It's the only audience mechanism: a plugin with adult and other content is an `adults` plugin, or two plugins. The wine accent (`contributes.chrome.accent: 'adult'`) is for `adults` plugins.

## Permissions

Each is shown to the admin in words at install (`describePermissions`); a new version asking for more stays disabled until the admin accepts the difference.

| Permission | Grants | Shown as |
|---|---|---|
| `images: [hosts]` (API 1.5) | the hosts your pictures (a card's `image`, a `backdrop`, a release's picture, a programme's) come from besides your `network` hosts: the server fetches every picture for clients ([tv.md](tv.md#models)); `image.tmdb.org` needs no entry. Same rules as `network` | "Shows pictures from i.ytimg.com" |
| `network: [hosts]` | `http.request` to those hosts (HTTPS, port 443): exact names, or `*.domain` for its sub-domains. No IP addresses, no `localhost` / `.local` / `.lan` / `.internal`…, no wildcard over a TLD. Hosts you can't know when you pack (the admin's IPTV provider, a self-hosted service) come from a `url` setting with `grantsHost` ([Settings](#settings)) | "Talks to api.trakt.tv" |
| `rateLimit: { perSecond, burst, inFlight }` | stricter request limits than the host's (2/s, burst 10, 4 in flight per host); never looser | |
| `storage: "<n>KB\|MB"` | its own key / value store (≤ 100 MB) | "Keeps up to 5 MB of its own data" |
| `secrets: [names]` | values the admin enters, for this plugin only | "Asks for: traktClientId" |
| `play: true` | the `play` effect | "Can start playback" |
| `sources: ["magnet", "http", "hls", "live", "embed"]` | the kinds of `Source` it may give (`play.collect`, `play.resolve`, `live.stream`, `play` and `download` effects); needs one of those uses, `http` / `hls` / `live` need `network` (every host a playlist names) or a `url` setting with `grantsHost`; `embed` (a YouTube video id, API 1.3) needs `play` and no host | "Adds torrents to Play" |
| `hooks: [names]` | middleware stages ([server.md](server.md#hooks)) | per hook ("Reorders or hides the sources of Play") |
| `events: [families]` | `playback`, `downloads`, `library`, `watchlist` | "Sees what you watch", … |
| `schedule: true` | background jobs | "Runs in the background" |
| `write: [scopes]` | `watchlist`, `watched`, `ratings`, `downloads` | "Can change your watch list", … |
| `link: [names]` | account linking flows declared in `link` | "Links your Trakt account" |
| `library: true` | the library's metadata (never paths) | "Sees what's on this server" |
| `files: true` | library files' relative paths, for `library.match` | "Sees the names of your video files" |
| `notify: true` | `notify.send` | "Can show you notifications" |

**Personal permissions**: `events: ["playback"]` and the write scopes `watchlist`, `watched`, `ratings`. Besides the admin's grant, **the admin switches each profile on** in the dashboard (Plugins › <name> › Profiles); a profile that didn't is never seen by your events nor written by your writes.

## Links

```jsonc
"link": [{
  "name": "trakt", "label": "Trakt", "scope": "profile",       // profile: each profile links its own; server: one account
  "deviceCode": {                                               // an RFC 8628 flow the host runs
    "codeUrl": "https://api.trakt.tv/oauth/device/code",
    "tokenUrl": "https://api.trakt.tv/oauth/device/token",
    "refreshUrl": "https://api.trakt.tv/oauth/token",          // optional
    "revokeUrl": "https://…/revoke",                            // optional: RFC 7009, unlinking revokes the tokens there
    "clientIdSecret": "traktClientId",                          // names in permissions.secrets
    "clientSecretSecret": "traktClientSecret"
  }
}]
```

Each link's name is in `permissions.link` and the other way round; its URLs' hosts are in `permissions.network`; its secrets in `permissions.secrets`. Instead of `deviceCode`, `"custom": "<data name>"` runs your own flow ([server.md](server.md#account-linking)); a link has exactly one of them. Either way the admin links it from the dashboard.

## Contributes

Plain data: the core reads it without running your code. `data` names a handler you register with `playpex.data(name, handler)`.

```jsonc
"contributes": {
  "sections": [{ "screen": "browse", "menu": { "label": "18+", "icon": "assets/seal.svg", "order": 50 } }],
  "screens": [
    { "name": "browse", "template": "catalog", "data": "browse", "title": "18+" },
    { "name": "title", "template": "title", "data": "title", "params": ["provider", "id"] }   // p/velvet/title/:provider/:id
  ],
  "slots": [{ "slot": "core.movies.rows", "data": "movieRows", "order": 60 }],
  "settings": [ … ],
  "chrome": { "accent": "adult" }
}
```

- **sections** (≤ 2): a menu entry opening one of your screens.
- **screens** (≤ 16): a template and the handler filling it (every template but `guide` needs `data`); `params` become path segments. A `guide` screen draws your `live.channels` and `live.guide` (needs those hooks); its optional handler only answers `{ title?, empty? }`.
- **releases** (with the hook `releases.providers`): `{ "kinds": ["movie"] }`: the kinds of the core's Find releases you list (`movie`, `show`; default both). The core shows you as a source only there.
- **slots**: contributions to core screens, at most 3 per slot. Slots: `core.movie.actions`, `core.show.actions`, `core.episode.actions` (action tiles), `core.movie.rows`, `core.show.rows`, `core.movies.rows`, `core.shows.rows`, `core.watchlist.rows` (rows), `core.title.meta` (meta items), `core.search.filters` (a filter of the search page and its results). What each one hands you and expects: [tv.md](tv.md#slots).

### Settings

Rendered by the dashboard from the manifest (a plugin's page: its **Settings** tab for `server` scope, its **Profiles** tab with a profile picker for `profile` scope; `GET` / `PUT /api/v1/admin/plugins/<id>/settings`); clients never show settings. A choice that only changes what one of your screens shows (a layout, a sort) belongs on that screen as a filter, not here. Read them with `settings.get(key, ctx)` (the manifest's `default` until the admin sets one); a change publishes `plugin.changed` and clients ask your open screens again. The server checks every value against its definition (type, options, bounds, `integer`, `maxLength`, `pattern`) and refuses a change with a bad one.

| `type` | Fields | Note |
|---|---|---|
| `switch` | `default` (boolean) | |
| `choice` | `options: [[value, label], …]` (2–20, unique values), `default` (one of the values) | |
| `slider` | `min`, `max`, `step?`, `unit?`, `default` (between them) | |
| `number` | `default`, `min?`, `max?`, `step?`, `integer?`, `unit?` | a typed number: a port, an interval, a limit |
| `text` | `maxLength?`, `placeholder?`, `pattern?` (a regular expression the whole value matches; the default too), `default?` | |
| `url` | `maxLength?` (≤ 2048), `placeholder?`, `schemes?` (`["https", "http"]` by default), `grantsHost?`, `streamHosts?`, `default?` | a web address (no user name or password in it). **`grantsHost`** (scope `server`, no default): saving it lets you reach that host, on that port, over https **or plain http**, and even a (public) IP address: an IPTV subscription, a self-hosted service; the admin sees "Talks to <host>" in your permissions. **`streamHosts`** (with `grantsHost`): the hosts of the streams, logos and guide the document at that address lists (`iptv.m3u`) may be **streamed** from too (your sources, never your own `http.request`). Addresses must still be public: a LAN server can't be reached |
| `secret` | `maxLength?`, `placeholder?` | **scope `server`**, its key listed in `permissions.secrets`: the admin enters it (never shown again, only "set"), you read it with `secrets.get`. While the admin entered none, the server's environment may provide it: `PLAYPEX_PLUGIN_<ID>_<NAME>` (upper case, camelCase and `-` → `_`: youtube `apiKey` → `PLAYPEX_PLUGIN_YOUTUBE_API_KEY`), so a server can ship credentials nobody else has to make (a link's client id and secret too) |
| `action` | `data` (a handler), `confirm?` | a button ("Sync now", "Test connection"): the dashboard calls the handler and shows its answer's toast |
| `list` (API 1.5) | `maxItems` (≤ 100; ≤ 1000 for a list of `text`), `minItems?`, `itemLabel?`, and either **`fields`** (≤ 10 field definitions: `key`, `type` `switch` · `choice` · `slider` · `number` · `text` · `url`, `label`, and that type's own fields; `visibleIf` / `enabledIf` name fields of the same entry; `titleField?`: the text field naming an entry) or **`item`** (one definition without `key` / `label`: `choice` · `number` · `text` · `url`; `unique?`), `default?` (an array) | a list the admin grows instead of fixed keys (`playlist`, `playlist2`…): entries the dashboard adds, reorders and removes. A `fields` list's value is `[{ id, …fields }]`: the server gives each new entry an `id` (`e_…`) and keeps it when the entry is edited or moved, so tie your own state to it; missing fields get their default. An `item` list's value is `[value, …]`. A `url` field with `grantsHost` grants **each entry's** host (scope `server`); `streamHosts` works per entry too. No `secret` fields yet: a list's values are settings, never secrets |

```json
{ "key": "playlists", "scope": "server", "type": "list", "label": "Playlists", "itemLabel": "Playlist", "titleField": "name", "maxItems": 20,
  "fields": [
    { "key": "name", "type": "text", "label": "Name", "maxLength": 60 },
    { "key": "url", "type": "url", "label": "Playlist (M3U)", "grantsHost": true, "streamHosts": true },
    { "key": "on", "type": "switch", "label": "Use it", "default": true }
  ] }
```

**Carrying settings across an update** (API 1.5): `contributes.migrate: "<data handler>"`. After an update is installed, the core calls it once with `{ fromVersion, toVersion, server, profiles: { <profile id>: values } }`: every value stored for you, also keys your new manifest no longer declares. Answer `{ data: { server?, profiles? } }` with values for this version's settings: they're saved as a save on the dashboard would (checked, all or nothing per scope; keys you don't declare dropped). The old rows stay, so a rollback finds them; a handler that fails changes nothing (the plugin starts on its defaults, the log says why). `plugins/m3u` 2.0 uses it to turn 1.x's five fixed playlist pairs into its list.

All have `key`, `scope` (`profile` · `server`), `label`, `description?`, and, from Kodi's settings: `group` (shown together under that title), `level` (`basic` · `advanced`: behind "Show advanced"), `visibleIf` / `enabledIf: { key, equals }` (another setting with a value, of the same scope or `server`).

## Translations

Any text people read (labels, options, listing) can be `"@key"`, looked up in `i18n/<locale>.json` (`{ "key": "text" }`; `en` required when any is used, a missing key falls back to `en`). Your handlers translate their own strings with `playpex.i18n.t(key, vars)` in `ctx.locale`.
