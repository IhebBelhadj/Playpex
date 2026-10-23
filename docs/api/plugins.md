# Plugins

What a client does with the server's plugins (`docs/plugins-plan.md` §4.9, §5). Plugins run **on the server**, in a sandbox; a client never runs plugin code and never sets plugins up (installing, permissions, settings, linked accounts: all on the server's dashboard). A client only **renders** what enabled plugins contribute, with its own screens and components, and performs the **effects** they answer. Plugin authors: [`docs/plugins/`](../plugins/README.md).

Status: all of this exists (plugins plan steps P1–P4): the sandbox and these routes, the hooks in Play, release lists, subtitles, markers and title meta, packages installed from the dashboard, and Playpex TV's renderer (`apps/tv/src/app/plugins/`: the remote adapter and the four templates; the example plugin `plugins/hello` uses every part).

## What's there

`GET /plugins?profile=<id>` → `{ plugins: [ClientPlugin] }`: the plugins enabled for that profile (a kids profile never gets an `audience: adults` plugin, and no profile gets a plugin the admin hid from it on the dashboard), each with

| Field | Use |
|---|---|
| `id`, `name`, `version`, `audience` | `audience: adults`: show it like the core's adult content (the `adult` accent); `name` and menu labels come translated for the request's `Accept-Language` |
| `play` | it may hand play requests to the core: its `releases` screens play the release selected (else say it can't) |
| `sections` | menu entries: `{ screen, menu: { label, icon, order } }` opening one of its screens |
| `screens` | `{ name, template, data, title?, params? }`: screen `plugin.<id>.<name>`; draw it with your `catalog` / `title` / `releases` / `list` template, filled by its `data` handler |
| `slots` | `{ slot, data, order? }`: contributions to your core screens (`core.movie.actions`, `core.movies.rows`, `core.search.filters`…) |
| `chrome` | `{ accent: 'adult' }` or null |
| `icon`, `assets` | `assets/…` paths of the package are served at `<api><assets><path under assets/>` |

Refetch it on the event `plugin.changed` (`{ id, state, reason? }`): a plugin was loaded, stopped or removed, or (`reason: 'settings'`, `'grants'`, `'link'`) the admin changed its settings, what it may do for a profile or a linked account: ask its open screen and slots again, they may show something else now.

## Notifications

`GET /plugins/notifications?profile=<id>` → `{ notifications: [{ id, plugin, name, text, tone, key, at }] }`: what plugins told this profile (`notify.send`) that **this device** hasn't had yet (each answered once per device, kept 24 h). Show each as a short message (a toast, `name` as its source), never as a question. Ask when a profile is chosen and on the event `plugin.notification` (`{ profileId, plugin }`) for the current profile.

## Asking a plugin

`POST /plugins/{id}/data/{name}?profile=<id>` with `{ args }` → `{ data, effects }`:

- `args`, by what asks:

| Asking | `args` |
|---|---|
| a `catalog` screen | `{ params, query, filters: { <group key>: [values] } }` |
| a `title` or `list` screen | `{ params }` (the screen's path params by name) |
| a `releases` screen | `{ params, query, filters, page }` (`page` 1, 2… while the list scrolls; the answer's `last` ends it) |
| a paged row (`row.page`) | `row.page.args` + `{ page }` |
| a slot | `{ slot, context }`: the slot's context without the profile: `{ movie: { tmdbId, imdbId, title, year } }`, `{ show, season }`, `{ show, season, episode }`, `{ section, query, filters }`, `{}` (watch list), `{ kind, tmdbId, imdbId }` (`core.title.meta`), `{ query }` (`core.search.filters`) |
| a card's, action's or list item's `call` | `call.args` (only its effects matter) |

- `data`: the model the template or slot expects (`$defs/templates/*`, `$defs/slots/*` of `@playpex/protocol/plugin-api.schema.json`, types in `@playpex/protocol/plugins`); checked by the server against where the manifest uses that handler (a screen's template, a slot's kind): out of shape → `502 PLUGIN_FAILED`. Images and icons that are `assets/…` paths are the package's files (`<api>/plugins/<id>/<path>`).
- `effects` (already checked against the plugin's permissions): `open` (an intent: one of its screens or `core.movie` / `core.show` / `core.episode` / `core.search`), `play` (a `PlayRequest`: one source plays at once, several open your source picker; `tracking: 'none'` = save nothing: no resume point, progress, history, Up next, download title), `toast`, `refresh` (`screen` or a slot), `confirm` (ask, then perform `then`: an effect, or `{ type: 'call', call }`), `download`. A `play` source is `{ kind: 'magnet', magnet | infoHash, … }` (a torrent: play it as the core's) or `{ kind: 'media', ref: 'r_…', label, … }` (a stream the server proxies: `GET /media/{ref}` like a file).

Errors: `404 NOT_FOUND` (no such plugin or handler; a stopped plugin), `403 FORBIDDEN` (a kids profile and an adults plugin, or a plugin hidden from that profile), `502 PLUGIN_FAILED` (the handler failed, took longer than 10 s or answered out of schema: show the screen's empty or error state, never a stack), `429 TOO_MANY_ATTEMPTS` (more than ~20 calls a second from one device to one plugin).

Send the profile on every call: the plugin's answer depends on it, and the server enforces the audience with it.

## What plugins add to the core's screens

Some plugin work reaches you through the core's own routes, with nothing to set up:

- **Play**: more sources, hidden ones with a reason, `cached` torrents, a question or a refusal before playing, markers ("Skip intro", Up next from the credits): see [playback](playback.md) (`POST /play/sources`, `/play/start`, `/play/markers`).
- **Release lists**: more sources in `GET /releases/providers?kind=movie|tv` (ids `plugin:<id>`), browsed like the others.
- **Subtitles**: more providers in `GET /subtitles/providers` (ids `plugin:<id>`), searched and fetched like the others (the server fetches the file and converts it to WebVTT).
- **Title pages**: `POST /plugins/meta?profile=` with `{ title: { kind: 'movie' | 'show' | 'episode', tmdbId, imdbId?, season?, episode? } }` → `{ meta: [{ plugin, name, items }] }`: up to three items per plugin (`text`, `chip`, `score` 0–10 with `votes` / `label`, `seal`) for the title's meta line.
