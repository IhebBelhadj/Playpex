# Playpex Mobile (`apps/mobile`) — Agent Guide

The phone client of Playpex Media Server (plan and status: [`docs/mobile-client-plan.md`](../../docs/mobile-client-plan.md)):
React Native 0.88 with **Expo SDK 58**, Expo Router, TanStack Query, **libmpv** (`modules/expo-mpv`) as the player. It follows the client author guide
([`docs/api/`](../../docs/api/README.md)) and nothing else: no admin feature (the Server Manager, `apps/manager`, opens the dashboard).
Android first; iOS later from the same code (the native module has no iOS side yet: discovery is off there, typed addresses work).

**Expo changes every SDK**: before touching an Expo or React Native API, read the versioned docs
(`https://docs.expo.dev/versions/v58.0.0/`, index with corrections: `https://docs.expo.dev/llms.txt`), not memory. Add native
libraries with `npx expo install <pkg>` (SDK-compatible versions). `android/` and `ios/` are **generated** (`expo prebuild`,
git-ignored): native settings go in `app.json` (config plugins), native code in `modules/`.

## How it works
```
src/app/_layout.tsx   QueryClient + SessionProvider; screens guarded by the session (Stack.Protected):
                      no server → connect, pair · a server, no profile → profiles · else (tabs), title, play, player
src/lib/session.tsx   the server (last one at its URL, else found again by id: discovery, 6 s), its API client, the profile
                      (in memory: "Who's watching?" at every start); 401 PAIRING_REQUIRED / 426 → back to Connect with the reason
src/lib/servers.ts    known servers {id → name, url, token} + this install's deviceId, in expo-secure-store (Keystore / Keychain)
src/lib/api.ts        openapi-fetch typed from @playpex/protocol/types/api; Authorization, X-Playpex-Client
                      (playpex-mobile/<v>; api=2), X-Playpex-Device on every request; unwrap() → ApiError
src/lib/pairing.ts    RFC 8628 device flow (client_id playpex-mobile), PUT /devices/me with the player's codecs
src/lib/catalog.ts    /catalog/* queries (lists, title, season, credits), IMDb, image URLs; the rows of each tab
src/lib/recommend.ts  what Home suggests: the profile's history (its genres, its last titles) + /similar, /discover, trending;
                      no model on the server; `unseen()` leaves out what the profile watched
src/lib/plugins.ts    GET /plugins (sections, screens, slots), POST /plugins/{id}/data/{name}; useSlotRows(slot) for core.movies.rows,
                      core.shows.rows, core.movie.rows, core.show.rows, core.watchlist.rows; openIntent (core.movie/show/search,
                      plugin.<id>.<screen> → /plugin/[plugin]/[screen]); perform(effects): open, play, toast, refresh
src/lib/playback.ts   /play/sources, /play/start, torrents, keepalive, release, progress; PLAYER_CAPABILITIES (every codec: what
                      PUT /devices/me declares); openPlay() → /play; PlaybackRequest kept by id for /player
src/lib/usePlayback.ts source → URL: a ref plays at once; a torrent: POST /torrents, poll for `chosen`, stats while waiting;
                      plugin `hls` → /media/{ref}/index.m3u8, `live` → /media/{ref}; else the file itself, /media/{ref} (no
                      /playback: the phone decodes everything); releases the lease on leaving (DELETE /media/{ref}, or
                      /torrents/{hash} before a file was known)
src/app/player.tsx    ExpoMpvView with `httpHeaders` (the token, client, device: mpv sends them with every request, HLS segments
                      and added subtitles included), `startPosition` for resume; keepalive 60 s, progress 15 s / pause / leave
                      (never before playback started); the file's audio and subtitle tracks from mpv's track list
modules/expo-mpv      libmpv as an Expo view: expo-mpv 0.1.21 vendored (GPL-3.0; what changed and how to update: its PLAYPEX.md).
                      Every container / codec / subtitle format decoded on the phone: MediaCodec / VideoToolbox first, FFmpeg
                      in software otherwise. Its native libraries are downloaded at build time (mpv-android release APKs by
                      android/build.gradle into android/src/main/jniLibs, MPVKit by the config plugin into ios/Frameworks;
                      both git-ignored). It replaces the app's merged libc++_shared.so with mpv-android's
modules/playpex-device  local Expo module (Kotlin): discovery (NsdManager mDNS + UDP `PLAYPEX_DISCOVER 1`, every address
                      confirmed with GET /server; ported from apps/manager's PlaypexDiscovery.java), probe(address), codecs()
                      (MediaCodecList: the hardware decoders, for the device's `maxHeight`)
src/app/plugin/[plugin]/[screen].tsx  a plugin's screen: the catalog, title and list templates (releases and guide: "on the TV")
src/ui/               theme.ts ("the lights go down": warm auditorium blacks, the mark's champagne as the one accent, Futura display +
                      Hanken Grotesk text, the type scale, motion), brand.tsx (the mark from assets/brand/mark.svg, the wordmark;
                      a centred mark goes 5 % right), press.tsx (press feedback), components (Button, Action, Poster with its
                      shared tag, Row, RowSkeleton, Loading = the mark breathing), home.tsx (Hero, ContinueRow, TopTenRow),
                      section.tsx (Movies / Shows: genre chips, rows, plugin rows), plugin-rows.tsx (a plugin's row and cards,
                      PluginSections on Home), rows.tsx (TabPage: header over the hero, darkening on scroll), toast.tsx, avatar
assets/avatars/       the TV app's avatar SVGs (same ids on every client), drawn by expo-image
assets/brand/         the mark's SVGs (from apps/tv/app_icon.svg); icon.png, android-icon-*.png, splash-icon.png are rendered from them
                      (`rsvg-convert`, see their sizes in app.json); assets/fonts/: Futura (from the TV app) and Hanken Grotesk,
                      embedded by expo-font (Android names a family by its file: `Futura-Bold`, `HankenGrotesk-Medium`…)
```

