# Plugins

What a client does with the server's plugins (`docs/plugins-plan.md` §4.9, §5). Plugins run **on the server**, in a sandbox; a client never runs plugin code and never sets plugins up (installing, permissions, settings, linked accounts: all on the server's dashboard). A client only **renders** what enabled plugins contribute, with its own screens and components, and performs the **effects** they answer. Plugin authors: [`docs/plugins/`](../plugins/README.md).

Status: the server side of this exists (plugins plan steps P2 and P3: the sandbox, these routes, the hooks in Play, release lists, subtitles, markers and title meta); installing plugins from the dashboard is step P4, so today only plugins a developer put in the server's `plugins-dev` folder run. Playpex TV's renderer is step P1.

## What's there

`GET /plugins?profile=<id>` → `{ plugins: [ClientPlugin] }`: the plugins enabled for that profile (a kids profile never gets an `audience: adults` plugin), each with

| Field | Use |
|---|---|
| `id`, `name`, `version`, `audience` | `audience: adults`: show it like the core's adult content (the `adult` accent) |
| `sections` | menu entries: `{ screen, menu: { label, icon, order } }` opening one of its screens |
| `screens` | `{ name, template, data, title?, params? }`: screen `plugin.<id>.<name>`; draw it with your `catalog` / `title` / `releases` / `list` template, filled by its `data` handler |
| `slots` | `{ slot, data, order? }`: contributions to your core screens (`core.movie.actions`, `core.movies.rows`, `core.search.filters`…) |
| `chrome` | `{ accent: 'adult' }` or null |
| `icon`, `assets` | `assets/…` paths of the package are served at `<api><assets><path under assets/>` |

Refetch it on the event `plugin.changed` (`{ id, state }`): a plugin was loaded, stopped or removed.

## Asking a plugin

`POST /plugins/{id}/data/{name}?profile=<id>` with `{ args }` → `{ data, effects }`:

- `args`: a screen's params, the slot's context, a card's or action's `call.args`, `{ page }` for a paged row.
- `data`: the model the template or slot expects (`$defs/templates/*`, `$defs/slots/*` of `@playpex/protocol/plugin-api.schema.json`, types in `@playpex/protocol/plugins`); checked by the server.
- `effects` (already checked against the plugin's permissions): `open` (an intent: one of its screens or `core.movie` / `core.show` / `core.episode` / `core.search`), `play` (a `PlayRequest`: one source plays at once, several open your source picker; `tracking: 'none'` = save nothing: no resume point, progress, history, Up next, download title), `toast`, `refresh` (`screen` or a slot), `confirm` (ask, then perform `then`: an effect, or `{ type: 'call', call }`), `download`. A `play` source is `{ kind: 'magnet', magnet | infoHash, … }` (a torrent: play it as the core's) or `{ kind: 'media', ref: 'r_…', label, … }` (a stream the server proxies: `GET /media/{ref}` like a file).

Errors: `404 NOT_FOUND` (no such plugin or handler; a stopped plugin), `403 FORBIDDEN` (a kids profile and an adults plugin), `502 PLUGIN_FAILED` (the handler failed, took longer than 10 s or answered out of schema: show the screen's empty or error state, never a stack), `429 TOO_MANY_ATTEMPTS` (more than ~20 calls a second from one device to one plugin).

Send the profile on every call: the plugin's answer depends on it, and the server enforces the audience with it.

## What plugins add to the core's screens

Some plugin work reaches you through the core's own routes, with nothing to set up:

- **Play**: more sources, hidden ones with a reason, `cached` torrents, a question or a refusal before playing, markers ("Skip intro", Up next from the credits): see [playback](playback.md) (`POST /play/sources`, `/play/start`, `/play/markers`).
- **Release lists**: more sources in `GET /releases/providers?kind=movie|tv` (ids `plugin:<id>`), browsed like the others.
- **Subtitles**: more providers in `GET /subtitles/providers` (ids `plugin:<id>`), searched and fetched like the others (the server fetches the file and converts it to WebVTT).
- **Title pages**: `POST /plugins/meta?profile=` with `{ title: { kind: 'movie' | 'show' | 'episode', tmdbId, imdbId?, season?, episode? } }` → `{ meta: [{ plugin, name, items }] }`: up to three items per plugin (`text`, `chip`, `score` 0–10 with `votes` / `label`, `seal`) for the title's meta line.
