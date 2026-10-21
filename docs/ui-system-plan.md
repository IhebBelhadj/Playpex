# UI system (tokens, components, layouts, slots): plan

Status (2026-10-21): **steps 0 and 1 done** (harness, tokens); **step 2 (overlays) built, verification unfinished** (see "Step 2 notes": what's left before it counts as done). Decisions A–J (§11) taken: the recommended defaults, except **G: rem, not px** (every length is `dp(n)`, the UI scales with the screen); the amber change of §6 approved. Read the root `CLAUDE.md`, `apps/tv/src/app/CLAUDE.md`, `docs/movement-system-plan.md` and `docs/navigation-system-plan.md` first; this plan assumes them. It builds on the navigation system as it is in the code (`apps/tv/src/app/nav/`, `public-api.ts`, `NAV_API_VERSION = 1`: screens, navigator, layers, `pxSelect`; its plan's status line still reads "proposed", and its step 7, the example plugin and `docs/tv-plugins.md`, isn't done). The movement system decides how focus moves, the navigation system which screen is shown and who gets an input; this plan covers **what a screen is built from.**

## 0. Findings and open items (2026-10-20, from writing this plan)

Found in the code while writing the plan, not fixed yet:
- **The navigation plan's status line is stale.** `docs/navigation-system-plan.md` says "proposed, nothing built", but its steps 0–6 are in the code (commit `2f90426`: `nav/` with navigator, registry, `screens.ts`, layers, input dispatcher, `pxSelect`, `nav-debug`, specs; every page migrated, `NavigationService` reduced). Its **step 7 isn't done**: no `src/app/plugins-dev/hello/` example plugin, no `docs/tv-plugins.md`. `nav/public-api.ts` and `NAV_API_VERSION = 1` exist. This plan's step 7 extends that same example.
- ~~The root `CLAUDE.md` doesn't link this plan yet~~: linked in step 1 ("UI system" paragraph, conventions, commands).
- **`adult-browse` layout defect**: `.sliderContainer` sets `margin-top: auto`, then `margin: 0 -10px` overrides it; the rows sit at the bottom only because `.titleInfo` has `flex: 1`. Fixed in step 4.
- **The search page has its own keyboard** (46 hard-coded `.keyboardBtn`s), separate from `<text-keyboard>` (§6, decided in step 3).
- ~~Amber is used as a focus colour in the player~~: white since step 1 (approved). The trailer has no amber focus (its amber is the progress bar).
- ~~`.px-row-pad` is unused~~: removed in step 1; the `px-row-gutter` mixin replaces it (rows adopt it in step 4).
- ~~Six component SCSS files declare their own `$ink` / `$muted` / `$wine` / … variables~~: gone in step 1.
- Caution for whoever continues: an automated inventory pass while writing this plan reported class names that don't exist (`.metaChip`, `.iconTile`). Every name and count in §2 was re-checked with grep; check any new claim the same way before relying on it.

Decided by the user (2026-10-21), before step 0:
1. **Decisions A–J (§11)**: the recommended defaults, except **G**: no px anywhere, lengths scale with the screen (rem with a root size that follows the window; §5.1 "Units").
2. **The amber change (§6)**: yes. Done in step 1.
3. Visual scope: parity first, then the §6 items (not a redesign while migrating).

Still open: correcting the navigation plan's status line (doc-only, not done).

## 1. Goal

One shared set of UI primitives for Playpex TV that:

1. **Gives the app one visual language in code.** Colours, type, spacing, radii, focus treatment, motion and stacking order are **tokens**, defined once. Today they're literals copied into each component's SCSS.
2. **Turns the patterns every page re-implements into components**: action tiles, cards, rows of cards, the title block, chips, search fields, dialogs, panels, empty states. Each one comes with its movement and navigation wiring built in (`pxItem`, `pxSelect`, `rowArrows`, layers), so a page can't get that wiring wrong.
3. **Provides layouts**: a handful of page skeletons (section, detail, rail + list, full screen) that core screens and plugin screens fill in, instead of copying a neighbour's SCSS.
4. **Lays the ground for plugins.** It adds **view models** (cards, rows, actions, title info as data) and **slots** (named extension points inside core screens: "actions of the movie page", "rows of the movies section"). With them a plugin can add to a core screen and look native without knowing its templates. This is the "extension points inside core screens" item that `navigation-system-plan.md` §13 left for later.
5. **Has the core use it first** ("dogfooding", as in the navigation plan). Core screens are built from the same components and fill the same slots a plugin will, so the API is proven before any plugin exists.

Like the other two systems, it can be adopted **page by page**: a page not yet migrated keeps its own markup and SCSS until it's moved, and each step leaves the app looking the same.

Non-goals: a visual redesign (parity first; changes are listed and decided, §6), the plugin loader (packaging, sandboxing, distribution: §12), the player's controls (a video surface with its own key handling; it gets tokens only), the dashboard (`apps/dashboard` has shadcn/ui), an Angular upgrade (works on 14.1 as installed).

## 2. What the UI looks like in code today

Inventory of `apps/tv/src/app` (31 component SCSS files, 5,732 lines; `styles.scss` 139 lines). Class names are the real ones.

| Pattern | Copies | Where |
|---|---|---|
| **Title block** (name, year / meta line, IMDb + TMDB scores, genres, overview) | 5 | `movie-description` (`.name`, `.infos`, `.imdb_score`, `.tmdb_score`, `.categories`), `episode-page` (`.titleBlock`, its own), `adult-title` (copy of the description, + the wine `.seal`), `watchlist-page` and `adult-browse` (`.titleInfo`, `.score`, + status / progress line, performers) |
| **Action tiles** (Play / Resume, Trailer, Find releases, Watch list, Watched) | 4 | `.option.focusable` > `.imgContainer` > icon + `<span>` label, in a `pxGrid` (`.optionPannel` / its equivalent): `movie-options`, `show-options`, `episode-page`, `adult-title`, each with its own SCSS for the tile, its focus state, the `.on` toggle and the amber resume bar |
| **Row title** | 8 | `.sectionTitle` in `movies-slider`, `watchlist-page`, `adult-browse`, `search-page`, `movie-options`, `show-options`, `episode-page`, `adult-title` |
| **Row of cards** (`rowArrows` wrapper + `pxRow` + `pxItem` cards) | 12 rows | the rule "every `pxRow` goes inside a `rowArrows` wrapper" is followed by hand in every template |
| **Poster card** (180×270, focus zoom, fallback title without artwork) | 4 | `movies-slider`, `watchlist-page` (+ amber progress, "TV" badge), `adult-browse`, `search-page` |
| **Episode card** (still, number, title, IMDb rating, watched / progress / upcoming) | 2 | `show-options`, `episode-page` |
| **Person portrait** (round, initials without a photo) | 3 | cast in `movie-options` and `adult-title`, guests in `episode-page` |
| **Modal frame** (blurred backdrop, centred panel, title, subtitle, option list) | 3 + 1 | `torrent-picker`, `play-choice` ("Same modal frame as <torrent-picker>"), `connection-lost` ("Same modal frame as <play-choice>"); `notification-handler` is an older variant |
| **Full-screen panel** (frame, `.panelTitle`, chip groups / keys, footer buttons) | 6 | `catalog-filter-panel` and the 18+ filter panel inside `adult-browse` (a copy of its frame and chips), `text-keyboard`, `pin-pad`, the `profile-editor` panels, the pairing panel of `connect-page` |
| **Chips** (pill, outline → filled when selected) | 6 | `.chip` in `catalog-filter-panel`, `adult-browse`, `releases-page`, `episode-page`, `watchlist-page`, `adult-title`; the search page's filter chips; the season chips |
| **Search field + toolbar buttons** (h44, r8, icon + label, focus white) | 3 | `.searchField` / `.filterBtn` / `.clearSearch` in `movies-page`'s `.sectionToolbar` ("styled like the 18+ toolbar"), `adult-browse`'s `.toolbar`, the `releases-page` rail (h54 variant) |
| **Outline `.actionBtn`** (empty / error states, panel footers) | 7 | `watchlist-page`, `adult-browse`, `catalog-filter-panel`, `releases-page` (`.retryBtn`), `profile-editor` (+ `.primary` / `.danger`), `profile-picker` (`.manageBtn`), `connect-page` (its own variant) |
| **Switch** (46×26) | 2 | `profile-editor` (kids, green) and `releases-page` ("As the profile editor's kids switch", wine) |
| **Key grids** | 3 | `text-keyboard` `.key`, `pin-pad` `.pinKey` (same recipe), and the search page's **own** keyboard (46 hard-coded `.keyboardBtn`s; doesn't use `<text-keyboard>`) |
| **Empty state / note** | 5+ | `.note` / `.empty` per page, each styled locally; no shared spinner or skeleton |
| **Page skeletons** | — | section (menu + header + rows at the bottom: `movies-page` + slider, `watchlist-page`, `adult-browse`, each self-contained), detail (`movies-page`'s scrolling `.pageContainer`; `adult-title` re-implements it), rail + list (`releases-page`), full screen (`profile-picker`, `connect-page`, `power-page`) |

Tokens, or rather their absence:

| What | Today |
|---|---|
| Variables, mixins, partials | **no shared ones**: no `@use` / `@import`, no custom properties except `--rowArrowsY/H`. Six files declare their own SCSS variables with copied names (`$ink`, `$muted`, `$wine`, `$chipBg`, `$amber`): `$ink` is `#fff` in five of them and `#141414` in `connect-page` |
| Shared global classes | `styles.scss` has the movement classes and a `.px-row-pad` (row gutter for the focus zoom) that **no template uses**: each row re-declares the padding |
| Font families | `@font-face`s: FuturaLt/Bk/Bd, NetflixBk/Th/Bd/lt/lc, Monda (Monda, NetflixTh, Netflixlc unused); the Netflix faces are written **10 ways** (`'NetflixBk'`, `'netflixBk'`, `"NetflixBk"`, `'Netflixlt'`, `'netflixLt'`, `'NetflixLt'`, `'netflixlt'`, …), ~200 declarations |
| Translucent whites | `rgba(255,255,255,…)` 60 times, **22 distinct values** |
| Amber `#FFC107` | 18 literals. The guide says amber = progress, but it's also the `.on` tile filter, the menu's active item, the torrent "Best match" tag, the notification's OK button and **the player's and trailer's focus colour** |
| z-index | 15 distinct values (−1 … 13, one 1000), unrelated to `LAYER_PRIORITY` |
| Focus zoom | 7 different scales (1.015 … 1.13) |
| 18+ wine accent | copied per file (`adult-browse`, `adult-title`, `releases-page`) |

Other constraints the primitives must respect (from the guides): `MenuComponent` queries `.description`, `.menuItem`, `.element`, `.tabs` document-wide, so primitives must use their own prefixed class names. Flex hosts with wide rows need `min-width: 0`. Rows need padding + negative margin for the focus zoom (`16px 10px` for posters). Angular 14 has no `hostDirectives` (15+), so a component can't apply `pxItem` to its own host. Layout is designed for a fixed 1440 px viewport.

What it costs: changing a focus treatment, a tile or the dialog frame is an edit in 3–8 files that drift apart. A new page copies the nearest one's SCSS. A plugin would have to copy core SCSS to look native, and would break whenever that SCSS changes.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Token** | A named design value (`--px-color-progress`, `--px-space-4`, `--px-z-modal`), a CSS custom property on `:root`. The only place a colour, size or duration literal may appear. |
| **Theme** | A set of token overrides scoped to an element (`[data-px-accent="adult"]`): the 18+ wine accent. |
| **Primitive** | A shared component or directive from `ui/`: an atom (tile, chip, field), a card, a row, the title block, an overlay frame. Owns its markup, styles, focus look and movement wiring. |
| **Layout** | A page skeleton with named regions filled by content projection (`<px-section-layout>`: header, toolbar, rows). |
| **View model** | Plain data a primitive renders without a template: `CardModel`, `RowModel`, `ActionModel`, `TitleInfoModel` (§5.5). What a plugin hands to a slot. |
| **Slot** | A named extension point in a core screen (`core.movie.actions`) where contributions are rendered, with a typed context (`MovieContext`). |
| **Contribution** | A registered entry for a slot: id, order, and a function from the slot's context to view models (or `null` = not shown here). |

## 4. Target architecture

New folder `apps/tv/src/app/ui/` (declared in `AppModule` like `movement/` and `nav/`; an array `UI_COMPONENTS`, no new NgModule, decision F). Tokens in `apps/tv/src/styles/` (global, included by `styles.scss`).

```
 layer 4  slots & contributions    defineContribution · <px-slot> · slot catalog      ← what a plugin adds to core screens
 layer 3  layouts                  section · detail · rail · fullscreen · dialog/panel host
 layer 2  composites               px-title-info · px-card-row · px-action-bar · px-dialog · px-panel
 layer 1  atoms                    px-action · px-card · px-chip · px-search-field · px-switch ·
                                   px-score · px-meta · px-progress · px-empty · px-spinner
 layer 0  tokens & themes          :root custom properties · SCSS mixins (focus zoom, row padding) · data-px-accent
 ───────────────────────────────── underneath, unchanged ─────────────────────────────────
 movement/  pxSection pxStack pxRow pxGrid pxItem rowArrows FocusEngine    nav/  defineScreen Navigator LayerStack pxSelect
```

Principles:
1. **Tokens only.** Inside `ui/` (and every migrated page) no colour, font, z-index or duration literal: `var(--px-…)`. Checked by a grep (§9).
2. **A primitive owns its wiring.** `px-card-row` is the `rowArrows` wrapper + `pxRow` + `pxItem` + `.sectionTitle`; `px-action` is the `.focusable` button with `pxSelect`; `px-dialog` opens its own layer and trapping section. Pages stop writing that boilerplate.
3. **Data in, events out.** Primitives take inputs (or a view model) and emit `(picked)` / `(nearEnd)`; they never call services, the navigator or TMDB. A contribution may carry an `Intent`; the slot opens it.
4. **Template escape hatch for the core.** Composites accept an `ng-template` for their items, so the core keeps its special cards (the season curve, the release row) while plugins stay on view models.
5. **Prefixed, encapsulated.** Selectors and classes `px-…`, emulated encapsulation, no `::ng-deep` inside `ui/`; theming crosses component boundaries through custom properties only.
6. **Same API for core and plugins.** Exported from `ui/public-api.ts` with `UI_API_VERSION`; the core imports `ui/` only through it (like `nav/public-api.ts`).
7. **Parity, then improvement.** Migration reproduces today's look; deliberate visual changes (unifying the 7 zoom scales, the 22 whites) are listed in §6 and decided, not slipped in.

## 5. Primitives and their APIs

Names are proposals; the shapes are what matters.

### 5.1 Tokens (`styles/_tokens.scss` → `:root`)

```scss
:root {
  // colour
  --px-color-bg: #141414;            --px-color-text: #fff;
  --px-color-text-2: rgba(255,255,255,.7);   --px-color-text-3: rgba(255,255,255,.45);
  --px-surface-1: rgba(255,255,255,.06);     --px-surface-2: rgba(255,255,255,.12);
  --px-surface-raised: rgba(20,20,20,.85);   --px-scrim: rgba(17,17,17,.4);
  --px-line: rgba(255,255,255,.25);
  --px-color-focus: #fff;            --px-color-on-focus: #000;
  --px-color-progress: #FFC107;      // progress only (resume bars, episode progress)
  --px-color-accent: var(--px-color-focus);  // themes override it (18+: wine)
  --px-color-danger: #e5383b;
  // type: 3 faces, one spelling each
  --px-font-bold: 'NetflixBd';  --px-font-book: 'NetflixBk';  --px-font-light: 'Netflixlt';  --px-font-display: 'FuturaLt';
  --px-text-hero: 2.8rem;  --px-text-title: 32px;  --px-text-row: 16px;  --px-text-body: 1.2rem;  --px-text-small: 14px;
  --px-text-shadow: 1px 1px 10px #00000040;
  // space, shape
  --px-space-1: 4px; …  --px-space-8: 40px;
  --px-radius-s: 4px;  --px-radius-m: 6px;  --px-radius-l: 12px;  --px-radius-pill: 999px;
  // focus, motion
  --px-zoom-card: 1.1;  --px-zoom-tile: 1.06;  --px-zoom-row-item: 1.06;
  --px-dur-fast: 150ms;  --px-dur: 200ms;  --px-dur-slow: 300ms;  --px-ease: cubic-bezier(.2,.7,.3,1);
  // stacking: one scale, layers aligned with LAYER_PRIORITY (nav/layer-stack.service.ts)
  --px-z-content: 1;  --px-z-menu: 5;  --px-z-back-button: 7;  --px-z-panel: 8;  --px-z-modal: 9;
  --px-z-alert: 10;  --px-z-root-page: 10;  --px-z-system: 11;  --px-z-splash: 12;
}
[data-px-accent="adult"] { --px-color-accent: #C2405F; /* + its tints */ }
```

- Values are **today's** most common ones (exact mapping table written in step 1); where a copy differs, the difference is noted for §6, not silently changed.
- SCSS mixins for what custom properties can't express: `@include px-focus-zoom(var(--px-zoom-card))`, `@include px-row-gutter(16px, 10px)` (padding + negative margin + `scroll-padding-inline`, the rule from the movement guide), `px-text(hero)`.
- **Theme by screen**: `Chrome` gets `accent?: 'adult'` (`nav/screen.ts`); on `navigated` the shell sets `data-px-accent` on `.masterContainer`. The 18+ screens declare it once and lose their copied wine CSS.
- `prefers-reduced-motion` sets the durations to 0 in one place.

**Units (decision G, as built).** No `px` in stylesheets or code. `dp(n)` (`styles/_px.scss`; `dp()` in TS from `ui/public-api.ts` for GSAP tweens and inline styles) is n pixels of the 1440 × 810 design, in rem. The root font size is `min(100vw / 90, 100vh / 50.625)`: 16px on a 1440 × 810 window (identical to the old px layout), 21.33px on 1920 × 1080, 32px on 4K, and bounded by height on screens wider than 16:9 so the rows don't fall off the bottom. Form controls get `font-size: dp(13.333)` globally (the browser's fixed default didn't scale). Measured values (`getBoundingClientRect`, the movement system's offsets, `--rowArrowsY/H`) stay in px: they are already the real size.

