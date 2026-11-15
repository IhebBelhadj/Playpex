# Playpex TV on the web: plan

Status: **steps 1–8 built 2026-11-15, committed; reload restore (§5.4) built the same day, uncommitted** (step 9, the optional ones, left: web manifest / install, YouTube embeds in the page). Decisions A–H taken as recommended (bold), the user's "implement the whole plan". Asked by the user: "can we make playpex tv client available for the web? (just like what youtube did long time ago with youtube's tv version on the browser)", then: what happens when the window is resized, an overlay for screens that don't fit, and calibration of the frame's shape in Settings for Electron too, shared with the web version.

Verified: the movement specs (34, 4 new in `movement/realign.spec.ts`: the focused item, the remembered one, the start, a clamped offset), `settings.service.spec.ts` (9) and `ui/` (39); `check:ui` (with the new whole-window rule), `check:plugins`, `check:contrast`; the server suite (507: 506 pass, 1 skipped) with `test/web-client.test.js` (9: `/tv/` serving, cookie pairing, cookie GET / WebSocket as a LAN client, the CSRF header, both cookies together, logout, revoke, loopback, browser names); the desktop build and `npm run build:web`. By hand in Chromium against a copy of the server on :28490: the first start in a browser (size, Screen area with x / y and the 4:3 shape: a centred 1080 × 810 area, the UI sized from it; Reset), Home with a row scrolled to its 7th poster kept at the row's start through 1440 × 810 → 1920 × 1080 → 1200 × 700, the "Make the window bigger" dialog at 900 × 500 (Continue anyway; Escape gives the focus back to the poster), Backspace as Back, the web power page, pairing from the LAN address (code + QR, approved with the CLI, the page reloads paired; the cookie unreadable from JS; `PUT /devices/me` with the browser's codecs, "Chrome on Linux"), a media request and the events socket authenticated by the cookie, a write without `X-Playpex-Client` refused (403), the app's own writes through (Settings › Screen area saved as 1 % · 0.5 % · 16:9), Forget this browser (the device deleted, back to pairing). **Not tried**: Firefox and Safari (playback, codec reports), playback of a real file in the browser, the remote control driving a browser (synthetic input, `web/web-remote.ts`), Electron's minimum window size and its shape lock (`setAspectRatio`), a TV with overscan.

