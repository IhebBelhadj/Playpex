# Navigation system (screens, history, layers, input): plan

Status (2026-10-22): **built** (steps 0–6, commit `2f90426`: `nav/` with the navigator, registry, `screens.ts`, layers, input dispatcher, `pxSelect`, `nav-debug`, specs; every page migrated). **Step 7**: `nav/public-api.ts` + `NAV_API_VERSION = 1` exist; the dev example plugin (`src/app/plugins-dev/hello/`, rebuilt as the packaged `plugins/hello` in plugins plan P1) and `docs/tv-plugins.md` came with the UI system's step 7 (`docs/ui-system-plan.md`), which extends the same example; its facade cleanup (`NavigationService`) isn't finished. Decisions A–H: §12. Read the root `CLAUDE.md`, `apps/tv/src/app/CLAUDE.md` and `docs/movement-system-plan.md` first; this plan assumes them. The movement system (focus movement and scrolling *inside* a page) is done and stays as it is. This plan covers what sits above it: **which screen is shown, how the app gets there and back, and who receives an input action.**

## 1. Goal

One central, declarative navigation system for Playpex TV that:

1. **Owns the history.** One stack of screen entries is the source of truth for "where am I, where did I come from, where does Back go". It doesn't count router events or rely on `location.back()`.
2. **Makes Back one algorithm.** Escape, the shell's Back button, the mouse's back button and later a phone remote all go through one ordered **back ladder** (§5.4): layers → in-page steps → previous entry → the screen's root policy. Today every page writes its own version.
3. **Routes input to whoever is on top.** An action (`select`, `back`, …) goes to the top layer if there is one, else to the current screen, and nowhere else. Pages stop subscribing to a global subject and filtering it by `router.url`.
4. **Declares screens, not URLs.** A screen is declared once: id, path, kind, requirements (server / profile / adult), chrome (menu, back button, clock), back policy, menu entry. Code opens screens **by id with typed params**, never by URL string.
5. **Lays the ground for plugins.** The same primitives the core uses (`defineScreen`, `Navigator`, `ScreenRef`, layers, `pxSelect`, menu entries) are the API a plugin author will get. The core is the first user of the plugin API ("dogfooding"), so the API is proven before any plugin exists.

Like the movement system, it must be adoptable **page by page**: unmigrated pages keep working through a compatibility facade until the last one moves.

Non-goals: the plugin loader itself (packaging, sandboxing, distribution: §13), redesigning pages, changing the movement system, an Angular upgrade (the plan works on Angular 14.1 as installed).

## 2. How navigation works today (and why it has to change)