### 5.2 Atoms

| Selector | Replaces | Inputs → outputs |
|---|---|---|
| `px-action` | the `.option` tiles of 4 detail pages | `icon`, `label`, `[on]` (toggled look: in watch list, watched), `[progress]` (amber resume bar, 0–1), `[busy]` ("Finding torrents…"), `[disabled]`, `key` → `(pxSelect)` on the inner button |
| `px-card` | poster / still / portrait / compact cards | `variant: 'poster' \| 'still' \| 'portrait' \| 'compact'` (sizes from tokens: 180×270, episode still, 130 round, 150×230), `image`, `title` (fallback when no artwork), `subtitle`, `badges: Badge[]` (`'tv'`, `'watched'`, `'upcoming'`, `{text}`), `progress`, `rating` |
| `px-chip` | the 6 `.chip`s, search filters, season chips | `label`, `[selected]`, `[accent]`, optional `caption` (IMDb mean on a season chip) |
| `px-search-field` | 3 `.searchField`s | `query`, `placeholder`, `hint` → `(open)`; the host opens `<text-keyboard>` (unchanged) |
| `px-switch` | the kids switch (profile editor), "Only releases that play here" | `label`, `[on]` (colour from `--px-color-accent`) |
| `px-button` | the 7 outline `.actionBtn`s, toolbar buttons | `variant: 'outline' \| 'primary' \| 'danger' \| 'toolbar'`, `icon?`, `label`, `[active]` |
| `px-score` | `.imdb_score`, `.tmdb_score`, `.score` | `source: 'imdb' \| 'tmdb' \| 'provider'`, `value`, `votes?` |
| `px-meta` | year / chips / runtime line pieces | `MetaItem[]` (§5.5) |
| `px-progress` | the amber lines | `value` (0–1), `variant: 'bar' \| 'line'` |
| `px-empty`, `px-spinner` | `.note` / `.empty`, ad-hoc spinners | `title`, `text`, optional action (`label` → `(action)`) |

