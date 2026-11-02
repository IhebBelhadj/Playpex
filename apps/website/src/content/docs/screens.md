---
title: "Screens and slots"
description: "The templates the TV and phone draw for your plugin, the rows you add to their screens, and effects."
group: Build plugins
order: 6
---

A plugin never runs code in the apps. It names **screens** (a template and a data handler) and **slot contributions** in its manifest; Playpex TV and Playpex Mobile call your handlers through the server and draw what they answer with their own layouts.

## Data handlers

```js
playpex.data('browse', async function (args, ctx) {
  return {
    data: { rows: [{ key: 'example:new', title: 'New this week', items: await newItems() }] },
    effects: [],
  };
});
```

The server checks `data` against the template; an answer out of shape shows the screen's error state, and the log says why.

## Screen templates

| Template | Looks like | `data` |
|---|---|---|
| `catalog` | the Movies section: the focused card's info on top, rows below, search and filters | `{ title?, rows, search?, filters?, empty? }` |
| `title` | a film's page: info, action tiles, rows | `{ info, actions?, rows? }` |
| `releases` | Find releases: a list with search and filters, by seeders | `{ title?, releases, last, filters?, empty? }` |
| `list` | a list of rows, like the library's folders | `{ title?, items, empty? }` |
| `guide` | a TV guide drawn from your `live.*` hooks | `{ title?, empty? }` (optional) |

A `catalog` handler gets `{ params, query, filters }` and is asked again when the user searches or filters. There is no settings screen: options are the dashboard's. A choice that only changes what a screen shows, like a sort, is one of its filters.

### On phones

Playpex Mobile draws the same templates (except `guide`, for now). A screen chooses how its top looks with `mobile: { bar }`: `plain`, `fold`, `app` or `overlay`.

## Models

- **Card** `{ key, title, image?, subtitle?, badges?, progress?, rating?, intent?, call?, info? }`: `image` is an HTTPS URL on a declared host, or `assets/…`.
- **Row** `{ key, title, items }`, or a paged row `{ key, title, page: { data, args? } }` asked with `args.page` 1, 2… as the user nears its end.
- **Action** `{ key, label, icon, on?, disabled?, intent?, call? }`: an action tile.
- **Intent** `{ screen, params? }`: one of your screens, or a core title or search screen.
- **Call** `{ data, args? }`: one of your handlers, whose effects are performed.

## Slots

Add rows, tiles and meta items to the apps' own screens with `contributes.slots`:

| Slot | Context | You answer |
|---|---|---|
| `core.movie.actions`, `core.show.actions`, `core.episode.actions` | the title | action tiles |
| `core.movie.rows`, `core.show.rows` | the title | rows under the page's |
| `core.movies.rows`, `core.shows.rows` | the section, query, filters | rows after the section's |
| `core.watchlist.rows` | | rows |
| `core.title.meta` | the title | up to 3 meta items |
| `core.search.filters` | the query | a chip and its result rows |

## Effects

What a handler asks the app to do after answering, up to 4:

| Effect | Needs | Does |
|---|---|---|
| `{ type: 'open', intent }` | | opens a screen |
| `{ type: 'play', request }` | `play` | plays one source at once, or opens the source picker |
| `{ type: 'download', request }` | `write: downloads` | the server's download flow |
| `{ type: 'toast', text, tone? }` | | a short message |
| `{ type: 'refresh', target }` | | asks your open screen or a slot again |
| `{ type: 'confirm', question, then }` | | a dialog, then an effect or a call |
