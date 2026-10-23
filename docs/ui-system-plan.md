# UI system (tokens, components, layouts, slots): plan

Status (2026-10-22, evening): **steps 0–7 done**: harness, tokens, overlays, atoms, cards and rows, title info and layouts, models and slots, the contract (`UI_API_VERSION = 1`) with the example plugin and `docs/tv-plugins.md`; **§13 built** (screen edges, media keys, toasts, loading states, the performance tool and baseline, `check:contrast`); **§14 done**. Step notes below each step; what stayed out (and why) is in them. Decisions A–J (§11) as before; K–P (§13) taken with the recommended defaults, N measured and left for the user (§13.6). The movement system decides how focus moves, the navigation system which screen is shown and who gets an input; this plan covers **what a screen is built from.**

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

~~Still open: correcting the navigation plan's status line~~: done 2026-10-22.

Gap review (2026-10-22, planned, not built): **§13** TV interface essentials (screen edges, media keys, toasts, loading states, performance budget, contrast) and **§14** plan housekeeping. Settings move to the server DB: `docs/settings-plan.md`.

### Review of 2026-10-22 (what the plan was missing)

Decided by the user: the UI scale per device, set on the first start and in Settings; a floor on the root size; the font sizes merged into a type scale now, with screenshots. Done:
- **UI scale** (`--px-ui-scale`, §5.1 "Units"): `client.json` `uiScale` (shell: `display:get` / `display:set`, `window.playpex.display`; browser: `localStorage['playpex.uiScale']`), applied before Angular boots (`ui/display.ts` `resolveDisplay()`, awaited by `main.ts` with `resolveServer()`). Five sizes, `UI_SCALES` (Small 0.7, Medium 0.8 = default, Large 0.9, Larger 1, Largest 1.15). Chosen on the **first start** (`core.display`, `display-setup/`, behind a new requirement `display` → `DisplayGuard` on `core.connect` and `core.profiles`) and in **Settings** (`core.settings`, `settings-page/`, menu entry order 60; the placeholder menu item is gone). Both use `<display-size>` (`display-size/`): a `pxGrid` of `px-chip`s, the focused size is applied at once (the screen is the preview), Enter stores it, leaving without Enter puts the stored one back. Settings has a plain ground over the shell's backdrop.
- **Floor**: the root size is `max(12px, …)`: dp(12) text stays ≥ 9 px on small windows (the one deliberate px, marked for `check:ui`).
- **Type scale** (§6): 30 font sizes → 11 steps `--px-text-*` (table in §6). Measured against shots taken just before (scale 0.8, 1440 × 810): titles, overviews and the dialogs' option rows unchanged; small tags / meta lines / labels moved by 1 dp where 13 / 15 / 17 / 19 / 21 / 25 / 30 / 34 / 38 / 48 / 58 were merged.
- **Image sizes**: `ui/images.ts` `tmdbImageBase(kind, widthDp, zoom = 1.1)` picks the smallest TMDB size covering the rendered size (root size × device pixel ratio × zoom): posters, similar titles, search results, stills, portraits (1440 × 810: w185 / w154; 4K: h632 / w500, was a fixed w154 / w342). The movie page's similar posters used the portrait base (w154) by mistake: fixed. The shell's backdrop stays w780 (it's blurred by dp(5)).
- **Reduced motion for GSAP**: `AppComponent` sets `gsap.globalTimeline.timeScale(1000)` while `prefers-reduced-motion` is on (timelines land at once, callbacks still fire). The literal GSAP durations in 9 files stay until their components move to `ui/` (steps 3–5: `dur()` from the tokens, see §5.1).
- **Enforcement**: `npm run check:ui` (`apps/tv/scripts/check-ui.js`) fails on colour / font / z-index / px literals and font sizes outside the scale; exceptions carry `// ui-check: allow (reason)`.
- **Screenshot references** re-shot (scale 0.8, the type scale): `.screens/baseline` (1440 × 810), `baseline-1080`; the scale-1 sets kept as `baseline-scale1` / `baseline-1080-scale1`. `scripts/screens.js` writes `uiScale` (`--scale`, default 0.8) into its copy of `client.json` and shoots `settings` and `display` too.

**Player** (2026-10-22, asked by the user with the frontend-design brief; features chosen: seek preview with hold-to-speed, next episode, subtitle size and sync): on the movement system (`pxSection="playerControls"`, `pxStack` of the timeline and a `pxGrid` of buttons; a window capture listener takes only the arrows that mean time), Angular state instead of GSAP display toggles, the subtitles panel a `px-panel` layer (new `edge="end"` variant: docked, side gradient, new tokens `--px-surface-pane-solid`, `--px-gradient-panel-end`). Signature: the timeline shows played (amber), downloaded around the playhead (`--px-timeline-loaded`) and the rest hatched (`--px-gradient-timeline-unloaded`); a scrub preview outlines its tab when it lands on the hatched part. Buttons are icons that grow into a labelled white pill when focused (new `assets/icons/next.svg`). Route `player/:session` so the next episode can replace the entry with a new component. Verified with a scratch scenario (keys on a 15 min ffmpeg test clip through `window.playpexDev.player()`): 25 checks (controls, button movement, held scrub previews without seeking then seeks once, controls-hidden scrub, OK pauses, subtitles layer + size + timing + focus back, stats, Up next card / button / dismiss) and the replace (new component, same depth, Back to the screen before). Not run: a real torrent and the next episode's real release (they'd download one); the streaming code itself is unchanged. Same day, after the user's review: the subtitles panel became **Settings** (the "•••" button; CC opens it on Subtitles): tabs on top (moving onto one shows it; tabs and content are one `pxStack`, so Up from the content returns to the shown tab, which a side rail of tabs couldn't guarantee) for Subtitles, Size & timing (with a live sample line), Audio (volume, mute), Video (speed, fit / fill), Stats (with "Show on screen while watching"; the separate stats toggle is gone). New movement option `enter="selected"` (a chip group is entered on its current choice). Checked with a second scenario (17 checks). The movie page's similar-title posters and cast portraits had no size of their own (they relied on the image's natural size, which `tmdbImageBase()` changed): now sized by their frame (`object-fit: cover`), and posterless titles no longer leave empty slots. Then, from the user's next review: quantities became sliders (**`px-slider`**, `ui/controls/`, a step-3 atom pulled forward: one focusable item, ←/→ and click / drag change it, `origin` and named `stops`, `role="slider"`): subtitle size and timing, volume, speed, and new Zoom and Brightness; picture modes Fit / Fill / Stretch / Original size; no line under the tabs. Scenario: 22 checks, including a click on a track.