Movement wiring on Angular 14: a component can't put `pxItem` on its own host, so focusable atoms render an inner `<button class="px-… focusable" pxItem [pxItemKey]="key" (pxSelect)="…">`. `pxItem` and `pxSelect` find their container and owner through the element-injector chain, which crosses the component boundary, so no change to `movement/` is needed. Each atom styles its own `.focused` state from tokens.

### 5.3 Composites

**`px-card-row`**: a row with its title, chevrons and paging, the 12-row boilerplate in one element:

```html
<px-card-row rowKey="similar" title="More like this" align="third"
             [items]="similar" [loadAhead]="6" (nearEnd)="more()" (picked)="open($event)">
  <!-- optional: the core's own card; without it each item is a CardModel → <px-card> -->
  <ng-template pxCardTemplate let-m><px-card variant="poster" [image]="m.poster_path | tmdbImg" [title]="m.title"></px-card></ng-template>
</px-card-row>
```

Renders `.px-row-title` + `<div rowArrows><div [pxRow]="rowKey" …>` + one `pxItem` per item (key from `trackBy` / `CardModel.key`), the row gutters, `min-width: 0`. Works in both stack motions: the parent `pxStack` decides (`transform` for sections, `scroll` for detail pages); add `pxStackItem` on the row.

**`px-action-bar`**: the `pxGrid` of `px-action`s, with optional `actions: ActionModel[]` (for slots) besides projected content.

**`px-title-info`**: the title block, one component for the 5 copies:

```html
<px-title-info [info]="titleInfo"></px-title-info>   <!-- TitleInfoModel, §5.5 -->
```

Regions: eyebrow (show name on an episode), title, meta line (`MetaItem[]`: text, chip, score, seal), genres, status + progress (watch list resumes), overview (clamped), credits (director / writers). `<movie-description>` keeps its data logic (selection, `BackgroundService`) and renders this component. `episode-page`, `adult-title`, `watchlist-page` and `adult-browse` build a `TitleInfoModel` and drop their markup.

**`px-dialog`** and **`px-panel`**: the overlay frames, wired to `LayerStack`:

```html
<px-dialog id="playChoice" [open]="request" [priority]="LAYER_PRIORITY.modal"
           title="Resume ‘Heat’?" subtitle="…" (closed)="…">
  <px-option key="resume" (pxSelect)="pick('resume')" [progress]="0.4">Resume from 1:02:10</px-option>
  <px-option key="restart" (pxSelect)="pick('restart')">Play from the beginning</px-option>
</px-dialog>
```

