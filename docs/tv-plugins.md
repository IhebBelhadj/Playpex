# Playpex TV plugins: author guide (draft)

How a plugin adds to Playpex TV: its own screens, and contributions to the core's screens. It is a **draft**: there is no plugin loader yet (a plugin is compiled with the app, like the example in `apps/tv/src/app/plugins-dev/hello/`), and what's described here is the contract that loader will keep. Server-side plugins and clients other than Playpex TV are out of scope; for those, see the client author guide in `docs/api/`.

**This is the core's internal extension API, not the third-party plugin API.** Packaged plugins (`.ppx`, `docs/plugins-plan.md`) never ship Angular code: they are a manifest plus sandboxed server code, and the TV renders them with core templates (that plan's §5, decision B). What's described here is what the core's own features, those templates and development plugins like `hello` use; third-party authors start from [`docs/plugins/`](plugins/README.md) (the packaged-plugin contract, P0 done; the loader comes with P2–P4).

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.

## The two contracts

A plugin imports only these two files, never the core's other files:

| | File | Version |
|---|---|---|
| Navigation: screens, the navigator, layers, input | `apps/tv/src/app/nav/public-api.ts` | `NAV_API_VERSION` (1) |
| UI: tokens, primitives, layouts, view models, slots, dialogs, toasts | `apps/tv/src/app/ui/public-api.ts` | `UI_API_VERSION` (1) |

A breaking change of either bumps its version. Design tokens marked `// stable` in `apps/tv/src/styles/_tokens.scss` are part of the UI contract: a renamed one keeps its old name for one version, a removed one bumps it. Unmarked tokens may change with the core.

The example plugin re-exports both from one file (`plugins-dev/hello/hello-api.ts`); do the same.

## Two ways in

1. **Your own screens**: full Angular components, declared with `defineScreen`, built from the UI system's layouts and primitives so they look and move like the core's.
2. **Contributions to core screens**: view models (plain data) handed to a named slot of a core screen; the core renders them with its own components, so they look native and survive changes to the core's templates.

### Screens

```ts
defineScreen({
  id: 'plugin.hello.section',        // plugin.<pluginId>.<name>
  path: 'p/hello/home',              // under p/<pluginId>/
  component: HelloSectionComponent,
  kind: 'section',                   // section | detail | fullscreen (root and system are the core's)
  requires: ['profile'],
  // menu: { label: 'Hello', icon: 'film', order: 70 },   a menu entry, if it's a section
});
```

Rules (checked when defined): ids `plugin.<pluginId>.<name>`, paths under `p/<pluginId>/`, kinds `section` / `detail` / `fullscreen`. Open a screen with an intent: `navigator.open({ screen: 'plugin.hello.title', params: { id } })`; Back is the navigator's (`docs/navigation-system-plan.md`). Inside a screen, `useScreen()` gives its params, payload and Back / select hooks.

### Building a screen

Start from a layout, fill it with primitives, put the movement wiring where the layout says:

| Layout | For | Put on it |
|---|---|---|
| `px-section-layout` | a section beside the menu: title info on top, rows at the bottom | `pxSection` (+ `[leaveFor]="{ left: '@menu' }"`) |
| `px-detail-layout` | a title page: title info, action tiles, rows; it scrolls | `pxSection` and `pxStack` |
| `px-rail-layout` | a rail (filters, groups) beside a main region | `pxRail` / `pxMain` on two children, each with its own `pxSection` |
| `px-fullscreen-layout` | a page over the shell (brand, centred content) | `pxSection` on your content |

Primitives (selectors, inputs: `apps/tv/src/app/CLAUDE.md` "UI system"):

| Need | Primitive |
|---|---|
| The title block | `<px-title-info [info]="TitleInfoModel" layout="detail \| section \| episode">` |
| Action tiles | `<px-action-bar>` of `<px-action key icon label [on] [progress] [busy]>` |
| A row of cards | `<px-card-row rowKey title [items]="CardModel[]" (picked) (nearEnd) [loading]>` |
| One card | `<px-card variant="poster \| compact \| portrait \| still" …>` |
| Buttons, fields, switches, sliders, tabs, chips | `px-button`, `px-search-field`, `px-switch`, `px-slider`, `px-tabs`, `px-chip` |
| Scores, meta line, progress | `px-score`, `px-meta`, `px-progress` |
| Nothing to show / loading | `px-empty`, `px-spinner`, `px-skeleton` |
| A question | `Dialogs.choose / confirm / alert` (an Observable: subscribe to open) |
| A short message | `Toasts.show({ text, tone, key })` (never takes the focus) |
| A full-screen panel | `<px-panel *ngIf>` (a layer: Back closes it, the focus comes back) |

