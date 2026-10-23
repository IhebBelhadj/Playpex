# Screens, slots and effects

A plugin never runs code in the TV. It names **screens** (a core template + a data handler) and **slot contributions** in its manifest; the TV calls the handlers through the server and renders what they answer with its own layouts and primitives. Shapes: `$defs/templates`, `card`, `row`, `action`, `titleInfo`, `effect` in `packages/protocol/plugin-api.schema.json` (types in `plugins.d.ts`).

## Screens

`contributes.screens: [{ name, template, data, title?, params? }]` → screen `plugin.<id>.<name>` at `p/<id>/<name>[/:param…]`. The handler gets `args` = the screen's params (+ the search query and filters for a catalog or release list) and answers `{ data: <the template's model>, effects? }`.

| Template | Looks like | `data` |
|---|---|---|
| `catalog` | the Movies section: title info of the focused card on top, rows below, a toolbar with search and filters | `{ title?, rows: Row[], search?, filters?: FilterGroup[], empty? }` |
| `title` | a movie page: title info, action tiles, rows; it scrolls | `{ info: TitleInfo, actions?: Action[], rows?: Row[] }` |
| `releases` | Find releases: a rail with search and filter chips, the release list by seeders | `{ title?, releases: Release[], last, filters?, empty? }`; selecting a release asks the core to play it (needs `play`) |
| `list` | a grid of options (menus, folders) | `{ title?, items: [{ key, label, meta?, icon?, intent?, call? }], empty? }` |

There is no settings screen: options are the dashboard's ([manifest.md](manifest.md#settings)). A choice that changes what a screen shows (a layout, a sort) is one of its `filters`; the core remembers it per profile.

## Models

- **Card** `{ key, title, variant?, image?, subtitle?, badges?, progress?, rating?, intent?, call?, info? }`: `image` is a full HTTPS URL (on a declared host) or `assets/…`; `info` is the title info shown while it has the focus (catalog); Enter opens `intent` or calls `call`.
- **Row** `{ key, title, variant?, items }` or `{ key, title, variant?, page: { data, args? } }`: a paged row calls `data` with `args.page` = 1, 2… as the user nears the end, expecting `{ items, last }`. Keys start with `<id>:`.
- **Action** `{ key, label, icon, on?, progress?, disabled?, intent?, call? }`: an action tile; `icon` is a core icon name or `assets/…`.
- **TitleInfo** `{ title, eyebrow?, meta?, genres?, overview?, overviewFallback?, credits?, notes?, backdrop? }`; **MetaItem** `text` · `chip` · `score` (`source: 'provider'`, with a `label`) · `seal`.
- **Intent** `{ screen, params? }`: one of your screens (`plugin.<id>.<name>`) or a core title / search screen (`core.movie`, `core.show`, `core.episode`, `core.search`).
- **Call** `{ data, args? }`: one of your data handlers; what it answers is performed (its effects; a returned model refreshes what called it).

## Slots

`contributes.slots: [{ slot, data, order? }]`; the handler gets the slot's context as `args` and answers `{ data }`:

| Slot | `args` | `data` |
|---|---|---|
| `core.movie.actions`, `core.show.actions`, `core.episode.actions` | the title (+ season / episode) | `Action[]` |
| `core.movie.rows`, `core.show.rows` | the title | `Row[]` (under the page's rows) |
| `core.movies.rows`, `core.shows.rows` | the section's query and filters | `Row[]` (after the section's rows) |
| `core.watchlist.rows` | none | `Row[]` |
| `core.title.meta` | the title's kind and ids | `MetaItem[]` |
| `core.search.filters` | the query | `{ chip: { key, label }, rows: Row[] }`: a chip on the search page; when on, its rows replace the core's results |

At most 3 contributions per slot and plugin; one that fails or answers out of schema shows nothing.

## Effects

What a handler asks the core to do after answering (`effects: [...]`, ≤ 4):

| Effect | Needs | Does |
|---|---|---|
| `{ type: 'open', intent }` | | opens a screen |
| `{ type: 'play', request: { title, subtitle?, ref?, artwork?, sources: Source[], tracking? } }` | `play` | the core's player: one source plays at once, several open the source picker. `tracking: 'none'`: no resume point, progress, history, watched mark, Up next, playback events or download title (forced for `adults` plugins) |
| `{ type: 'download', request: { title, ref?, source } }` | `write: downloads` | the core's Download flow and its toast |
| `{ type: 'toast', text, tone? }` | | a short message (`info`, `success`, `error`) |
| `{ type: 'refresh', target }` | | `screen` (your open screen) or a slot name: asks its handler again |
| `{ type: 'confirm', question, yes?, no?, then }` | | a dialog; `then` is an effect or `{ type: 'call', call }` |

Nothing about setup reaches a client: no settings, permissions or linking codes. Notifications from `notify.send` show as toasts ([server.md](server.md#notifications)).