When opened, the frame calls `layers.open({ id, priority, element })`, adds its trapping `pxSection`, restores focus on close (the layer does), and maps Back to `(closed)`. `px-panel` is the full-screen frame (title, scrolling body, footer) for filter panels, the profile editor's panels and pairing; `text-keyboard` and `pin-pad` keep their keys but use its frame. `px-option` is the dialog list row (the torrent picker's rows project their tags into it).

**`Dialogs` service** (for plugins and simple core cases, where nobody can put a component in the shell): `dialogs.choose<T>({ title, subtitle, options: {key, label, detail?, value: T}[] })` → `Observable<T>` (completes empty on Back), `dialogs.confirm({ title, text, confirm, cancel })` → `Observable<boolean>`, `dialogs.alert(…)`. Rendered by one `<px-dialog-host>` in `app.component.html`. `PlayChoiceService.choose` becomes a thin call to it; the torrent picker keeps its component (custom rows) on `px-dialog`.

### 5.4 Layouts

| Layout | Regions | Today's users → after |
|---|---|---|
| `px-section-layout` | `[pxHeader]` (a `px-title-info`, hidden while empty), `[pxToolbar]` (search field, filter button, chips), `[pxRows]` (the stack, pushed to the bottom), `[pxEmpty]` | `movies-page` + `movies-slider`, `watchlist-page`, `adult-browse` |
| `px-detail-layout` | the scrolling `pxStack` (scroll motion) holding `[pxHeader]`, `[pxActions]`, `[pxRows]`; revealing the first entry scrolls back to the top (movement rule) | `movies-page`'s `.pageContainer` (movie / show / episode screens) and `adult-title`'s copy of it |
| `px-rail-layout` | `[pxRail]` (fixed width, its own `pxSection`), `[pxMain]`; `leaveFor` between them given as inputs | `releases-page`; later Settings (`core.settings`) |
| `px-fullscreen-layout` | backdrop, `[pxHeading]`, `[pxHint]`, body, `[pxFooter]`; `z = --px-z-root-page` | `profile-picker`, `connect-page`, `power-page`, the profile editor |

Layouts declare structure and sizes, not sections: the page still says `pxSection="…"` on its regions (section ids stay unique and stable for the movement system). Chrome (menu shown / hidden, Back button) stays in `ScreenDef.chrome`. A layout doesn't duplicate it.

### 5.5 View models (`ui/models.ts`)

```ts
interface CardModel {
  key: string | number;
  title: string;
  variant?: 'poster' | 'still' | 'portrait' | 'compact';
  image?: string;                 // full URL (a plugin doesn't know TMDB's image base)
  subtitle?: string;
  badges?: Badge[];
  progress?: number;              // 0–1, amber
  rating?: { source: 'imdb' | 'tmdb' | 'provider'; value: number };
  intent?: Intent;                // nav/: what Enter opens (the slot / row opens it)
}

interface RowModel {
  key: string;                    // position memory key (scoped like any pxRow)
  title: string;
  variant?: CardModel['variant'];
  source: RowSource;              // static list or paged loader
}
type RowSource =
  | { items: CardModel[] }
  | { page: (n: number) => Observable<{ items: CardModel[]; last: boolean }> };   // paging = (nearEnd)

interface ActionModel {
  key: string;
  label: string;
  icon: string;                   // assets/icons/<icon>.svg, or a URL
  on?: boolean; progress?: number; busy?: boolean; disabled?: boolean;
  run?: () => void | Promise<void>;
  intent?: Intent;
}

interface TitleInfoModel {
  title: string;
  eyebrow?: string;
  meta?: MetaItem[];
  genres?: string[];
  overview?: string;
  status?: string; progress?: number;
  credits?: { label: string; names: string[] }[];
}
type MetaItem =
  | { kind: 'text'; text: string } | { kind: 'chip'; text: string }
  | { kind: 'score'; source: 'imdb' | 'tmdb' | 'provider'; value: number; votes?: number }
  | { kind: 'seal'; text: string };
```

Models are plain, serializable-friendly data (functions only for `run` / `page`). That keeps the door open to plugins not compiled into the app (§12): a contribution's output could cross a worker or iframe boundary later.

### 5.6 Slots and contributions

```ts
// a plugin (or the core) registers
defineContribution<MovieContext>({
  id: 'plugin.hello.watchParty',
  slot: 'core.movie.actions',
  order: 60,                                   // core actions: 10, 20, 30…
  actions: ctx => ctx.movie.imdb_id ? [{ key: 'party', label: 'Watch party', icon: 'users', run: () => … }] : [],
});

defineContribution<SectionContext>({
  id: 'plugin.hello.anime',
  slot: 'core.movies.rows',
  order: 15,
  rows: ctx => [{ key: 'hello:anime', title: 'Anime picks', source: { page: n => … } }],
});
```

```html
<!-- in a core screen -->
<px-action-bar><px-slot name="core.movie.actions" [context]="ctx"></px-slot></px-action-bar>
```