What differs from the text below:
- **Settings**: three flat device keys instead of one `display.frame` object, so older clients keep working: `display.safeArea` (x, its max raised from 0.06 to 0.1), `display.safeAreaY` (null = as x), `display.shape`. Boot cache: `localStorage['playpex.frame']` in Electron too (the renderer's storage persists there), not `client.json`; a first start's choice waits in `playpex.safeArea` / `playpex.safeAreaY` / `playpex.shape` until a server has it (`SettingsService` LEGACY).
- **The frame is the safe-area tokens**: `applyFrame()` (`ui/display.ts`) sets `--px-safe-x / -y` to where the area starts (edges plus the shape's bands), so `--px-screen-w / -h` and everything already inside the screen edges follow; no new `--px-frame-*` tokens. The root size (`styles.scss`) is `min(--px-screen-w / 90, --px-screen-h / 50.625) × scale`. A changed frame sends a `resize` event (realignment, chevrons, the guard).
- **Calibration**: `<screen-edges>` (same selector) became "Screen area": two sliders (Left and right, Top and bottom, 0–10 %), the shape chips, Done / Reset; not ←/→ and ↑/↓ on one control.
- **Too small**: `frame-guard/` (`<frame-guard>` in the shell, not `ui/`): a system `px-dialog` (Full screen in a browser, Continue anyway), the portrait hint a toast. Full screen in a browser: **F** toggles it and the first key / click on a device says so once (a toast), instead of a "Press Enter for full screen" prompt.
- **The browser's shell**: `app/web/` (`web-client.ts`: `webConnection`, pairing, `describeDevice` / `browserCapabilities`, `forgetBrowser`; `web-client.interceptor.ts`; `web-remote.ts`); `desktop()` stays the Electron bridge only. `environment.web` (`environment.web.ts`, the `web` configuration: `apps/server/public-tv`, base href `/tv/`). `keymap.ts` `isRealKey()` (a trusted key or one the browser's remote dispatched).
- **Server** (`apps/server/lib/auth/`, `lib/api.js`; `docs/api/auth.md` "Browsers"): the token answer with `cookie: true` is `{ token_type: 'cookie', expires_in, scope }`, the cookie `playpex_device`; `POST /auth/device/logout`; 403 `CLIENT_HEADER_REQUIRED`. **Admin and device cookies together**: a request with `X-Playpex-Client` is the device, one without is the admin (the dashboard sends no such header), not "client routes use the device"; WebSockets can't send headers, so in a browser holding both cookies the TV's sockets are the admin's (`?device=` still names the device).
- The dashboard's Devices page has "Open Playpex TV in a browser" (`/tv/`).

**Revised 2026-11-15 (later the same day), asked by the user**: "black bands around areas that are not included in the screen area and … when the user starts to resize the window you get black bands just like in youtube tv … and make the ui smaller automatically so it scales everything evenly at once", and "a button in the player for picture in picture". So, replacing §3.1's "backdrops and the video stay full-bleed" and §3.3's threshold:
- **The whole app lives in the screen area**: `applyFrame` sets `--px-frame-x/-y` and `--px-screen-w/-h`; `body` is placed and sized to the area (`contain: layout paint`: every fixed element, the video and backdrops included, stays inside); `html` paints the bands black (`--px-color-band`). `--px-safe-x/-y` are 0. Every `100vw` / `100vh` became `var(--px-screen-w/-h)` and `check:ui` refuses them outright. The Back button and the remote's drawn pointer subtract the page's offset.
- **No floor on the root size**: `min(screen-w / 90, screen-h / 50.625) × scale`, so a smaller window gets an evenly smaller UI, never a cut-off one. `<frame-guard>` now only says when it gets too small to read (a root under 7px at full scale: an area under ≈ 630 × 354); Electron's minimum window is 640 × 360.
- **`display.shape` `auto`** (the new default): 16:9 in a browser (letterboxed like YouTube's TV app at any window shape), the whole window in Electron (`effectiveShape()`); the Shape chips start with "Automatic (16:9)" / "Automatic".
- **Picture in picture**: the player's `pip` button (controls, before Settings; `requestPictureInPicture` on the `<video>`; not for embeds; its label follows `enterpictureinpicture` / `leavepictureinpicture`). Leaving the player closes it (the video goes with the page).
- Verified in Chromium: a 1600 × 700 window → a centred 1244 × 700 area with black sides; 900 × 800 → 900 × 506 with black top and bottom, everything scaled (root 8px), nothing cut off; a live channel letterboxed in the area, the Back button beside the clock; the video entering and leaving picture in picture with the button's label following. Not tried: pressing the button itself with a real key in the automated browser (the call it makes was), Electron with the bands.

Two parts, in this order:

1. **The screen frame** (§3–§4): the UI follows any window and any screen correctly. Rows realign after a resize, the root size comes from the calibrated frame and not the whole window, the frame can be adjusted per axis and locked to a shape, and an overlay appears when the window is too small. This is useful for Playpex TV in Electron today (windowed, projectors, TVs that crop the picture), and the web version needs it.
2. **Playpex TV in a browser** (§5–§6): the server serves the TV app at `/tv/`, the browser pairs like any device (its token in an httpOnly cookie), and the few things only the Electron shell does get web stand-ins.

---

## 1. Goal

- Any browser on the LAN opens `http://<server>:28470/tv/` and gets the full 10-foot UI: profiles, rows, title pages, Play, the player, live TV, plugins. It's driven by keyboard or remote, the mouse works too, and it pairs once like Playpex TV.
- The UI is right in any window: any size, any shape, during and after a resize, with the frame calibrated per device. Electron and the web share the same code and the same device setting.
- No second app. It's the same Angular build as `apps/tv`, with a web flavour of `desktop.ts`.

Not goals: a public-internet deployment (HTTPS, a reverse proxy, accounts outside the LAN; §8), a phone layout (Playpex Mobile is the phone client), offline use.

---

## 2. What exists (checked 2026-11-15)

| Piece | Where | State |
|---|---|---|
| Root size | `apps/tv/src/styles.scss:34`: `max(12px, min(100vw / 90, 100vh / 50.625) * var(--px-ui-scale))` | follows the window live; fits the tighter side (16:9 design on 1440 × 810); the 12px floor wins over fitting |
| UI size | `ui/display.ts` (`UI_SCALES` 0.7–1.15, default 0.8), `client.json` `uiScale` / `localStorage['playpex.uiScale']`, `/display` on the first start | built |
| Screen edges | `ui/display.ts` `applySafeArea()` → `--px-safe-x/-y`, `--px-screen-w/-h` (`_tokens.scss:228`); `<screen-edges>` calibration; device setting `display.safeArea` (`packages/protocol/settings.js:20`, 0–0.06, **one value for both axes**) | built (ui-system-plan §13.1): shell, layouts, panels, toasts and player controls inside; video and backdrops edge to edge. The root size ignores it: at 6 % the UI keeps its size in a frame 12 % smaller |
| Rows after a resize | `movement/motion.ts` `TransformMotion`: offsets kept **in pixels** (`offsets` WeakMap, `translate3d(-left px)`); `px-container.ts` observes resizes only to update its edge arrows | **bug**: a row scrolled sideways keeps its old pixel offset after a resize, the posters don't, so it's misaligned until the next move |
| Small windows | the 12px floor | below about **1080 × 608** CSS px the design no longer fits and the right / bottom are cut off (`body { overflow: hidden }`): nothing can be scrolled to |
| TV in a browser | `server-config.ts` `browserConnection()` (`?server=`, `localStorage`, a device id, `platform: 'web'`) | works under `ng serve` against a loopback server only: no pairing, and cross-origin requests need the server's CORS list |
| Electron-only | `desktop.ts` (`window.playpex`): `connection`, `discovery`, `display`, `power`, `remote`, `updater` | 5 used from the renderer |
| Auth | `apps/server/lib/auth/index.js` `identify()`: Bearer / `?access_token=` (devices), the admin's cookie (dashboard), loopback (local) | no cookie for a device |
| Hosting | `apps/server/lib/api.js:802`: the dashboard's static files + an SPA fallback for every non-`/api/` GET | the fallback would swallow `/tv/*`: the TV's routes go first |

---

## 3. Design: the screen frame

### 3.1 One frame, everything sized from it

The **frame** is the part of the screen the UI uses: the window minus the screen edges, optionally narrowed to a shape. Everything you read or focus goes inside it, and **the root size is computed from it**:

```scss
// _tokens.scss / styles.scss (sketch)
--px-frame-w: calc(100vw - 2 * var(--px-safe-x));
--px-frame-h: calc(100vh - 2 * var(--px-safe-y));
html { font-size: max(12px, calc(min(var(--px-frame-w) / 90, var(--px-frame-h) / 50.625) * var(--px-ui-scale))); }
```

`--px-screen-w/-h` already are this frame; they get renamed or aliased, not duplicated. Backdrops, the video, scrims and the splash stay edge to edge, as today.

The effect: on a TV that crops 5 % at each edge, calibrated to 5 %, the UI shrinks by 10 % and fits what's visible. Today it stays the same size and gets squeezed. This changes how Electron looks for anyone who already set screen edges, and that's intended (decision B).

### 3.2 Calibration: per axis, and a shape

`display.safeArea` (one number) becomes a frame setting:

| Field | Range | Meaning |
|---|---|---|
| `x` | 0–0.10 | inset of the left and right edges, as a fraction of the width |
| `y` | 0–0.10 | inset of the top and bottom, as a fraction of the height |
| `shape` | `fill` · `16:9` · `21:9` · `4:3` | `fill`: the frame is the inset window, any shape; otherwise the largest frame of that shape inside it, centred (bands on the other axis) |

Per axis rather than per edge (decision A): TVs crop symmetrically, separate x / y covers 4:3-ish cropping and projectors, and the tokens are already x / y. A shape lock keeps an ultrawide monitor or an odd window from spreading the rows across 3 m of screen. The bands show the backdrop, never black bars.

The shape is pure CSS too (no script on resize):

```scss
--px-frame-w: min(calc(100vw - 2 * var(--px-safe-x)), calc((100vh - 2 * var(--px-safe-y)) * var(--px-shape-ratio, 999)));
```

with `--px-shape-ratio` unset for `fill`. The inset that positions the frame (`--px-frame-left/top`) is computed from it the same way.

**Setting**: `display.frame` (device scope, `packages/protocol/settings.js`), `{ x, y, shape }`, default `{ x: 0, y: 0, shape: 'fill' }`. Migration: an old `display.safeArea` = `f` becomes `{ x: f, y: f, shape: 'fill' }` when read (the setting registry's default + a one-time copy in `SettingsService`); `display.safeArea` is then retired. The boot cache follows `uiScale`: `client.json` in Electron (`window.playpex.display` gains `frame`), `localStorage['playpex.frame']` on the web. It's applied before Angular boots (`resolveDisplay()`), so the first frame is already right.

**Calibration screen**: `<screen-edges>` becomes "Screen area" (Settings › Display, and offered on the first start after the size, as now):

- the dashed frame and four corner marks, as today; the UI behind follows live (the screen is the preview);
- **←/→** move the left and right edges together, **↑/↓** the top and bottom (two sliders on a mouse);
- a **Shape** choice row: Fill · 16:9 · 21:9 · 4:3;
- **Reset**, **OK** keeps, **Back** restores (unchanged rule).

In Electron, the shape can also lock the window when it isn't fullscreen (`BrowserWindow.setAspectRatio`, decision D).

### 3.3 Too small: an overlay at the floor

The 12px floor exists for readability; it should never turn into cut-off content. So:

> **The "too small" overlay shows exactly when the frame's fitting size is under 12px:** `min(frame-w / 90, frame-h / 50.625) < 12px`, i.e. a frame under about **1080 × 608** CSS pixels.

- It **doesn't depend on the UI size**: below the threshold even the full-size design doesn't fit. Between 1080 and ~1350 px wide at scale 0.8 the floor only makes the UI a bit larger than chosen, with nothing cut off. So "make the UI smaller" is not an answer to it.
- **No overlay for aspect ratio.** The frame fits any shape. A **portrait** window (taller than wide) gets a dismissible hint instead: "Playpex TV is made for wide screens. On a phone, use Playpex Mobile."
- What it says: "Make the window bigger", with **Full screen** (the Fullscreen API on the web, `setFullScreen` in Electron) and, on the web, "or zoom out (Ctrl −)". Browser zoom changes CSS pixels, so zooming in can trigger it, which is correct.
- How: `ui/frame-guard` (a small service + `<px-frame-guard>` in `px-shell`), `matchMedia` / `resize` debounced 150 ms, the threshold computed from the same tokens (`getComputedStyle` of a probe element sized `--px-frame-w/-h`). While it's up, input goes only to its buttons (a layer, like `px-dialog`). The page underneath keeps its state; resizing back removes it.
- Electron also sets `minWidth` / `minHeight` on its window (1080 × 608 at frame 0), so it rarely gets there.

### 3.4 Rows after a resize

`TransformMotion` keeps pixel offsets, so the movement system needs a resize step:

- `px-container.ts`'s existing `ResizeObserver` (and a window `resize`, debounced to the next frame) calls `realign()`: for a `transform` container, recompute the offset that puts the **focused item** (else the first visible item, else the start) where its alignment rule wants it, then `moveTo(…, { instant: true })`. `scroll` containers re-run the same reveal through `Scroller`, also instant.
- `PositionStore` entries saved in pixels are re-derived from the item they point at when they're restored, never replayed as numbers (check: `position-store.service.ts`).
- GSAP timelines that captured sizes (the player's timeline, splash) are left to finish; anything still wrong after the 150 ms debounce counts as a bug for §7.
- The remote control's pointer scale (`remote-control.service.ts:230`, `innerWidth`) already listens to `resize`: unchanged.

This is a bug fix for today's Electron app and lands first (step 1).

---

## 4. Who uses which unit

The rule the audit applies (and the `check:ui` rule §13.1 left undone finally gets written):

| Kind | Sized / placed by | Examples |
|---|---|---|
| Edge to edge | `100vw` / `100vh` / `inset: 0` | backdrops, the player's `<video>`, scrims, splash video, the YouTube embed's picture |
| Inside the frame | `--px-frame-*` (and `dp()` inside) | `px-shell`, layouts, `px-dialog`, `px-panel`, toasts, back button, clock, player controls / notices / Up next / stats, the remote's drawn pointer bounds, the power page, `/connect`, `/display` |

`check:ui` refuses `100vw` / `100vh` / `position: fixed` in components unless the line says `// ui-check: allow (edge-to-edge)`. The current users (25 stylesheets with `position: fixed`, 19 with `100vw` / `100vh`) are sorted once in step 2.

---

## 5. Design: the web client

### 5.1 Served by the server

`npm run build:web -w apps/tv` = `ng build --configuration web --base-href /tv/` into `apps/server/public-tv` (git-ignored, like `public`), with `environment.web = true`. The server:

- serves `/tv/assets…` cached (hashed names), `/tv/*` GET → the TV's `index.html` (`no-cache`), **before** the dashboard's SPA fallback in `api.js`;
- answers 404 with "Playpex TV for the web is not built: run `npm run build:web -w apps/tv`" when it's missing, like the dashboard;
- ships it in the desktop server's installers (the Angular build is ~a few MB; it's the same UI the TV app ships).

The app and the API share an origin, so there's no CORS, no `Origin` stripping and no discovery: **the page's server is the server that served it** (`location.origin`). `server-config.ts` gets a third path, `webConnection()`, next to Electron and `ng serve`.

Router: path routing under `/tv/` (base href). The "no query or hash at boot" rule (CLAUDE.md) holds; the pairing callback, if any, must not leave one.

### 5.2 Pairing and auth: a device cookie

Video elements, `hls.js`, `<track>` and WebSockets can't set headers, and tokens in URLs (`?access_token=`) end up in logs and history. So a browser device is identified by a **cookie**:

1. The page on another machine (not loopback) has no cookie: `/connect` shows "Pair this browser": code + QR, polling (the existing RFC 8628 routes, `client_id = playpex-web`).
2. When the admin approves, the page doesn't get the token. Instead `POST /api/v1/auth/device/token` with `{ cookie: true }` (new) answers with `Set-Cookie: playpex_device=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<a year>` (`Secure` when served over HTTPS). The page's JavaScript never sees the token.
3. `identify()` gains a fourth source: the `playpex_device` cookie → `{ kind: 'device', device }`, same as Bearer. The **admin's cookie is never a device** (unchanged). When both are present, a client route uses the device and an admin route the admin.
4. **CSRF**: cookie-authenticated, state-changing requests must carry `X-Playpex-Client` (a custom header: cross-site forms can't send it, and cross-origin `fetch` needs a preflight the server doesn't grant). The TV sends it on every call already (an Angular interceptor on the web, the shell in Electron). Plus `SameSite=Strict`.
5. Revoking the device on the dashboard → `401 PAIRING_REQUIRED` → back to "Pair this browser", as in Electron. "Forget this server" = `POST /auth/device/logout` clears the cookie.

Loopback stays trusted (`{ kind: 'local' }`): a browser on the server machine needs no pairing, as `ng serve` does today.

Device id: `localStorage['playpex.deviceId']` (as `browserConnection()` does) sent as `X-Playpex-Device` / `?device=`; the device row keeps it (`clientDeviceId`). The device's name defaults to the browser and OS ("Chrome on Windows"), renamable on the dashboard.

### 5.3 What the shell did, on the web

| `window.playpex.*` | Web stand-in |
|---|---|
| `connection` (which server, switching) | `location.origin`, fixed; the menu's "Server" item shows it and offers "Forget this browser" instead of a server list |
| `discovery` | none (the page knows its server); `/connect`'s server list is hidden |
| `display` (`uiScale`, the frame) | `localStorage` boot cache + the device settings (`display.uiScale`?, `display.frame`) once paired, as `SettingsService` already adopts |
| `power` (quit, shutdown) | the power page offers **Exit full screen** and **Switch profile** only; no quit / OS power |
| `updater` | none: the server serves the version that matches it |
| `remote` (input injected by the main process) | synthetic events: keys go to `NavigationService` / the keymap as if pressed (the on-screen keyboards read `keydown`: dispatch on `document.activeElement`), the pointer to `PointerService` (hover = focus, click = select); the drawn pointer as today. Text fields keep working (`field` messages). The device says `capabilities.remote: 'synthetic'` so the dashboard knows; decision F |
| `cast` receiver (`app/cast/`) | works: it's the events socket, which the cookie authenticates |

`desktop.ts` grows a `web` implementation of the same interface, so call sites check `bridge.power` etc. as they do today, without `if (web)` spread across components.

### 5.4 Browser specifics

- **Codecs.** The device reports what it actually plays (`MediaSource.isTypeSupported`, `canPlayType`, in `PUT /devices/me` `capabilities`), and the play pipeline already decides direct play vs remux / transcode from that. Chrome and Edge are like Electron. Firefox has no HEVC (more transcodes). Safari plays HLS natively (`hls.js` only where MSE is needed) and not Matroska. The 2-transcode limit (`streaming.*`) matters more with several browsers; the dashboard's Activity already shows why a session transcodes.
- **YouTube** (trailers, the YouTube plugin's `embed` sources): YouTube's IFrame player accepts an `http://` origin, unlike `file://`, so embeds may play in the page directly. The server's `/embed/youtube` frame stays the default until that's verified (decision G).
- **Keys.** Back = Escape **and** Backspace (outside text fields); the browser keeps F5 / F11 / Ctrl+W. Media keys arrive through `navigator.mediaSession` handlers (play / pause / seek / next track) besides `keydown`. Nothing may need a key the browser reserves.
- **Full screen.** Browsers want a user gesture: the first key or click after load offers it once ("Press Enter for full screen", dismissible, remembered per device), and the power page has the button. Leaving full screen is a resize: §3.4 covers it.
- **Autoplay.** Sound needs a gesture too: playback always starts from Enter / a click, so the player is fine. The splash video plays muted.
- **Cursor.** The custom cursor and its hiding on key press (`PointerService`) stay as they are.
- **Reload.** A refresh comes back where it was (built 2026-11-15, `apps/tv/src/app/session-restore.ts`): the profile, the history (Back still works), the focused item and the rows' positions, kept in `sessionStorage` (`playpex.session`: this tab only, gone when it closes, so a new tab or the next start shows "Who's watching?"; tied to the server's id). A locked profile comes back only when the server says this device opened it in the last 12 h (`POST /profiles/{id}/resume`, else `403` → the picker). Restored: sections, detail screens and the player (`ScreenDef.restore`); not roots, system or other full-screen screens. The player plays on from where it was (its entry's state `reloadAt`, written as the page goes through `onSessionSave`), muted until a key when the browser wants a gesture. Search asks its query again (its entry's state `search`) and goes back to the card it was on. Plugin screens: the profile's plugins are asked for at boot when the stack holds one, so their routes exist before the first navigation. The root of the history stays the root whatever its kind (a menu entry may open a plugin's detail screen, e.g. Velvet's last view). An entry's state keeps only small plain-data keys (no functions, class instances, over 16 KB): a plugin page's loaded models are built again, its choices (search, filters) are kept apart as `pluginChoices`, and a catalog / release list shown again waits for its rows to go back to the card it was on; an entry opened with a payload that isn't plain data isn't brought back. The profile comes back first (`POST /profiles/{id}/resume`, tried again with more time when the server is slow), so a reload doesn't end on the picker unless the server refuses it; the history only when the page reloads at the saved top's URL or the app's start (another address typed in the tab: the profile only); no splash then. Each decision is logged (`[restore] …` in the console, `sessionStorage['playpex.session.restore']`).
- **The browser's Back** (its arrow, Alt+Left, a mouse's back button) is the app's Back (`web/browser-back.ts`, like YouTube's TV app in a browser): the navigator replaces the tab's history entry on every screen, so the app keeps two entries, a base one and a spare one above it; Back lands on the base entry (or any older entry of the app a tab holds, from before a reload or another build: every `popstate` is a Back, since the spare entry pushed again after each one leaves no Forward), a `popstate` listener installed in `main.ts` before Angular (first in line, so the router never sees it) puts the spare entry back and dispatches Back (a panel, an in-page step, the previous screen). At the bottom of the app's history it leaves the app, as pages do. A reload happens on the spare entry: nothing is added.
- **Install as an app** (optional, step 6): a web manifest + icons, `display: fullscreen`, so Chrome / Edge offer "Install Playpex TV" (its own window, no browser chrome). Plain HTTP on a LAN address isn't a secure context, so service workers and installation only work on `localhost` or over HTTPS (§8).

---

## 6. Steps

1. **Rows realign after a resize** (§3.4). Movement specs for a resized `transform` row and a resized `scroll` stack; screenshots before / after a window resize at 1440 → 1920 → 1280. Fixes Electron today.
2. **The frame** (§3.1, §4): `--px-frame-*` tokens, the root size from the frame, the audit of fixed / full-viewport elements, the `check:ui` rule. Screenshots at frame 0 and 5 % (every screen + the player): nothing focusable or readable outside it.
3. **Calibration** (§3.2): `display.frame` in the protocol's registry (+ migration from `display.safeArea`), boot cache (`client.json` / `localStorage`), "Screen area" with x / y and the shape, Electron's aspect lock (if D).
4. **Too small** (§3.3): `px-frame-guard`, the portrait hint, Electron's minimum window size.
5. **Served by the server** (§5.1, §5.3): the `web` build configuration, `/tv/` routes in `api.js`, `webConnection()`, `desktop.ts`'s web implementation (display, power, connection), the dashboard's Devices page links to "Open Playpex TV in a browser". Loopback only at this step (no pairing yet).
6. **Pairing with a cookie** (§5.2): `openapi.yaml` (`cookie: true`, the cookie security scheme, logout), `identify()`, CSRF header check, "Pair this browser" in `/connect`, `docs/api/auth.md`. Server tests: cookie device, admin + device cookies together, cross-site POST refused, revoke.
7. **Browser specifics** (§5.4): codec report, keys, `mediaSession`, the full-screen offer, playback tried on Chrome, Firefox, Safari (direct, remux, transcode, HLS, live).
8. **Remote control for web devices** (§5.3): synthetic input target, `capabilities.remote`, the TV scenario `remote.js` run against the web build.
9. **Optional**: web manifest / install, YouTube embeds in the page (G), the website's download page mentions the web version.

Steps 1–4 stand on their own (Electron benefits) and can ship before the web client. 5–6 make a usable LAN web client (Chrome). 7–8 make it complete.

---

## 7. Verification

- Movement specs (step 1); `npm run check:ui` with the new rule (step 2).
- `npm run screens -w apps/tv` at frame 0 / 5 % / `16:9` lock on a 21:9 window, compared with the baseline by eye; the dev gallery by pixels.
- Resize scenario (Electron, `apps/tv/scripts/scenarios/`): a row scrolled to its 10th poster, the window resized three times, the focused poster still fully visible and aligned; the overlay appearing at 1079 × 607 and gone at 1081 × 609; the portrait hint.
- Server tests for the cookie auth (step 6) and the `/tv/` routes (the dashboard's fallback untouched); the contract test.
- Browsers (step 7): Chrome / Edge / Firefox on Linux and Windows, Safari on macOS if available; a second machine on the LAN for pairing. Torrent playback tried on small torrents only (~100 MB).
- Remote control and casting to a web device (step 8).

---

## 8. Later (not in this plan)

- **Outside the LAN**: HTTPS (the server's own certificate, or a reverse proxy the admin runs), `Secure` cookies, an origin allow list, rate limits on pairing. Same legal framing as the rest of the project (educational, torrent streaming may be illegal where you live).
- A smart TV's own browser (Tizen / webOS browsers, consoles) as a target: they're the same page, but their key codes and codec reports need their own pass.
- Several frames per device (a different one for full screen and windowed).

---

## 9. Decisions

- **A. Frame calibration**: one value (today) / **x and y separately + a shape lock** / four edges separately.
- **B. Root size from the frame**: **yes, the UI shrinks to fit what's visible** (changes Electron for anyone with screen edges set) / no, keep sizing from the window.
- **C. Too-small rule**: **overlay exactly where the floor would cut content (~1080 × 608 CSS px), portrait = a hint only** / a fixed minimum size / no overlay (shrink below 12px instead).
- **D. Electron window lock**: **lock the window to the shape when it isn't full screen** / the shape only affects the frame. (Built: `display:shape` → `BrowserWindow.setAspectRatio`.)
- **E. Web URL**: **`/tv/` on the server** / its own port / the dashboard's root with the dashboard moved.
- **F. Remote control of web devices**: **synthetic input in the page** / not offered for web devices.
- **G. YouTube embeds on the web**: **keep the server's `/embed/youtube` frame first, try the IFrame player in the page after** / in the page from the start.
- **H. Auth for browsers**: **an httpOnly device cookie (`SameSite=Strict`, CSRF header)** / a Bearer token in `localStorage` + `?access_token=` for media (readable by any script on the page, tokens in URLs).

---

## 10. Files you will touch (summary)

- TV: `src/styles.scss`, `src/styles/_tokens.scss`, `app/ui/display.ts`, `app/screen-edges/` (→ "Screen area"), `app/display-setup/`, `app/settings-page/`, `app/movement/motion.ts`, `px-container.ts`, `position-store.service.ts`, `app/ui/layouts/px-shell.*`, new `app/ui/frame-guard/`, the stylesheets of §4's audit, `app/server-config.ts`, `app/desktop.ts` (+ a web implementation), `app/connect-page/`, `app/power-page/`, `app/remote/`, `angular.json` (`web` configuration), `src/environments/`, `scripts/check-ui.js`, `electron/main.js` (min size, aspect lock), `electron/clientConfig.js` (`frame`).
- Server: `lib/api.js` (`/tv/`), `lib/auth/index.js` + `http.js` (the device cookie, CSRF), `lib/middleware.js`.
- Protocol: `settings.js` / `settings.d.ts` (`display.frame`), `openapi.yaml` (cookie scheme, `cookie: true`, logout), `types/api.d.ts`.
- Docs: `docs/api/auth.md` (browsers), `docs/ui-system-plan.md` §13.1 (points here), `apps/tv/src/app/CLAUDE.md` (the frame), root `CLAUDE.md`.
