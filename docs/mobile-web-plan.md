# Playpex Mobile on the web: plan

Status: **steps 1–6 built 2026-11-16, uncommitted; tried in Chromium only** (a phone-sized window and a 1280 × 800 one,
on loopback and from the LAN address with pairing). Left: §7 (open, to discuss; §7.4 built) and §8 (later). Choosing between Playpex TV and Playpex Mobile by
device (one entry that sends phones to `/m/` and the rest to `/tv/`) is **not part of this plan**, as the user asked: each
client is opened at its own address.

## 1. Goal

The phone app (`apps/mobile`, React Native with Expo) runs in a browser from the same code, served by the server at
`/m/`, the way Playpex TV runs at `/tv/` (`docs/web-client-plan.md` §5). Every screen is the phone's; only what a
browser can't do the phone's way changes, behind the same ports the app already has (`src/core/session/ports.ts`,
`src/core/player/port.ts`): Metro picks `<name>.web.ts(x)` over `<name>.ts(x)` when it bundles for the web, so the
native modules (`modules/expo-mpv`, `modules/playpex-device`, `expo-secure-store`) are never bundled there.

## 2. What differs in a browser

| Area | Phone | Browser (`*.web.ts(x)`) |
| --- | --- | --- |
| The server | the last one, found again by id (mDNS + UDP), or a typed address | the page's own (`location.origin`), nothing else: its device cookie is this origin's (`native/discovery.web.ts`, `native/serverStore.web.ts`) |
| Credentials | a device token in the Keystore, `Authorization: Bearer` | the httpOnly cookie `playpex_device` (`KnownServer.cookie`, `token: null`): fetch, `<video>`, hls.js and the WebSockets carry it; the server's machine needs none (loopback) |
| Pairing | RFC 8628, `client_id` `playpex-mobile`, the token in the answer | the same flow with `client_id` `playpex-web` and `cookie: true` (`PairingMode`), answered `token_type: 'cookie'`; the server names the device after the browser ("Chrome on Linux") |
| Device id | `m-<hex>` in secure storage | `localStorage['playpex.deviceId']`, shared with Playpex TV on the web: one browser, one device |
| Device description | everything mpv decodes | what the browser's `<video>` decodes, asked of it (`web/browser.ts` `browserCapabilities`, as the TV's `web-client.ts`) |
| Player | libmpv, the file as it is | `<video>` + hls.js (`native/mpvPlayer.web.tsx`): a file asks `GET /media/{ref}/playback` (direct, or the server's HLS stream from `start`; a seek outside it or another sound asks again with `t` / `audio`); a plugin's HLS plays as it is |
| Tracks | mpv's track list | the file's streams from `GET /media/{ref}/tracks`; subtitles are WebVTT (`…/subtitles/embedded/{n}`, files, online ones) parsed into cues on one text track, moved by the stream's start and `sub-delay`; `sub-scale` = `::cue` size; a separate sound file can't play beside the video (a message) |
| Who's watching | in memory: the picker at every start | kept for the tab (`sessionStorage['playpex.mobile.profile']`, `native/profileMemory.web.ts`): a reload reopens it with `POST /profiles/{id}/resume` while "Looking for your server…" shows (`ProfileMemory` port of `SessionController`) |
| Morphs | Reanimated shared transitions | none (`state/boundary.web.tsx`: `SharedTransitionBoundary` doesn't render on the web) |
| Fonts | embedded by app.json's expo-font plugin | loaded with the page under the same family names (`state/page.web.ts`) |
| The page | — | no scrollbars, no focus ring on fields, the app's black, no overscroll (`state/page.web.ts`) |
| Back | Android's Back (`useBackPress`) | Escape closes what `useBackPress` closes; the browser's Back is the router's |
| Share to Playpex | Android's Share sheet | nothing (`native/share.web.ts`) |
| Connect / Settings | the network's servers, a typed address, "Change server" | "Your server" (this one, Pair), no address field, no "Change server" / "Choose another server"; Settings › "This browser" |

## 3. Served by the server

`npm run build:mobile-web` (= `npm run build:web -w apps/mobile`: `expo export --platform web --output-dir
../server/public-m`) writes `apps/server/public-m` (git-ignored). `app.json`: `platforms` + `web`, `web.output` `single`
(one `index.html`), `experiments.baseUrl` `/m`. `lib/api.js` serves it as `/tv`: `/m` → 301 `/m/`; files with a 32-hex
content hash (`entry-<hash>.js`, `<name>.<hash>.ttf`) immutable for a year, others an hour; any other GET under `/m/`
without a dot → `index.html` (`no-cache`); 404 text when not built. `PLAYPEX_MOBILE_WEB_DIR` overrides the folder.

## 4. Steps

1. **Spike** (built): `react-native-web`, `react-dom` 19.3.0 (the workspace's React), `@expo/metro-runtime` with
   `npx expo install`; `expo export --platform web` bundles the whole app as it is.
2. **Ports** (built): `discovery.web.ts`, `serverStore.web.ts`, `share.web.ts`, `profileMemory(.web).ts`; `PairingMode`,
   `KnownServer.cookie`, `isPaired()` in the core; `web/browser.ts`.
3. **Player** (built): `mpvPlayer.web.tsx` (`hls.js` 1.7.3, as the TV and the dashboard).
4. **Served at `/m/`** (built): §3.
5. **What broke in a browser** (built): `SharedTransitionBoundary` (React error 130), `animationName` inside
   `StyleSheet.create` (react-native-web refuses it: `ui/loading.tsx` keeps the sweep a plain object), fonts,
   `BackHandler`.
6. **Browser wording** (built): Connect, Profiles, Settings (§2).

## 5. Verified (2026-11-16, Chromium, a copy of the server on :28490)

- Loopback: no pairing; "Who's watching?", Home with its rows, Search (titles, torrents), a title page, the Play
  chooser ("On this server": "Sound converted by the server", from this browser's description).
- A 2-minute H.264 / AC-3 Matroska file with an embedded SRT: `/playback` answered `hls`, played at 1280 × 720, the
  controls, Audio & subtitles listing the file's sound and subtitle, the subtitle's cue at 1:00 showing, Escape closing
  the panel; its progress saved (Continue watching on Home).
- A reload on a title page stays there with the profile.
- From the LAN address with no cookie: Connect lists this server, Pair shows a code; approved on the server, the
  browser gets the httpOnly cookie and opens "Who's watching?"; the device is "Chrome on Linux", platform `linux`, the
  browser's codecs, client `playpex-mobile`.
- A 1280 × 800 window: the phone's layout stretched to the width (rows of more posters, a wide hero), usable.

Not tried: Firefox, Safari (iPhone: native HLS without MediaSource), a real phone, the player in landscape on a phone,
casting from the browser (the code is the phone's: the cast button shows when screens exist), plugin screens beyond Home.

## 6. Known differences, accepted

- No morph from a poster into its title page (§7.7).
- mpv's other properties (subtitle position and style, pan and scan, brightness, audio delay) do nothing (§7.5).

## 7. Open, to discuss (2026-11-16)

The gaps left after steps 1–6, each with the way round it proposed:

1. **Browsers not tried**: Firefox, Safari on iPhone, a real phone (Chrome on Android).
   *Proposed*: run the same checks in Playwright's Firefox and WebKit; give the player a native-HLS path for
   Safari on iPhone (no MediaSource there: hls.js isn't supported, the `<video>` plays the `.m3u8` itself;
   `ManagedMediaSource` (iOS 17.1+) lets hls.js run where it exists). The device cookie needs nothing more: the page,
   the playlist and its parts are one origin. Then the user's phone on the LAN address.
2. **Casting from the browser**: the phone's code is there, never tried.
   *Proposed*: try it here with Playpex TV on the web as the screen (`/tv/` in a second window of the test server,
   `cast.allowed` on): the cast button, Play on a screen, the mini player, the remote.
3. **Plugin screens** beyond Home's plugin rows (the catalog, title and list templates, `mobile.bar` choices).
   *Proposed*: install `plugins/hello` (every template, slot and setting) in the test copy's `plugins-dev/` and go
   through each screen.
4. **The player in portrait**: built 2026-11-16 (`features/player/frame.web.tsx`, tried in Chromium at 390 × 844).
   A Turn button at the top right, while the window is higher than wide: it asks the browser for full screen +
   `screen.orientation.lock('landscape')` (Chrome on Android), and where that is refused (Safari, a computer) draws the
   player a quarter turned across the window (the phone held on its side), remembered for the next video
   (`localStorage['playpex.mobile.playerTurned']`); "Upright" turns it back. What measures the window or reads a
   finger (the tap zones, the panels, the timeline) asks the player's frame (`frameContext.ts`), since a turned
   box's touches come in screen coordinates. The phone build has no button (the system turns the screen).
5. **mpv's properties with no browser counterpart**.
   *Proposed*, one by one:
   - subtitle position, size, colour, background: draw the cues ourselves (they are already parsed, `parseVtt`) in a
     view over the video instead of the `<video>`'s text track, styled like mpv's `sub-*` properties;
   - brightness: a CSS `filter: brightness()` on the `<video>`;
   - pan and scan / zoom: `object-fit: cover` or a scale on the `<video>`;
   - audio delay: the sound through Web Audio (`createMediaElementSource` → `DelayNode`). Only a positive delay (the
     sound later) is possible that way; a negative one hides itself, or moves the picture back with the subtitles.
6. **A separate sound file** (a torrent's other audio file) can't play beside the video.
   *Proposed*: the server adds it to its HLS stream (`/playback` with `audioRef`: ffmpeg maps the video of one file
   and the sound of the other, as it already converts the sound). Playing a second `<audio>` in step with the
   `<video>` (nudging its rate) needs no server change, but drifts and stutters on a phone: second choice.
7. **No poster → title morph** on the web.
   *Proposed*: the View Transitions API (`document.startViewTransition` around the navigation, the same
   `view-transition-name` on the poster and the title page's poster: Chrome, Safari 18), a fade where it's missing,
   in `state/boundary.web.tsx` beside the no-op morphs.
8. **The pre-existing lint error** in `features/player/PlayerScreen.tsx` (an effect in a screen: closing on
   `stoppedByServer`). *Proposed*: an event hook in `src/state` (`useEvent(controller.events, 'stoppedByServer', …)`).
9. **No server test for `/m/`**. *Proposed*: cases as `test/web-client.test.js` has for `/tv/` (not built → 404,
   `/m` → 301, index fallback, hashed files immutable, the rest an hour).

## 8. Later

- Full screen and the Wake Lock in the player (`requestFullscreen` + `screen.orientation.lock('landscape')` where the
  browser allows it), the player's own Picture in picture button.
- A web manifest (install to the home screen), the app icon as `apple-touch-icon`.
- A centred column, or a tablet layout, for wide windows.
- Device-based choice between `/tv/` and `/m/` (left out on purpose for now).