## Commands (repo root)
| Goal | Command |
|---|---|
| Metro (JS dev server) | `npm run mobile` (= `expo start`); the app must be a development build, not Expo Go (native module, video) |
| Build and run on a phone / emulator | `npm run android:mobile` (= `expo run:android`: prebuild, Gradle, install, Metro). Needs JDK 21 (`JAVA_HOME=~/.local/jdk-21`) and the Android SDK (`~/Android/Sdk`; `android/local.properties` `sdk.dir`, recreated by prebuild) |
| Debug APK without a device | `cd apps/mobile && npx expo prebuild -p android && cd android && ./gradlew assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk` (loads JS from Metro) |
| Typecheck | `npm run typecheck -w apps/mobile` |
| Health | `npx expo-doctor` (from `apps/mobile`) |

React is pinned to **19.3.0** for the whole workspace (root `overrides`, dashboard exact): React Native's renderer refuses another
version, and npm workspaces share one copy.

## Conventions
- Data through TanStack Query (`queryKey` starts with the area: `catalog`, `library`, `progress`, `watchlist`, `profiles`, `play`);
  after a write, invalidate what shows it. No `localStorage`-like state: what a user does lives on the server (profile data).
- Types from the protocol (`Schemas['…']`); bracket access isn't needed (strict TS). Route params are strings: pass small JSON or
  an id into a module map (`storeRequest`), never a whole object graph.
- Colours, spacing, type from `src/ui/theme.ts`. Lengths are plain numbers (density-independent pixels). Headings are Futura
  in sentence case (no all-caps labels); amber of the TV = champagne here (progress, what is chosen); focus white.
- Motion: one launch moment (`LightsDown` in `_layout.tsx`, after the native splash), the poster → title morph (Reanimated
  shared transitions: `posterTag(scope, …)` on the tapped poster, passed as the `tag` param, the same tag on the title page's
  poster, or its backdrop when it came from the hero; tags are unique per row, hence the scope), press feedback; respect
  `useReducedMotion`. Shared transitions are a static Reanimated flag (`package.json` `reanimated.staticFeatureFlags`
  `ENABLE_SHARED_ELEMENT_TRANSITIONS`): changing it needs a native rebuild. Reanimated 4.7 only morphs between screens inside an
  active `SharedTransitionBoundary`: every navigator sets `screenLayout={screenBoundary}` (`src/state/boundary.tsx`, active while
  focused; the root stack leaves `(tabs)` to its sections, and the tabs keep `detachInactiveScreens={false}` so a section's boundary
  sits in the stack's screen). Images that morph use `cachePolicy="memory-disk"` (else the opened screen's copy is blank mid-morph).
  The top bar's avatar morphs into Settings (tag per section: `me-<title>`). A picture in a section is tagged only when tapped
  (`useMorphTag` in `state/boundary.tsx`: tag, commit, then navigate): Reanimated checks every tagged view on each screen change,
  tab switches included, and can leave posters hidden. Rows never use `removeClippedSubviews` (`ROW_LIST`). Morphs run one way only, because Reanimated 4.7's reverse morph
  on a pop can leave the poster it flies back to hidden for good: both tags live only for the morph in (`MORPH_SETTLE_MS`, 600 ms:
  `useMorphTag` takes the tapped picture's off, `useArrivingTag` the opened screen's), so however the screen is left (Back, a
  gesture, a pop from code) nothing morphs back; `useLeave()` (`state/hooks.ts`) makes Back a fade.
