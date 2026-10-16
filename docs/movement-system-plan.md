# Movement system rewrite: plan

Status (2026-10-15): **done** — Steps 0–4 and the motion strategies (§15). Every page is on the engine (§16 lists how the remaining ones were migrated and what was left out on purpose). Decisions A, B, C confirmed by the user with the defaults (§11). How the system works today and how to migrate a page: the "Movement system" section of `apps/tv/src/app/CLAUDE.md`; what differs from this plan: §14. Read the root `CLAUDE.md` and `apps/tv/src/app/CLAUDE.md` first; this plan assumes them.

## 1. Goal

One robust, reusable "movement system" for the Angular UI that gives, on every page:

1. **Fluid keyboard / remote navigation**: arrows move focus instantly; rows and pages glide to keep the focused item in place, including while an arrow key is held down.
2. **Horizontal mouse scroll**: trackpad sideways swipes, shift + wheel, tilt wheels and the existing row paddles scroll rows **natively**.
3. **Vertical mouse scroll**: the wheel scrolls the page natively, like a website (decision A, see §11).
4. **Correct mouse focus**: hovering focuses the item under the cursor without scrolling anything; content sliding under a still cursor never steals focus; clicks select; modals trap the mouse.

It must be built so the rest of the app can adopt it **page by page**: old pages keep working untouched until migrated.

Non-goals for this work: replacing the vendored spatial-navigation library entirely (later, optional, §10), redesigning pages, touch input.

## 2. How movement works today (and why it has to change)

| Layer | Where | What it does |
|---|---|---|
| Spatial navigation (vendored js-spatial-navigation, MPL-2.0) | `apps/tv/src/plugins/spacialNavigation.js` | Picks the next focusable element **by on-screen geometry**, per "section" (`add/remove/focus`, `restrict`, `leaveFor`, `enterTo`, `straightOnly`). Fires `sn:willmove` (**cancelable**), `sn:willfocus`, `sn:focused`, `sn:unfocused`, `sn:navigatefailed`. Keys come from `keymap.ts` via `setKeyMap()`. |
| Section registration | every page, via `NavigationService.updateNavigation('add'/'remove'/'focus', …)` → `AppComponent` → library | Each page registers / removes its section ids by hand (ids listed in `apps/tv/src/app/CLAUDE.md`). Forgetting a `remove` breaks the next visit. |
| Row-to-row movement | per page: `data-sn-up` / `data-sn-down` selectors pointing at the neighbour row's `.lastSelected`; each page maintains `.lastSelected` itself | Movies slider `neighbour()`, watch list `neighbour()`, search `neighbour()`, show page `updateLastSelected()`, movie page `updateLastSelected()`, 18+ browse `neighbour()` |
| Scrolling | per page, mostly **`transform`** | Movies slider: `translateX` per row + `translateY` on the rows (`updateNavigation`, `alignRow`). Watch list and 18+ browse: same pattern in `onFocus`. Search: `scrollRowTo` / `setRowOffset` / `setPageOffset` (transforms) + paddle state. Show page: `scrollRowTo` / `ensureRowVisible` / `setPageOffset` (transforms). Movie page: **native** (`.nativeScroll`, `scrollTo({behavior:'smooth'})`). 18+ compact list: `translateY` on the list. |
| Position memory | per page | `Catalog.navigationData` (movies/TV), module-level `lastFocusKey` (watch list), `SearchState.focusKey`, `AdultService.state.focusKey` / `browseState.focusKey`. |
| Paging ("load more") | per page, triggered **only by focus** | Slider `catalog.requestPage` at index ≥ length − 10, 18+ browse `LOAD_MORE_AHEAD`, compact list `LOAD_MORE_AHEAD`. |
| Mouse | `apps/tv/src/app/pointer.service.ts` | Hover → `spatialNavigation.focus(el)` (sets `isPointerFocus()` so pages skip scrolling); click → synthetic `select` keydown; right click / button 3 → `back`; **wheel → synthetic up/down arrow keys** (`WHEEL_STEP`, `WHEEL_INTERVAL`, `WHEEL_SETTLE`), horizontal wheel ignored; `pagedIndex()` for paddles reads the row's transform; `NO_HOVER_SELECTOR` (`data-pointer-hover="off"`) for rows peeking below the current one. |
| Global CSS | `apps/tv/src/styles.scss` | Cursor, `body.pointer-hidden`, `.pagedRow > .rowPaddle` paddles (shown on hover with the cursor visible), `.section.atStart/.atEnd` hide paddles. |

Problems:
- Content is **moved, not scrolled**, so the browser can't scroll it: horizontal mouse scrolling is impossible, and the wheel had to be faked as arrow keys.
- Six or so near-copies of the same row logic (each slightly different, each with its own bugs). Every new page copies about 100 lines.
- Geometry-based movement inside transformed rows is fragile (mid-transition rects, off-screen items).
- Paging only reacts to focus, so a mouse user can't load more by scrolling.
- Empty containers dead-end focus (e.g. 18+ browse with no results, see §12).