- `ContributionRegistry` (root) holds contributions per slot, sorted by `order`. `<px-slot>` re-evaluates when its `context` changes and renders the models with the matching composite (`px-action`, `px-card-row`, `px-meta`). A contribution that throws is logged and skipped. It never takes the screen down.
- **The core fills its own slots** (dogfooding): the movie page's Play / Trailer / Find releases / Watch list / Watched are core contributions to `core.movie.actions` (orders 10–50), its cast / similar rows to `core.movie.rows`. Which core items stay as plain template code (where they need a custom card or behaviour) is decided per slot in step 6.
- Contexts are **typed, read-only snapshots** (`MovieContext { movie: { tmdbId, imdbId, title, year }, profile: { id, kids } }`), not the page's component or services. A slot's context type is part of the contract.
- Visibility and safety: a slot context carries `profile.kids`, and contributions to adult slots are refused for kids profiles by the registry, not left to each plugin.
- Rules (enforced by `defineContribution`, like the screen rules in `navigation-system-plan.md` §8): ids `plugin.<pluginId>.<name>`, row keys prefixed `<pluginId>:` (position memory can't collide), at most N contributions per slot per plugin, ordering ties broken by id.

First slot catalog (more only when a real need appears; every slot is a promise to keep):

| Slot | Context | Contributes |
|---|---|---|
| `core.movie.actions`, `core.show.actions`, `core.episode.actions` | title (+ season / episode), profile | `ActionModel[]` |
| `core.movie.rows`, `core.show.rows` | title, profile | `RowModel[]` (below the core rows) |
| `core.movies.rows`, `core.shows.rows` | section, profile, active filters | `RowModel[]` (between core rows, by order) |
| `core.title.meta` | title kind + ids | `MetaItem[]` (e.g. another score) |
| `core.watchlist.rows` | profile | `RowModel[]` |

Not slotted on purpose (for now): the player, the menu (sections come from `defineScreen` + `MenuEntry` already), the profile picker, `/connect`.

### 5.7 Dev gallery (`core.dev.gallery`)

A screen declared with `defineScreen` (dev builds only, not in the menu; opened from `nav-debug`) that shows every primitive in every state (focused, on, busy, disabled, empty, long titles, missing artwork, adult accent) with fixture data. It's where primitives are built and checked, the first "plugin-like" consumer, and the deterministic half of the visual checks (§9): real pages show live TMDB data that changes every day.

## 6. Visual parity and the deliberate changes

Each migration step reproduces today's look; the step's notes list every pixel that moved. Unifications that *change* the look are only made with an explicit choice (decision H), grouped here so they can be reviewed together:

- Focus zoom: 7 scales → 3 tokens (card 1.1, tile 1.06, row item 1.06); 1.13 / 1.08 / 1.05 / 1.04 / 1.015 copies mapped to the nearest.
- Translucent whites: 22 values → ~7 tokens (text 2/3, surface 1/2, line, scrim, raised).
- z-index: 15 values → the scale of §5.1 (stacking order unchanged; values renumbered).
- Font names: 10 spellings → 4 tokens (no visual change: CSS matches family names case-insensitively, but one spelling avoids surprises in fallback chains); the unused faces (Monda, NetflixTh, Netflixlc) dropped from `styles.scss`.
- Amber back to one meaning (progress, plus "on"): the player's and trailer's focus colour becomes the focus token (white), the notification's OK button a normal button. Needs a yes: it changes the player's look.
- Focus treatments: today fill (buttons, chips, keys), zoom + un-dim (posters), ring by `border` or by `outline` (portraits, episode cards). Primitives keep these three, as tokens and mixins, with one way of drawing the ring.
- The search page's own keyboard → `<text-keyboard>` in an inline (non-layer) mode, or kept as is (decided in step 3).
- The error notification moves onto the `px-dialog` frame like the other three modals.
- Radii and paddings of the 3 dialog copies and the 2 filter-panel copies → one.

## 7. Plugin readiness

What this plan adds to the navigation plan's plugin contract (`nav/public-api.ts`):

- **`ui/public-api.ts`**: tokens (documented names, the stable ones marked), the atoms, composites and layouts, `Dialogs`, the view models, `defineContribution`, `px-slot`, the slot catalog with context types, `UI_API_VERSION`. The core imports `ui/` only through it.
- **Two ways in for a plugin:** (1) **its own screens** (`defineScreen`, kinds section / detail / fullscreen) built from layouts and primitives: full Angular, compiled with the app for now. (2) **Contributions to core screens**: view models only, rendered by the core's components, so they look native and survive core template changes.
- **Theming for free**: a plugin that uses tokens follows the 18+ accent, reduced motion and any future theme; custom properties also cross shadow DOM, so Web-Component plugins (one of the loader options) can use them too.
- **Proof**: the dev example plugin of the navigation plan's step 7 (`src/app/plugins-dev/hello/`, not built yet) is extended: a section built on `px-section-layout` with a paged `RowModel`, an action in `core.movie.actions` opening its detail screen, a row in `core.movies.rows`, a `dialogs.confirm`.
- **Out of scope** (§12): loading plugins at runtime, their isolation, plugin-provided server routes, plugin settings UI.

## 8. Implementation steps

Each step leaves the app working and looking the same (§6 changes excepted), is verified with §9 before the next, and is one commit (the user commits).

### Step 0: harness (done 2026-10-21, notes below)
- `ui/` folder, `UI_COMPONENTS` in `AppModule`, `ui/public-api.ts` (empty), Karma setup like `nav/*.spec.ts`.
- `core.dev.gallery` screen (§5.7), dev builds only.
- **Screenshot baseline**: a dev script (`apps/tv/scripts/screens.js`, runs the built app in Electron offscreen) that opens a fixed list of intents through a dev-only `window.playpexDev.open(intent)` hook (exposed by `nav-debug`; never a URL query: the boot gotcha) and saves `webContents.capturePage()` per screen + gallery state to `apps/tv/.screens/<name>.png` (git-ignored). Run it once now: the baseline. The gallery's shots compare by pixels; live screens, side by side by eye.
- Map the inventory of §2 into a checklist of every copy to migrate (in this file, under the step notes).

### Step 1: tokens (done 2026-10-21, notes below)
- `styles/_tokens.scss`, `_mixins.scss`, included by `styles.scss`; the mapping table (old literal → token) in the step notes.
- The per-file `$ink` / `$muted` / `$wine` / … variables go (they become token references); `.px-row-pad` becomes the `px-row-gutter` mixin.
- Replace literals in every SCSS file mechanically (fonts, colours, z-index, durations, shadows); no structure change. `Chrome.accent` + `data-px-accent`; the 18+ screens declare it, the copied wine CSS goes.
- Verify: screenshot set identical (except the §6 items approved in this step), `grep` check of §9 passes for the migrated files.

#### Step 0 and 1 notes (2026-10-21)

Built:
- `apps/tv/src/app/ui/` (`public-api.ts` with `UI_API_VERSION = 0` until step 7, `UI_COMPONENTS` in `AppModule`, `units.ts` = `dp()` for code), `ui/gallery/` = `core.dev.gallery` (defined only when `!environment.production`; a token sheet for now: text and meaning colours, surfaces over the backdrop gradient, focus treatments, the seal in both themes, fonts, radii, space). Above the clock (`--px-z-root-page`) so its shots compare by pixels.
- The dev hook is **`DevHook`** (`src/app/dev-hook.service.ts`, installed by `AppComponent`), not `nav-debug`: it also needs `ProfilesService` and `ReleasesService`, which `nav/` must not import. `window.playpexDev`: `open`, `reset`, `profile(name?)` (enters a profile without a PIN), `releases(kind, query, label, imdb?)`, `screen()`.
- `apps/tv/scripts/screens.js` + `npm run screens -w apps/tv` (development build to `dist/screens`, then shots to `.screens/latest`; `--out`, `--size WxH`, `--only a,b`, `--settle ms`; `PLAYPEX_SCREENS_DEBUG=1` logs capture size, viewport and root font size). It requires `electron/main.js` with `PLAYPEX_TV_INDEX` / `PLAYPEX_TV_SHOTS` (main.js: hidden offscreen window of that size, `enableLargerThanScreen`), its own userData (`<tmp>/playpex-tv-screens`) with a **copy of Playpex TV's `client.json`** (the server knows that device: a fresh one is asked to pair, even on loopback) and `force-device-scale-factor=1` (on a 125 % display the window was clamped to 1536 × 864). Needs a server on this machine. 14 shots: profiles, movies, movie (Heat, 949), shows, show (Breaking Bad, 1396), episode (S1E1), watchlist, search, releases (Heat), adult-browse, adult-releases, power, gallery, connect.
- Screenshot sets (git-ignored, `apps/tv/.screens/`): `before-tokens/` (the code before step 1, taken at 1440 × 864: the window was still clamped then), `step1/` (after step 1, same size: compared with `before-tokens`), **`baseline/` (after step 1, 1440 × 810) and `baseline-1080/` (1920 × 1080): the references for step 2 on**.
- `src/styles/_px.scss` (`dp()`, `px-row-gutter` mixin; emits no CSS, `@use 'px' as *;` in each component, `src/styles` on the include path of build and test in `angular.json`), `src/styles/_tokens.scss` (palette + roles, themes, reduced motion), `styles.scss` (`@use 'tokens'`, root font size, 4 `@font-face`s: Monda, NetflixTh, Netflixlc, FuturaBk, FuturaBd were unused and are gone; `.px-row-pad` gone, replaced by the mixin).
- `Chrome.accent?: 'adult'` (`nav/screen.ts`) on `core.adult.browse`, `core.adult.releases`, `core.adult.title`; `AppComponent.accent` from `navigator.current$` → `data-px-accent` on `.masterContainer`; the seals use `--px-color-accent`.
- Every component SCSS: 1,138 `px` → `dp()`; fonts → 4 tokens (the 19 spellings); colours → tokens (no hex / rgba left outside `_tokens.scss`); the per-file `$ink` / `$muted` / `$faint` / `$wine` / `$chipBg` / `$amber` / `$track` / connect-page's `$plate` / `$bone` / `$ash` / `$live` / `$caution` gone (`$rowH`, a length, stays); transition durations → `--px-dur-*` (keyframe animations keep their own timing: blink 1s, shake .35s, scan sweep 1.8s, and the pairing time bar's 1s linear, tied to its 1 s tick); z-index → `--px-z-*`; icon filter recipes → `--px-icon-light` / `--px-icon-on`; shadows, gradients and the selected-chip ring → tokens. TS: GSAP widths / offsets (menu, slider, player, trailer indicator), the player's play-icon nudge, the row chevrons' nudge → `dp()`; `nav-debug`'s inline styles → rem and tokens.