- Settings (`/settings`, from the top bar's avatar): every value is the server's (`GET /settings?profile=`, `PATCH
  /profiles/{id}/settings` or `/settings/device` by the key's scope, `core/services/settings.ts`; optimistic in
  `state/settings.ts`). The player applies them before a file opens (`core/player/preferences.ts`: `alang`, `slang`, `sid`,
  `sub-scale`).
- See all (`/browse/[mediaType]`): one `BrowseQuery` (`core/catalog/browse.ts`, tested): a list as ranked, or discover by genres
  (any / all), era, minimum score, original language, in an order; the header names it plainly (the list, else "Best rated movies"),
  the count under it, the filters on as removable chips; Filters opens the panel (`FilterSheet`, a draft with the server's live count).
- Posters in rows and grids are `TitleCard`s (`ui/components.tsx`): the poster, then the name on one line, the year and the score
  (`TitleCaption`, also under the Top 10's posters).
- The player (`features/player`) is laid out as the TV's (`apps/tv/src/app/player-page`): the title, the timeline (now · "Ends at" ·
  −left; a white scrub tab, outlined where nothing is downloaded) and one row of buttons at the bottom, Skip intro / Up next at
  the right, panels docked at the right edge (`Panel.tsx`: Audio & subtitles; Settings with Subtitles, Style, Audio, Video, Stats).
  State lives in `core/player`: `PlayerController` (tracks, `tune()`: mpv's `sub-delay`, `audio-delay`, `sub-scale`, `sub-pos`,
  `sub-border-style`, `panscan`, `keepaspect`, `brightness`, speed; the resume point's tracks restored once), `PlayerExtras`
  (`Markers` from `/play/markers`, `UpNext` (the next aired episode, its best source looked up ahead, autoplay by
  `player.autoplayNext`), `OnlineSubtitles` (`/subtitles/*`, the profile's `subtitles.provider`), `PlayerStats` (mpv's media info
  and the torrent's swarm, polled only while shown)).
- Search (`features/search`, the Search tab) is the dashboard's Search on a phone: one field ("Titles, videos or a link"); words
  find catalog titles, plugins' videos of any kind (`/search/sources`, kind `any`: files and streams under Videos, their torrents
  under Torrents), the release providers' torrents (both kinds, one row per info hash) and live channels, each provider queried on
  its own (`state/search.ts`), chips narrowing to one kind; a pasted link (URL, magnet, info hash) is read by the server on
  Enter / Open (`POST /links/inspect`, refused for kids profiles) and its items play, saved for no title (`tracking: 'none'`).
  Plugins' chips come after the core's (slot `core.search.filters`, `useSearchChips` in `lib/plugins.ts`, as on the TV): each
  contribution asked with the words; its rows show only when its chip is chosen (Velvet's 18+ chip: its films and a Releases card
  opening its torrent list; no 18+ code in the app, and kids profiles never get the chip: the server leaves adults plugins out).
- A plugin screen's top is the plugin's choice (`features/plugins/PluginChrome.tsx`): `mobile.bar` from its manifest's screen or
  its data answer (wins): `plain` (default; `title` screens: `overlay`), `fold`, `app` (the app's TopBar with Back), `overlay`.
- Tabs come from `expo-router/js-tabs` (the custom tab bar gets `navigateToTab(route.key)`), not the deprecated `Tabs` of `expo-router`.
- Errors: show `ApiError.message` (the server's `error`), branch on `code`.
