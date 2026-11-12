# Casting plan

Status: **steps 1–2 built 2026-11-09** (decisions A–F taken as recommended): the protocol and the server (`lib/cast`, `/cast/*`, `apps/server/test/cast.test.js`), the client guide `docs/api/cast.md`, Playpex TV as a screen (`apps/tv/src/app/cast/`, Settings › Casting, scenario `scripts/scenarios/cast.js`: 30 checks with YouTube), the dashboard's Settings › Casting (`cast.enabled`). **Step 3 partly built 2026-11-10**: the dashboard as a sender (the top bar's cast button: where Play sends, this browser or a screen; a bar of what plays on the screens with pause, ± seconds, stop; the player's "Continue on a screen"; Activity's "cast from", `Session.cast` on `GET /sessions`) and Playpex TV as a sender (the player's "Play on another screen": `cast/cast-sender.service.ts`, the panel `#playerCast`; the scenario's section 8: 42 checks with YouTube). Step 3's Playpex Mobile part built the same day: the top bar's cast button (`features/cast/Cast.tsx`: where Play sends, this phone or a screen; while a screen is chosen every Play's session is handed to it instead of the player, `state/navigation.ts` `setCastHandoff`), the mini player over the tabs and its remote (± 10 / 30 s, play / pause, Stop, Continue on phone), the player's "Play on a screen" (the file it reads, at its position); `core/cast/caster.ts` with its tests; the events socket asks for `cast`. Not tried on a phone yet. **Step 4 built 2026-11-10**: no `POST /cast/links`; the link reader learnt YouTube instead (`lib/links/inspect.js` `youtubeOf`: watch, youtu.be, shorts, live, embed, `t=`; a `youtube` LinkItem with `embed`, `startS`, its oEmbed title, `image`, `author`; not fetched as a page), so `POST /links/inspect` serves Share to Playpex, the dashboard's Search (a "Play on a screen" button) and the TV's Search (plays it in its embed player) alike. Playpex Mobile: an Android share target (`app.json` intent filter ACTION_SEND `text/plain`; `modules/playpex-device` `takeSharedText()` / event `share` from `OnNewIntent`), `state/share.tsx` (`ShareReceiver`: kept until a profile is chosen, the link pulled out of the text, then `/share`), `features/share/ShareScreen.tsx` (what was found, where: the screens that take it, this phone unless it's a YouTube video, Play), tests `core/services/__tests__/share.test.ts`; Search's YouTube results open the same screen. Not tried on a phone yet. **Step 0 passed 2026-11-10**: a `yt-cast-receiver` 2.1.0 receiver ("Playpex test", DIAL on 28473 bound to the Wi-Fi interface: the machine's Docker bridges would be advertised otherwise) showed in YouTube's Cast list (in a laptop's browser: the sender was "Desktop"); connecting, play (video id + position, from a signed-in app), pause, resume and seek all arrived; TV codes were issued (linking by code not tried; volume not sent). Its default data store (node-persist) warned on its first write: the real receiver gives it its own `DataStore`. **Step 5 built 2026-11-10**: `apps/server/lib/cast/youtube.js` (`yt-cast-receiver` 2.1.0 pinned, loaded with `import()`): one receiver per screen whose events socket takes `embed` casts (≤ 8, DIAL from 28473, the LAN interfaces only), named "Playpex - <screen>" (an ASCII hyphen: the YouTube app left out a name with an en dash), its identity in `<config>/youtube-cast.json`, kept 60 s after its screen leaves; its player turns YouTube's play into a cast (`lib/cast` `play(…, as)` with sender "YouTube · <account>", the embed, the oEmbed title, `tracking: none`, the screen's own profile), pause / resume / seek / stop into cast commands (`command(…, as)`), a play of the video already cast into a seek and a stop held 1.5 s (YouTube's far seeks are stop + play), the volume into the screen's `player.volume`, the screen's reports into the position and duration the phone shows, a video's end into Up next; announced every 30 s (the library announces once). Server setting `cast.youtube` (off by default; Settings › Casting on the dashboard, with the receivers and their phones: `GET /cast/youtube`), `GET /cast/youtube/code` (the screen's TV code: Playpex TV › Settings › Casting › Link with TV code). Tests `apps/server/test/cast.youtube.test.js` (the player driven directly, no YouTube); the TV's scenario `cast-wait.js` keeps a muted TV open as a screen for trying by hand. Tried from YouTube in a browser on a laptop on the same network (the sender "Desktop"): found, cast, title, pause, resume, seek. **Limit**: the YouTube Android app offers casting (and linking by TV code) only while the phone is a Wi-Fi client: a phone sharing its hotspot (on mobile data) gets "connect to the same Wi-Fi network as your TV", so the app on that phone was never tried; Share to Playpex works there. A relay was tested the same day (a throwaway DIAL announcer in Server Manager on the hotspot phone, answering searches on its hotspot, loopback and mobile-data interfaces with the laptop receiver's description; it answered a test search from the laptop): the YouTube app sent **no search at all** with its Cast list open, so no receiver on or near such a phone can reach that list; the relay was removed. Instead, Share to Playpex got quicker (2026-11-10): the device setting `cast.shareTo` (Playpex Mobile › Settings › Casting › Send shared links to: a screen, or ask) plays a shared link on that screen at once, and Android's Share sheet lists a direct share target per screen that's on (sharing shortcuts `screen:<deviceId>`, `plugins/with-share-targets.js`, `setShareTargets` in `modules/playpex-device`); the sheet asks when that screen is off or takes nothing the link holds. Next: step 6 (Playpex Mobile as a screen), step 7.

What changed from the plan while building: a sender drives a cast with `POST /cast/{castId}/commands` (through the screen's session, else straight to the screen as `session.command` with `castId`), `GET /cast/{castId}`; a screen without a session reports with `POST /cast/{castId}/state`; `CastPlayEvent.adults` (the screen refuses it while a kids profile is picked); a device may cast as a locked profile for 12 h after it opened it with its PIN; the player says "Cast from <sender> · <profile>" above the title instead of a toast.

Goal: Playpex as a LAN player you cast to.

1. **Playpex casting**: from a phone (Playpex Mobile), the dashboard or another screen, start a film, an episode, a library file, a plugin's stream or a YouTube video on **any Playpex screen** (Playpex TV, Playpex Mobile, later the dashboard's player), then drive it from where you cast it. Hand playback over mid-play ("Continue on TV").
2. **Casting from other apps**: the **YouTube app's own Cast button** lists Playpex screens; and any app's **Share** sheet sends a link to Playpex, which plays it on a screen.

Not goals: being a Google Cast (Chromecast) receiver (it needs Google's certification: senders check the device); AirPlay receiving; mirroring a phone's screen. Pushing to devices that don't run Playpex (DLNA renderers, Chromecasts) is §7, later.

---

## 1. What exists (checked 2026-11-09)

| Piece | Where | What casting reuses |
|---|---|---|
| Events addressed to one device | `apps/server/lib/events.js` `publishTo(deviceId, topic, data)`; `?control=playback` on the upgrade; `online` | the `cast.play` event goes the same way, with a new control word `cast` |
| Playback commands | `POST /sessions/{id}/commands` (pause, resume, toggle, seek, seekBy, stop), `session.command`; the player sends a keepalive at once (`docs/api/remote.md`) | driving a cast player: unchanged, opened to the caster (§4.4) |
| Remote keyboard / pointer | `/api/v1/remote`, `apps/server/lib/remote` | the phone drives the TV's UI after a cast (optional) |
| Device-wide refs | `/media/{ref}`: library files, torrents' files; a plugin's proxied sources `r_…` (`lib/plugins/remote.js`), `h_…` / `l_…` (`lib/media/hls.js`): **kept server-wide** (an HMAC of the plugin and the source, not of the device), 1 h after last use, lost on restart | a ref the phone resolved plays on the screen as it is |
| Embedded YouTube | `embed` sources (provider `youtube`, plugin API 1.3), the server's page `GET /embed/youtube?v=&start=` (`lib/routes/embed.js`), the TV's `player-page/embed.ts` | a cast YouTube video plays there; nothing new in the player |
| Links read by the server | `POST /admin/links/inspect` (`lib/links/inspect.js`): a page's videos, playlists, magnets | Share to Playpex reads links the same way (§5) |
| DLNA media server | `lib/dlna/` (SSDP, its own HTTP) | the SSDP code is a model for §6 and §7 |

What's missing: nothing **starts** playback on another device; session commands are the admin's only; no screen announces itself as a cast target to other apps.

---

## 2. The model

A **screen** is a device that plays (Playpex TV; Playpex Mobile; the dashboard's player later). A **sender** is whoever casts: Playpex Mobile, the dashboard, another screen, or the server itself on behalf of another app (the YouTube receiver, §6).

Casting never moves video through the sender. The sender sends the screen, through the server, **what to play** (a `CastRequest`, §3) and the screen plays it from the server like its own Play. After that the screen's playback is an ordinary session: resume points, history, Up next and `tracking: 'none'` work as they do today, for the profile it plays as.

```
 Phone (sender)                 Server                              TV (screen)
  │ GET /cast/screens ─────────► online devices with control=cast
  │ POST /cast/screens/{id}/play {CastRequest} ─► checks (§4.4) ── cast.play ──► opens its player
  │ ◄── 202 {castId}                                   ◄── keepalive {sessionId, castId} ──┤
  │ ◄── events: cast.updated {castId, sessionId, state, positionS, title}
  │ POST /sessions/{sessionId}/commands {pause|seek|stop} ── session.command ──►
```

---

## 3. What a cast carries

`CastRequest` (protocol, `openapi.yaml`):

```jsonc
{
  "profileId": "…",            // who watches (§4.4); default: the sender's current profile
  "title": "…", "subtitle": "…", "artwork": "https://…",   // what the screen shows while it opens
  "item": {                    // what it is, for resume / history (as PlaybackRequest has it)
    "kind": "movie" | "episode" | "file" | "plugin",
    "tmdbId": 0, "imdbId": "tt…", "season": 1, "episode": 2
  },
  "source":                    // one of:
    { "ref": "f_…" | "t_…" | "r_…" | "h_…" | "l_…" }            // a media ref, as /play/sources answers
  | { "magnet": "magnet:?…", "fileHint": "…" }                   // a torrent: the screen adds it itself (its lease)
  | { "embed": { "provider": "youtube", "id": "…" } }            // a YouTube video
  | { "resolve": "sources" },                                    // let the screen run POST /play/sources itself (§8 D)
  "positionS": 0,
  "audio": "eng", "subtitle": { "provider": "…", "id": "…" } | null,
  "tracking": "none"           // forced when the source came from an adults plugin
}
```

Rules:
- The **sender resolves** what to play (its own source picker, its plugin `play` effect), the screen doesn't ask again. Refs are device-wide (§1), so this works; a ref that expired answers `NOT_FOUND`, which the screen reports as `cast.failed` (the sender can resolve again).
- A plugin's direct link (a `call`) is resolved by the sender first: the `play` effect's sources are what's cast. For a cast, the TV's `PluginClientService` doesn't play the effect locally: it sends it (§4.2).
- `embed` sources are cast as they are; the screen frames `/embed/youtube` as for the YouTube plugin.

---

## 4. Playpex casting (sender ⇄ server ⇄ screen)

### 4.1 Server

- **Screens**: `GET /cast/screens` → `[{ deviceId, name, kind: 'tv'|'mobile'|…, online, playing: { castId?, sessionId?, title, state, positionS }?, accepts: { media, magnet, embed } }]`. A device is a screen while one of its events sockets is open with `?control=cast`; what it accepts comes on the same upgrade (`?control=playback,cast&accepts=media,magnet,embed`).
- **Cast**: `POST /cast/screens/{deviceId}/play {CastRequest}` → checks (§4.4) → `publishTo(deviceId, 'cast.play', { castId, from: { deviceId, name }, request })` → `202 { castId, delivered }`; `409 DEVICE_OFFLINE`, `422 UNSUPPORTED` (the screen doesn't accept that kind of source), `403 CAST_REFUSED` (§4.4).
- **State**: the screen's keepalive gains `castId`; the server publishes `cast.updated { castId, deviceId, sessionId, state: 'opening'|'playing'|'paused'|'buffering'|'ended'|'failed', positionS, durationS, title, error? }` to the **sender** (`publishTo` its device) and to the admin's sockets. `cast.ended` when the session ends.
- **In memory** (`lib/cast/`): the casts in flight (castId → sender, screen, sessionId), forgotten 1 h after they end. Nothing in the DB: what was watched is already the session's history.
- **Tray / dashboard**: the dashboard's Activity shows "cast from <sender>" on a session; the dashboard can cast too (a "Play on…" menu next to its player's Play).

### 4.2 Playpex TV (screen and sender)

- Opens its events socket with `control=playback,cast` when Settings › Casting › "Let devices cast to this screen" is on (device setting `cast.allowed`, default on, beside `remote.allowed`).
- On `cast.play`: a toast "Casting from <sender>" and the player opens with the request (`PlaybackService.play`, the same `PlaybackRequest` it builds for itself: a `source` ref, a magnet, an `embed`), at `positionS`, as the request's profile. When no profile is picked yet (the TV on "Who's watching?") it takes the request's profile (§8 C). When it is already playing, the new cast replaces it (the old session stops).
- As a **sender**: "Play on…" in the source picker and the player's menu, listing the screens (`GET /cast/screens`, minus itself). "Continue on <screen>" in the player = cast at the current position, then close its own player.

### 4.3 Playpex Mobile (sender first, screen later)

- **A cast button** in the top bar (like YouTube's): the screens, the one it casts to remembered for the session. While a screen is chosen, every Play sends a `CastRequest` instead of opening the phone's player.
- **A mini player** while a cast runs (`cast.updated`): title, play / pause, a seek bar, stop; tap → a full remote (the same controls, ± 10 s, audio / subtitles, "Continue on phone", the remote keyboard / pointer from `/api/v1/remote`).
- **Continue on phone**: stop the cast's session, open the phone's player at its position.
- As a **screen** (later step): its events socket with `control=cast` while the app is in front.

### 4.4 Who may cast what (the server checks)

- A sender is a **paired device or the admin**. Loopback clients count as paired with their `X-Playpex-Device`.
- The screen must allow it (`cast.allowed`), and the admin may turn casting off server-wide (Settings › Casting, `cast.enabled`, default on).
- **Profile**: the request's profile must be one the sender may use: the sender's current profile, or any profile without a PIN; a PIN-locked profile only from the admin, or with its PIN (`pin` in the request, checked like `/profiles/{id}/unlock`).
- **Kids profiles**: an `adults` plugin's source can't be cast as a kids profile, nor to a screen whose current profile is a kids profile (§8 E). The server knows which plugin a ref belongs to (`r_` / `h_` / `l_` entries keep `pluginId`).
- **Tracking**: an adults plugin's source is always `tracking: 'none'`, whatever the request says.
- **Commands**: today `POST /sessions/{id}/commands` is the admin's only; it also accepts **the sender of that session's cast** (the castId's sender device), and the session's own device.

---

## 5. Share to Playpex (any app → a screen)

1. Playpex Mobile registers as an Android **share target** for `text/plain` links (an intent filter in its Expo config; iOS later: a Share extension).
2. Shared text → `POST /cast/links { url }` (the reader of `lib/links/inspect.js`, opened to paired devices for this use) → what it found: a **YouTube** link (watch, youtu.be, shorts, a playlist's first video; `t=` as the position) → an `embed` source; a page's video / HLS / magnet → a ref or a magnet, as the dashboard's Search does today.
3. A small sheet: what was found ("YouTube · <title>"), the screens, Play. Casting is §4.
4. Nothing found: "Playpex can't play this link".

YouTube links don't need the YouTube plugin: the `embed` page is the core's (`/embed/youtube`); the plugin is only for browsing YouTube (§8 F).

---

## 6. The YouTube app's Cast button (a YouTube receiver)

YouTube's apps find two kinds of device: Google Cast (not possible, see Goals) and "YouTube on TV" devices, found by **DIAL** (SSDP on the LAN) or paired with **"Link with TV code"**, then driven over YouTube's **Lounge** protocol. [`yt-cast-receiver`](https://github.com/patrickkfkan/yt-cast-receiver) (npm, MIT, 2.1.0, updated 2025-10; Volumio's YouTube Cast plugin) implements the receiver side in Node: it announces itself, pairs, and hands us a **player** to implement (play a video id at a position, pause, resume, seek, stop, volume, the queue's next / previous; we report state, position, duration, volume).

In Playpex:

- **The server runs the receivers** (`lib/cast/youtube.js`): one per screen that allows casting and is online, named "Playpex – <screen name>", started when the screen connects and stopped when it leaves (or one receiver for the server with a chosen default screen, §8 B). They can't live in the YouTube plugin: receivers need sockets (SSDP over UDP, HTTP for DIAL, long polls to YouTube), and plugins run in the QuickJS sandbox, which has none.
- **Its player is a cast**: `play(videoId, position)` → a `CastRequest` with `{ embed: { provider: 'youtube', id } }` to its screen, sender "YouTube"; pause / resume / seek / stop → that session's commands; the screen's keepalives (and the embed page's 250 ms state) → the receiver's status, so the phone's YouTube app shows the right state and position. The queue lives in the receiver; when a video ends, the receiver asks YouTube for the next one and casts it.
- **Profile**: casts from the YouTube app play as the screen's current profile, else as the profile the admin chose for that screen (Settings › Casting; a screen showing a kids profile is fine: YouTube's own content rules apply, not ours).
- **Admin**: Settings › Casting › "Show Playpex screens in the YouTube app" (off by default: it talks to YouTube's servers), the receivers' state (paired senders, last error), "Forget paired phones". The TV code for "Link with TV code" is shown on the screen when asked (Settings › Casting › "Link with TV code" on the TV).
- **Network**: DIAL needs multicast (SSDP 239.255.255.250:1900) like DLNA, and an HTTP port of its own (`cast.youtubePort`, default 28473); only with LAN sharing.

Risks:
- The Lounge protocol is **unofficial**: YouTube can change it (the library has followed past changes); a breakage must only turn the feature off, with the error on the dashboard, never hurt playback.
- Videos whose owner forbids embedding (errors 101 / 150) don't play in the IFrame player: the screen shows "This video can't be played outside YouTube" and the receiver reports an error, so the phone's app shows it.
- Whether today's YouTube app still lists DIAL devices found on the LAN, or only ones linked by TV code, is to be checked first (step 0).
- YouTube Music casts the same way (the library supports it); music videos only, through the same embed player.

---

## 7. Later: casting to devices without Playpex

- **DLNA renderers** (most smart TVs, consoles, AV receivers): the server as a DLNA *controller* (UPnP AVTransport: `SetAVTransportURI`, `Play`, `Pause`, `Seek`, `GetPositionInfo`), renderers found by SSDP and listed in `GET /cast/screens` with `kind: 'dlna'`. They fetch the stream themselves, without our auth: a short-lived signed URL per cast (`/media/{ref}?cast=<token>`, valid for that ref, that cast and a few hours; a decision for the API's no-token-in-URLs rule). Formats: what the renderer says it plays (its `ProtocolInfo`), else ffmpeg's conversion (`/media/{ref}/playback`). No embed sources.
- **Google Cast (Chromecast) as a target**: the Default Media Receiver plays an HTTP(S) URL; the same signed URLs; MP4 / H.264 / AAC or HLS only (the conversion again). A sender in Playpex Mobile (Google's Cast SDK) or in the server (castv2, unofficial).
- **AirPlay as a target**: later still.

---

## 8. Decisions to take

| | Question | Recommended |
|---|---|---|
| A | Where the YouTube receiver runs | **the server**: it has the sockets, one place serves every screen, and it already knows which screens are online. The alternative, the TV's Electron main process, would only cover that machine's screen and not Playpex Mobile |
| B | One YouTube receiver per screen, or one for the server with a target picker | **one per screen**: the YouTube app's list shows "Playpex – Living room", "Playpex – Bedroom"; at most 8 |
| C | A cast to a screen with no profile chosen ("Who's watching?") | play as the **request's profile** (the sender's), and show it on the screen ("Casting from <sender> · <profile>"); the screen goes back to the picker when the cast ends |
| D | Sender resolves the source, or the screen | **the sender** (it has the chooser and the plugin's answer; refs are device-wide); `resolve: 'sources'` only for the YouTube receiver's future "play this title" and DLNA |
| E | Adults sources cast to a screen showing a kids profile | **refused** (`CAST_REFUSED`), and to any screen when the request's profile is a kids profile |
| F | Share to Playpex for YouTube links without the YouTube plugin | **yes**: the embed page is the core's; the plugin is for browsing |

---

## 9. Steps

0. **Spike (no repo code)**: `yt-cast-receiver` in a script in the scratchpad on the user's LAN, logging what arrives; check that "Playpex test" shows in the YouTube app's Cast list on the user's phone (Android), and pairing by TV code. Decides whether step 5 is worth building.
1. **Protocol**: `CastRequest`, `/cast/screens`, `/cast/screens/{id}/play`, `cast.play` / `cast.updated` / `cast.ended`, errors `CAST_REFUSED` (`openapi.yaml`, the client guide `docs/api/cast.md`); the server's `lib/cast/` and the checks (§4.4); commands opened to the sender. Tests: `apps/server/test/cast.test.js` (delivery to one device, offline, unsupported, profiles and PINs, adults to kids refused, the sender's commands, state relayed).
2. **Playpex TV as a screen**: `control=cast`, the `cast.play` listener, the toast, replacing what plays, the keepalive's `castId`, Settings › Casting; a scenario (`scripts/scenarios/cast.js`: cast a library file, an `h_` stream, a YouTube embed; pause / seek / stop from "the phone"; replace a cast).
3. **Senders**: Playpex Mobile's cast button, mini player, remote, Continue on phone; the TV's "Play on…" / "Continue on <screen>"; the dashboard's "Play on…" and Activity's "cast from". Needs the mobile app tried on a phone first.
4. **Share to Playpex**: the share target, `POST /cast/links`, the sheet.
5. **YouTube receiver** (if step 0 passed): `lib/cast/youtube.js`, Settings › Casting on the dashboard, "Link with TV code" on the TV, the queue; a test with the library's player driven directly (no YouTube in tests).
6. **Playpex Mobile as a screen.**
7. Later (§7): DLNA renderers, then Chromecast as targets, with signed URLs.

Docs to update as steps land: `CLAUDE.md` (a Casting line beside Remote control), `docs/api/README.md`, `apps/server/CLAUDE.md`, `apps/tv/src/app/CLAUDE.md`, `apps/mobile/CLAUDE.md`.