Planned where they belong (not built):
- Layouts and the scale (step 5): regions sized by the screen (`vh`, the menu's spread icons, rows pushed to the bottom) and content sized by the scale; at 0.8 the movies list has a taller gap above the rows. Each layout says which regions follow which.
- Pieces in no step until now: menu, back button and clock (step 5, shell layout), profile tiles and power buttons (step 3: `px-card variant="portrait"` / `px-button`), release rows and the `/connect` server list (step 4: a `list` row variant of `px-option`), season curve and trailer (tokens only, like the player), the shell layout (step 5, `px-shell`).
- Slots that change (step 6, §5.6): contributions return an `Observable` of models (or a value), action keys are prefixed like row keys.
- Smaller (step 3 unless noted): `OnPush` on every primitive; `px-card` placeholder and failed-image states; ARIA roles on dialogs, options and switches; labels stay English (no i18n in this plan, §12).

## 1. Goal

One shared set of UI primitives for Playpex TV that:

1. **Gives the app one visual language in code.** Colours, type, spacing, radii, focus treatment, motion and stacking order are **tokens**, defined once. Today they're literals copied into each component's SCSS.
2. **Turns the patterns every page re-implements into components**: action tiles, cards, rows of cards, the title block, chips, search fields, dialogs, panels, empty states. Each one comes with its movement and navigation wiring built in (`pxItem`, `pxSelect`, `rowArrows`, layers), so a page can't get that wiring wrong.
3. **Provides layouts**: a handful of page skeletons (section, detail, rail + list, full screen) that core screens and plugin screens fill in, instead of copying a neighbour's SCSS.
4. **Lays the ground for plugins.** It adds **view models** (cards, rows, actions, title info as data) and **slots** (named extension points inside core screens: "actions of the movie page", "rows of the movies section"). With them a plugin can add to a core screen and look native without knowing its templates. This is the "extension points inside core screens" item that `navigation-system-plan.md` §13 left for later.
5. **Has the core use it first** ("dogfooding", as in the navigation plan). Core screens are built from the same components and fill the same slots a plugin will, so the API is proven before any plugin exists.

Like the other two systems, it can be adopted **page by page**: a page not yet migrated keeps its own markup and SCSS until it's moved, and each step leaves the app looking the same.

Non-goals: a visual redesign (parity first; changes are listed and decided, §6), the plugin loader (packaging, sandboxing, distribution: §12), the player's own layout (it stays in `player-page/`; its controls come from `ui/`: `px-button variant="icon"`, `px-tabs`, `px-slider`, `px-chip`, `px-panel edge="end"`), the dashboard (`apps/dashboard` has shadcn/ui), an Angular upgrade (works on 14.1 as installed).

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

Other constraints the primitives must respect (from the guides): `MenuComponent` queries `.description`, `.menuItem`, `.element`, `.tabs` document-wide, so primitives must use their own prefixed class names. Flex hosts with wide rows need `min-width: 0`. Rows need padding + negative margin for the focus zoom (`16px 10px` for posters). Angular 14 has no `hostDirectives` (15+), so a component can't apply `pxItem` to its own host. Layout was designed for a fixed 1440 px viewport (written in 2026-10-20; since step 1 it scales, §5.1 "Units").

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

The sketch below is the proposal as written before step 1; the built names differ (roles such as `--px-surface-bg`, `--px-color-text-secondary`, `--px-color-text-muted`, the type scale `--px-text-tiny … -display`): `_tokens.scss` and the "UI system" section of `apps/tv/src/app/CLAUDE.md` are the reference.

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

**Units (decision G, as built).** No `px` in stylesheets or code. `dp(n)` (`styles/_px.scss`; `dp()` in TS from `ui/public-api.ts` for GSAP tweens and inline styles) is n pixels of the 1440 × 810 design, in rem. The root font size is `min(100vw / 90, 100vh / 50.625)`: 16px on a 1440 × 810 window (identical to the old px layout), 21.33px on 1920 × 1080, 32px on 4K, and bounded by height on screens wider than 16:9 so the rows don't fall off the bottom; all of that times `--px-ui-scale` (`_tokens.scss`, 0.8 since 2026-10-21: at 1 the UI read too big, so the sizes above are now 12.8 / 17.07 / 25.6px). Full-screen frames are in `vw` / `vh`, so a smaller scale shows more content, not a smaller frame. The scale is **per device** (`client.json` `uiScale`, `ui/display.ts`): chosen on the first start (`core.display`) and in Settings; the token's 0.8 is the default before one is stored. The root size never goes under **12 real pixels** (`max(12px, …)`). Images follow the same arithmetic: `tmdbImageBase()` (`ui/images.ts`). TS durations: `dur(token)` reading `--px-dur-*` is planned with the primitives (step 3); until then GSAP is slowed to instant globally for reduced motion (`AppComponent`). Form controls get `font-size: dp(13.333)` globally (the browser's fixed default didn't scale). Measured values (`getBoundingClientRect`, the movement system's offsets, `--rowArrowsY/H`) stay in px: they are already the real size.

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
<px-dialog *ngIf="request" id="playChoice" level="modal"
           title="Resume ‘Heat’?" subtitle="…" (closed)="…">   <!-- built: open while it exists, `level` instead of a priority (step 2 notes) -->
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
- Rules (enforced by `defineContribution`, like the screen rules in `navigation-system-plan.md` §8): ids `plugin.<pluginId>.<name>`, row keys **and action keys** prefixed `<pluginId>:` (position memory and the action bar's `pxGrid` keys can't collide with the core's), at most N contributions per slot per plugin, ordering ties broken by id.
- **Contributions change** (added 2026-10-22): `actions` / `rows` / `meta` return the models **or an `Observable` of them**, so a contribution can wait for data ("only when the server has X") and update its state after a `run()` (a toggle's `on`, `busy` while working). `<px-slot>` subscribes per context and unsubscribes on change. When an item disappears or moves, focus goes to its neighbour in the same container (the `FocusEngine`'s rule for removed items), and a row that appears late never takes the focus. Specs in step 6 cover both.

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
- **Type scale (done 2026-10-22)**: 30 font sizes → 11 steps. `tiny` 12 (was 11, 12), `small` 14 (13, 14), `label` 16 (15, 16, 17), `lead` 18 (18), `body` 19.2 (18.4, 19, 19.2, 20, 21; 19.2 = the overviews' 1.2rem, kept so they wrap as before), `heading` 22, `headline` 26 (25, 26), `title` 32 (30, 32), `large` 36 (34, 35.2, 38), `hero` 44.8 (44.8, 48), `display` 54 (54, 58). `--px-text-row` = `label`. Exceptions: the form controls' base `dp(13.333)` (styles.scss) and the player's relative `120%`.
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
- [x] Title block ×5: `movie-description`, `episode-page`, `adult-title`, `watchlist-page`, `adult-browse` (step 5)
- [x] Action tiles ×4: `movie-options`, `show-options`, `episode-page`, `adult-title` (step 3)
- [x] Row titles ×8 and rows ×12 (step 4): movies / TV rows (`movies-slider`), watch list, 18+ posters, search results, cast, similar, seasons, episodes (show page), episodes (episode page), guests, 18+ cast, 18+ more
- [x] Poster cards ×4, episode cards ×2, portraits ×3 (step 4)
- [x] Modal frames: `torrent-picker`, `play-choice` (now `Dialogs.choose`), `connection-lost`, `notification-handler` (step 2)
- [x] Full-screen panels: `catalog-filter-panel`, 18+ filter panel (`adult-browse`), `text-keyboard`, `pin-pad`, `profile-editor` panels, `connect-page` pairing (step 2)
- [x] Chips ×6 + search filters + season chips (step 3; the two filter panels' chips are `px-chip` since step 2; the title blocks' chips are `px-meta`'s; season chips stay the show page's own, in `px-card-row`'s template)
- [x] Search field / toolbar buttons ×3: `movies-page`, `adult-browse`, `releases-page` rail (step 3)
- [x] Outline buttons ×7: `watchlist-page`, `adult-browse`, `catalog-filter-panel`, `releases-page`, `profile-editor`, `profile-picker`, `connect-page` (step 3)
- [x] Switches ×2: `profile-editor`, `releases-page` (step 3)
- [x] Key grids ×3: decided in step 3: `text-keyboard` / `pin-pad` keep their keys on `px-panel`; the search page keeps its own inline keyboard (see step 3 notes)
- [x] Empty states / notes ×5+ (step 3)
- [x] Page skeletons: section ×3, detail ×2, rail ×1 (+ Settings), full screen ×4 (step 5; the power page stays a page cover)

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

Finished 2026-10-22: rebuilt and re-shot (`.screens/pre-step3`, against `.screens/baseline`): the four overlay shots show one frame, the first option focused (the two fixes hold); panels checked by eye in the same set and in the scenario shots. The old scratch scenario wasn't kept: `scripts/scenario.js` + `scripts/scenarios/*.js` replace it (step 3 notes); the overlay paths are covered by `settings` (a `px-panel` calibration: Back restores, focus back), `media-keys`, `plugin` (`Dialogs.confirm` then a toast) and the overlay specs. Docs: `apps/tv/src/app/CLAUDE.md` updated.

### Step 3: atoms and the action bar
- `px-action`, `px-action-bar`, `px-button`, `px-chip`, `px-search-field`, `px-switch`, `px-score`, `px-meta`, `px-progress`, `px-empty`, `px-spinner`.
- Migrate the 4 detail pages' tiles, the toolbars (`movies-page`, `adult-browse`, the releases rail), chips everywhere, empty states.
- Also (review of 2026-10-22): the profile picker's tiles (`px-card variant="portrait"`) and the power page's buttons (`px-button`); `OnPush` on every primitive; ARIA roles (`role="dialog"` on `px-dialog`, `option` / `listbox` on `px-option` lists, `switch` on `px-switch`); `dur(token)` in `ui/units.ts` (reads `--px-dur-*`, 0 with reduced motion) and the GSAP durations of migrated components moved onto it.
- Verify: tile states (Resume bar, on / off, busy, disabled), toolbar Left / Down handoffs unchanged (`leaveFor` targets), search field → keyboard → results.

### Step 4: cards and rows
- `px-card` (4 variants), `px-card-row` (+ `pxCardTemplate`).
- Known defect to fix on the way: `adult-browse`'s `.sliderContainer` sets `margin-top: auto` and then `margin: 0 -10px` overrides it (the rows sit at the bottom only because `.titleInfo` has `flex: 1`).
- Migrate all 12 rows: movies / TV rows, watch list, 18+ posters, search results, cast, similar, seasons (chips via template), episodes, guests, 18+ cast / more.
- `px-card` takes its image size from `tmdbImageBase()` (`ui/images.ts`, built) and has a placeholder (loading) and a failed-image state besides "no artwork". The release rows (`releases-page`) and the `/connect` server list become a list variant (`px-option` rows in a scrolling `pxGrid`).
- Verify: positions restored per row (`PositionStore` keys unchanged: same `rowKey`s), paging (`nearEnd`), chevrons, wheel stepping on transform stacks, focus zoom not clipped, `min-width: 0` behaviour in the flex shell.

### Step 5: title info and layouts
- `px-title-info`; `px-section-layout`, `px-detail-layout`, `px-rail-layout`, `px-fullscreen-layout`.
- `movie-description`, the episode title block, `adult-title`, `watchlist-page`, `adult-browse` render `px-title-info`. `movies-page` uses `px-detail-layout` for its `.pageContainer`; `adult-title` drops its copy. `releases-page` on the rail layout; picker / connect / power / editor on the fullscreen layout.
- The shell as a layout (`px-shell`: menu rail, back button, clock, backdrop, content), so the menu, back button and clock get tokens and a place in the plan.
- **Layouts and the UI scale**: each layout says which regions follow the screen (`vw` / `vh`: full-screen frames, the backdrop) and which follow the scale (rem: content, gaps, the menu's item spacing). At 0.8 today the section pages keep a screen-tall gap above the rows and the menu spreads its icons over the full height; decide per layout (e.g. rows pushed to the bottom keep a scale-sized gap, the menu centres a scale-sized block).
- Verify: every screen's screenshot vs the baseline; detail pages: buttons focused → page back at the top; the description hidden while the view is empty; each layout at scales 0.7 and 1.15.

### Step 6: models and slots
- `ui/models.ts`, `ContributionRegistry`, `defineContribution`, `<px-slot>`, the slot catalog of §5.6 with typed contexts.
- The core moves its movie / show / episode actions and title-page rows to contributions where that's natural (decided per slot; the step notes list which stay in templates and why).
- Specs: ordering, context changes re-render, a throwing contribution is skipped, kids profiles never get adult contributions, key prefix rules.
- Verify: nothing visible changes; the gallery gets a "slot" page fed by test contributions.

### Step 7: contract, example, docs
- `ui/public-api.ts` complete, `UI_API_VERSION = 1`; the example plugin of `navigation-system-plan.md` step 7 built with this plan's additions (§7). If that step is done together with this one, one example covers both.
- Docs: `docs/tv-plugins.md` (author guide draft: screens, layouts, primitives, slots, tokens; like `docs/api/` for server clients), the "Recipes › Add a new page / Add a row" parts and a new "UI system" section of `apps/tv/src/app/CLAUDE.md`, the component index updated, the root `CLAUDE.md` conventions bullet ("tokens only, primitives from `ui/`").

### Steps 3–7 notes (2026-10-22)

Built in one pass after the settings plan's server side; every step verified with the build (development and production), `check:ui`, `check:contrast`, the `ui` / `movement` / `nav` specs (107, all pass; the full suite has only the 14 CLI "should create" stubs failing, as on the last commit), screenshots (`.screens/pre-step3`, `step3`, `step4`, `step5`, `step5-scale0.7`, `step5-scale1.15`, `final`) and keyboard scenarios.

**Scenario runner** (new, kept): `apps/tv/scripts/scenario.js` + `scripts/scenarios/<name>.js` (`npm run scenario -w apps/tv -- <name>`): Electron like `screens.js`, real keys (`sendInputEvent`), checks, shots, CDP (`t.cdp`); `--server <url>` uses a throwaway server (e.g. `PLAYPEX_CONFIG_DIR=… PLAYPEX_PORT=28480 npm run server`, loopback, device `tv-scenario`). Scenarios: `rows` (15 checks), `settings` (20), `media-keys` (8, `PLAYPEX_TEST_CLIP`), `plugin` (10), `perf` (§13.5). Electron's `sendInputEvent` has no FastForward / Rewind key names: those are DOM events. `window.playpexDev` gained `api`, `deviceId`, `plugin(name, on)`.

**Step 3 (atoms)**, `ui/atoms/`, `ui/controls/`, `ui/toast/`: `px-action` (+ `onIcon`, `busyLabel`; `--px-action-label-width`), `px-action-bar` (projected tiles and/or `ActionModel`s → `(picked)`; padding, not margin, so it never collapses into its neighbours), `px-button` (`outline` · `primary` · `filled` · `danger` · `toolbar` (`active`, `quiet`, `dim`, `size="l"`) · `plate` · `icon` (the player's: round, a white pill with its label when focused); `caps`, `size`, `round`, `width`, `align`), `px-search-field`, `px-switch` (a focusable row; restyled through `--px-switch-*`), `px-score` (+ `label`: a provider's name), `px-meta`, `px-progress`, `px-spinner`, `px-empty` (`size="hero"`, `busy`, `(act)`), `px-skeleton`, `px-tabs` (from the player; `vertical` for rails), `Toasts` + `<px-toast-host>` (§13.3), `dur()` in `ui/units.ts`, `ui/models.ts`. `OnPush` on every primitive (also the step 2 ones; the slider marks itself on keys / drags); ARIA: `role="dialog"` + `aria-modal` on dialogs and panels, `listbox` / `option`, `switch` + `aria-checked`, `slider`, `tablist` / `tab`, `progressbar`, `status` (toasts, spinner), `aria-pressed` on chips and on/off tiles, `aria-busy`. New tokens: `--px-zoom-control`, `--px-gradient-shimmer`, `--px-z-toast` (system / splash renumbered 13–14, order unchanged), `--px-safe-*`, `--px-screen-h/-w`.
- Migrated: the tiles of the 4 title pages; the toolbars (movies, 18+, the releases rail); the filter panels' buttons; the outline buttons of the watch list, 18+, filter panels, releases, profile editor (caps), profile picker, `/connect` (`size="l" round`); both switches; the search filters' and the releases rail's chips → `px-chip`; the empty states / notes (watch list, 18+, releases, the list page's and the search page's notes) → `px-empty`; the power menu (`plate`); the player's buttons (`icon`) and its tabs (`px-tabs`).
- Kept, decided: the profile picker's tiles (square avatars with an edit overlay, a kids tag and a lock: not a portrait card); the search page's own keyboard (always on screen with live results; `<text-keyboard>` is a modal panel) and no `px-text-field` until a second text input needs one; keypads keep their keys on `px-panel`.
- Visual changes (§6, measured on the shots): the 18+ filter button's max width 300 → 420 (the movies one); releases rail: "Back to <title>" all white (the prefix was muted), "Clear search" padding 12 → 16; chips of the search page / releases rail: h40 → 42, padding 20 → 16, zoom 1.08 → 1.06, still dark (`--px-chip-bg`) with white labels (`--px-chip-color`, §13.6); "Manage Profiles" spacing 3 → 2 dp, muted instead of dim; `/connect` buttons: label 19.2 → 18, a 1 dp grey outline instead of 2 dp; empty-state notes line-height 1.7 (the list page's was 1.5, the search page's a 16 px .7 line).

**Step 4 (cards and rows)**, `ui/cards/`: `px-card` (`poster` · `compact` · `portrait` · `still`; a shimmer after 300 ms while the image loads, faded in once `decode()`d, the title (initials on a portrait) when there's none or it fails; badges `tv` / `watched` / `upcoming` / `current` / text; progress; `busy` cover; `dim`; caption: number, title, rating, subtitle, `meta`; `data` = `data-*` on the focusable element), `px-card-row` (title in `section` / `detail` tone, `rowArrows`, `pxRow` with the same keys, gutters through `--px-row-*`, `pxCardTemplate` escape hatch, `CardModel` items → `(picked)`, `loading` skeletons).
- All 12 rows migrated: movies / TV, watch list, 18+ posters, search results (people as portraits), cast (movie, 18+), similar, 18+ "More from", seasons (the chip stays the page's, in the template), episodes (show and episode pages, `still`), guests. Fixed on the way: `adult-browse`'s `.sliderContainer` margin (`margin: auto -10 0`).
- Kept, decided: the release rows and the `/connect` server list stay the pages' own (principle 4 names the release row; `/connect` is a bespoke "TV source" list); no `px-option` list variant.
- Visual changes: compact and portrait focus zoom 1.13 → 1.1 (`--px-zoom-card`); cast names in 120 dp instead of 95 (one line for "Robert De Niro"); search portraits 140 → 130, search posters 225 → 230 high; the cast row's gap under its title approximated (46 dp).
- Verified: `rows` scenario (moves, description following, paging near the end, the same poster after a title and Back, a title page's Down / Up through buttons, cast, similar).

**Step 5 (title info and layouts)**, `ui/title/`, `ui/layouts/`: `px-title-info` (`detail` · `section` · `episode`; eyebrow (+ `[pxEyebrow]`), meta (+ `[pxMeta]`), genres, notes, status + amber line, clamped overview, fallback, credits; skeleton while loading) on the 5 title blocks; `px-shell` (`.masterContainer` frame, backdrop and its overlay, `app.component.html`), `px-section-layout` (watch list, 18+ posters), `px-detail-layout` (movies-page's `.pageContainer`, the 18+ title), `px-rail-layout` (releases page, Settings), `px-fullscreen-layout` (picker, editor, `/connect`, the first-start display: brand, safe area). The power menu stays a page cover.
- Visual changes: the description's overview is clamped to 4 lines instead of cut at 255 characters; the meta line's gaps are one rule; the watch list's overview is clamped to 3 lines; the 18+ posters' title sits .67em down (was .4em).
- Layouts and the UI scale (shot at 0.7 and 1.15): section pages keep their rows at the bottom at every scale (the gap shows the title's backdrop: the convention of TV sections), the menu is already a centred block; detail pages scroll. Nothing else moved.

**Step 6 (models and slots)**, `ui/slots/`: the catalog `SLOTS` with typed contexts (`MovieContext`, `ShowContext`, `EpisodeContext`, `SectionContext`, `TitleMetaContext`, `WatchlistContext`), `ContributionRegistry` / `defineContribution` / `CONTRIBUTIONS` (ids `plugin.<id>.<name>` or `core.<name>`, one kind matching the slot, no duplicates, at most 3 per plugin and slot, order then id, adult contributions never for kids, a plugin's keys prefixed `<pluginId>:`, a throwing or erroring contribution shows nothing), `<px-slot>` (actions → `px-action`s, rows → `px-card-row`s with paging and skeletons, meta → `px-meta`; Observables followed, dropped on a new context; intents opened through the `Navigator`). Placed in: the movie / show / episode action bars, the movie / show pages' rows, the Movies / TV sections' rows (not while a search stands in), the watch list's rows, the description's meta line. Core builders in `src/app/slot-contexts.ts`.
- Decided per slot (E): the core's own actions and rows stay in the templates: they depend on page state a read-only context doesn't carry (resume position, busy, the toggles' optimistic state, the season curve). The slots are proven by the example plugin and the gallery's slot section.
- Specs `ui/slots/slots.spec.ts` (9).

**Step 7 (contract, example, docs)**: `UI_API_VERSION = 1`; `ui/public-api.ts` exports everything above; stable tokens marked `// stable` in `_tokens.scss` (§14.5); the example plugin `src/app/plugins-dev/hello/` (development builds: screens `plugin.hello.section` (`p/hello/home`) and `plugin.hello.title` (`p/hello/title/:id`), built on `px-section-layout` / `px-detail-layout` / `px-title-info` / a paged row / `Dialogs.confirm` + a toast; contributions (an action in `core.movie.actions`, a paged row in `core.movies.rows`) installed with `window.playpexDev.plugin('hello', true)` so the core's screenshots stay the core's; it imports only `nav/public-api` and `ui/public-api`); `docs/tv-plugins.md`; the guides. Scenario `plugin` (10 checks). (Replaced 2026-10-23 by the packaged `plugins/hello`, drawn by the plugin templates of `docs/plugins-plan.md` P1: the compiled example, its `playpexDev.plugin()` and the `plugin` scenario are gone; scenario `plugin-templates`.)

Definition of done for a primitive (§14.3), applied to every one above: a spec, every state in the gallery, `check:ui` clean, `OnPush`, its ARIA role, exported from `public-api.ts`, a line in `apps/tv/src/app/CLAUDE.md`, listed here.

## 9. Verification

For every step (and the final pass), from `apps/tv`:
- Unit: `CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --include src/app/ui` (+ `src/app/movement` and `src/app/nav` stay green).
- Build: `NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null`.
- Screenshots: the step 0 script, compared with the baseline (gallery: pixel diff; live screens: side by side). Differences are listed in the step's notes, each either a §6 item that was approved or a bug.
- Literals check: `npm run check:ui` (`apps/tv/scripts/check-ui.js`, every stylesheet): no colour / font family / z-index / px literal outside `styles/_tokens.scss` and `_px.scss`, every font size from the type scale; `@font-face` blocks may name their families, deliberate exceptions carry `// ui-check: allow (reason)`.
- Scenarios (Electron, keys via `webContents.sendInputEvent` with Electron key names `Escape` / `Return` / arrows, plus the mouse), for every migrated screen:
  1. Every focusable thing reachable with arrows, Enter does what it did, Back follows the screen's ladder (`navigation-system-plan.md` §6).
  2. Movies list → poster → similar → similar → Back × 3: each page's rows where they were (positions survive the new components).
  3. Every overlay: open, navigate, Back, focus restored; overlay over overlay.
  4. Mouse: hover focuses, click selects, chevrons page, wheel steps / scrolls as before, Back button.
  5. 18+ screens show the accent, others don't; switching sections switches it.
  6. Kids profile: no adult contributions, no 18+ menu entry (unchanged).

## 10. Files you will touch (summary)

New: `apps/tv/src/styles/` (`_tokens.scss`, `_px.scss`: `dp()` and the mixins), `apps/tv/src/app/ui/` (atoms, composites, layouts, `dialogs.service.ts`, `px-dialog-host`, `models.ts`, `contribution-registry.ts`, `px-slot`, `slots.ts` (catalog + context types), `gallery/`, `public-api.ts`, specs), `apps/tv/scripts/screens.js`.
Changed: `styles.scss`, `app.module.ts`, `app.component.html` (dialog host, accent attribute), `nav/screen.ts` (`Chrome.accent`), `nav/screens.ts` (accents, gallery), `dev-hook.service.ts` (`window.playpexDev`; not `nav-debug`, which mustn't import app services), every component's `.html` / `.scss` in steps 1–5, `play-choice.service.ts`, `torrent-picker/`, `.gitignore` (`apps/tv/.screens/`), the `CLAUDE.md` files, `docs/tv-plugins.md`.

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
- More themes (light, high contrast). Other resolutions are handled (decision G + the per-device scale).
- Translation: labels are English and written in templates; no i18n in this plan. Primitives keep text out of their own markup (labels are inputs), so a later translation layer only touches pages.
- Sharing tokens with the dashboard (`apps/dashboard`, shadcn/ui) through `packages/protocol` or a `packages/design-tokens`.

## 13. TV interface essentials (planned 2026-10-22, not built)

From the gap review of 2026-10-22, asked by the user ("plan first, don't implement"); **built the same day** (status in §13.8). Six things a 10-foot UI needs that no step covered. Settings they add are stored as in `docs/settings-plan.md` (server DB). Decisions K–P at the end.

### 13.1 Screen edges (overscan / safe area)
Many TVs crop 2–5 % of the picture at each edge, and Electron can't detect it.
- Setting `display.safeArea` (device, 0–6 % of each dimension, default 0). Tokens `--px-safe-x` / `--px-safe-y` on `:root`, set from it like `--px-ui-scale` (`ui/display.ts`).
- **What moves in**: everything you read or focus (menu, back button, clock, page content, dialogs, panels, toasts, player controls, subtitles via `video::cue` line position). **What stays at the edge**: backdrops, the video itself, scrims.
- Where: the shell (`.masterContainer` padding) and the player now; the layouts own it from step 5 (`px-shell`, `px-fullscreen-layout`). Rows that bleed to the right edge keep bleeding: only their first item respects the inset (`px-row-gutter` + `scroll-padding-inline`).
- **Settings › Display › Screen edges**: a full-screen calibration (`core.settings.edges`, a `px-panel`): four corner marks and a frame at the current inset; ←/→ (or a `px-slider`) shrink / grow it until the marks are fully visible, Enter keeps, Back restores (the same preview rule as `<display-size>`). Offered on the first-start `/display` screen too, after the size (decision K).
- Verify: screenshots at 0 and 5 % (every screen + player), nothing focusable or text outside the frame; `check:ui` rule: `position: fixed` / `absolute` elements in `ui/` and pages use the safe tokens or carry `// ui-check: allow (edge-to-edge)`.

### 13.2 Remote media keys
`keymap.ts` knows six actions; remotes and keyboards also send `MediaPlayPause`, `MediaPlay`, `MediaPause`, `MediaStop`, `MediaFastForward`, `MediaRewind`, `MediaTrackNext`, `MediaTrackPrevious`, and some send `BrowserBack` / `GoBack` for Back.
- `keymap.ts`: new actions `playPause`, `play`, `pause`, `stop`, `forward`, `rewind`, `next`, `previous`; `back` also gets `BrowserBack` and `GoBack`. Not `Backspace` (the text keyboard and fields use it).
- **The player** handles them through the **Media Session API** (`navigator.mediaSession.setActionHandler`; Chromium routes hardware media keys there, and the OS media overlay / MPRIS on Linux shows the title and poster from `MediaMetadata`), plus the keymap actions for keys Chromium doesn't route (decision L). `forward` / `rewind` = the held-scrub of the arrows (preview, one seek on release), `next` = the next episode (when there is one), `stop` = leave the player.
- Outside the player: `playPause` on a title page = its Play button (decision L), the rest unused. `InputDispatcher` sends them to the top owner like every input; a page that doesn't handle one ignores it.
- Verify: a scenario with `sendInputEvent` for each key name; by hand with a real remote / keyboard media keys on Linux (MPRIS) and Windows.

### 13.3 Toasts (short, non-blocking messages)
Today a message is a dialog (takes focus) or nothing.
- **`Toasts`** service + **`<px-toast-host>`** in `app.component.html` (next to `<px-dialog-host>`): `toasts.show({ text, detail?, tone: 'info' | 'success' | 'error', icon?, key?, durationMs? })` → a handle with `dismiss()`. Same `key` replaces the visible one (rapid watch-list toggles show one toast).
- **Never focusable, never takes input**: anything that needs an answer is a `Dialogs` call. One visible at a time, a queue of 3, 4 s default (errors 6 s); bottom-start inside the safe area, above player controls; `--px-z-toast` between `alert` and `system`; `role="status"`, `aria-live="polite"`; reduced motion: no slide.
- Uses: watch list / watched toggles, a setting that failed to save (settings plan §7), subtitles loaded / not found, "Reconnecting…" before the connection-lost dialog, a torrent that went BUSY. `notification-handler`'s informational messages move here; blocking errors stay a dialog.
- In the gallery (every tone, long text, replace by key, queue); specs for the queue and the key rule.

### 13.4 Loading states
Only "Finding torrents…" and ad-hoc notes exist; rows and pages pop in.
- **`px-skeleton`** (`variant: 'poster' | 'still' | 'portrait' | 'line' | 'block'`, sizes from the same tokens as `px-card`; a slow shimmer, static with reduced motion). Not focusable: a row of skeletons can't be entered, focus waits for the first real item (the `FocusEngine` rule for late items).
- Where: `px-card-row` shows N skeleton cards (as many as fit) until its first page (step 4); `px-card` uses it as its placeholder, then fades the image in after `decode()`, and shows the title fallback on error (step 4 already lists the states); `px-title-info` has a loading form (step 5); detail pages show the skeleton header while TMDB answers.
- **Timing**: shown only after 300 ms (no flash on fast answers), and an answer never moves what's already focused.
- `px-spinner` stays for actions (`busy`).

### 13.5 Performance budget
Nothing measures speed today; TV hardware is weaker than a dev machine.
- **Reference machines** (decision M): the dev machine at 4K and one low-end box at 1080p (e.g. an Intel N100 mini PC; a Raspberry Pi 5 if it's a target).
- **Budget**: moving focus ≤ 1 dropped frame per move at 60 fps; no long task > 50 ms while navigating; first rows visible ≤ 1.5 s after picking a profile (warm cache); JS heap back within 10 % after opening and leaving 10 detail pages; image bytes per screen within 1.5× of `tmdbImageBase()`'s ideal.
- **Tool**: `apps/tv/scripts/perf.js` (like `screens.js`: Electron offscreen, `webContents.debugger` / CDP `Performance` + tracing) runs fixed journeys (hold Right on a row 5 s, Down through 10 rows, open / leave a detail page ×10, open the player settings and move through the tabs) and writes `.perf/<name>.json` (git-ignored); `npm run perf -w apps/tv`. A baseline now, compared at each step.
- **Rules** for the UI guide: animate only `transform` / `opacity`; no animated `filter: blur` or `backdrop-filter` (check where panels use them); `will-change` only while moving; heavy rows off screen get `content-visibility: auto` if the trace says so.

### 13.6 Contrast and readable sizes
Text tokens go down to `text-faint` (.38) over moving backdrops, and the smallest type step at the default scale is small for a couch.
- **`check:contrast`** (in `check-ui.js` or next to it): a table of (text token, ground token) pairs in `_tokens.scss` comments or a JSON; fails under WCAG 4.5 : 1 for body sizes, 3 : 1 for `heading` and up. Text over backdrops is checked against the scrim's worst case (scrim alpha over a white image).
- **Focus visible from 3 m**: each of the three focus treatments (fill, zoom + un-dim, ring) differs from its unfocused state by ≥ 3 : 1 or a ≥ dp(3) ring.
- **Size floor**: measure `tiny` / `small` at scale 0.8 on 1080p (≈ 12.8 / 14.9 px) against the common 10-foot minimum (decision N); if too small, raise the steps or limit them to secondary information.
- Gallery: a contrast sheet (every pair, its ratio).

### 13.7 Where they land
| Item | Lands with | Depends on |
|---|---|---|
| 13.1 Screen edges | its own step now (shell + player), finished by step 5 | settings plan steps 1–3 (`display.safeArea`) |
| 13.2 Media keys | its own step now (keymap + player) | none |
| 13.3 Toasts | step 3 (an atom + host) | none; the settings plan uses it |
| 13.4 Loading states | `px-skeleton` in step 3, used in steps 4–5 | none |
| 13.5 Performance | tool + baseline now, checked every step | none |
| 13.6 Contrast | `check:contrast` now, fixes as §6 items (decision H) | none |

Suggested order: settings plan (server, then TV) → 13.2 → 13.3 → 13.1 → 13.5 baseline → 13.6 → 13.4 with steps 3–5.

### 13.8 Status (2026-10-22)
- **13.1 Screen edges: built.** Setting `display.safeArea` (device) → `applySafeArea()` (`ui/display.ts`) sets `--px-safe-x/-y` (and `--px-screen-h/-w`, the screen inside them, which page heights now use instead of `100vh`). Inside: the shell (`px-shell` padding, clock, back button), full-screen pages (`px-fullscreen-layout`), panels (`px-panel`'s frame, the docked one too), toasts, the player's controls / loading view / notices / Up next / stats (its picture stays edge to edge: `.player` is fixed over the shell). Calibration: `<screen-edges>` (`screen-edges/`, a `px-panel`: dashed frame, four corner marks, a 0–6 % slider by 0.5; the UI follows live; OK keeps, Back restores) from Settings › Display, and offered after the size on the first start (decision K): kept in `localStorage['playpex.safeArea']` until a server has it (`SettingsService` adopts it). Not done: the `check:ui` rule for fixed / absolute elements, subtitle cue positions (`video::cue` can't be moved per cue from CSS).
- **13.2 Media keys: built.** `keymap.ts`: `playPause`, `play`, `pause`, `stop`, `forward`, `rewind`, `next`, `previous`; Back also `BrowserBack` / `GoBack`. `MediaKeys` (`media-keys.service.ts`): document keydown → actions for the screen shown with no layer open (`for(screen)`). The player: those actions + a Media Session (metadata, play / pause / stop / seek ± / previous / next track while there's an Up next, playback state), deduplicated within 250 ms; forward / rewind = the held scrub (a preview, one seek), previous = from the start, stop = leave. Title pages: Play / PlayPause = their Play (decision L). Scenario `media-keys` (8 checks). Not done: a real remote by hand.
- **13.3 Toasts: built** (decision O: bottom start). Used for: watch list / watched toggles (success, and failures that used to be an error dialog), settings that failed to save, "Trying to reach <server>…" before the lost-connection dialog. Not moved: subtitles found / not found (the panel shows it), a BUSY torrent (it stops playback: stays a dialog).
- **13.4 Loading states: built.** `px-skeleton`; `px-card` placeholder / fade-in / failed image; `px-card-row` `loading` (slot rows until their first page); `px-title-info` loading (the description until the first title arrives).
- **13.5 Performance: built.** `scripts/scenarios/perf.js` (`npm run perf -w apps/tv`; `PLAYPEX_PERF_NAME`): first rows, Right held 5 s, Down ×10, 10 detail pages (heap after 3 to warm up, then twice 10), the player's settings tabs → `.perf/<name>.json` (git-ignored). Baseline `.perf/baseline-step3.json` on the dev machine (decision M's low-end box not available here): 0 dropped frames per move, no long task, warm first rows 53 ms; the heap grew ~10 % per 10 title pages: **a leak, fixed**: `MenuServiceService.sendInstruction` logged its caller (`console.log(source)`), and the console kept every page that collapsed the menu alive (two other stray logs removed too); after: +3 % then +2 %.
- **13.6 Contrast: built** (decision P: pairs listed in `_tokens.scss`). `npm run check:contrast` (`scripts/check-contrast.js`, 25 pairs, WCAG 4.5 / 3). Fixed as §6 items: `--px-color-text-faint` .38 → .46 (3.6 → 4.6 : 1 on the page ground); chips over pictures get white labels (3.3 → 4.9 : 1 on a dark chip over a bright picture). **Decision N, measured, left open**: at 1080p and the default size, `tiny` / `small` are 12.8 / 14.9 real px, under the ~16 px 10-foot guideline; not raised (it would undo the size the user chose on 2026-10-21): the per-device size (Large and up) is the remedy for a TV across the room. Raise them if wanted.

### Decisions K–P (taken 2026-10-22: the recommended defaults; N measured, see §13.8)
- **K. Screen edges on the first start**: **offered after the size, skippable** / only in Settings.
- **L. Media keys**: **Media Session in the player + keymap actions; `playPause` on title pages = Play** / keymap only (turn off Chromium's hardware media key handling) / player only.
- **M. Low-end reference machine**: **an N100-class mini PC at 1080p** / Raspberry Pi 5 / dev machine only.
- **N. Smallest readable size**: **measure first, then raise `tiny` / `small` if under ~16 real px at 1080p and default scale** / keep the scale as is.
- **O. Toast position**: **bottom-start** / top-end (where the stats overlay is).
- **P. Contrast pairs**: **listed by hand in the tokens file** / derived from the stylesheets (more work, fewer misses).

## 14. Plan housekeeping (from the same review)

Not features, but the plan has drifted from the code. **All done 2026-10-22** (1: `px-slider` has its spec and gallery entries, the tabs / docked panel / icon button are primitives, the timeline stays the player's; 2: §1 rewritten; 3: the definition of done is in the steps 3–7 notes; 4: step 2 finished, `screens.js` shoots the player with `PLAYPEX_TEST_CLIP`; 5: stable tokens marked; 6: the navigation plan's status line, text input decided in step 3):
1. **Built but not in the plan**: `px-slider` (`ui/controls/`, exported) → §5.2, step 3's list, §10, the checklist; it has no spec and isn't in the gallery. The player's other new pieces are reusable and become primitives: **tabs** (tabs + content in one `pxStack`; the Settings page will need them), `px-panel edge="end"`, the **icon button that grows into a labelled pill** (a `px-button` variant), the **timeline** (`px-progress` variant with loaded ranges).
2. **§1's non-goal** "the player's controls (tokens only)" is out of date: the player now uses `ui/` primitives. Rewrite the line: the player's own layout stays in the player; its controls come from `ui/`.
3. **Definition of done for a primitive** (so the slider can't happen again): a spec, every state in the gallery, `check:ui` clean, `OnPush`, its ARIA role, exported from `public-api.ts`, a row in `apps/tv/src/app/CLAUDE.md`, listed here.
4. **Step 2 is still unverified** (its "left to do" list) while later work landed on top; finish it before step 3. `scripts/screens.js` shoots no player: add shots through `window.playpexDev.player()` on the ffmpeg test clip (controls, settings tabs, Up next).
5. **Token stability** for plugins (§7 says "the stable ones marked"): mark them in `_tokens.scss` (`// stable`), renaming a stable token keeps the old name as an alias for one `UI_API_VERSION`, removing one bumps it.
6. `navigation-system-plan.md`'s status line (still "proposed, nothing built"), and text input: decide in step 3 whether the search page keeps its own keyboard and whether a `px-text-field` (any text, not only search) is needed.

## Legal note
Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.
