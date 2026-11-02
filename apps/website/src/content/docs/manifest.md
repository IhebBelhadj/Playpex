---
title: "The manifest"
description: "playpex-plugin.json, the file that says who you are, what you add and what you need."
group: Build plugins
order: 2
---

The manifest is plain data: the server reads it without running your code. Its schema is `plugin.schema.json` in the `packages/protocol` folder of the source code.

```jsonc
{
  "id": "trakt",                                   // [a-z][a-z0-9-]{1,31}, never changes
  "name": "Trakt",
  "description": "Scrobbles what you watch to Trakt…",
  "version": "1.0.0",                              // semver
  "publisher": { "name": "Playpex", "key": "ed25519:…" },
  "api": { "server": "^1", "nav": "^1", "ui": "^1" },
  "icon": "assets/trakt.svg",
  "listing": { },                                  // what the dashboard's catalog shows
  "permissions": { },
  "link": [ ],
  "requires": [ ], "exports": [ ],
  "contributes": { }
}
```

## Identity

- **`id`** is your namespace. Your screens are `plugin.<id>.<name>`, your settings `plugin.<id>.<key>`, row keys start with `<id>:`. It never changes between versions.
- Names inside the plugin (screens, data handlers, settings, secrets) are `[a-z][A-Za-z0-9]{0,39}`.
- Assets are paths under `assets/` (`.svg`, `.png`, `.jpg`, `.webp`), checked to exist when the plugin is installed.

## Listing

What the dashboard's catalog shows:

```jsonc
"listing": {
  "summary": "Scrobbles what you watch to Trakt…",       // up to 150 characters
  "description": "…",
  "license": "MIT", "source": "https://github.com/…",
  "categories": ["tracking"],     // catalog sources streams live resolvers subtitles metadata library tracking notifications tools
  "screenshots": ["assets/shot-1.jpg"]
}
```

## Permissions

Each one is shown to the admin in words before installing. A new version asking for more stays off until the admin accepts the difference.

| Permission | Grants | Shown as |
|---|---|---|
| `network: [hosts]` | `http.request` to those hosts over HTTPS: exact names or `*.domain`. No IP addresses or local names. | "Talks to api.trakt.tv" |
| `rateLimit` | stricter request limits than the host's (2 per second, burst 10, 4 in flight) | |
| `storage: "5MB"` | your own key/value store, up to 100 MB | "Keeps up to 5 MB of its own data" |
| `secrets: [names]` | values the admin enters for this plugin only | "Asks for: traktClientId" |
| `play: true` | the `play` effect | "Can start playback" |
| `sources: [kinds]` | the kinds of source you may give: `magnet`, `http`, `hls`, `live` | "Adds torrents to Play" |
| `hooks: [names]` | stages of core features ([Hooks](hooks)) | one line per hook |
| `events: [families]` | `playback`, `downloads`, `library`, `watchlist` | "Sees what you watch" |
| `schedule: true` | background jobs | "Runs in the background" |
| `write: [scopes]` | `watchlist`, `watched`, `ratings`, `downloads` | "Can change your watch list" |
| `link: [names]` | account linking | "Links your Trakt account" |
| `library: true` | the library's titles (never paths) | "Sees what's on this server" |
| `files: true` | library files' relative paths, for `library.match` | "Sees the names of your video files" |
| `notify: true` | notifications | "Can show you notifications" |

**Personal permissions**, `events: ["playback"]` and the writes to `watchlist`, `watched` and `ratings`, also need the admin to switch each profile on, in the plugin's **Profiles** tab.

## Settings

Settings are drawn by the dashboard from your manifest; apps never show them. Read them with `playpex.settings.get(key, ctx)`.

```jsonc
"contributes": {
  "settings": [
    { "key": "playlist", "scope": "server", "type": "url", "label": "Playlist address", "grantsHost": true },
    { "key": "quality", "scope": "profile", "type": "choice", "label": "Quality",
      "options": [["hd", "HD"], ["sd", "SD"]], "default": "hd" }
  ]
}
```

| `type` | Fields |
|---|---|
| `switch` | `default` (boolean) |
| `choice` | `options: [[value, label], …]`, `default` |
| `slider` | `min`, `max`, `step?`, `unit?`, `default` |
| `number` | `default`, `min?`, `max?`, `step?`, `integer?`, `unit?` |
| `text` | `maxLength?`, `placeholder?`, `pattern?`, `default?` |
| `url` | `schemes?`, `grantsHost?`, `streamHosts?`: with `grantsHost`, saving it lets you reach that host, on its port, even over plain http |
| `secret` | server scope, listed in `permissions.secrets`; read it with `playpex.secrets.get` |
| `action` | `data`, `confirm?`: a button, such as "Sync now" |

Every setting has `key`, `scope` (`profile` or `server`), `label` and `description?`, and may have `group`, `level` (`basic` or `advanced`) and `visibleIf` / `enabledIf`.

## Contributes

```jsonc
"contributes": {
  "sections": [{ "screen": "browse", "menu": { "label": "Live TV", "icon": "assets/live.svg", "order": 50 } }],
  "screens": [
    { "name": "browse", "template": "catalog", "data": "browse", "title": "Live TV" },
    { "name": "title", "template": "title", "data": "title", "params": ["id"] }
  ],
  "slots": [{ "slot": "core.movie.rows", "data": "movieRows", "order": 60 }],
  "settings": [ ]
}
```

- **sections** (up to 2): a menu entry that opens one of your screens.
- **screens** (up to 16): a template and the data handler that fills it.
- **slots**: rows, action tiles and meta items on the apps' own screens, up to 3 per slot.
- **releases**: with the `releases.providers` hook, the kinds of Find releases you list.

What each template and slot expects: [Screens and slots](screens).

## Dependencies

`requires: [{ id, version, optional? }]` names plugins yours works with; the dashboard installs them with yours. `exports: [names]` lists your data handlers that plugins requiring yours may call with `playpex.plugins.call`.

## Translations

Any text people read can be `"@key"`, looked up in `i18n/<locale>.json` (`en` is required when any is used). Handlers translate their own strings with `playpex.i18n.t(key, vars)`.
