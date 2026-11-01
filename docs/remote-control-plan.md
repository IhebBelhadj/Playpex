# Remote control plan

Status: **steps 1–7 built 2026-10-31** (step 8, the screen preview and mobile as a keyboard target, left for later). Decisions A–E taken as recommended. Verified: `apps/server/test/remote.test.js` (5: commands to one device, UNSUPPORTED / DEVICE_OFFLINE, Stop asking then cutting, the relay with shapes / take-over / refusals / cursor, against `openapi.yaml`), the contract test, the TV scenario `apps/tv/scripts/scenarios/remote.js` (31 checks on a real Playpex TV with a throwaway server: the badge, keys, the pointer hovering and clicking a setting, text into the search keyboard, pause / seek / resume / seekBy / stop from `POST /sessions/{id}/commands` with the session following within a second, the setting off and on), the dashboard's Remote control page and Activity buttons in a browser against a stand-in target (keys, text, a touch drag, clicks, the cursor dot), Playpex Mobile's unit tests (56, two new: commands for its own session only, stop / session.ended). Not done: the phone app tried on a phone, the touchpad's tuning tried on a real phone, the dashboard's Remote control page driving a real TV by hand (the scenario plays the dashboard's part through the same socket). Revised the same day after a first try: no text field on the dashboard (the TV's own keyboard, or keys while the mouse is captured); phones get the touchpad filling the screen with Click / Back under it and big arrows behind a switch; on a desktop a click on the pad captures the mouse (pointer lock: it can't leave the pad, its moves scaled by the TV's width over this screen's) and the keys until Esc. Revised 2026-11-01 after measuring a phone on its own hotspot: the TV injects pointer moves once a frame outside Angular's zone (the overlay draws the pointer by hand), and **the pointer goes over WebRTC** when the target says `rtc` (`signal` relayed by the server; channels `moves`: unordered, never resent, running totals; `input`: reliable, buttons / wheel with the totals; the cursor back on `moves`; the socket stays the fallback; `docs/api/remote.md` "Over WebRTC"; the dashboard says "Direct" while it's in use).

What differs from the text below: the TV's **renderer** holds the remote socket (`apps/tv/src/app/remote/remote-control.service.ts`, the shell adds the device's headers like to any request) and hands each input to the main process over IPC (`window.playpex.remote.input` → `apps/tv/electron/remote.js` → `sendInputEvent`), instead of the main process opening the socket itself: the main process has no auth of its own for WebSockets, and the renderer draws the cursor anyway. Text is sent as key presses (keyDown + char + keyUp per character: the on-screen keyboards read `keydown`). `MediaFastForward` / `MediaRewind` have no Chromium key code: the renderer sends them to `MediaKeys` itself. The keepalive's answer now carries `sessionId`, so a player knows its own session (`session.ended` is matched by it). The dashboard's page is `/remote` (the targets) and `/remote/:deviceId` (the controller); the setting sits in Settings › Display.

Two things, one channel:

1. **Playback control from the server works**: the admin pauses, resumes, seeks or stops what a client plays (the dashboard's Activity), and the client obeys at once.
2. **Remote control**: from the dashboard, the admin drives a client's UI with a **remote keyboard** (every client that can take keys) and a **remote mouse** (Playpex TV only, for now), like a phone remote or a laptop touchpad.

Both are messages the server sends **to one device**, which the server can't do today.

---

## 1. Why pausing from the server doesn't work today

What exists (checked 2026-10-31):

| Piece | What it does | The gap |
|---|---|---|
| Dashboard Activity (`apps/dashboard/src/pages/activity.tsx`) | one action, **Stop** (`DELETE /sessions/{id}`); the "Paused / Playing" badge only *shows* the last keepalive | no Pause / Resume / Seek at all |
| `sessions.stopSession` (`apps/server/lib/sessions.js`) | destroys the lease's open HTTP streams, releases the lease, publishes `session.ended` | the client is never told *to stop*: it only loses a stream |
| TV player (`player-page.component.ts`) | plays from `<video>`'s buffer, then sends a new `Range` request when it needs more, which takes a **new lease** | it never listens to `session.ended`: after a Stop it keeps playing the buffer, then carries on as a new session |
| Events socket (`apps/server/lib/events.js`) | broadcasts topics to every client; *"Messages you send are ignored"* | no way to address **one** device; local clients (the TV on the server machine) have no `deviceId` on their socket |
| Keepalive | every 60 s, carries `paused` / `positionS` | the dashboard's badge can be up to a minute late |
| Mobile (`apps/mobile/src/core/events/serverEvents.ts`) | subscribes to `session.ended`, but only to invalidate queries | its player doesn't leave either |

So the fix isn't a one-liner in the player: the server needs **commands addressed to a device** and the clients need to **act on them and report back at once**. That channel is also what the remote control runs on, so this is step 1 of the same plan.

---

## 2. Design

### 2.1 Two kinds of messages, two paths

| | Playback commands | Remote input |
|---|---|---|
| What | `pause`, `resume`, `toggle`, `seek {positionS}`, `seekBy {deltaS}`, `stop` | key down / up / char, pointer move / button / wheel |
| Rate | a few per minute | up to ~60 per second while the pointer moves |
| Who acts | the **renderer**'s player (it owns `<video>`) | the TV's **Electron main process** (`webContents.sendInputEvent`: real, trusted input events) |
| Path | `POST /sessions/{id}/commands` → the server pushes `session.command` on the **events socket** to that device only | a dedicated WebSocket `/api/v1/remote`, server relays controller ⇄ target, nothing stored |
| Answer | `202` when delivered to a connected socket of the device, `409 DEVICE_OFFLINE` when none; the effect shows as a `session.updated` (the player sends a keepalive at once) | `remote.state` messages (connected, target capabilities, cursor position) on the same socket |

Why not one path: playback commands must work for every client (TV, mobile, future ones) with plain HTTP + the events socket they already have; remote input needs low latency, back-pressure and an explicit "someone is controlling you" session, and on the TV it must land in the main process (only it can inject trusted input), which doesn't hold the events socket.

### 2.2 Addressing a device

- `events.js` gets `publishTo(deviceId, topic, data)`: only sockets whose `deviceId` matches. Paired devices: their `devices.id` (already on the socket). **Local** clients: the `?device=` / `X-Playpex-Device` value, accepted on the upgrade for `kind: 'local'` (the TV already sends `?device=`), so a socket's id equals the lease's `deviceId` (`sessions.device(req)`).
- `GET /sessions` and the Devices list gain `online: boolean` (a socket of that device is connected) and `control: { playback, keyboard, pointer }` (what it declared, §2.3), so the dashboard only shows buttons that will work.

### 2.3 Capabilities

A client says what it accepts, so the server never sends what it can't do:

- events socket: `?control=playback` on the upgrade (the TV and mobile players);
- remote socket: its first message, `{ "type": "hello", "role": "target", "capabilities": { "keyboard": true, "pointer": true, "text": true } }`.

Now: Playpex TV = playback + keyboard + pointer + text. Mobile = playback (keyboard later, §5). The dashboard's own player = playback.

### 2.4 Playback commands

```
POST /api/v1/sessions/{id}/commands        (admin)
{ "action": "pause" | "resume" | "toggle" | "seek" | "seekBy" | "stop", "positionS"?: n, "deltaS"?: n }
→ 202 { delivered: true } · 404 NOT_FOUND · 409 DEVICE_OFFLINE · 422 UNSUPPORTED (the device didn't declare playback)

event to that device only:
{ "topic": "session.command", "data": { "sessionId", "infoHash", "ref", "action", "positionS"?, "deltaS"?, "by": "<admin name>" } }
```

- The player acts only when `ref` / `infoHash` match what it plays (a late command for an old session is ignored), then **sends a keepalive at once** so `session.updated` reaches the dashboard in well under a second.
- `stop` = the client leaves the player itself (toast "Stopped from the server"), *then* the server's lease goes the normal way; `DELETE /sessions/{id}` stays as the forceful stop for clients that don't answer (old versions, hung players), and those clients now also **leave on `session.ended` with their own device id and ref** instead of re-leasing.
- Independently of commands: the player sends a keepalive on every `play` / `pause` / `seeked` (debounced 500 ms), so the Activity badge is current.

### 2.5 The remote socket

```
ws://<server>/api/v1/remote
  target:     a device (Bearer token, or loopback + ?device=); one per device
  controller: the admin (dashboard cookie); ?device=<deviceId>
```

Messages (JSON text frames; pointer moves may be batched):

| From → to | `type` | Fields |
|---|---|---|
| target → server | `hello` | `role: 'target'`, `capabilities`, `screen: { width, height }` (the window, in CSS px) |
| controller → server | `hello` | `role: 'controller'`, `device` |
| server → both | `state` | `{ connected, controller: { name }, capabilities, screen }` |
| controller → target | `key` | `{ phase: 'down' \| 'up', key, code, modifiers[], repeat }` (DOM `KeyboardEvent` names) |
| controller → target | `text` | `{ text }` (typed into the focused field: Search, Enter address…) |
| controller → target | `pointer` | `{ phase: 'move', dx, dy }` (touchpad, relative) · `{ phase: 'move', x, y }` (absolute, 0–1 of the screen, from the preview §2.8) · `{ phase: 'down' \| 'up', button: 'left' \| 'right' \| 'back' }` · `{ phase: 'wheel', dx, dy }` |
| target → controller | `cursor` | `{ x, y }` (normalised; at most 30 / s, for the controller's touchpad dot) |
| either | `bye` | ends the remote session |

Server rules (`apps/server/lib/remote/`): **relay only**, nothing persisted, nothing logged per event (only "remote control of <device> started / ended by <admin>" in the log and Activity); one controller per device (a second one takes over, the first gets `state { connected: false, reason: 'taken' }`); the target's socket is checked for `bufferedAmount` and moves are dropped (not queued) while it's behind, keys / buttons never dropped; a controller can only address an online target that declared the capability (else `state { connected: false, reason }`).

### 2.6 Playpex TV: the target

**Main process** (`apps/tv/electron/remote.js`, new):

- Opens `/api/v1/remote` to the current server (through the same `auth.js` header injection; reconnects with back-off like the renderer's events socket), sends `hello` with the window's size, resends it on resize.
- Injects into **its own window only**: `win.webContents.sendInputEvent(...)`: `keyDown` / `keyUp` / `char` for keys and text, `mouseMove` / `mouseDown` / `mouseUp` / `mouseWheel` for the pointer. These are real Chromium input events (trusted, hit-tested), so **nothing in the app changes**: `keymap.ts`, the spatial navigation, `FocusEngine`, `PointerService` (hover = focus, click = select, right click / back button = back, the wheel) all work as with a local keyboard and mouse. Never OS-level input (no robotjs / xdotool): the remote can't leave Playpex TV.
- Key names: DOM `KeyboardEvent.key` → Electron key codes (`ArrowUp` → `Up`, `Enter` → `Return`, `Escape`, `Backspace`, `MediaPlayPause`, letters / digits as is…), one table in `remote.js`; `repeat: true` → the `isAutoRepeat` modifier, so held keys scrub in the player exactly like a held remote button.
- Relative pointer: main keeps the virtual cursor's position (clamped to the window), applies `dx, dy` (with a touchpad-like acceleration curve), and sends `mouseMove` at the new point.
- Tells the renderer (IPC, `window.playpex.remote` in the preload: `onState`, `onCursor`) so it can draw.

**Renderer** (`apps/tv/src/app/remote/`, new):

- A **virtual cursor** layer: `sendInputEvent` doesn't move the OS cursor, so the custom cursor image (`assets/cursor/`) is drawn at the remote position while a remote pointer is active (hidden after 3 s idle, like the real one; `PointerService` keeps owning the hidden / shown classes).
- A small badge, top right, while a controller is connected: "Controlled from <admin> · Back + Back to end" (tokens, `dp()`; `chrome` layer above pages, under dialogs). Always shown: the person in front of the TV must know.
- Settings › Remote control: **Allow remote control from the server** (on / off, device setting through the settings API, `remote.allowed`; default on, see decision B). Off → the main process doesn't open the socket.

**Player** (`player-page.component.ts`): subscribes to `session.command` and `session.ended` (§2.4) and sends keepalives on state changes; seek / pause go through the same methods its keys use, so the on-screen controls react the same way.

### 2.7 Dashboard: the controller

- **Activity** session cards: Pause / Resume, −10 s / +10 s, a seek bar on the position line, Stop (the existing confirm; now asks the player first, §2.4). Disabled with a tooltip when the device is offline or didn't declare playback.
- **Remote control** page `/devices/:id/remote` (entry: the Devices list and each Activity card, when the device is online and declares keyboard / pointer):
  - a **touchpad** surface (pointer events: drag = move, tap = click, two-finger tap / long press = right click (back), two-finger drag = wheel), the target's cursor shown as a dot;
  - a **D-pad** + OK + Back + Home (menu) + Play/Pause, −10 / +10 s, big enough for a phone (the dashboard on a phone is the remote);
  - **keyboard capture**: while the page has focus (a visible "Keyboard on" toggle), `keydown` / `keyup` are forwarded and `preventDefault`ed, except the browser's own shortcuts we can't take;
  - a **Type text** field (sent as `text`, for Search on the TV).
  - Pointer moves coalesced per animation frame (one message per frame at most).
- Works on the same machine too (dashboard and TV both on loopback).

### 2.8 Later: a screen preview

`webContents.capturePage()` in the TV's main process, JPEG at 2–4 fps, sent as binary frames on the remote socket **only while the controller page is open and asks for it**, so the admin can point absolutely (click on the preview → `pointer { x, y }`). Not needed for a first version: the touchpad and the D-pad are enough to drive a 10-foot UI, and the preview costs CPU and bandwidth on the TV.

---

## 3. Security and privacy

- Only the **admin** may send commands or open a controller; devices never control each other (a device token on `/remote` can only be a target, a `POST …/commands` from a device answers `403`).
- Input goes only into the **Playpex TV window** (`sendInputEvent` on its own `webContents`), never the OS.
- The TV shows it's being controlled for as long as it is, and can refuse it (Settings, §2.6). The remote socket is closed when the device is revoked (`dropDevice`) or the setting is turned off.
- The remote can type a profile's PIN like a person at the TV could; the admin already manages profiles and PINs, so this adds no power. Kids profiles: nothing special.
- Origin / Host checks of `/remote` exactly like `/events` (cross-site WebSocket hijacking).
- Nothing typed is logged or stored (no key logging in `playpex-server.log`, debug level included).

---

## 4. Steps

| # | Step | Where | Done when |
|---|---|---|---|
| 1 | **Stop actually stops**: TV + mobile players leave on `session.ended` for their own device + ref; keepalive on play / pause / seek | `player-page.component.ts`, mobile `core/player` | Stop on the dashboard closes the TV's player within a second, no new session appears; the badge flips within a second of pausing on the TV |
| 2 | Device-addressed events: `publishTo`, `deviceId` for local sockets, `?control=`, `online` / `control` on sessions and devices | `lib/events.js`, `lib/sessions.js`, `openapi.yaml`, `docs/api/events.md` | contract test: a `session.command` reaches only its device's sockets, local and paired |
| 3 | **Playback commands**: `POST /sessions/{id}/commands`, the player obeys, Activity's buttons | `lib/api.js`, TV player, mobile player, dashboard Activity | pause / resume / ±10 s / seek / stop from the dashboard on the TV and on the phone; `DEVICE_OFFLINE` when the TV is closed |
| 4 | The remote socket: relay, roles, one controller per device, back-pressure, log lines | `lib/remote/`, `openapi.yaml` (described as a WebSocket like `/events`), `docs/api/remote.md`, `packages/protocol` (message types, `REMOTE_PATH`) | test: controller ⇄ target relay, take-over, refused for devices as controllers, closed on revoke |
| 5 | TV main process: `remote.js` (socket, key table, `sendInputEvent`, relative pointer), preload `window.playpex.remote` | `apps/tv/electron/` | keys and text from a test controller drive menus, Search and the player; held arrows scrub |
| 6 | TV renderer: virtual cursor, "Controlled from" badge, Settings › Remote control | `apps/tv/src/app/remote/`, settings | the pointer hovers / focuses / clicks posters, right click goes back; badge shows / hides; off = no socket |
| 7 | Dashboard Remote control page (touchpad, D-pad, keyboard capture, text) | `apps/dashboard/src/pages/remote.tsx`, Devices, Activity | the whole TV flow (profile → movie → Play → pause → back) from a phone's browser |
| 8 | Later: screen preview + absolute pointing (§2.8); mobile as a keyboard target (D-pad focus in React Native) | | |

Steps 1–3 fix the reported bug and are useful alone; 4–7 are the remote control. Each step leaves the app working.

---

## 5. Decisions to take

| | Question | Recommendation |
|---|---|---|
| A | Pointer: touchpad (relative) first, or a screen preview with absolute clicks? | **Touchpad first** (§2.7); the preview is step 8 |
| B | "Allow remote control" on the TV: on by default, or off until someone turns it on at the TV? | **On by default** for this machine and paired devices (the admin approved the pairing), with the badge always shown; revisit when there are non-admin dashboard users |
| C | Should Stop from the dashboard still cut the streams at once, or only ask the player? | **Ask first, cut after 5 s** if the player hasn't released its lease (old clients, hung players) |
| D | Mobile as a keyboard target | **Later** (React Native has no `sendInputEvent`; it would go through its own focus model). Playback commands on mobile are in step 3 |
| E | Remote control from the tray app | **No**: the tray links to the dashboard's Remote control page |

## 6. Non-goals

- Control of the operating system, other windows or other apps on the TV machine.
- Devices controlling each other (a phone remote *as a paired client* is a separate feature; this plan's protocol leaves room for it: a `remote:control` grant on a device could later let it be a controller).
- Screen sharing / recording beyond the low-fps preview of §2.8.