## 3. Target architecture

New folder `apps/tv/src/app/movement/` (declared in `AppModule`, no lazy loading, matching the app).

```
 input sources                movement core                          DOM (real scroll containers)
 ─────────────                ─────────────                          ────────────────────────────
 keys / remote ─ sn:willmove ─► FocusEngine ── next item by index ──► pxStack (overflow-y: auto)
 mouse hover ── focus(el) ───►   (rows / stacks / grids;               └ pxRow (overflow-x: auto)
 wheel / pad ── native scroll ─►  library only between sections)          └ pxItem (focusable)
                                      │                                pxGrid (chips, lists)
                                  Scroller ── tween scrollLeft/Top ───────┘
                                      │
                                  PositionStore (key → index, scrollLeft, scrollTop)
```

Principles:
1. **Real scrolling everywhere.** Containers are `overflow: auto` with hidden scrollbars. No `transform` for positioning content (transforms stay fine for zoom/animation effects).
2. **Index-based movement inside a container**, geometry only between containers or sections. A row knows its items in order, so "right" is always index + 1, independent of what is on screen.
3. **Focus drives scroll for keys; scroll never drives focus for the mouse.**
4. **Declarative wiring.** Pages add attributes and directives in templates; no per-page `onFocus` scroll code, `neighbour()` selectors or `.lastSelected` bookkeeping.
5. **Coexistence.** Built on top of the vendored library through its public hooks (`sn:willmove`, `focus(el)`, sections), so unmigrated pages keep working.

## 4. Components and their APIs

All names are proposals; keep them consistent once chosen. Prefix `px` (Playpex) for directives.

### 4.1 `pxItem` (directive)