| Concern | Where | What it does |
|---|---|---|
| Routes | `app-routing.module.ts` | Plain Angular routes; `/movies` and `/shows` are frames (`MoviesPageComponent`) with child routes (list, title, episode). Guards: `ServerGuard`, `ProfileGuard`, `AdultGuard`, `AdultLayoutGuard`. |
| History | `NavigationService` (`navigation.service.ts`) | `historyDepth` is counted from router events (`+1` on every navigation that isn't `replaceUrl`, `-1` on `popstate`). `goBack()` = `location.back()` while `historyDepth > 0`, else `/movies/list`. `openPowerMenu()` = `navigateByUrl('/power')`. |
| Opening a screen | ~30 call sites | `router.navigateByUrl('/movies/movie/' + id)`, `` `/shows/show/${id}/season/${s}/episode/${e}` ``, `/player`, `/adult/title/…`, `/releases/…` written inline in pages, services (`EpisodePlaybackService`, `ReleasesService`, `ConnectionService`), the menu and `AppComponent`. |
| Data handed to the next screen | four different mechanisms | `MoviesService.movieAppHistory` (a second, parallel stack of movie objects, popped with `navigation.routerCurrentMovieId`); `AdultService.openedTitle`; history state `RELEASES_FROM` read from `history.state`; `PlaybackService.current`; the connect page's `getCurrentNavigation().extras.state`. |
| Remembering a screen's own state for the way back | per page | Module-level `lastShown` (show page: season), `MoviesService.searchData`, `ReleasesService.states[kind]`, `AdultService.browseState`, `PositionStore` (global keys). |
| Input commands | `AppComponent` keydown → `NavigationService.addCommand('click'\|'back'\|'leave')` → `executeCommand()` Subject | **Every** page subscribes and filters by `this.router.url` (`==`, `startsWith`, `includes`). The slider unsubscribes itself before `openPowerMenu()` so it doesn't run twice. |
| Modals | `AppComponent` keydown + `BackButtonComponent.back()` | The same `connection.isOpen ? … : torrentPicker.isOpen ? … : playChoice.isOpen ? …` chain, written twice. `NotificationHandlerComponent` listens to every command with no filter. |
| Panels inside pages | flags in hosts | `<text-keyboard>`, `<pin-pad>`, `<catalog-filter-panel>`, the 18+ filter panel, editor panels, the pairing panel: the panel subscribes to `executeCommand()` itself and **the host must ignore commands** while it's open (`catalog.typing`, `catalog.filtering`, `keyboardOpen`, `panel == 'keyboard'`, `pinProfile`, `typing`, `entering`, …). Forgetting one = both react. |
| Select | `AppComponent` + every page | `AppComponent` special-cases menu items (`MenuServiceService 'navigate'`) and list-page posters (`moviesPageNavigation()`: GSAP out, `addMovieToHistory`, navigate). Pages run long `switch (true) { case active.classList.contains('play'): … }` blocks on `document.activeElement`. |
| Back | every page | Each page implements its own "Escape ladder" (§6) and decides between `goBack()`, `openPowerMenu()`, `navigateByUrl('/profiles')` and `navigateByUrl('/power')`. The player also listens to `keydown` itself to leave before playback is ready (`escClicked`). |
| Chrome | pages + `BackButtonComponent` | Pages call `menuService.sendInstruction('hide'\|'show'\|'collapse'\|'expand')`; the power page shows the menu again before `goBack()`; the Back button keeps a URL allow-list (`showsOn()`); the menu derives its active tab from the URL and maps `data-destination` to URLs in a `switch`. |

Problems:
- **History is inferred, not owned.** `historyDepth` guesses from router events; `replaceUrl`, guard redirects, `skipLocationChange` and the app reload on a server change all bend it. Nothing knows *what* is below the current page, so "back to the show page", "back to the section", "close everything above the player" can't be expressed.
- **Back behaviour is scattered over ~15 components**, each with its own ladder, flags and fallbacks. Changing one rule (e.g. "Back on a section root opens the power menu") means editing every section page; adding "history back" behaviour means touching all of them again.
- **Input fan-out.** Every command goes to every subscribed component; correctness depends on string checks of the URL and on per-page "a panel is open" flags. Two components reacting to one key is a whole class of bug (`navSub.unsubscribe()` workarounds).
- **Four ways to pass data to the next screen**, one of them a second history stack (`movieAppHistory`) that can drift from the real one.
- **Position memory is global.** `PositionStore` keys (`<stack>/<row>`) don't know which history entry they belong to: movie page → similar movie → Back restores the cast / similar rows of the *second* movie onto the first one's (`cast`, `similar` keys are shared).
- **URLs are written by hand everywhere**, so a route change is a grep, and a plugin would have to know the core's URL scheme.
- **No lifecycle.** Cleanup that must run whatever the exit path (the player releasing its torrent lease) is called by hand from each path (Escape, Back button, errors, before ready).

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Screen** | A declared destination: id, path pattern, component, kind, requirements, chrome, back policy, optional menu entry (§5.1). The unit of navigation and the unit a plugin contributes. |
| **Entry** | One visit of a screen in the history: `{ id, screen, params, payload, state, positions }` (§5.3). Two visits of the movie screen = two entries. |
| **Stack** | The navigator's list of entries; the top one is shown. `stack[0]` is the **root** (a section, the profile picker, `/connect`). |
| **Section** | A screen the menu switches to (movies, TV shows, search, watch list, 18+). Switching section resets the stack to `[section]` (decision B). |
| **Frame** | A routed component that stays mounted across several screens and hosts them (`MoviesPageComponent` for the movies / TV list, title and episode screens). |
| **Layer** | Something drawn above the current screen that takes input while open: modals (connection lost, torrent picker, play choice, error notification) and panels (text keyboard, PIN pad, filter panels, editor panels, pairing). Layers stack (§5.5). |
| **Action** | An abstract input from `keymap.ts` (`select`, `back`, arrows), plus `leave` (out of the screen at once: the Back button). |
| **Intent** | "Open screen X with params P and payload D", as data: `{ screen: 'core.movie', params: { id: 603 }, payload: movie }`. What code passes to the navigator, what a menu entry or a plugin's link holds. |
| **Back ladder** | The ordered rules that decide what one `back` does (§5.4). |

## 4. Target architecture

New folder `apps/tv/src/app/nav/` (declared in `AppModule`, no lazy loading, like `movement/`).

```
 input sources                       nav core                                         Angular
 ─────────────                       ────────                                         ───────
 keys (keymap.ts) ──┐
 pointer (click,    ├─► InputDispatcher ──► LayerStack (top layer) ──handled? stop
  back button) ─────┤        │                                   │ no
 Back button ───────┤        │                         ScreenRef handlers of the
 (later) remote ────┘        │                         current entry (pxSelect, onBack…)
                             │                                   │ not handled
                             │                         Navigator.back() / root policy
                             ▼
                        Navigator ── stack of Entries ── ScreenRegistry (defineScreen)
                             │  push / replace / back / backTo / reset / switchSection
                             │  guards from `requires`, beforeLeave hooks, chrome
                             ▼
                   router.navigateByUrl(url, { replaceUrl: true })   ─► <router-outlet> renders
                             │
                   PositionStore (keys scoped by entry)  ◄── FocusEngine (movement/, unchanged)
```

Principles:
1. **The navigator owns history; the router only renders.** Every navigation goes through `Navigator`; it calls the router with `replaceUrl: true`, so the browser history never grows and can't disagree (decision A). The URL is kept as the rendering key, for guards and for debugging.
2. **Screens and intents, not URLs.** URLs are built from a screen's `path` and params in one place.
3. **Input goes to exactly one owner**: the top layer, else the current entry's handlers, else the navigator. No subscriber filters by URL.
4. **Back is one algorithm with declared steps.** Pages contribute in-page steps; the navigator does the rest.
5. **Lifetime by entry.** Handlers, state and positions belong to an entry: they are dropped when the entry leaves the stack and suspended while it's covered. No `ngOnDestroy` bookkeeping for navigation.
6. **Same API for core and plugins.** Core screens are declared with `defineScreen` in `nav/screens.ts`; nothing in the core uses a private shortcut a plugin couldn't.
7. **Coexistence.** `NavigationService` stays as a facade over the new pieces until every page is migrated (§9, step 1).

## 5. Primitives and their APIs

Names are proposals; the shapes are what matters. Everything public is exported from `nav/public-api.ts` (§8).

### 5.1 `defineScreen` and the `ScreenRegistry`

```ts
export interface ScreenDef<P = {}, D = unknown> {
  id: string;                         // 'core.movie', 'plugin.<pluginId>.<name>' (decision G)
  path: string;                       // 'movies/movie/:id' — params by name, as in Angular
  component: Type<unknown>;
  frame?: { path: string; component: Type<unknown>; data?: object };   // e.g. movies-page under /movies
  kind: 'section' | 'detail' | 'fullscreen' | 'system' | 'root';
  requires?: ('server' | 'profile' | 'adult')[];                   // → generated CanActivate guards
  chrome?: { menu?: 'expanded' | 'collapsed' | 'hidden'; backButton?: boolean; clock?: boolean };
  back?: BackPolicy;                  // at the bottom of the stack / when the ladder reaches the navigator
  menu?: MenuEntry;                   // sections only (§5.7)
  params?: (p: P) => Record<string, string>;   // typed params → URL segments (default: String())
  title?: (p: P, d: D) => string;     // for logs, the debug overlay, "Back to <title>"
  beforeLeave?: (ctx: LeaveContext) => void | Promise<void>;  // see §5.8
}

export type BackPolicy =
  | 'pop'                     // default for detail / fullscreen / system: previous entry
  | 'power'                   // sections: open the power menu (today's last step out of a section)
  | 'none'                    // root screens that handle Back themselves (the picker)
  | { open: Intent };         // anything else, e.g. the profile editor → the picker
```

`defineScreen(def)` validates (unique id, unique path, kind/back consistent) and registers it. `nav/screens.ts` declares every core screen (§7). The registry **generates the Angular `Routes`** handed to `RouterModule.forRoot` (frames become parents with `children`, `requires` become guards, the `''` redirect stays), so `app-routing.module.ts` shrinks to `routes: buildRoutes(registry)`. Plugin screens are added to the same registry before the router is configured (§8; with lazy plugins later, `router.resetConfig`).

### 5.2 `Navigator` (service, root)

```ts
class Navigator {
  readonly stack$: Observable<readonly Entry[]>;
  readonly current$: Observable<Entry>;
  get current(): Entry;

  open(intent: Intent): Promise<boolean>;              // push (the usual way forward)
  replace(intent: Intent): Promise<boolean>;           // swap the top entry (episode → next episode)
  back(n = 1): Promise<boolean>;                       // pop; at the root, apply the root's BackPolicy
  backTo(match: string | ((e: Entry) => boolean)): Promise<boolean>; // pop until the screen / entry
  reset(intent: Intent): Promise<boolean>;             // stack = [intent] (profile chosen, /connect)
  switchSection(sectionId: string): Promise<boolean>;  // menu: stack = [section] (decision B)
  canGoBack(): boolean;                                // stack.length > 1
  urlFor(intent: Intent): string;                      // for links and logs only
  events$: Observable<NavEvent>;                       // willNavigate / navigated / popped / blocked
}

interface Intent<P = any, D = any> { screen: string; params?: P; payload?: D; state?: object }
```

Behaviour:
- **One navigation at a time.** Calls are queued; a call made while another is running (two keys in a row, an error path firing during a back) runs after it. Today two `navigateByUrl` racing is possible.
- Each call: run the leaving entry's `beforeLeave` (§5.8) → snapshot its focus into the entry (`FocusEngine` current item → `entry.focus`) → compute the new stack → `router.navigateByUrl(urlFor(top), { replaceUrl: true, state: { entryId } })` → on `NavigationEnd`, commit the new stack. On `NavigationCancel` / `NavigationError` nothing is committed.
- **Guard redirects** (`requires` failed, `AdultLayoutGuard`): the router lands somewhere else; the navigator reads `urlAfterRedirects`, resolves it back to a screen (`registry.match(url)`) and commits *that* (a redirect to `/profiles` or `/connect` = `reset`, others = replace of the intended entry).
- **`popstate`** should no longer happen (nothing is pushed on the browser history). If one does (Chromium shortcuts, devtools), it's turned into `back()`.
- **Same-screen navigation** (similar movie → similar movie) creates a new entry; whether the component is reused is Angular's business (today it is: `paramMap` subscriptions), the entry is new either way.
- **Depth cap** (decision H): stack limited to 50 entries; past it, the oldest entry *above the root* is dropped.
- `HOME_URL` disappears: an empty stack can't happen; the bottom is always a root/section.

### 5.3 `Entry` and `ScreenRef` (what a screen component gets)

```ts
interface Entry {
  readonly id: number;                // unique per session
  readonly screen: ScreenDef;
  readonly params: Record<string, any>;
  readonly payload: unknown;          // in-memory data handed over by the opener (never in the URL)
  state: Record<string, any>;         // the screen's own state, kept while the entry is in the stack
  focus?: FocusSnapshot;              // taken on leave, used on return (§5.9)
}

class ScreenRef<P = any, D = any> {
  readonly entry: Entry;
  readonly params: P;  readonly params$: Observable<P>;    // replace() on the same component emits
  readonly payload: D | undefined;
  readonly returning: boolean;        // true when shown again after a pop (restore, don't reset)
  state<T>(key: string, init: () => T): T;                 // per-entry state bag

  onSelect(fn: (el: HTMLElement) => boolean | void): void; // fallback when no pxSelect matched
  onBack(fn: () => boolean): void;    // an in-page step; return true when it consumed the back
  onLeave(fn: () => void): void;      // `leave` (Back button) wants out: close what you must
  onAction(action: InputAction, fn: (e) => boolean): void; // rare: arrows the screen owns (player seek)
  ready(): void;                      // data is on screen: restore focus now (§5.9)
}

// In a screen component (Angular 14.1: inject() works in field initializers)
private screen = useScreen<{ id: number }, Movie>();
```

How `useScreen()` binds to the right entry without `ngOnDestroy`: the navigator marks the entry being activated on `ActivationStart` for the leaf route; `useScreen()` (called while that component is constructed) attaches to it. **Attaching replaces the entry's previous handlers**, so a component re-created after a pop starts clean. Handlers of an entry that isn't on top are never called; they're dropped with the entry. A **frame** (`MoviesPageComponent`) calls `useFrame()` instead: its handlers follow whichever entry is current under it and are dropped when the frame's route deactivates.

What `payload` and `state` replace:

| Today | With entries |
|---|---|
| `MoviesService.movieAppHistory`, `addMovieToHistory`, `getMovieFromStack`, `popFromHistoryStack`, `navigation.routerCurrentMovieId` | `open({screen: 'core.movie', params: {id}, payload: movie})`; the page reads `screen.payload` (fetches by id when absent, e.g. a reload) |
| `AdultService.openedTitle` | payload of `core.adult.title` |
| `RELEASES_FROM` history state + `history.state` | payload of `core.releases.*` (`ReleasesOrigin`); "Back to <title>" = `navigator.back()` |
| `ConnectPage` reading `getCurrentNavigation().extras.state` (`reason`, `code`) | payload of `core.connect` |
| Module-level `lastShown` (show page season) | `screen.state('season', …)` on the show entry |
| `PlaybackService.current` | payload of `core.player` (`PlaybackRequest`); `PlaybackService.play()` becomes `navigator.open({screen: 'core.player', payload: request})` |

Section-wide state that must survive *leaving* the section (catalogs, `ReleasesService.states`, `AdultService.browseState`, search) stays in its services: entries only outlive their own stack life.

### 5.4 The back ladder

One function in `InputDispatcher`, for `back` (Escape, the mouse's back button, a remote's Back) and `leave` (the shell's Back button):

```
back:
  1. top layer?            → layer.back()            (a layer always consumes: closes, or steps inside itself)
  2. current entry's onBack handlers, last registered first; the first returning true stops
                                                       (in-page steps: results → search bar, poster → menu)
  3. navigator.back()       → stack.length > 1: pop.  At the root: the screen's BackPolicy
                              ('power' → open power menu, 'none' → nothing, {open} → that intent)

leave:
  1. top layer?            → layer.back()            (panels close first, as today)
  2. current entry's onLeave handlers (no in-page steps)
  3. same as back step 3
```

Consequences:
- A page with no special steps declares nothing: Back pops. Title pages, the episode page, the trailer, the power menu lose their `back` code entirely.
- Section pages declare only their in-page steps; "the last step goes to the power menu" is their `back: 'power'` policy, written once.
- Changing a rule ("Back on a section root opens a confirm-exit dialog", "Back on the player goes to the show, not the episode") is a change in one screen definition or one policy, not in N pages.

### 5.5 Layers (`LayerStack`, `defineLayer`)

```ts
class LayerStack {
  open<R>(def: LayerDef<R>, data?: unknown): LayerRef<R>;   // pushes; result$ emits once or completes empty on cancel
  readonly top: LayerRef | null;
  readonly layers$: Observable<readonly LayerRef[]>;
}

interface LayerRef<R = unknown> {
  readonly result$: Observable<R>;    // like TorrentPickerService.choose() today
  close(result?: R): void;
  back(): void;                       // default: close() without a result
  onSelect / onBack / onAction        // same as ScreenRef
}
```

- A layer is either **global** (rendered by the shell: connection lost, torrent picker, play choice, error notification) or **local** (rendered by a screen's template: text keyboard, PIN pad, filter panels, editor panels, pairing). Local layers are owned by their entry: closed when it's popped or covered by a new screen.
- Opening a layer remembers the focused element and **restores it on close** (the torrent picker does this by hand today); the layer's trapping `pxSection` stays as it is (movement system).
- Priority: some layers must sit above others whatever the opening order (connection lost above the torrent picker). `LayerDef.priority` (e.g. `system` > `modal` > `panel`) sorts them; `top` is the highest priority, latest opened.
- Hosts no longer need "a panel is open" flags: while a layer is on top, the screen gets no input.
- `TorrentPickerService.choose`, `PlayChoiceService.choose`, `ConnectionService` keep their public methods; inside they become `layers.open(…)`. `isOpen` / `sendCommand` disappear.

### 5.6 Input: `InputDispatcher` and `pxSelect`

- `InputDispatcher.dispatch(action, { source: 'key' | 'pointer' | 'button' | 'remote', target? })` is the only entry point. `AppComponent`'s keydown, `PointerService`'s synthetic select / back, `BackButtonComponent` and the future phone remote (`remoteSocket.service.ts`) call it. It replaces `NavigationService.addCommand` / `executeCommand`.
- Arrows are **not** dispatched: they stay with spatial navigation and the `FocusEngine`, unchanged. A screen or layer that owns arrows (the player's ←/→ seek on the progress bar) registers `onAction('left', fn)`; the dispatcher calls it from a capture listener before the movement system and stops the event when it returns true.
- **`pxSelect`** (directive) makes selection declarative:

  ```html
  <button class="play focusable" (pxSelect)="play()">Play</button>
  <div class="poster" pxItem [pxItemKey]="m.id" (pxSelect)="open(m)">…</div>
  ```

  On `select`, the dispatcher looks for the nearest `[pxSelect]` ancestor of the focused element **inside the current owner** (top layer's element, else the current screen's) and calls it; else the owner's `onSelect` fallback. This replaces the `switch (true) { case active.classList.contains(...) }` blocks, `AppComponent.moviesPageNavigation()` and the menu's `'navigate'` instruction. The select key's native click is still prevented once, in the dispatcher.
- Mouse: unchanged model (`PointerService` hover = focus, click = `select`, right click / button 3 = `back`), now through `dispatch`.

### 5.7 Menu entries

A section's `ScreenDef.menu`:

```ts
interface MenuEntry { label: string; icon: string; order: number; visible?: (ctx: { profile: Profile | null }) => boolean }
```

`MenuComponent` renders the registry's entries sorted by `order` (Search, Movies, TV shows, Watch list, 18+ with `visible: p => !p?.kids`, Settings), and the bottom items (server → `core.connect`, profile → `core.profiles`) as fixed core items. Enter on an entry → `navigator.switchSection(id)`. The active item = the section of `stack[0]`, not a URL test. The `data-destination` switch disappears. A plugin adds a section by declaring a screen with `kind: 'section'` and a `menu` entry.

### 5.8 Lifecycle and guards

- `requires` → generated guards (`ServerGuard`, `ProfileGuard`, `AdultGuard` become the implementations behind `'server' | 'profile' | 'adult'`). `AdultLayoutGuard` becomes the `core.adult` section's resolver: `switchSection('adult')` opens the profile's layout screen.
- `beforeLeave(ctx)` on a screen definition: runs on **every** way out of the entry (pop, reset, switchSection, the connection-lost "Choose server", an error path). `ctx.reason` says which. May be async (awaited, 2 s cap). The player's lease release (`removeTorrent`) and progress save move here; `leavePlayer()` just calls `navigator.back()`.
- `canLeave(ctx) → boolean | Promise<boolean>` (optional): for screens that must confirm (a profile editor with unsaved changes, later). Blocked navigations emit `blocked` on `events$`.
- **Transitions**: an optional `beforeLeave` animation (the list page's GSAP fade-out of the rows before a title opens, today in `AppComponent`) is just a `beforeLeave` that resolves when the timeline ends.
- **Chrome**: on `navigated`, the shell applies the new screen's `chrome` (menu expanded / collapsed / hidden, Back button, clock). Pages stop calling `menuService.sendInstruction('hide'|'show')` for page-level chrome (they may still collapse / expand the menu while moving inside a section). `BackButtonComponent.showsOn()` becomes `screen.chrome.backButton ?? (navigator.canGoBack() || screen.kind != 'section')`.

### 5.9 Focus and positions per entry

- `PositionStore` keys get the entry as a prefix: `e<entryId>:<stack>/<row>`. Two movie pages in the stack no longer share `cast` / `similar`. Sections keep **unscoped** keys (`catalog:movie`, `watchlist`, …) on purpose, because their positions must survive leaving and re-entering the section (today's behaviour): a container opts in with `scope="section"` (default for `section` screens) or `scope="entry"` (default for the rest). Entries' keys are cleared when the entry is dropped.
- On leave, the navigator saves `entry.focus` = the focused item's container + key (`FocusEngine` already knows it). On return (`returning == true`), once the screen calls `screen.ready()` (or after its first render when it has nothing async), the navigator calls `engine.restore(entry.focus)`, falling back to the screen's initial focus. This replaces the per-page `setTimeout(() => engine.restore('stack:…'))` and `focusFirstWhenReady` retries with one mechanism.

## 6. Behaviours to preserve (the spec for migration and verification)

What Escape (`back`) does today, screen by screen; `leave` (Back button) = panels close first, then out at once. Each row becomes: in-page steps (`onBack`) + a back policy.

| Screen | In-page steps (`onBack`, in order) | Policy at the end |
|---|---|---|
| Profile picker | splash not cleared → ignore; manage mode → leave it | `{open: power}` (root) |
| Profile editor | open panel closes (layer) | `{open: core.profiles}` (cancel) |
| Connect | pairing panel closes (layer) | connected → `pop`; else `{open: power}` |
| Movies / TV list | keyboard / filter panel close (layers); search result → search bar; search bar → menu; poster → its row `home()` + menu | `power` |
| Movie / show / episode page | — | `pop` (an episode swap is a `replace`, so Back still lands on the show) |
| Watch list | card → menu | `power` |
| Search | — (clears its state in `beforeLeave`) | `power` |
| 18+ posters | filter panel / keyboard close (layers); posters → toolbar; toolbar → menu | `power` |
| 18+ title | — | `pop` |
| Release list (from a title) | list → rail | `pop` (to the title) |
| Release list (18+ section) | list → rail; rail → menu | `power` |
| Player | subtitles panel → controls → stats panel (in-page); before ready: none | `pop` (+ `beforeLeave`: release the lease, save progress) |
| Trailer | — | `pop` |
| Power menu | — | `pop` (chrome restores the menu) |
| Modals | connection lost / torrent picker / play choice: cancel; error notification: OK | (layers) |

## 7. Screen catalog (core)

| Id | Path | Kind | Requires | Notes |
|---|---|---|---|---|
| `core.connect` | `connect` | root | — | payload `{reason, code}` |
| `core.profiles` | `profiles` | root | server | back `{open: core.power}` |
| `core.profiles.new` / `.edit` | `profiles/new`, `profiles/:id/edit` | detail | server | back `{open: core.profiles}`, menu hidden |
| `core.movies` | `movies/list` (frame `movies`, data `media: movie`) | section | profile | menu order 20 |
| `core.movie` | `movies/movie/:id` (frame `movies`) | detail | profile | payload: TMDB movie |
| `core.shows` | `shows/list` (frame `shows`) | section | profile | menu order 30 |
| `core.show` | `shows/show/:id` (frame `shows`) | detail | profile | state: season |
| `core.episode` | `shows/show/:id/season/:season/episode/:episode` (frame `shows`) | detail | profile | other episode = `replace` |
| `core.watchlist` | `watchlist` | section | profile | menu order 40 |
| `core.search` | `search` | section | profile | menu order 10, chrome menu hidden |
| `core.adult` | `adult` → layout screen | section | adult | menu order 50, `visible: !kids` |
| `core.adult.browse` / `core.adult.releases` | `adult/browse`, `adult/releases` | section | adult | the two layouts of one section |
| `core.adult.title` | `adult/title/:provider/:id` | detail | adult | payload: title |
| `core.releases.movies` / `.shows` | `releases/movies`, `releases/shows` | detail | profile | payload: `ReleasesOrigin` |
| `core.player` | `player` | fullscreen | profile | payload: `PlaybackRequest`; `beforeLeave` |
| `core.trailer` | `ytplayer/:id` | fullscreen | profile | |
| `core.power` | `power` | system | — | chrome menu hidden |

The menu's Settings placeholder becomes `core.settings` when Settings is built.

## 8. Plugin readiness

What this plan delivers for plugins, and what it doesn't:

- **The contract** is `apps/tv/src/app/nav/public-api.ts`: `defineScreen`, `defineLayer`, `Intent`, `Navigator` (open / replace / back / backTo / reset / switchSection / events$), `useScreen` / `ScreenRef`, `LayerStack`, `pxSelect`, `MenuEntry`, `BackPolicy`, plus the movement directives already public in practice (`pxSection`, `pxStack`, `pxRow`, `pxGrid`, `pxItem`). Core code imports the nav system through this file too, so a breaking change shows up in core first.
- **Rules a plugin follows** (enforced by `defineScreen`): ids `plugin.<pluginId>.<name>`, paths under `p/<pluginId>/…` (decision G), only `section` / `detail` / `fullscreen` kinds (no `root` / `system`), no access to core screens' entries except through intents.
- **Opening core screens from a plugin**: by intent (`{screen: 'core.movie', params: {id}}`); core screen ids are part of the contract and versioned with it (`NAV_API_VERSION`).
- **Proof**: step 7 adds a dev-only example plugin module in the repo (`src/app/plugins-dev/hello/`) that declares a section with a menu entry, a detail screen, a layer and an intent into `core.movie`, built only in development.
- **Not in this plan** (§13): how plugins are packaged and loaded (Angular lazy modules, Web Components, iframes), permissions and sandboxing, plugin-provided server routes, extension points inside core screens (e.g. extra buttons on the movie page).

## 9. Implementation steps

Each step leaves the app working, is verified with §10 before the next, and is one commit (the user commits).

### Step 0: harness
- `nav/` folder, Karma specs set up like `movement/*.spec.ts`.
- A debug overlay (dev builds, toggled by a key): the stack (screen ids, params), layers, current owner. Makes every later step observable.
- Write §6 as a scenario list (`docs/navigation-scenarios.md` or a section here) and run it once against today's app to record the baseline (some rows may already be buggy: note them, don't fix yet).

### Step 1: core, no page changes
- `ScreenRegistry` + `defineScreen`, `nav/screens.ts` with every route of §7, `buildRoutes()` generating today's exact route table (diff it against `app-routing.module.ts`: identical paths, guards, data).
- `Navigator` (stack, queue, router with `replaceUrl`, redirect resolution, depth cap), `InputDispatcher` (layers → handlers → navigator), `LayerStack` (empty for now).
- **`NavigationService` becomes a facade**: `goBack()` → `navigator.back()`, `openPowerMenu()` → `navigator.open(power)`, `addCommand(c)` → `dispatch`, and `executeCommand()` still emits to unmigrated pages when the current entry has no handlers (so they behave as today). `router.navigateByUrl` calls in pages keep working: the navigator observes navigations it didn't start (`NavigationStart` without its `entryId`) and treats them as `open` (or `reset` for `/profiles` / `/connect`).
- Specs: stack operations, queueing, redirect → reset/replace, depth cap, back ladder order, facade behaviour.
- Verify: the whole of §6 unchanged.

### Step 2: global layers
- Connection lost, torrent picker, play choice, error notification → `LayerStack` (priorities: connection lost > notification > pickers).
- Remove the modal chains from `AppComponent` and `BackButtonComponent`; remove `isOpen` / `sendCommand`.
- Verify: each modal with keys and mouse; connection lost over an open torrent picker; focus restored on close.

### Step 3: local layers (panels)
- `<text-keyboard>`, `<pin-pad>`, `<catalog-filter-panel>`, 18+ filter panel, profile editor panels, pairing panel → local layers (a `pxLayer` directive or `layers.open` from the host).
- Delete the host flags (`typing`, `filtering`, `keyboardOpen`, `panel == 'keyboard'`, `pinProfile`, …) and their checks.
- Verify: every panel: Escape closes it, the Back button closes it first, the host never reacts while it's open.

### Step 4: pilot — title pages
- `core.movie`, `core.show`, `core.episode`, `core.adult.title`, `core.trailer`: `useScreen()`, `pxSelect` on buttons and rows, no `back` code, payload instead of `movieAppHistory` / `openedTitle`, `state` instead of `lastShown`, entry-scoped positions.
- `AppComponent.moviesPageNavigation()` → the list page's poster `(pxSelect)` + `beforeLeave` animation.
- Verify: list → movie → similar → similar → Back × 3 lands on each with its own rows' positions; show → episode → other episode → Back = show; adult title → More from → Back.

### Step 5: sections and the menu
- Menu from the registry, `switchSection`, chrome declarations, active item from `stack[0]`.
- Movies / TV lists, watch list, search, 18+ browse, release lists (payload `ReleasesOrigin`): in-page steps as `onBack`, policies, `pxSelect`.
- Verify: §6 rows for every section; switching sections from deep in a title (menu on the movie page) → `[section]`, Back → power menu; returning to a section restores its positions.

### Step 6: root, system and fullscreen screens
- Profile picker, editor, connect, power, player (`beforeLeave` lease release + progress save; `onAction` for seeking; the `escClicked` keydown listener goes), `PlaybackService.play` → `open(core.player)`.
- Profile chosen → `reset(core.movies)`; connect chosen (no reload case) → `reset(core.profiles)`; `ConnectionService` → `reset(core.connect, {reason})`.
- Verify: player exits by Escape (ready / not ready), Back button, error, connection lost → Choose server: the lease is released in every case (server's `/sessions`).

### Step 7: cleanup + contract
- Delete the facade: `NavigationService` keeps only what isn't navigation (or is removed: the description and slider subjects move to `MoviesService` / `Catalog`; `updateNavigation` callers are already gone or moved to `pxSection`).
- `grep -rn "router.url\|navigateByUrl\|executeCommand\|location.back" apps/tv/src/app` → only inside `nav/`.
- `public-api.ts`, `NAV_API_VERSION`, the dev-only example plugin, `docs/tv-plugins.md` (author guide draft, like `docs/api/` for server clients).
- Rewrite the "Routes", "Spatial navigation › Key handling" and "Recipes › Add a new page" parts of `apps/tv/src/app/CLAUDE.md`; root `CLAUDE.md` input-model bullet.

## 10. Verification

For every step (and the final pass), from `apps/tv`:
- Unit: `CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --include src/app/nav` (+ `src/app/movement` stays green).
- Build: `NG_CLI_ANALYTICS=false npx ng build --base-href ./ < /dev/null`.
- Scenarios (Electron, keys via `webContents.sendInputEvent` with Electron key names `Escape` / `Return` / arrows, plus the mouse): every row of §6, plus:
  1. Movies list → poster → similar → similar → Back × 3 → the list, same poster focused, rows where they were.
  2. Movie → Find releases → play → Escape → release list (same release focused) → Back → movie.
  3. Show → episode → next episode (replace) → Play → Escape → episode → Back → show, last season + episode focused.
  4. Menu switch from a title page → section root; Back → power menu; Back → that section.
  5. Profile picker → profile → movies; menu profile item → picker → another profile → movies with fresh positions.
  6. Panels: open keyboard on the list page, Back button (mouse) → keyboard closes, page stays.
  7. Connection lost over the player → Choose server → `/connect`, lease released.
  8. Hammering Escape / Enter during transitions: never two screens reacting, never a blank outlet (`NG04002`), stack consistent in the debug overlay.

## 11. Files you will touch (summary)

New: `apps/tv/src/app/nav/` (`navigator.service.ts`, `screen-registry.ts`, `screens.ts`, `screen-ref.ts`, `input-dispatcher.service.ts`, `layer-stack.service.ts`, `px-select.directive.ts`, `public-api.ts`, specs).
Changed: `app-routing.module.ts`, `app.module.ts`, `app.component.ts`, `navigation.service.ts` (facade, then gone), `menu/`, `back-button/`, `pointer.service.ts`, `movement/position-store.service.ts` (scopes), every page component (steps 4–6), `torrent-picker.service.ts`, `play-choice.service.ts`, `connection.service.ts`, `playback.service.ts`, `episode-playback.service.ts`, `releases.service.ts`, `movies.service.ts` (`movieAppHistory` removed), `adult.service.ts` (`openedTitle` removed), guards, `CLAUDE.md` files.

## 12. Decisions (open; bold = recommended)

- **A. Source of truth for history** — **own stack, router driven with `replaceUrl: true`** (browser history unused; deterministic, nothing to reconcile) / mirror the stack onto browser history (push/pop in sync; `popstate` must be reconciled, gains nothing in Electron where there's no browser Back button).
- **B. Menu switch** — **reset the stack to `[section]`** (tab-like; Back from a section never wanders into another section's titles; matches today's "section root → power menu") / push the section (Back returns to the previous section's title page).
- **C. Back at a section root** — **power menu, as today** (`back: 'power'`) / a confirm-exit layer / nothing.
- **D. Handler style** — **`useScreen()` (inject in field initializer) + `(pxSelect)` in templates** / an abstract `ScreenComponent` base class / keep a Subject but scoped per entry (least change, keeps the switch blocks).
- **E. Persist the stack across reloads** (choosing a server reloads the app) — **no** (a reload goes through `/connect` → `/profiles` anyway) / `sessionStorage`.
- **F. Positions scope** — **sections unscoped, everything else per entry** (§5.9) / everything per entry (sections then forget positions when switched away from) / as today.
- **G. Plugin namespace** — **ids `plugin.<id>.<name>`, paths `p/<id>/…`** / free-form with collision checks.
- **H. Stack depth cap** — **50, oldest above the root dropped** / unbounded / collapse repeated visits of the same entry.

## 13. Later (not part of this plan)

- Plugin loading: Angular lazy modules (`loadChildren` + `router.resetConfig`) vs Web Components vs iframes; a manifest (id, version, `NAV_API_VERSION` range, screens, menu entries, permissions); where plugins come from (the server could host them for every client: ties into the server's API and `packages/protocol`).
- Extension points inside core screens: extra action buttons on title pages, extra rows on sections, extra layers on the player (each an explicit, versioned slot).
- Deep links from outside (the phone remote / server events opening `core.movie` on the TV): the `Intent` shape is already the payload format.
- A real Settings screen editing per-profile preferences (`preferences.adult`, …) as `core.settings`.
- Angular upgrade (≥ 16: `DestroyRef`, standalone components, signals) would simplify `useScreen()` lifetime and plugin loading; not required here.

## Legal note
Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.
