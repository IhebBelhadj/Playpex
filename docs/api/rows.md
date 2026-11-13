# Rows

What a profile sees on Home, Movies and TV shows, and in what order, is the server's: a **layout** per section (the admin's default, or the profile's own), resolved into rows for each profile (`docs/rows-plan.md`). A client draws the rows it's given, in order, and asks each row for its items. It defines no rows of its own.

A server that has layouts says so in `GET /plugins` → `capabilities.rows: true`. Without it (an older server), keep the rows your client had.

## A section's rows

`GET /sections/{section}/rows?profile=<id>` (`section`: `home`, `movies` or `shows`) → `{ section, own, rows: [ResolvedRow] }`:

| Field | Use |
|---|---|
| `id` | ask its items with it (below); stable while the layout is |
| `title`, `variant` | its heading; `poster`, `landscape`, `top10`, or a plugin's card variant (`still`, `portrait`, `compact`) |
| `kind` | what its items are: `titles` (catalog titles, as `/catalog/*` answers them), `progress` (Continue watching items: resume or next episode), `library` (titles on this server), `cards` (a plugin's cards, drawn as its slot rows are, [Plugins](plugins.md)) |
| `plugin` | `cards` rows: the plugin. Its pictures are `images/<token>` paths of that plugin (`<api>/plugins/{plugin}/images/{token}`), its cards' intents are its own |
| `personal` | it depends on the profile (Continue watching, For you, an account's rows) |
| `because` | "Because you watched": the seed `{ mediaType, tmdbId, title }` |
| `items`, `last` | when the row came with its items (personal rows, the library, some plugin rows): draw them at once |
| `new` | a plugin that joined since the layout was saved (an editor can point it out) |

Rows with nothing in them are left out (a new profile has no Continue watching), as are rows of plugins the profile can't see. Ask again when a profile is chosen, on `plugin.changed` and `rows.changed` (a layout was edited, [events](events.md)), and after the profile watched something.

## A row's items

`GET /sections/{section}/rows/{rowId}/items?profile=<id>&page=<n>` → `{ id, kind, items, last, title?, plugin? }`. Page 1, 2… while the row scrolls; `last: true` ends it. Rows that come whole answer on page 1. A plugin row's `title`, when present, replaces the row's heading (an add-on naming its seed). Titles the profile watched are already left out of rows that hide them.

## Editing rows

Anyone using a profile may change its rows; a kids profile's rows only the admin, on the dashboard (`FORBIDDEN` otherwise).

- `GET /sections/{section}/layout?profile=<id>` → `{ section, own, custom, rows: [RowEntry], known }`: the profile's own layout, else the default, with joined plugins included (`new`).
- `PUT /sections/{section}/layout?profile=<id>` with `{ rows, known }`: the profile's own, a full list. Send `known` back as you got it: a plugin taken out then doesn't join again.
- `DELETE …/layout?profile=<id>`: back to the default.
- `GET /rows/sources?profile=<id>`: what can be added: the core's sources with their params, TMDB's lists, and each plugin's offered rows (`key`, `title`, `sections`, `params` to pick, such as a genre).

A `RowEntry` is `{ id, source, params, title?, variant?, hideWatched?, candidates?, hidden? }` (`hidden`: kept in the layout, not shown; an editor's Hide, so Show puts it back where it was). Answers add `label` (what to call it in an editor: its title, the offer's, the plugin's name) and `new`; both are dropped when you send the list back; `@playpex/protocol/rows.js` has the sources, their params and `checkLayout()` (what the server checks). A new entry's id is `r_` and 6 to 16 lowercase letters or digits (`newRowId()`).

| Source | Params | Fills with |
|---|---|---|
| `core.list` | `mediaType`, `list` | one of TMDB's lists |
| `core.discover` | `mediaType`, `sort`, `genres`, `withoutGenres`, `language`, `minVotes`, `minRating`, `from` / `to` or `recentYears` | titles by filters |
| `core.continue`, `core.watchlist`, `core.forYou` | `mediaType?` | the profile's resume points, My list, recommendations |
| `core.because` | `mediaType?`, `count` (1–3) | one row per strongest seed: "Because you watched …" |
| `core.library` | `mediaType?`, `order` (`added`, `title`) | what is on this server |
| `plugin` | `plugin`, `row`, `values` | one row a plugin offers |
| `plugin.all` | `plugin` | every row of that plugin that joins this section |

The admin's default: `GET / PUT / DELETE /admin/sections/{section}/layout` (the dashboard).