Mapping (old literal → token; the full set with comments is `_tokens.scss`):

| Old | Token |
|---|---|
| `#fff` text / fills of focused things / other whites | `--px-color-text` / `--px-color-focus` / `--px-white` |
| `#000`, `#141414`, `rgb(17,17,17)`, `#131313`, `#000000e7` as text on white | `--px-color-on-focus` (`#141414`) |
| `#141414`, `rgb(17,17,17)` as page ground | `--px-surface-bg` |
| white text at .9 / .85, `#e5e5e5` | `--px-color-text-soft` (.9) |
| .72 / .7, `#b3b3b3`, `#c9c9c9`, `#d0d0d0` | `--px-color-text-secondary` (.7) |
| .62 / .6, `#a3a3a3` | `--px-color-text-muted` (.62) |
| .5 / .45, `#808080`, `#8c8c8c` (text) | `--px-color-text-dim` (.5) |
| .38, `#6d6d6d`, `#6b6b6b` | `--px-color-text-faint` (.38) |
| white fills .06–.1 / .12–.14 / .22 (keys, switch off) | `--px-surface-1` / `-2` / `-3` |
| progress tracks .2 / .22 / .25 | `--px-color-progress-track` (.22) |
| `rgba(0,0,0,.56)` (chipBg) | `--px-surface-control` |
| `rgba(28,28,28,.72)` / `rgba(40,40,40,.72)` / `rgba(103,103,103,.35)` | `--px-surface-tile` / `-option` / `-card` |
| `#1d1d1d9e`, `rgba(29,29,29,.62)` / `#1515152e`, `rgba(21,21,21,.18)` | `--px-surface-chip` / `-score` |
| dialog panels `rgba(20,20,20,.72 / .85 / .9)` | `--px-surface-raised` (.85) |
| scrims `rgba(17,17,17,.191 / .4)` / `.55` / `rgba(10,10,10,.9 / .92)` | `--px-scrim` / `-strong` / `-panel` (.92) |
| `#FFC107` progress / "on" (menu section, tiles in the list, best match) | `--px-color-progress` / `--px-color-on` |
| `#2bb673`, `#46d369`, `#f5a524`, `#e5383b`, `#ff6f6f`, `#e88aa1`, `#C2405F` | `--px-color-positive`, `-live`, `-caution`, `-danger`, `-error`, `-warn`, `--px-wine` / `--px-color-accent` |
| 15 z-index values | `--px-z-*`, same order, except below |

Visual changes, measured (pixel diff of `step1/` against `before-tokens/`, the clock masked; > 24 levels: nothing but the clock):
- Text on a white focus fill: `#000` and `rgb(17,17,17)` → `#141414` (keys, chips, menu, dialogs).
- Opaque greys on the full-screen pages → the white-alpha scale: a few levels each (power menu 5 % of pixels by ≤ 16 levels: its ground `rgb(17,17,17)` → `#141414`, buttons `#181818` → `#1d1d1d`; profile picker 2 % by ≤ 12).
- Near values merged (.6 → .62, .45 → .5, .25 / .2 → .22, dialog panel .9 / .72 → .85, connection-lost scrim kept as `--px-scrim-strong`); invisible at the diff threshold.
- §6 amber, approved: the player's focus (control buttons, subtitle provider tabs, subtitle list) and the error notification's OK button are white like every focus; the torrent picker's "may not play" warning is caution orange (`#b26a00` on focus kept as caution-on-focus); amber is left for progress and "on". Not on any screenshot (the player and the picker aren't shot).
- Stacking: connection lost (`--px-z-system`, 12) is now above full-screen panels (11); they were equal before (DOM order decided).
- Not changed (deliberately, decided in their steps): the 7 focus zoom scales (`--px-zoom-*` defined, used from step 3), radii and spacing (tokens defined, used by the primitives), the two switch colours (kids: mint, releases: wine), button labels' font family.
- At 1920 × 1080 the layout is the 1440 one scaled by 4/3 (`baseline-1080/` vs `baseline/` scaled down: 0.1–7 % of pixels differ by > 40 levels, text antialiasing and the animated backdrop). Before, it stayed 1440 px wide in the top left part of the screen (rows showed more posters, text was smaller).

Checks: `ng build` (production and development) clean; movement + nav specs 60 / 60; the literals grep (§9) finds only the `@font-face` names in `styles.scss`.

