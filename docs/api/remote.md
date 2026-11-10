# Control from the server

The server's admin can act on what a client plays and, on clients that allow it, drive the client's screen from the dashboard. Both are optional for a client: one that does neither still works; the dashboard just disables those controls for it. Design and reasons: `docs/remote-control-plan.md`.

## Playback commands

The admin's Activity page has Pause / Resume, −10 s / +10 s, a seek bar and Stop on every session. To take them:

1. **Open the [events socket](events.md) with `?control=playback`** (a client without a device token also says `?device=<id>`, the same id as its `X-Playpex-Device`). The server then sends this socket **`session.command`** events, and only this device's sockets get them:
   ```json
   { "topic": "session.command", "time": "…",
     "data": { "sessionId": "9f2c…", "infoHash": "…" | null, "ref": "f_…" | null,
               "action": "pause" | "resume" | "toggle" | "seek" | "seekBy" | "stop",
               "positionS": 30, "deltaS": -10, "by": "admin" } }
   ```
   `positionS` comes with `seek`, `deltaS` with `seekBy`.
2. **Know your session.** Every keepalive answers `{ ok: true, sessionId }` ([playback](playback.md#leases-keepalive-and-releasing)): send the first one as soon as the player has its file, and keep the id. A command is yours when its `sessionId` is yours (before your first answer: when its `ref` or `infoHash` is what you play). Ignore the others: a late command can arrive for a player you already closed.
3. **Act, then report at once.** Pause, play or seek the way your own controls do, then send a keepalive straight away (not at the next minute), so the admin sees the change within a second. Send one whenever the user pauses, plays or seeks, too.
4. **`stop`**: close the player as if the user pressed Back (releasing the lease as usual), and tell the user it was stopped from the server.
5. **`session.ended` with your `sessionId`**: the admin cut the session (your player didn't answer `stop`, or an older client): close the player too, don't take a new lease.

What the server does on Stop: a device that declared `control=playback` is sent `stop`; if it still holds the lease 5 s later, or never declared it, its streams are closed and its lease released.

The admin's side: `POST /sessions/{id}/commands {action, positionS?, deltaS?}` → `202 {delivered}`, `409 DEVICE_OFFLINE` (no socket of the device is open), `422 UNSUPPORTED` (none declared `control=playback`). `Session.control` (`{online, playback, keyboard, pointer, text}`) says what a session's device can do now.

## Remote input (keyboard, pointer, text)

Volume keys: `key` messages `AudioVolumeUp`, `AudioVolumeDown`, `AudioVolumeMute` (the dashboard's − / + and, in Server Manager, the phone's volume buttons). Playpex TV doesn't inject them: they change its own playback volume (the device setting `player.volume`, 5 % a step; mute for this run), shown for a moment at the top of the screen; the player follows at once. Another target may do the same, or ignore them.

A client whose UI can take injected input (Playpex TV: its Electron shell; not phones yet) can let the admin use it from the dashboard: arrows, OK, Back, media keys, a touchpad pointer and typed text.

Open the WebSocket **`ws://<host>:<port>/api/v1/remote`** as a **target** (your token, or loopback with `?device=<id>`; same Host / Origin checks as the events socket) and say what you take, with your window's size:

```json
{ "type": "hello", "role": "target", "capabilities": { "keyboard": true, "pointer": true, "text": true },
  "screen": { "width": 1440, "height": 810 } }
```

Send `hello` again when the window's size changes. Then, as JSON text frames (`RemoteMessage` in `@playpex/protocol`):

| You get | Do |
|---|---|
| `{type: 'state', connected, controller: {name} \| null, reason?}` | `connected`: an admin is controlling you now: **show it on screen** for as long as it lasts (the person in front of the screen must know). `reason`: `ended`, `taken`, `offline`… |
| `{type: 'key', phase: 'down' \| 'up', key, code?, modifiers?, repeat?}` | press / release that key (DOM `KeyboardEvent.key` names: `ArrowUp`, `Enter`, `Escape`, `MediaPlayPause`, `a`…); `repeat`: a held key's repeats |
| `{type: 'text', text}` | type it into the focused field |
| `{type: 'pointer', phase: 'move', dx, dy}` | move your pointer by that many CSS pixels (clamp it to the window) |
| `{type: 'pointer', phase: 'move', x, y}` | move it to that point (0–1 of the window) |
| `{type: 'pointer', phase: 'down' \| 'up', button}` | `left`, `right`, `middle`, or `back` (your Back) |
| `{type: 'pointer', phase: 'wheel', dx, dy}` | scroll by that much (DOM wheel directions) |

Send `{type: 'cursor', x, y}` (0–1, at most ~30 a second) when your pointer moves, so the dashboard's touchpad shows where it is. Injected input should stay **inside your app**, never the operating system's.

Let the user turn it off on the device (Playpex TV: Settings › Display › Remote control, the device setting `remote.allowed`): then don't open the socket. The server relays only what you declared, drops pointer moves while your socket is behind, keeps one controller per device and stores nothing; the admin sees the targets with `GET /remote/targets`.

The controller side (the dashboard): `?role=controller&device=<id>` with the admin's session; it sends `key`, `text`, `pointer`, `field`, `bye` and gets `state`, `cursor` and `field`. A device token can never be a controller.

### Text fields (optional): the controller's own keyboard

A target with on-screen keyboards says `"field": true` in its `hello` capabilities, and tells the controller when one opens, so a phone's own keyboard can fill it (the dashboard's remote shows a text box and brings the phone's keyboard up):

| You send | When |
|---|---|
| `{type: 'field', open: true, id, value, title?, placeholder?, maxLength?, kind?}` | a text field opens (a new `id` each time), and again when its text changes on your side (keys on your own remote; at most a few times a second). `kind`: `search`, `address` or `text`, for the controller's keyboard |
| `{type: 'field', open: false, id}` | it closes (done, cancelled, gone) |

The server keeps the open field while your socket is open and sends it to a controller that connects later; send it again after a reconnect. You get `{type: 'field', id, value, submit?}`: the field's **whole text** (not keystrokes: autocorrect and swipe typing replace words), for the field open now (the server drops another id's; check it too). Replace your text with it, cut to your length, and don't send it back. `submit`: then do what your Done does. The controller's Cancel is a plain `Escape` key.

### Over WebRTC (optional, the pointer only)

The socket is TCP: on a lossy Wi-Fi one lost packet holds up every move behind it, and the pointer lags in bursts. A target that can take a WebRTC peer connection says `"rtc": true` in its `hello` capabilities; the dashboard then sends the pointer straight to it over two data channels. Keys and text stay on the socket, and the socket stays the fallback: until the channels are open, or if they fail, the pointer comes over it as before.

1. The controller offers: `{type: 'signal', data: {description: {type: 'offer', sdp}}}` reaches you through the server. Make an `RTCPeerConnection` (no ICE servers needed on a LAN), apply the offer, answer with `{type: 'signal', data: {description: {type: 'answer', sdp}}}`. ICE candidates go both ways as `{type: 'signal', data: {candidate}}` (`RTCIceCandidate.toJSON()`; `null` at the end). A new offer replaces the connection; drop it when `state` says `connected: false`. Offer real LAN addresses if you can (Playpex TV turns off Chromium's mDNS host names).
2. The controller opens two channels (`REMOTE.RTC`), JSON messages (`RemoteRtcMessage`):

| Channel | Message | Do |
|---|---|---|
| `moves` (unordered, never resent) | `{t: 'move', s, x, y}` | `x`, `y`: the controller's **running totals** of its moves in CSS px since the connection started, `s` how many moves so far. If `s` is newer than the last you applied, move the pointer by the difference from those totals; ignore older ones (late packets). A lost message costs nothing: the next carries the sum |
| `input` (ordered, reliable) | `{t: 'pointer', s, x, y, phase: 'down' \| 'up', button}`, `{t: 'pointer', s, x, y, phase: 'wheel', dx, dy}` | first catch up with the totals as above (so a click lands where the pointer is), then the button or wheel |
| `moves`, from you | `{t: 'cursor', x, y}` | instead of the socket's `cursor` while the channel is open |

The server only relays `signal` (shape-checked, to an `rtc` target and its controller) and never sees the channels' messages: check them yourself as you would the socket's.