Styling: only tokens (`var(--px-…)`) and `dp(n)` lengths (`@use 'px' as *;`), never a colour, font, z-index or px literal: `npm run check:ui` enforces it for the app's stylesheets. Respect the screen edges: what you read or focus stays inside `--px-safe-x` / `--px-safe-y` (the layouts do it for you), heights use `var(--px-screen-h)`, not `100vh`.

### Contributions

```ts
defineContribution({
  id: 'plugin.hello.party',             // plugin.<pluginId>.<name>
  slot: 'core.movie.actions',
  order: 60,                             // the core uses 10, 20, 30…; ties by id
  actions: ctx => ctx.movie.tmdbId
    ? [{ key: 'hello:party', label: 'Hello', icon: 'film', intent: { screen: 'plugin.hello.title', params: { id: ctx.movie.tmdbId } } }]
    : [],
});

defineContribution({
  id: 'plugin.hello.picks',
  slot: 'core.movies.rows',
  rows: ctx => [{ key: 'hello:picks', title: 'Hello picks', source: { page: n => fetchPage(n) } }],   // paged: (nearEnd) loads the next
});
```

| Slot | Context | Gives |
|---|---|---|
| `core.movie.actions`, `core.show.actions`, `core.episode.actions` | the title (+ season / episode), the profile | `ActionModel[]` |
| `core.movie.rows`, `core.show.rows` | the title, the profile | `RowModel[]` (under the page's rows) |
| `core.movies.rows`, `core.shows.rows` | the section, the profile, the search / filters | `RowModel[]` (after the section's rows) |
| `core.title.meta` | the title's kind and ids, the profile | `MetaItem[]` (on its meta line) |
| `core.watchlist.rows` | the profile | `RowModel[]` |

Context types: `MovieContext`, `ShowContext`, `EpisodeContext`, `SectionContext`, `TitleMetaContext`, `WatchlistContext` (`ui/slots/slots.ts`); read-only snapshots, never a page or a service. A contribution returns its models, `null` / `[]` (nothing here), or an **Observable** of them (wait for data; update a toggle's `on`, show `busy` while working). An action's `run()` is called on select, else its `intent` is opened; a card's `intent` is opened on select.

Rules (checked when defined, or the contribution shows nothing):
- ids `plugin.<pluginId>.<name>`; at most 3 contributions per plugin and slot; one kind, the slot's.
- **keys** of your actions and rows start with `<pluginId>:` (`hello:party`): position memory and the action bar can't collide with the core's.
- `adult: true` on a contribution with adult content: it's never offered to kids profiles. (Packaged plugins don't set it: their manifest's `audience` decides for every contribution, `docs/plugins-plan.md` §5.3.)
- a contribution that throws, or an Observable that errors, shows nothing (logged); it never takes the screen down.

### View models

`CardModel` (`key`, `title`, `variant?`, `image?` as a full URL, `subtitle?`, `badges?`, `progress?` 0–1, `rating?`, `intent?`), `RowModel` (`key`, `title`, `variant?`, `source`: `{ items }` or `{ page: n => Observable<{ items, last }> }`), `ActionModel` (`key`, `label`, `icon` (a name in `assets/icons/` or a URL), `on?`, `progress?`, `busy?`, `disabled?`, `run?`, `intent?`), `MetaItem` (`text` · `chip` · `score` · `seal`), `TitleInfoModel`. Plain data (functions only for `run` / `page`), so a later loader can run plugin code outside the page.

## The example

`apps/tv/src/app/plugins-dev/hello/` (development builds only):
- screens `plugin.hello.section` (`p/hello/home`: `px-section-layout`, a title info following the focused card, a paged row of made-up titles) and `plugin.hello.title` (`p/hello/title/:id`: `px-detail-layout`, an action asking with `Dialogs.confirm` and answering with a toast);
- contributions: an action on movie pages opening its title screen, a paged row in the Movies section. They're installed on demand (`window.playpexDev.plugin('hello', true)`) so the core's screenshots stay the core's.
- Its path through the app is checked by `npx electron scripts/scenario.js plugin` (from `apps/tv`, after a development build).

## Not yet (docs/ui-system-plan.md §12)

Loading plugins at run time (and from the server), isolating their code, a manifest with the API version ranges and permissions, data access beyond view models (catalog, library, playback as a contract), settings pages contributed by plugins (with setting keys `plugin.<pluginId>.<name>`, planned in `docs/settings-plan.md` §4), player extension points.