Migration checklist (the copies of §2, ticked as steps move them to `ui/`):
- [ ] Title block ×5: `movie-description`, `episode-page`, `adult-title`, `watchlist-page`, `adult-browse` (step 5)
- [ ] Action tiles ×4: `movie-options`, `show-options`, `episode-page`, `adult-title` (step 3)
- [ ] Row titles ×8 and rows ×12 (step 4): movies / TV rows (`movies-slider`), watch list, 18+ posters, search results, cast, similar, seasons, episodes (show page), episodes (episode page), guests, 18+ cast, 18+ more
- [ ] Poster cards ×4, episode cards ×2, portraits ×3 (step 4)
- [x] Modal frames: `torrent-picker`, `play-choice` (now `Dialogs.choose`), `connection-lost`, `notification-handler` (step 2)
- [x] Full-screen panels: `catalog-filter-panel`, 18+ filter panel (`adult-browse`), `text-keyboard`, `pin-pad`, `profile-editor` panels, `connect-page` pairing (step 2)
- [ ] Chips ×6 + search filters + season chips (step 3; the two filter panels' chips are `px-chip` since step 2)
- [ ] Search field / toolbar buttons ×3: `movies-page`, `adult-browse`, `releases-page` rail (step 3)
- [ ] Outline buttons ×7: `watchlist-page`, `adult-browse`, `catalog-filter-panel`, `releases-page`, `profile-editor`, `profile-picker`, `connect-page` (step 3)
- [ ] Switches ×2: `profile-editor`, `releases-page` (step 3)
- [ ] Key grids ×3: `text-keyboard`, `pin-pad`, the search page's own keyboard (decide in step 3)
- [ ] Empty states / notes ×5+ (step 3)
- [ ] Page skeletons: section ×3, detail ×2, rail ×1, full screen ×4 (step 5)

### Step 2: overlays
- `px-dialog`, `px-option`, `px-panel`, `Dialogs` + `<px-dialog-host>`.
- Migrate the torrent picker, play choice, connection lost, error notification (frames), then the catalog filter panel + the 18+ filter panel (one shared frame and `px-chip`), the profile editor's panels, the pairing panel; `text-keyboard` / `pin-pad` on `px-panel`'s frame.
- Verify: every overlay with keys and mouse: Back closes, focus returns, connection lost over an open picker, a panel above a dialog never takes input below it.

#### Step 2 notes (2026-10-21, in progress)

Built (`apps/tv/src/app/ui/overlay/`, exported from `ui/public-api.ts`, declared through `UI_COMPONENTS`):
- **`PxOverlay`** (`px-overlay.ts`, abstract directive): what `px-dialog` and `px-panel` share. **Open while it exists** (the host puts `*ngIf` on it; no `[open]` input, unlike the sketch in §5.3): `ngAfterViewInit` opens a `LayerStack` layer (`id`, priority from `level`, `global`, `element` = the host, `restoreFocus`), `ngOnDestroy` closes it. Inputs `id` (layer + trapping `pxSection` id: the old ids are kept), `level` (`OverlayLevel`: `panel` / `modal` / `alert` / `system` → `LEVEL_PRIORITY` = `LAYER_PRIORITY`, and `--px-z-<level>`), `global`, `focus` (CSS selector focused on open, default the first `[data-px-item], .focusable`), `restoreFocus`. Outputs `(back)` (when listened to, Back is the host's and the overlay stays) and `(closed)` (Back closed it, or its screen was left; not emitted when the host destroys it). `finish()` = closed by the host before acting on a choice (focus goes back first, so what opens next remembers the right element; no `(closed)`). Focus goes through `LayerStack.focus` (the FocusEngine: `.focused` even without OS focus). It keeps the focus: re-grabbed 400 ms after opening if something outside took it, and select with the focus outside refocuses first (replaces connection-lost's own hack and the notification's 100 ms delay). A static `title` attribute is removed from the host (`@HostBinding('attr.title')`: it would be a tooltip over the whole screen).
- **`px-dialog`**: scrim (system level: `--px-scrim-strong`), centred panel (`width` = content width in dp, padding 40/40/34, radius m, max-height 80vh), `title` (2 lines max), `subtitle` (+ `subtitleTone="caution"`), body = a one-column `pxGrid` that scrolls natively (projected items work: containers find entries in the DOM). `reset()` = scroll to top + focus first (new content in an open dialog).
- **`px-option`**: the dialog row (label bold 20, detail, `[progress]` amber bar, dim .7 until focused, white fill when focused); `:host { display: contents }`; projected content follows the focus through `--px-option-fill` / `--px-option-caution`.
- **`px-panel`**: full-screen frame (`--px-scrim-panel`, blur, `--px-z-panel` by default), column `.px-panel-frame` (padding 36 top/bottom, max-height 100vh), optional `title` (bold, `--px-text-title`, margin-bottom 26), `align="start"` + `width` for the wide filter panels.
- **`px-chip`** (pulled forward from step 3 for the filter panels): `key`, `label`, `[selected]`; `display: contents` host, inner `pxItem` button; zoom `--px-zoom-tile`.
- **`Dialogs`** (`dialogs.service.ts`) + **`<px-dialog-host>`** (in `app.component.html` where `<play-choice>` was): `choose<T>({title, subtitle, choices: {key, label, detail?, progress?, value}[], level?, global?, width?, focus?: key, id?})` → Observable (subscribe opens, unsubscribe closes; completes empty on Back), `confirm` → boolean (Back: false), `alert` → emits once dismissed.
- Specs `ui/overlay/overlay.spec.ts` (10: layer + focus, `focus` selector, Back → `(closed)` + focus back, `(back)` keeps it open, quiet finish, focus re-grab, global vs owned layers on navigation, Dialogs choose / cancel / unsubscribe / confirm / alert).
- Gallery: an "Overlays" group (options, chips, buttons opening `Dialogs.choose` / `confirm` / `alert` and a `px-panel`).
- Dev hook: `window.playpexDev.overlay('torrents' | 'playChoice' | 'error' | 'connectionLost')` (fixture data), `input('select' | 'back' | 'leave')`, `layers()` (open layer ids). `scripts/screens.js`: 4 overlay shots after `movie` (`torrent-picker`, `play-choice`, `error`, `connection-lost`; shot entries take an `after` call that closes them).

Migrated:
- `torrent-picker` → `px-dialog` + `px-option`s with projected tags / meta / name / warnings (a new request while open swaps in place: `reset()`); `connection-lost` → `px-dialog level="system" global` (component reduced to `onClosed`, scss deleted); `notification-handler` → `px-dialog level="alert" global`, message as subtitle, an "OK" option (scss deleted); **`play-choice/` deleted**: `PlayChoiceService.choose` is a `Dialogs.choose` call (id `playChoice`, same texts and progress).
- `text-keyboard`, `pin-pad` → `px-panel` (`(back)` = cancelled; select via `(pxSelect)` on their key wrappers; they no longer touch `LayerStack`); `catalog-filter-panel` and the 18+ filter panel (`adult-browse`) → `px-panel align="start" [width]="1040"` + `px-chip`s with `(pxSelect)` per chip (no more dataset parsing); profile editor's `avatarChooser` / `confirmDelete` → `px-panel [restoreFocus]="false"` (`(back)="saving || closePanel()"`); `/connect` pairing → `px-panel` around its own card. No component outside `ui/` and `nav/` calls `LayerStack.open` any more.

Visual changes (§6, decision H), measured against before shots (a scratch build of the old overlay files, same fixtures):
- Dialogs: one frame. Subtitle colour `--px-color-text-muted` (.62; was opacity .6 / .7), line-height 1.4, title → subtitle 10, subtitle → list 26 (torrent picker was 8 / 24, play choice 10 / 26); torrent rows padding 16/18/18 (was 14/18: rows 4 dp taller); bottom padding 34 (picker was 30). The play choice title wraps to 2 lines instead of an ellipsis.
- Error notification on the dialog frame: 480 wide (was 262, centred text, white "ok" button), left-aligned message, an "OK" option row.
- Filter panels: one layout (the list page's): 18+ panel padding 40 → 36, group titles 30/14 → 26/12, chip padding 14 → 16, actions margin 16 (+28 on the buttons) → 30, period chips wrap; both titles stay put while the groups scroll.
- Panels' titles are `<h2>` (were `<p>` in the keyboard / editor): same font and size.

Left to do before step 2 is done:
1. **Rebuild and re-shoot** (`npm run screens -w apps/tv`): the first run predates two fixes (dialog `width` is the content width, not border-box: dialogs were 80 dp narrow; first option not shown focused in an unfocused window: focus now goes through the FocusEngine). Compare the 4 overlay shots with the before set and the rest with `.screens/baseline`. The before set lives only in the session scratchpad: rebuild it if needed (old overlay files are in git history once committed, or in this step's diff).
2. **Scenario run** (keys + mouse): a scratch script (`scenarios.js`, Electron, `sendInputEvent`) covers picker navigation / trap, connection lost over the picker (Back closes only the top one, focus back in the picker), play choice Enter, error OK, click / hover / right click on options, the movies and 18+ filter panels (open on the selected chip, Enter selects, Back → filter button), keyboard on `/connect` (typing, Back → "Enter address"), avatar panel and PIN pad in the profile editor, the gallery's Dialogs. Its first run finished but **wasn't read**; re-run on the fixed build and read it. Not covered yet: a panel above a dialog never taking input below it, the pairing panel (needs a server to pair with).
3. Look at the panels by eye (keyboard, PIN pad, both filter panels, avatars, delete confirmation, pairing).
4. Docs: `apps/tv/src/app/CLAUDE.md` (shell layout, component index rows of the migrated overlays, services rows for `PlayChoiceService` / `Dialogs`, "UI system" section), then mark step 2 done here.

### Step 3: atoms and the action bar
- `px-action`, `px-action-bar`, `px-button`, `px-chip`, `px-search-field`, `px-switch`, `px-score`, `px-meta`, `px-progress`, `px-empty`, `px-spinner`.
- Migrate the 4 detail pages' tiles, the toolbars (`movies-page`, `adult-browse`, the releases rail), chips everywhere, empty states.
- Verify: tile states (Resume bar, on / off, busy, disabled), toolbar Left / Down handoffs unchanged (`leaveFor` targets), search field → keyboard → results.

### Step 4: cards and rows
- `px-card` (4 variants), `px-card-row` (+ `pxCardTemplate`).
- Known defect to fix on the way: `adult-browse`'s `.sliderContainer` sets `margin-top: auto` and then `margin: 0 -10px` overrides it (the rows sit at the bottom only because `.titleInfo` has `flex: 1`).
- Migrate all 12 rows: movies / TV rows, watch list, 18+ posters, search results, cast, similar, seasons (chips via template), episodes, guests, 18+ cast / more.
- Verify: positions restored per row (`PositionStore` keys unchanged: same `rowKey`s), paging (`nearEnd`), chevrons, wheel stepping on transform stacks, focus zoom not clipped, `min-width: 0` behaviour in the flex shell.

### Step 5: title info and layouts
- `px-title-info`; `px-section-layout`, `px-detail-layout`, `px-rail-layout`, `px-fullscreen-layout`.
- `movie-description`, the episode title block, `adult-title`, `watchlist-page`, `adult-browse` render `px-title-info`. `movies-page` uses `px-detail-layout` for its `.pageContainer`; `adult-title` drops its copy. `releases-page` on the rail layout; picker / connect / power / editor on the fullscreen layout.
- Verify: every screen's screenshot vs the baseline; detail pages: buttons focused → page back at the top; the description hidden while the view is empty.

### Step 6: models and slots
- `ui/models.ts`, `ContributionRegistry`, `defineContribution`, `<px-slot>`, the slot catalog of §5.6 with typed contexts.
- The core moves its movie / show / episode actions and title-page rows to contributions where that's natural (decided per slot; the step notes list which stay in templates and why).
- Specs: ordering, context changes re-render, a throwing contribution is skipped, kids profiles never get adult contributions, key prefix rules.
- Verify: nothing visible changes; the gallery gets a "slot" page fed by test contributions.

### Step 7: contract, example, docs
- `ui/public-api.ts` complete, `UI_API_VERSION = 1`; the example plugin of `navigation-system-plan.md` step 7 built with this plan's additions (§7). If that step is done together with this one, one example covers both.
- Docs: `docs/tv-plugins.md` (author guide draft: screens, layouts, primitives, slots, tokens; like `docs/api/` for server clients), the "Recipes › Add a new page / Add a row" parts and a new "UI system" section of `apps/tv/src/app/CLAUDE.md`, the component index updated, the root `CLAUDE.md` conventions bullet ("tokens only, primitives from `ui/`").

## 9. Verification

For every step (and the final pass), from `apps/tv`:
- Unit: `CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --include src/app/ui` (+ `src/app/movement` and `src/app/nav` stay green).
- Build: `NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null`.
- Screenshots: the step 0 script, compared with the baseline (gallery: pixel diff; live screens: side by side). Differences are listed in the step's notes, each either a §6 item that was approved or a bug.
- Literals check on migrated files: `grep -nE "#[0-9a-fA-F]{3,8}\b|rgba?\(|font-family: *['\"]|z-index: *-?[0-9]|[0-9]px\b" <files>` finds nothing outside `styles/_tokens.scss` (exceptions: the `@font-face` names in `styles.scss`, `px` in comments).
- Scenarios (Electron, keys via `webContents.sendInputEvent` with Electron key names `Escape` / `Return` / arrows, plus the mouse), for every migrated screen:
  1. Every focusable thing reachable with arrows, Enter does what it did, Back follows the screen's ladder (`navigation-system-plan.md` §6).
  2. Movies list → poster → similar → similar → Back × 3: each page's rows where they were (positions survive the new components).
  3. Every overlay: open, navigate, Back, focus restored; overlay over overlay.
  4. Mouse: hover focuses, click selects, chevrons page, wheel steps / scrolls as before, Back button.
  5. 18+ screens show the accent, others don't; switching sections switches it.
  6. Kids profile: no adult contributions, no 18+ menu entry (unchanged).

## 10. Files you will touch (summary)

New: `apps/tv/src/styles/` (`_tokens.scss`, `_mixins.scss`), `apps/tv/src/app/ui/` (atoms, composites, layouts, `dialogs.service.ts`, `px-dialog-host`, `models.ts`, `contribution-registry.ts`, `px-slot`, `slots.ts` (catalog + context types), `gallery/`, `public-api.ts`, specs), `apps/tv/scripts/screens.js`.
Changed: `styles.scss`, `app.module.ts`, `app.component.html` (dialog host, accent attribute), `nav/screen.ts` (`Chrome.accent`), `nav/screens.ts` (accents, gallery), `nav/nav-debug.component.ts` (dev hook), every component's `.html` / `.scss` in steps 1–5, `play-choice.service.ts`, `torrent-picker/`, `.gitignore` (`apps/tv/.screens/`), the `CLAUDE.md` files, `docs/tv-plugins.md`.

## 11. Decisions (taken 2026-10-21; bold = chosen: the recommended defaults, except G)

- **A. Token format**: **CSS custom properties as the source, a thin SCSS layer for mixins** (themable at runtime, cross encapsulation and shadow DOM, usable by plugins without SCSS) / SCSS variables only (compile-time, no runtime themes) / both mirrored.
- **B. Granularity**: **few components with variants** (`px-card variant=…`, `px-action`) / one component per use (`px-poster-card`, `px-episode-card`, …).
- **C. Item rendering in composites**: **view models by default + an `ng-template` escape hatch** (core keeps custom cards; plugins use models) / templates only / models only.
- **D. Plugins in core screens**: **slots with view models, rendered by core components** (native look, survives template changes, no plugin code in core templates) / plugins render their own components into slots (more freedom, look and keyboard behaviour not guaranteed) / no slots, own screens only.
- **E. Core actions through slots**: **yes where natural** (the core proves the slot; decided per slot in step 6) / slots for plugins only (core stays in templates; slots untested by the core).
- **F. Packaging**: **folder `apps/tv/src/app/ui/` in `AppModule`, extracted to a package (`packages/tv-ui`) when a plugin loader exists** / a separate `UiModule` now / a package now.
- **G. Units**: keep px (the app is designed for a fixed 1440 px viewport) / **rem with a root scale** (chosen by the user: px doesn't follow the screen; built in step 1, §5.1 "Units").
- **H. Visual unification (§6)**: **apply it, item by item, with screenshots of before / after for each** / strict parity only, unify later / redesign while migrating.
- **I. 18+ accent**: **a theme attribute set from `ScreenDef.chrome.accent`** / a class each 18+ page adds itself.
- **J. Visual checks**: **screenshot script + eye comparison for live screens, pixel diff only for the gallery** / pixel diff everywhere (live TMDB data makes it flaky) / by eye only.

## 12. Later (not part of this plan)

- Plugin loading and isolation (Angular lazy modules + `router.resetConfig`, Web Components, iframes or workers for contribution code), a manifest (`NAV_API_VERSION` + `UI_API_VERSION` ranges, screens, slots used, permissions), where plugins come from (served by the server for every client).
- Plugin data access: a plugin needs catalog, library and playback APIs (`PlaybackService.play`, `LibraryService`, the server's API); today they're core services, not a contract. A `sdk/` facade over them is the next plan.
- Player extension points (overlays, extra panels), menu badges, settings pages contributed by plugins (with `core.settings` on `px-rail-layout`).
- More themes (light, high contrast) and other resolutions (decision G).
- Sharing tokens with the dashboard (`apps/dashboard`, shadcn/ui) through `packages/protocol` or a `packages/design-tokens`.

## Legal note
Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.
