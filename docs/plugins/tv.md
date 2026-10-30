# Screens, slots and effects

Status: built (plugins plan P1). Playpex TV reads `GET /plugins` on a profile change and on `plugin.changed`, defines your screens with its templates and your slot contributions with its registries (`apps/tv/src/app/plugins/remote.ts`), and drops them when your plugin goes. The example plugin [`plugins/hello`](../../plugins/hello) uses every template, slot, effect and kind of setting: start from it.

A plugin never runs code in the TV. It names **screens** (a core template + a data handler) and **slot contributions** in its manifest; the TV calls the handlers through the server and renders what they answer with its own layouts and primitives. Shapes: `$defs/templates`, `card`, `row`, `action`, `titleInfo`, `effect` in `packages/protocol/plugin-api.schema.json` (types in `plugins.d.ts`).

## Screens

`contributes.screens: [{ name, template, data, title?, params? }]` → screen `plugin.<id>.<name>` at `p/<id>/<name>[/:param…]`. A screen a section opens has no params; the others are detail screens (Back returns to where they were opened from) that keep your section's menu entry highlighted. The handler answers `{ data: <the template's model>, effects? }` and gets:

- `catalog`: `{ params, query, filters: { <group key>: [values] } }`, asked again when the user searches or applies filters (`filters` is what you marked `on` until the user chooses);
- `title`, `list`: `{ params }`;
- `releases`: `{ params, query, filters, page }`, `page` 1, 2… as the list scrolls, until you answer `last: true`.

The server checks `data` against the template (out of shape: the screen shows its error state, the log says why). Your open screen, and your slot contributions, are asked again on a `refresh` effect and when the admin changes your settings.

| Template | Looks like | `data` |
|---|---|---|
| `catalog` | the Movies section: title info of the focused card on top, rows below, a toolbar with search and filters | `{ title?, rows: Row[], search?, filters?: FilterGroup[], empty? }` |
| `title` | a movie page: title info, action tiles, rows; it scrolls | `{ info: TitleInfo, actions?: Action[], rows?: Row[] }` |
| `releases` | Find releases: a rail with search and filter chips, the release list by seeders | `{ title?, releases: Release[], last, filters?, empty? }`; selecting a release asks the core to play it (needs `play`) |
| `list` | a list of rows like the library's folders (menus, folders) | `{ title?, items: [{ key, label, meta?, icon?, intent?, call? }], empty? }` |
| `guide` | a TV guide: channels as lines, their programmes over 3 h from now, an amber now line, groups, Later / Earlier; Enter on what's on plays the channel (↑/↓ flip channels in the player) | drawn from your `live.channels` / `live.guide` by the core (playing needs no `play` permission: `live.stream` is the core's way in); your handler (optional) answers `{ title?, empty? (shown when there's no channel: say what the admin should set) }` |

There is no settings screen: options are the dashboard's ([manifest.md](manifest.md#settings)). A choice that changes what a screen shows (a layout, a sort) is one of its `filters`; the core remembers it per profile.

### On phones

Playpex Mobile draws the same templates (`guide` excepted, for now). A screen chooses how its top looks on a phone with `mobile: { bar }`, in the manifest (`contributes.screens[].mobile`) or in its handler's answer (`data.mobile`, which wins: a screen can change it at run time):

| `bar` | The top of the screen |
|---|---|
| `plain` (default; `title` screens default to `overlay`) | Back on a dark strip; your title large at the top of the content |
| `fold` | your title large in the content; as it scrolls away the strip darkens in and the title comes into it beside Back |
| `app` | the app's own top bar (the Playpex mark, the server, Search, the profile) with Back: a section that feels like one of the app's |
| `overlay` | no strip and no title: Back floats over your first row (a wide picture that goes to the top edge) |

The TV ignores it.

## Models

- **Card** `{ key, title, variant?, image?, subtitle?, badges?, progress?, rating?, intent?, call?, info? }`: `image` is a full HTTPS URL (on a declared host) or `assets/…`; `info` is the title info shown while it has the focus (catalog); Enter opens `intent` or calls `call`.
- **Row** `{ key, title, variant?, items }` or `{ key, title, variant?, page: { data, args? } }`: a paged row calls `data` with `args.page` = 1, 2… as the user nears the end, expecting `{ items, last }`. Keys start with `<id>:`.
- **Action** `{ key, label, icon, on?, progress?, disabled?, intent?, call? }`: an action tile; `icon` is a core icon name or `assets/…`.
- **TitleInfo** `{ title, eyebrow?, meta?, genres?, overview?, overviewFallback?, credits?, notes?, backdrop? }`; **MetaItem** `text` · `chip` · `score` (`source: 'provider'`, with a `label`) · `seal`.
- **Intent** `{ screen, params? }`: one of your screens (`plugin.<id>.<name>`) or a core title / search screen (`core.movie`, `core.show`, `core.episode`, `core.search`).
- **Call** `{ data, args? }`: one of your data handlers; its answer's effects are performed (its `data` is ignored: answer a `refresh` to show something new).

## Slots

`contributes.slots: [{ slot, data, order? }]`; the handler gets `args = { slot, context }` and answers `{ data }` (a title is `{ tmdbId, imdbId, title, year }`):

| Slot | `context` | `data` |
|---|---|---|
| `core.movie.actions` | `{ movie }` | `Action[]` (after the core's tiles) |
| `core.show.actions` | `{ show, season }` | `Action[]` |
| `core.episode.actions` | `{ show, season, episode }` | `Action[]` |
| `core.movie.rows` / `core.show.rows` | `{ movie }` / `{ show, season }` | `Row[]` (under the page's rows) |
| `core.movies.rows`, `core.shows.rows` | `{ section, query, filters }` | `Row[]` (after the section's rows) |
| `core.watchlist.rows` | `{}` | `Row[]` |
| `core.title.meta` | `{ kind, tmdbId, imdbId }` | `MetaItem[]` (≤ 3) |
| `core.search.filters` | `{ query }` | `{ chip: { key, label }, rows: Row[] }`: a chip after the search page's filters; chosen, its rows (the first page of a paged one) are the results, asked again as the query changes |

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