```html
<button class="card" pxItem [pxItemKey]="item.id">…</button>
```
- Marks a focusable item and gives it a stable `key` (used by `PositionStore`). Index = order among the parent container's items (computed from `QueryList` or DOM order on changes).
- Keeps the existing focus model: the element must still be inside a registered spatial-navigation section (the container's section, see `pxSection`) so `PointerService` hover and click keep working.
- Adds/removes the `.focused` class exactly like `AppComponent` does today (keep that code; don't duplicate).

### 4.2 `pxRow` (directive, horizontal container)

```html
<div class="slider" pxRow="popular" align="start" [loadAhead]="6" (nearEnd)="loadMore(row)">
  <button *ngFor="…" pxItem [pxItemKey]="…">…</button>
</div>
```
Inputs:
- `pxRow`: row key, unique within its stack (also the PositionStore key part).
- `align`: `'start'` (focused item at the row's left edge: movies, watch list, 18+ posters), `'third'` (focused item about ⅓ in: cast, similar, episodes), `'nearest'` (minimal scroll to make it fully visible: chips, search results).
- `loadAhead` (items) / `loadAheadPx`: when to emit `nearEnd`.
- `wrap` (default false).

Behaviour:
- Container CSS: `overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain;` plus `::-webkit-scrollbar { display: none }`. **Vertical padding** inside the row (and matching negative margin outside, if needed) so the focused item's `scale(1.1)` is not clipped: `overflow-x: auto` forces `overflow-y` to clip.
- **Left / right** (via `sn:willmove`, §5): `preventDefault()`, focus item index ± 1 (`spatialNavigation.focus(el)`), then `Scroller` aligns it. At the ends: don't cancel, so the library performs its normal `leaveFor` (e.g. left at index 0 → `@menu`).
- **Remembered index** (replaces `.lastSelected`): updated on keyboard focus, and on a click. A mere hover does **not** update it (same rule as today: up/down must come back without a sideways jump). Keep adding a `.lastSelected` class anyway during migration, for CSS and old selectors.
- Emits `nearEnd` on **focus** (index ≥ count − `loadAhead`) **and on scroll** (`scrollLeft + clientWidth ≥ scrollWidth − loadAheadPx`), debounced; the page appends items; the row must keep its scroll position (append-only DOM, `trackBy`).
- Paddles: the row renders/uses the global `.rowPaddle` markup (or the directive injects it) and pages by `clientWidth − one item` with the Scroller; it toggles `atStart` / `atEnd` from the real `scrollLeft`. **Replace `pagedIndex()`** (it reads transforms).
- Horizontal wheel: native. Do **not** intercept `wheel` on rows; the browser scrolls `overflow-x` containers for `deltaX` and shift + wheel by itself.

### 4.3 `pxStack` (directive, vertical container of rows / blocks)

```html
<div class="rows" pxStack="adult-browse" align="row-top" [restore]="true">
  <section *ngFor="let row of rows" pxStackItem>
    <h3>…</h3>
    <div pxRow="{{row.key}}" …>…</div>
  </section>
</div>
```
- Container CSS: `overflow-y: auto; scrollbar-width: none; overscroll-behavior-y: contain`.
- **Up / down** between `pxRow`s: `preventDefault()` on `sn:willmove`, focus the target row's **remembered** item (fallback: the item nearest to the alignment point currently visible, see §6.3). Rows with zero items are skipped. At the first/last row: let the library do its `leaveFor` (e.g. up from the first row → toolbar).
- Vertical alignment `align`: `'row-top'` (focused row scrolled to the top of the stack viewport: movies, watch list, 18+ browse), `'nearest'` (minimal: show page, movie page, search). Non-row blocks (buttons, text) can be `pxStackItem`s too: a stack is a vertical sequence of focus targets (rows or single focusables).
- Registers a spatial-nav **section** for all its items (or receives one from `pxSection`), so hover and click work.

### 4.4 `pxGrid` (directive, 2D or 1D list)

For chip grids (18+ filter panel studios, keyboards), the compact release list (1 column), avatar grids.
- `columns` = `'auto'` (computed from item offsets) or a number. Arrow keys move by index (±1, ± columns); scroll with `nearest` (or `align="third"` for long vertical lists like the compact list).
- Same `nearEnd` support (the compact list pages).

### 4.5 `pxSection` (directive, replaces manual section add/remove)

```html
<div pxSection="adultToolbar" [leaveFor]="{ left: '@menu', down: 'stack:adult-browse' }" restrict="self-only">
```
- On init: `NavigationService.updateNavigation('add', {...})` with `selector` built from the host (e.g. a generated `[data-px-section="adultToolbar"] [pxItem], …`); on destroy: `remove`. Ends the "forgot to remove the section" class of bugs.
- `trap` (= `restrict: 'self-only'`, no `leaveFor`) for modals; `PointerService.canReach()` keeps working because it reads the library's section config.
- **New `leaveFor` target forms**, resolved by the engine before handing to the library: `'stack:<id>'` (enter that stack at its remembered row/item), `'row:<key>'`, and a **fallback chain** `['stack:adult-browse', '@adultToolbar']` (first one that has a focusable item wins). This fixes "menu → right into an empty section does nothing".
- `defaultFocus` and `enterTo: 'last-focused'` keep their library meaning.

### 4.6 `FocusEngine` (service)

- Listens once (in `AppComponent` or the service's `init()`) to `sn:willmove` on `window` (capture). Finds the nearest `pxRow` / `pxStack` / `pxGrid` ancestor of `event.target`, asks it for the next item for `event.detail.direction`; if it returns an element, `event.preventDefault()` and focuses it; otherwise lets the library continue (section change / `leaveFor`).
- Key-repeat batching: at most one move per animation frame (`requestAnimationFrame` gate); extra repeats in the same frame are dropped, not queued.
- Exposes `focus(el, {cause: 'key' | 'pointer' | 'restore' | 'click'})`. Pointer focus must not scroll; `restore` scrolls instantly; `key` scrolls with the tween.
- Exposes `lastInput: 'keys' | 'pointer'` (and an observable) so containers can apply §6.3.

### 4.7 `Scroller` (service or plain module)

- `scrollTo(container, {left?, top?}, {instant?})`: one requestAnimationFrame tween per container and axis, easing `easeOutCubic`, duration ~250 ms (today's CSS transitions use `.25s`); **re-targets** a running tween (no queueing, no restart from zero velocity). This is what makes held arrow keys glide.
- Instant when `prefers-reduced-motion: reduce`, on restore, and when the delta is 0.
- Cancels its tween when the user scrolls natively (`wheel` / `pointerdown` on the container, or a `scroll` event the tween didn't cause).
- **Don't use `scrollTo({behavior:'smooth'})`** (Chromium restarts it on every call and stutters under key repeat; the movie page uses it today and should move to the Scroller).
- Alignment helpers (pure functions, unit-tested): `targetLeft(container, item, align)`, `targetTop(stack, rowEl, align)`, clamped to `[0, scrollWidth − clientWidth]`. Use `offsetLeft` / `offsetTop` relative to the container (`offsetParent` must be the container: give containers `position: relative`).

### 4.8 `PositionStore` (service)

- `Map<string, {index?: number, key?: string, scrollLeft?: number, scrollTop?: number}>`, keyed by `<stack id>/<row key>` and `<stack id>` (the stack's own `scrollTop` and focused row).
- Rows save on focus change and on scroll end (debounced 150 ms); restore on view init **after** items render (`ngAfterViewChecked` once / `requestAnimationFrame`), instantly, then focus the remembered item by **key** (indexes shift when data changes), falling back to the index.
- Lives in root, survives navigation (player, title pages). Clears per profile (subscribe to `ProfilesService.current` id changes, like `AdultService` does).
- Replaces over time: `Catalog.navigationData`, watch list `lastFocusKey`, `SearchState.focusKey`, `AdultState.focusKey`, `BrowseState.focusKey`. During migration pages may keep their state objects for **data**, but not for positions.

## 5. Keyboard flow in detail

1. `keydown` ArrowRight → library `onKeyDown` → fires `sn:willmove {direction:'right', sectionId}` on the focused element.
2. `FocusEngine` (window listener) → `closest('[pxRow]')` → row says "next is item i + 1" → `preventDefault()` → `spatialNavigation.focus(next)` → library fires `sn:willunfocus/willfocus/focused` as usual (pages, `AppComponent` `.focused`, the menu collapse logic keep working).
3. The row records the index (+ `.lastSelected`), the Scroller tweens `scrollLeft` to `targetLeft(row, next, align)`, and `nearEnd` may fire.
4. ArrowDown → engine finds the `pxStack`; the target row's remembered item is focused; the stack tweens `scrollTop` to put that row in place (`row-top` / `nearest`); the row is horizontally aligned instantly if its remembered scroll position is stale.
5. At an edge (no next item / row) the engine does nothing, so the library continues with geometry inside the section or `leaveFor`.
6. Enter / Escape: unchanged (`AppComponent` → `NavigationService.addCommand`).

Note: `straightOnly` and geometry inside a migrated row no longer matter; they still matter for jumps between sections.

## 6. Mouse flow in detail (`PointerService` changes)

### 6.1 Wheel
- New flag `wheelMode: 'scroll' | 'focus'` (default `'scroll'`, decision A). Keep `wheelNavigation = false` for the player (it owns the wheel).
- `'scroll'`: **don't `preventDefault()`** on `wheel` (except `ctrlKey` zoom, which stays blocked as today if desired); let the browser scroll the nearest scrollable ancestor. Vertical wheel over a row scrolls the stack (rows only take horizontal deltas because they are `overflow-y: hidden`). After any native scroll, set `hoverPausedUntil = now + 150ms` (see 6.2).
- `'focus'`: today's behaviour (wheel → arrow keys), kept for unmigrated pages: **decide per page**. The engine sets `wheelMode = 'scroll'` while the active route's page is migrated (e.g. a `data-px-native-wheel` attribute on the page root, checked on each wheel event via `event.target.closest(...)`), otherwise `'focus'`. This avoids a global switch breaking old pages whose content can't scroll.

### 6.2 Hover focus must be correct
- Keep the existing guard: only **real** mouse movement (`clientX/Y` changed) can hover-focus (already in `onMove`).
- New: ignore hover while content is scrolling under the cursor: listen to `scroll` (capture, passive) on document and pause hover focus until 120–150 ms after the last scroll event. Re-check on the next real `mousemove`.
- Hover focus never scrolls (cause `'pointer'`); it does **not** update a row's remembered index.
- `NO_HOVER_SELECTOR` / `data-pointer-hover="off"` is no longer needed for migrated stacks (rows peeking below are really scrolled, and hovering them is legitimate). Keep supporting it for old pages.

### 6.3 Handoff mouse → keys
On the first arrow key after pointer activity (`FocusEngine.lastInput == 'pointer'`):
- If the focused item is **fully visible** in its row and its row is visible in the stack, continue from it (normal flow).
- Otherwise don't jump back: pick the item **nearest to the row's alignment point** among the visible items of the row nearest to the stack's alignment point, focus it (cause `'key'`), then apply the move. Never scroll the view back to where the mouse left it.

### 6.4 Click
- Unchanged path: `PointerService.onClick` → focus + synthetic `select`. Decision B (§11): open directly.
- The paddles stay plain `(click)` elements outside sections; they call the row's `page(direction)`.

## 7. CSS foundations (`apps/tv/src/styles.scss` + per component)

- Utility classes: `.px-scroll-x`, `.px-scroll-y` (overflow, hidden scrollbars, overscroll-behavior), `.px-row-pad` (vertical padding for zoom; e.g. `padding-block: 16px` around 270 px posters scaled 1.1, i.e. 13.5 px each side).
- **Rows next to the menu**: today `.sliderContainer` uses `overflow: clip` + `overflow-clip-margin: 10px` so posters scrolled to the left don't show over the menu. With real `overflow-x: auto` the clip is automatic; the left padding / first-item zoom must stay visible: give rows `padding-inline-start` equal to the zoom overhang and `scroll-padding-inline-start` matching, or align to `start` minus that padding.
- Host elements in the flex shell still need `min-width: 0` (root CLAUDE.md gotcha), and scroll containers need a definite size (`height` / `max-height` or flex `min-height: 0`), otherwise they grow instead of scrolling.
- Keep `.focused`, `.lastSelected`, `.atStart/.atEnd` class names (pages style them).
- Don't name elements `.description`, `.menuItem`, `.element`, `.tabs` (menu queries them document-wide).

## 8. Implementation steps

Each step ends with a build (`NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null`) and the checks in §9.

### Step 0: prerequisites (small, independent; do first)
1. **18+ browse dead end** (§12.1).
2. **ThePornDB provider fixes** (§12.2): independent of movement; can be done any time.

### Step 1: core (no page changes)
1. `apps/tv/src/app/movement/`: `scroller.ts` (tween + alignment pure functions), `position-store.service.ts`, `focus-engine.service.ts`, directives `px-item`, `px-row`, `px-stack`, `px-grid`, `px-section`; `movement.ts` barrel; declare in `AppModule`.
2. `FocusEngine.init()` called from `AppComponent` constructor right after `spatialNavigation.init()`.
3. `PointerService`: per-page wheel mode (§6.1), scroll-pauses-hover (§6.2), `lastInput` reporting to the engine, paddles helper that works on `scrollLeft` (keep `pagedIndex()` for old pages until they migrate).
4. Unit tests (Jasmine, `*.spec.ts` next to files): alignment math, clamp, tween re-targeting (fake rAF), next-index logic for row/stack/grid incl. empty rows and edges, PositionStore key/index fallback.
5. Docs: new "Movement system" section in `apps/tv/src/app/CLAUDE.md` (APIs, rules, how to migrate a page), and update the section-id list.

### Step 2: pilot on the 18+ pages
- `adult-browse`: toolbar → `pxSection` (`leaveFor.down: ['stack:adult-browse']`); rows container → `pxStack` (`row-top`); each row → `pxRow` (`start`, `loadAhead` 6, `nearEnd` → `loadMore`); remove `onFocus` transform code, `neighbour()`, `pageRow()`, `restoreFocus()` position parts, `browseState.focusKey`; the description header still updates on focus (keep the `sn:focused` listener for **data**, not for scrolling). Menu `leaveFor.right`: `['stack:adult-browse', '@adultToolbar']`.
- `adult-title`: page → `pxStack` (`nearest`), "More from" → `pxRow` (`third`).
- `adult-page` (compact list): list → `pxGrid` (1 column, `align="third"`, `nearEnd`), rail → `pxSection`; remove `listOffset` / `ROW_HEIGHT` transform logic.
- Filter panel / text keyboard → `pxGrid` + `pxSection trap`.
- Verify with §9 on these pages only, then **stop and show the user** (screenshots and a short note) before migrating more.

### Step 3: migrate the rest, one page per PR / commit
Recommended order (simplest first):
1. **Watch list** (`watchlist-page`): same pattern as 18+ browse.
2. **Search** (`search-page`): rows `nearest`, page `nearest`; keep `instantly()` semantics through `restore`.
3. **Show page** (`show-options`): seasons / episodes rows `third`, page `nearest`; season focus still loads episodes (data).
4. **Movie page** (`movie-options`): already native: swap `scrollTo smooth` for the Scroller, rows → `pxRow third`, page → `pxStack nearest`; drop `.nativeScroll` toggling on `.pageContainer` if the page owns its stack.
5. **Movies / TV slider** (`movies-slider` + `movies-page` + `catalog.ts`): the hardest. `Catalog.navigationData` → PositionStore keys `catalog:<media>/<category>`; `requestPage` from `nearEnd`; `focusFirstWhenReady` / splash flow kept; `AppComponent.moviesPageNavigation` (GSAP out on Enter) unchanged; `MenuServiceService` collapse/expand interplay unchanged.
6. **Profiles picker / editor / pin pad / power page**: `pxGrid` + `pxSection` (cheap, mostly removes boilerplate).

### Step 4: cleanup
- Delete per-page transform scrolling, `neighbour()` / `data-sn-up/down` row selectors, `.lastSelected` bookkeeping, `pagedIndex()`, `NO_HOVER_SELECTOR` usage, `wheelMode 'focus'` (once nothing uses it), `Catalog.navigationData`.
- Update `apps/tv/src/app/CLAUDE.md` (component index entries mention transforms in many places; rewrite them) and the root `CLAUDE.md` input-model bullet.

## 9. Verification (do for every migrated page)

Use the offscreen Electron harness (see "Testing harness" below). In an offscreen/unfocused window `element.focus()` does not emit `sn:focused`, but `SpatialNavigation.focus(el)` / `SpatialNavigation.move('right')` (global) do, and **real arrow keys work** when sent with Electron's key names (`sendInputEvent({type:'keyDown', keyCode:'Right'})`; `'ArrowRight'` is silently ignored, which is why earlier notes said arrows don't work). Use real keys for anything that depends on `isTrusted` (the mouse → keys handoff). Mouse: `mouseMove` (send two positions: the first one only reveals the cursor) and `mouseWheel` with `deltaX` / `deltaY` (negative = scroll right / down) work offscreen too.

Checklist:
- [ ] Right × 15 on a row: focus advances one item per press; the row glides (screenshot mid-way and at rest); `nearEnd` loads the next page once; no duplicate items.
- [ ] Holding right (simulate 30 moves 30 ms apart): no stutter (scrollLeft increases monotonically across samples), final item aligned.
- [ ] Down / up between rows lands on each row's remembered item; empty rows skipped; up from the first row reaches the toolbar; left at index 0 reaches the menu.
- [ ] Shift + wheel / horizontal wheel (`sendInputEvent({type:'mouseWheel', deltaX:-120, …})`) scrolls the hovered row natively; vertical wheel scrolls the stack; focus unchanged during both.
- [ ] Hover after a scroll focuses the item under the cursor; content sliding under a still cursor does not change focus.
- [ ] Key after mouse scroll continues from a visible item (§6.3), no jump back.
- [ ] Leave the page (open a title / the player) and come back: same focused item, same scroll positions, instantly (no visible animation).
- [ ] Empty states (no results, network error) keep a focusable path (toolbar or Retry / Clear).
- [ ] Modals (filters, text keyboard, torrent picker, play choice, notification) trap keys and mouse; closing restores focus.
- [ ] `prefers-reduced-motion`: moves are instant.
- [ ] The menu still expands on focus and collapses when leaving it; the clock and backgrounds unaffected.
- [ ] Profile switch clears positions.

### Testing harness (used during the 18+ work and the movement pilot)
- Server: `STREAMER_PORT=9100 REMOTE_PORT=9600 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron apps/server/server.js` (port 9000 is usually taken on the dev machine). Stop it with `pkill -f "[s]treamingServer/server.js"` **in a separate command** (a pattern matching the same shell command line kills the shell).
- UI: build, then a small Electron script (scratchpad) that opens `dist/playpex/index.html?streamer=9100` in an offscreen 1440×900 `BrowserWindow` (`backgroundThrottling: false`), waits ~9 s for the splash, sends Enter to pick the profile, navigates with `history.pushState({}, '', '<route>'); dispatchEvent(new PopStateEvent('popstate'))`, runs steps from a JSON file (`{route}`, `{js}` evaluated as an async function body, `{key:'Right'}`, `{move:{x,y}}`, `{wheel:{x,y,dx,dy}}`, `{shot:'name.png'}`) and saves `webContents.capturePage()` PNGs. Useful probes: the active element's `data-*`, each `[data-px-container]`'s `scrollLeft` / `scrollTop` sampled during a held key.

## 10. Later (optional, not part of this plan)
- Replace the vendored library with an engine-owned section graph (sections are already declared by `pxSection`; geometry fallback only for free-form layouts).
- Pointer drag-to-scroll on rows (mouse grab), momentum.
- Phone remote input source (`remoteSocket.service.ts`) can feed `FocusEngine.move(direction)` directly.

## 11. Decisions

The user asked about all three; the defaults below are the recommended ones. **Confirm with the user before Step 2** if they haven't answered yet.

| # | Question | Default (recommended) | Alternative |
|---|---|---|---|
| A | Vertical mouse wheel | **Scrolls the page natively** (website-like); focus doesn't move until hover/click/keys. Required for "vertical mouse scroll". | Wheel keeps moving focus row by row (today); then only horizontal scrolling is native. |
| B | Clicking a poster with the mouse | **Opens it directly** (the user pointed at it). | First click brings its row into place, second click opens (today's behaviour for rows marked `data-pointer-hover="off"`). |
| C | Pilot scope | **18+ pages**, then the watch list as the second page. | 18+ pages only. |

## 12. Related open items (found before this plan)

### 12.1 18+ poster page dead end: **fixed 2026-10-15** (kept for context)
Fixed: the empty state always has a Clear search / Clear filters or Try again button inside `.titleInfo` (part of the `adultPosters` section, so the menu's `@adultPosters` always lands somewhere), the toolbar's `down` targets it, and `restoreFocus()` falls back to it / the search field. The migration must keep this guarantee (empty stack → focus the empty state or the toolbar).

Original report:
`apps/tv/src/app/adult-browse/adult-browse.component.*`: when a search or filter returns no titles, the page has nothing focusable except the toolbar, and:
- `restoreFocus()` focuses nothing when there are no cards (coming back to `/adult/browse` with an empty result leaves focus on the menu);
- the menu section's `leaveFor.right` is `'@adultPosters'`, which is empty, so right does nothing;
- the "No titles" header only shows a button on `loadError` (Retry).

Fix: in the empty state render a **Clear search / Clear filters** `actionBtn` inside `.titleInfo` (it belongs to the `adultPosters` section via its `.titleInfo .focusable` selector; selecting it does what the toolbar's Clear does); in `restoreFocus()` fall back to `.adultBrowse .clearAll` or `.searchField` when there's no card; register the menu with `leaveFor.right` pointing at the toolbar when `state.rows` is empty (re-register on change), or, after Step 1, `['stack:adult-browse', '@adultToolbar']`. Check the compact layout (`adult-page`) the same way (it has its rail, so it's OK today; keep it so).

### 12.2 ThePornDB provider (`apps/server/lib/adultMeta/providers/theporndb.js`)
**Fixed 2026-10-15**: curated `SITES`, `sorts: ['newest']` exposed by `/api/adult/meta/providers` and used by `adult-browse` `rowSpecs()`, future-dated / cover-less items dropped, "New releases" = merge of the home studios, periods via `year=`. Note: movie covers turned out to be **portrait** (`image`, `posters.*`); the landscape images seen at first belonged to scraped junk entries, so no landscape card variant is needed. Details below are the original findings.

Tested with a real key (2026-10-15): the key works, but
- `studios()` returns `/sites` alphabetically ("007xvision", "01Arlequina", …): home rows and the filter are junk. Use a **curated list** of sites like the TMDB provider (resolve ids with `/sites?q=<name>`; e.g. Vixen is site `3372`, not `103841` "VIXEN").
- Sorting: only `orderBy=recently_released` and `recently_created` are accepted (others → 422: `most_popular`, `popular`, `rating`, `views`, …). `recently_released` returns bogus future dates first (`3024-01-03`); `date_from/date_to` are ignored, `year=<yyyy>` works. So: "New releases" = `orderBy=recently_released` + filter out `date > today` (and/or query `year=<current>` then `year=<current−1>`); there is **no popularity sort**: don't offer "Popular" / "Top rated" rows for this provider (the UI builds Popular / Newest / Top rated rows for filtered views in `adult-browse` `rowSpecs()`; make that list come from the provider, e.g. a `sorts` capability in `/api/adult/meta/providers`).
- Images: movies rarely have `poster_image` (0/30 for "vixen"); `posters.*` / `background.*` are **landscape** stills; `image` is sometimes a cover. Add an `orientation`/`aspect` hint per item or a provider capability (`posterAspect: 'landscape'`) and let the poster row render 16:9 cards for it.
- Period filter: use `year=` where possible instead of filtering a page client-side.
- Recommendation given to the user: **keep TMDB as the default** catalog provider (real covers, popularity and rating sorts, curated studios); keep ThePornDB as an option (strong on scenes, performers, release hashes: a good fit for enriching the compact release list later).
- The provider is chosen per profile in `preferences.adult.metadataProvider` (see `AdultService.preferences`); there is no Settings UI yet. Set it with `PUT /api/profiles/:id` body `{"preferences":{"adult":{"layout":"posters","metadataProvider":"theporndb"}}}`.

## 13. Files you will touch (summary)

New: `apps/tv/src/app/movement/*` (+ specs), `docs/movement-system-plan.md` (this file: update its status as you go).
Changed in Step 1: `apps/tv/src/app/app.module.ts`, `apps/tv/src/app/app.component.ts` (engine init), `apps/tv/src/app/pointer.service.ts`, `apps/tv/src/styles.scss`, `apps/tv/src/app/CLAUDE.md`.
Pilot: `apps/tv/src/app/adult-browse/*`, `apps/tv/src/app/adult-title/*`, `apps/tv/src/app/adult-page/*`, `apps/tv/src/app/text-keyboard/*`, `apps/tv/src/app/adult.service.ts` (drop focus keys).
Later: `watchlist-page/*`, `search-page/*`, `show-options/*`, `movie-options/*`, `movies-slider/*`, `movies-page/*`, `catalog.ts`, `movies.service.ts` (`SearchState`), profile pages, power page.

Conventions to keep (from the CLAUDE.md files): Angular 14 NgModule, no standalone components; RxJS subjects in root services; listener hygiene (store handlers, remove in `ngOnDestroy`, never assign `addEventListener`'s return value); key bindings only in `keymap.ts`; match the surrounding code style and comment density; the streaming server URL only from `server-config.ts`.

## 14. Implementation notes (what differs from the plan, 2026-10-15)

- **Library patch** (`apps/tv/src/plugins/spacialNavigation.js`, marked "Playpex"): a `leaveFor` value may be a function (called when leaving; returns an element, `false` = nothing, `null` = blocked), and `navigableElements(sectionId)` is public. `FocusEngine.target([...])` builds those functions for `'stack:'/'row:'/'grid:'` targets and fallback chains; `PointerService.canReach` asks `FocusEngine.leads()`.
- **Focus causes**: `key`, `pointer`, `select` (the plan's `click`: any Enter / click remembers the item, so Enter on a hovered poster comes back to it), `restore`.
- **`enter="nearest"`** on containers (new): keyboards and filter grids enter at the on-screen entry nearest to where focus comes from instead of the remembered one.
- **Short button lines** (filter panel actions / periods, title page actions, keyboard's bottom row) are one-line `pxGrid`s, not `pxRow`s: a `pxRow` always scrolls sideways, which clips its items' zoom vertically.
- **Rows aligned on entry**: moving into another row lines that row up instantly (its remembered item may have been scrolled away with the mouse); moves along a row and stack moves glide.
- **Scroll offsets are saved as they change** (debounced 150 ms), never on destroy: by then the page's DOM is detached and reads 0.
- **`row-top` stacks** append a `.px-stack-end` spacer so the last row can reach the top, as the old transforms allowed.
- **Row snapping** (added after the pilot, user request): `row-top` stacks snap wheel / trackpad scrolling to a row at the top (`scroll-snap-type: y mandatory` on the stack, `scroll-snap-align: start` on each block). The Scroller turns snapping off while it tweens (`.px-snap-paused`), since Chromium snaps every programmatic scroll write. `[snap]="false"` opts out.
- Rows get 10px of sideways zoom room (not 14): the 1.1 zoom of a 180px poster needs 9px and the 10px gap keeps the previous poster hidden.
- Handoff (§6.3) counts a stack entry as on screen when a third of it shows (a row peeking in under the current one, hovered, stays the starting point); rows / grids need the item whole.
- `angular.json`'s test target loaded the library from a URL, which broke `ng test`; removed (the app imports the vendored copy). Movement specs: `apps/tv/src/app/movement/*.spec.ts`, 24 passing.
- Verified with the harness (§9) on `/adult/browse`, `/adult/title`, `/adult/releases`, the filter panel, the text keyboard and `/watchlist`; `/movies/list` (unmigrated) checked for regressions. Not checked: `prefers-reduced-motion` in a real window (the Scroller reads the media query), a real trackpad, and a hands-on session in `npm run electron`.

## 15. Motion strategies (added 2026-10-15, user decision)

Principle 1 ("real scrolling everywhere") is now per container: the user found translations snappier for the category views (cards in rows), so how a container moves became a strategy of the engine (`apps/tv/src/app/movement/motion.ts`), chosen with `motion="scroll" | "transform"`; nested containers inherit it.

- `ScrollMotion`: what §3–§7 describe (Scroller tweens, native wheel, CSS snapping).
- `TransformMotion`: the host clips (`.px-clip`), its `pxTrack` child (or, for rows, the host itself) gets `translate3d` with a 250 ms easeOutCubic CSS transition. It runs on the compositor, so it stays smooth while Angular is busy; a new target re-targets the running transition (held keys glide). Offsets live in the motion (no `scrollLeft`). The wheel is the engine's: `FocusEngine.wheel()` (called by `PointerService`) accumulates 40 px of travel, then steps the stack one row (vertical) or the row under the cursor one poster (sideways: trackpad, tilt, shift + wheel), at most every 140 ms; hover pauses 350 ms. Trackpad momentum is not emulated (the user's choice between free and stepped sideways movement was left open; stepping was picked to match the keys and row snapping).
- Containers only speak in offsets through the `Motion` interface (`offset`, `viewport`, `moveTo`, `moveBy`, `toContent`, `trackOf`); visibility, handoff, paging, paddles, restore and memory work unchanged for both.
- Used: `transform` on the 18+ poster stack and the watch list; `scroll` everywhere else. Plan for the rest: movies / TV rows `transform`; search, show page, movie page, lists, panels `scroll`.
- Verified with the harness: 30 key repeats glide monotonically, one wheel notch = one row / one poster, handoff and restore as before, visuals (zoom kept, previous poster hidden). Specs: `motion.spec.ts` (29 movement specs in all).

## 16. Full migration (2026-10-15)

- **Movies / TV rows** (`movies-slider`): translated `pxStack="catalog:<media>"` of `pxRow`s; `Catalog.navigationData` deleted (positions in `PositionStore`); paging from `(nearEnd)`; splash "first poster" and return restore through `engine.restore`; Back on a poster → `row.home()` (new `PxContainer.home()`: remember the first entry, back to offset 0) + menu; `AppComponent.moviesPageNavigation` no longer touches positions (the engine remembers on select).
- **`movies-page`**: `.pageContainer` is a scrolling `pxStack` (no id); detail pages' button grids and rows are its entries across the component boundary (entries are found in the DOM). Replaces `.nativeScroll` toggling and the show page's `translateY`.
- **Stacks**: revealing the first entry scrolls to the very start (shows a description / search field above it).
- **Search**: page = `pxStack="search"` (`nearest`); keyboard stays geometry inside `pxSection="keyboard"` (`pxSelector=".keyboardBtn"`), in a `pxStackItem` block with the input; filters `pxGrid`; rows `pxRow` (`nearest`, 60px scroll padding). `SearchState.focusKey` deleted. Non-entries focused inside a container (the keyboard keys in the page stack) are revealed but not remembered.
- **Show / movie pages**: rows `pxRow align="third"` (seasons, episodes, cast, similar), buttons `pxGrid`; new season → episodes `home()`; Enter on a season → `row:episodes` remembered.
- **Profiles, editor panels, PIN pad, power page, torrent picker, resume choice**: template `pxSection`s (traps for modals); tiles / avatars / keypad / power buttons / torrent list as `pxGrid`s.
- **Cleanup**: `pagedIndex`, `isPointerFocus`, `NO_HOVER_SELECTOR` / `data-pointer-hover`, the wheel → arrow-keys mode and `data-px-native-wheel` (native wheel is the default now), `.lastSelected` bookkeeping, `data-sn-*` row links, the old `.section.atStart` paddle CSS.
- **Left on the library on purpose**: the player (custom arrow semantics: ←/→ seek on the progress bar; overlay sections managed in code) and the error notification (always rendered; its section is added / removed in code). `NavigationService.updateNavigation` stays the API underneath `pxSection`.
- Verified with the harness on every page (keys, real arrow keys, wheel, hover, restore after title pages / the player route, traps); 29 movement specs.
