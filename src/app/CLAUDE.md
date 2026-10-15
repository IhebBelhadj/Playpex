# Angular UI (`src/app`) — Agent Guide

Single NgModule app (`app.module.ts`), Angular 14, no lazy loading, no standalone components. Everything is driven by keyboard via spatial navigation and coordinated through RxJS Subjects in root services. See the root [`CLAUDE.md`](../../CLAUDE.md) for the overall architecture, data sources and ports.

## Layout of the shell (`app.component.html`)

```
<splash>                         full-screen intro video; emits 'clearSplash' when done
.masterContainer (flex row)
  <menu>                         left nav: current profile (→ /profiles) / Search / Movies / Tv shows / Watch list / Settings*  (*placeholder)
  <notification-handler>         modal error popup with an "ok" button
  <torrent-picker>               modal "Choose a torrent" list shown before playback
  <play-choice>                  modal "Resume / Play from the beginning" for titles with a saved position
  <router-outlet>                pages (see routes)
  <clock>                        top-right clock
.overlay
img.newBackground / img.previousBackground   full-screen backdrop crossfade (driven by BackgroundService)
```

## Two sections, one set of components

Movies and TV shows share the home page, slider and description panel. The route's `data.media` (`'movie' | 'tv'`) picks a **`Catalog`** (`catalog.ts`) from `MoviesService.catalogs`:

| | `catalogs.movie` | `catalogs.tv` |
|---|---|---|
| Rows | `categories` in `categories.ts` | `showCategories` in `categories.ts` (all `discover/tv`; trending/popular endpoints ignore the language filter) |
| List URL | `/movies/list` | `/shows/list` |
| Detail URL | `/movies/movie/:id` → `MovieOptionsComponent` | `/shows/show/:id` → `ShowOptionsComponent` |
| Enrichment on focus | TMDB details + YTS torrents/rating/runtime | TMDB TV details (genres, seasons, imdb id) |

A `Catalog` holds `items` (BehaviorSubject `{[category]: item[]}`, created in category order), `navigationData` (slider position per row), `reachedPages`, and the page-request / selection channels. It lives in the root service so it survives trips to the player. `MoviesService.catalogForUrl(url)` maps a list URL back to its catalog (used by `AppComponent`).

TV items carry `media_type: 'tv'`; `<movie-description>` uses that to show `name`, `first_air_date`, season count and TMDB score instead of the movie fields.

## Routes (`app-routing.module.ts`)

| URL | Component | Purpose |
|---|---|---|
| `/` | redirect → `/profiles` | |
| `/profiles` | `ProfilePickerComponent` (`profile-picker/`) | "Who's watching?" start page; manage mode; PIN pad for locked profiles |
| `/profiles/new`, `/profiles/:id/edit` | `ProfileEditorComponent` (`profile-editor/`) | Name (on-screen keyboard), avatar, kids flag, PIN lock, delete |
| `/movies` (`data.media='movie'`) | `MoviesPageComponent` (`movies-page/`) | Section page: fills the catalog, enriches the focused item, hosts `<movie-description>` + child outlet |
| `/movies/list` | `MoviesSliderComponent` (`movies-slider/`) | Category rows of posters |
| `/movies/movie/:id` | `MovieOptionsComponent` (`movie-options/`) | Movie detail: Play (or Resume) / Trailer / Add to watch list / Mark as watched, cast row, similar row. `:id` = TMDB id |
| `/shows` (`data.media='tv'`) | `MoviesPageComponent` | Same as `/movies`, TV catalog |
| `/shows/list` | `MoviesSliderComponent` | TV rows |
| `/shows/show/:id` | `ShowOptionsComponent` (`show-options/`) | Show detail: Play / Trailer / Add to watch list, seasons row, episodes row (watched badge / progress bar per episode). `:id` = TMDB TV id |
| `/watchlist` | `WatchlistPageComponent` (`watchlist-page/`) | The profile's library: Continue watching, My list, Watched (history) |
| `/player` | `PlayerPageComponent` (`player-page/`) | Plays `PlaybackService.current` (movie or episode); subtitle side panel with provider tabs |
| `/search` | `SearchPageComponent` (`search-page/`) | On-screen keyboard + TMDB **movie** search (TV search not implemented) |
| `/ytplayer/:id` | `YoutubeComponent` (`youtube/`) | Trailer player (server side currently broken, see root CLAUDE.md) |
| `/power` | `PowerPageComponent` (`power-page/`) | Quit / Sleep / Shutdown / Restart → Electron :3344 |

`movies`, `shows`, `watchlist`, `player`, `search`, `ytplayer` are guarded by `ProfileGuard` (no current profile → `/profiles`). The current profile is in-memory only: every app start goes through "Who's watching?".

Reached from: start → `/profiles` → Enter on a profile → `/movies/list`. List page → Escape with the menu expanded & focused → `/power`. Menu "Search" → `/search`, "Movies" → `/movies/list`, "Tv shows" → `/shows/list`, "Watch list" → `/watchlist`. Poster Enter → the catalog's detail URL.

## Component index

| Folder | Class / selector | Key responsibilities |
|---|---|---|
| `app.component.*` | `AppComponent` / `app-root` | **Input hub**: `spatialNavigation.init()`, executes `NavigationService.updateNavigation` instructions, toggles `.focused` on `sn:focused`/`sn:unfocused`, maps the `select` action (Enter)→`click` / `back` (Escape)→`back` via `keymap.ts`. Select on a list page poster → `moviesPageNavigation()` (GSAP out → `catalog.detailUrl(id)`; movies also go on `movieAppHistory`). Background crossfade/Ken-Burns via GSAP. |
| `menu/` | `MenuComponent` / `menu` | Expand/collapse/hide/show via `MenuServiceService`; auto-expands when a `.menuItem` is focused. `navigate()` routes by `data-destination`. Active tab from the URL (`/movies`, `/shows`). |
| `movies-page/` | `MoviesPageComponent` / `movies-page` | Generic section page (see above). Seeds rows in category order, fetches each category once, appends pages on request, enriches the focused item (`enrichMovie` / `enrichShow`), clears a selection left over from the other section. Host has `min-width: 0` (flex item). |
| `movies-slider/` | `MoviesSliderComponent` / `movies-slider` | Renders the catalog's non-empty rows, registers `slider` + `menu` sections, scrolls rows/columns with `transform`, requests the next page 10 items before a row's end (`limit = 20`), restores position from `catalog.navigationData`. Back → expand menu / go to `/power`. |
| `movie-description/` | `MovieDescriptionComponent` / `movie-description` | Title, year, qualities or season count, IMDb/TMDB score, genres, overview; pushes `backdrop_path` to `BackgroundService`. Listens to `checkSelection()` and `onDescriptionUpdate()`. |
| `movie-options/` | `MovieOptionsComponent` / `app-movie-options` | Movie detail (`options` + `menu` sections): credits, similar, trailer, YTS play data. Play → torrent picker (YTS `torrents`) → `PlaybackService.playMovie(movie, torrent)` → `/player`; Enter on a similar title opens it. Back pops `movieAppHistory`. Scrolls **natively**: adds `.nativeScroll` to `.pageContainer` (vertical `scrollTo`, `ensureSectionVisible`) and the cast/similar rows are `overflow-x: auto` (`scrollRowTo`, focused item ~⅓ in); no transforms. |
| `show-options/` | `ShowOptionsComponent` / `app-show-options` | Show detail (`showOptions` + `menu` sections). Loads `getTvDetails` (incl. `external_ids.imdb_id`, videos); seasons sorted with Specials last; focusing a season loads it (`switchMap`, latest wins); episodes flagged `upcoming` if not aired. Enter on an episode / "Play" → `TorrentService.findEpisodeTorrents` → torrent picker (server ranking, first = "Best match") → `PlaybackService.play({...season, episode})` → `/player`. Rows scroll with `scrollRowTo` (focused item ~⅓ in) and `ensureRowVisible` (slides `.pageContainer` up). |
| `player-page/` | `PlayerPageComponent` / `app-player-page` | See "Player" below. |
| `search-page/` | `SearchPageComponent` / `app-search-page` | Virtual keyboard (`.keyboardBtn`, `data-fct` = del/space/num/char), TMDB movie search when input > 2 chars, state kept in `MoviesService.searchData`. |
| `youtube/` | `YoutubeComponent` / `youtube` | `<video class="ytPlayer">` ← `STREAMING_SERVER/youtube/:id?type=video&quality=136`, hidden `<video class="audioTrack">` ← `?type=audio`, synced on `timeupdate`. ←/→ seek 5s. |
| `power-page/` | `PowerPageComponent` / `power-page` | `.powerBtn[data-instruction]` → `PowerService`. |
| `torrent-picker/` | `TorrentPickerComponent` / `torrent-picker` | Modal list of torrents (quality, codec/source tags, size, seeds, playability/audio warnings). Own `torrentPicker` section (`restrict: self-only`); while open `AppComponent` forwards select/back to it instead of the pages; restores the previous focus on close. Options scroll natively. |
| `play-choice/` | `PlayChoiceComponent` / `play-choice` | Same frame and key handling as the torrent picker (`playChoice` section; `AppComponent` forwards select/back while `PlayChoiceService.isOpen`). Two options: **Resume** (time + amber bar) and **Play from the beginning**. Used by Play on the movie page and Enter/Play on an episode, only when `LibraryService.state()` has a resume point. Resume with a saved `infoHash` plays that same release directly (bare hash as the magnet, no torrent picker) so the position matches; otherwise and for "from the beginning" the torrent picker follows. The choice reaches the player as `PlaybackRequest.startAt` (seconds; 0 = from the start). |
| `notification-handler/` | `NotificationHandlerComponent` / `notification-handler` | Shows `NotificationService` `type: 'error'` messages; `okBtn` section (`restrict: self-only`) traps focus. |
| `splash/` | `SplashComponent` / `splash` | Plays the intro video, fades out, emits `'clearSplash'` (`SplashService.cleared` flips to true). The picker ignores Enter/Escape until then; the slider focuses its first poster when it opens after the splash with no row visited (`focusFirstWhenReady`). |
| `profile-picker/` | `ProfilePickerComponent` / `app-profile-picker` | Full-screen (z 10, under the splash) "Who's watching?": tiles + "Add Profile" (hidden at `maxProfiles`) + "Manage Profiles" (toggles edit overlays; `ProfilesService.picker.managing`). Enter: managing → editor; locked → `<pin-pad>`; else `unlock` → GSAP out → `/movies/list`. Back: leave manage mode, else `/power`. Focus restored from `picker.focusId` (last focused/edited) or the server's `lastUsedId`. Section `profiles`. |
| `profile-editor/` | `ProfileEditorComponent` / `app-profile-editor` | Edits locally, sends on Save (`update`, then `setPin` if the PIN changed; `create` for new). Overlay panels, each its own `restrict: self-only` section opened/removed on demand: `nameKeyboard` (A–Z, 0–9, space/del/clear/done; on-screen letters capitalize word starts, physical typing is taken as is), `avatarChooser`, `confirmDelete`; PIN via `<pin-pad>`. Back closes the panel, else cancels. Section `profileEditor`. |
| `watchlist-page/` | `WatchlistPageComponent` / `app-watchlist-page` | Laid out like the movies page: a title-info header (as `<movie-description>`: name; year, Movie/Series chip, runtime or season count, TMDB score; genres; the profile's status line + amber progress line for resumes; overview). Details come from TMDB (`getTmdbMovieDetails` / `getTvDetails`) for the focused card, debounced 150 ms and cached per title and category-style rows below (same 180×270 posters, `sliderContainer` 370 px, focused row slides to the top, focused poster to the row start). One `GET …/library` call → rows, empty ones left out: "Continue watching series" / "Continue watching movies" (most recently watched kind first; amber line on the poster), "My list", "Watched this week / this month / earlier". The shell backdrop follows focus (`BackgroundService`). Up/down via `data-sn-up/down` → the neighbour row's `.lastSelected`. Enter: show → `/shows/show/:id`; movie → `getTmdbMovieDetails` + `addMovieToHistory` → `/movies/movie/:id`. Back: menu, then `/movies/list`. Focus restored on return (module-level `lastFocusKey`). Section `library` (+ re-registers `menu`). Amber `#FFC107` means "progress" here and on episode thumbnails — keep it for that. |
| `pin-pad/` | `PinPadComponent` / `pin-pad` | 4-digit PIN overlay (keypad + number keys/Backspace). `(completed)` then waits for the host to close it or call `fail(msg)` (shake + message); `(cancelled)` on Cancel/back. Section `pinPad`; hosts ignore click/back while it is open. |
| `clock/` | `ClockComponent` / `clock` | 12h clock, refresh every 10s. |
| `descrition-viewer/` | `DescritionViewerComponent` | Unused CLI stub (typo in name is real). |
| `catalog.ts` | `Catalog`, `MediaType` | Section state (see above). |
| `categories.ts` | `Category`, `categories[]`, `showCategories[]` | Rows: name + TMDB URL with `<<api_key>>` placeholder. **Add/remove a row here**; array order = display order. |
| `keymap.ts` | `KEY_BINDINGS`, `actionForKey(e)`, `SPATIAL_NAVIGATION_KEYS` | **All key bindings** (`select`, `back`, `up/down/left/right` → `KeyboardEvent.key` names). Components react to actions, never compare `e.key`; the spatial-nav library gets its arrow/enter keys from here via `setKeyMap()`. |
| `server-config.ts` | `STREAMING_SERVER` | Base URL of the local server, from Electron's `?streamer=<port>`; strips the param before Angular boots. **Import this instead of writing a port.** |

Each component folder holds `.ts`, `.html`, `.scss`, `.spec.ts` (CLI-generated spec stubs).

## Services (all `providedIn: 'root'`) — the event bus

| File | Class | Channels / API | Main producers → consumers |
|---|---|---|---|
| `navigation.service.ts` | `NavigationService` | `updateNavigation(type, query)` / `updatedNavigation()` — spatial-nav instructions (`add`, `remove`, `makeFocusable`, `focus`) | pages → `AppComponent` |
| | | `addCommand('click'\|'back')` / `executeCommand()` | `AppComponent` keydown → every page |
| | | `descriptionUpdateQuery(movie)` / `onDescriptionUpdate()` | movie-options → movie-description |
| | | `sendMovieSliderEvent(e)` / `getMovieSliderEvent()` | movies-page (after splash) → slider (focus first) |
| `movies.service.ts` | `MoviesService` | **TMDB**: `getMovies(query)`, `getCredits`, `getSimilarMovies`, `getTmdbMovieDetails`, `searchMovies`, `getMovieVideos`, `getTvDetails(id)` (+external_ids, videos), `getTvSeason(id, n)`; **YTS via server**: `getYTSMovieDetails(imdb_id)` | |
| | | `catalogs: {movie, tv}` + `catalogForUrl(url)` | section page, slider, AppComponent |
| | | `selectedmovie` BehaviorSubject — `assignSelection`/`checkSelection`: the item shown in `<movie-description>` | section page, movie/show options → description |
| | | `movieAppHistory[]` (movies only — TMDB movie and TV ids overlap): `addMovieToHistory`, `getMovieFromStack`, `popFromHistoryStack` | app/search/options → movie-options |
| | | `searchData` BehaviorSubject | search-page |
| `playback.service.ts` | `PlaybackService` | `current: PlaybackRequest` (`title, subtitle?, year?, runtimeMinutes?, magnet, imdbId?, season?, episode?, mediaType?, tmdbId?, artwork?, startAt?` — `mediaType/tmdbId/artwork` let the player resume and save progress; `startAt` = the user's Resume / from-the-beginning choice, unset = resume automatically); `play(request)`; `playMovie(movie, torrent, startAt?)` builds the magnet (torrent needs only `hash`) + fills `tmdbId`/`artwork` | movie/show options → player |
| `torrent.service.ts` | `TorrentService` | `registerTorrent(magnet)`, `getTorrent(hash)`, `deselectTorrent(hash)`, `removeTorrent(hash)`, `findEpisodeTorrents(imdbId, title, season, episode)` | player, show-options |
| `subtitles.service.ts` | `SubtitlesService` | `getProviders()`, `search(provider, {imdbId, season?, episode?}, languages)`, `fileUrl(subtitle)` (WebVTT), `preferredProvider` (localStorage) | player |
| `menu-service.service.ts` | `MenuServiceService` | `sendInstruction('collapse'\|'expand'\|'hide'\|'show'\|'navigate', source)`; `menuState` | pages → menu |
| `background.service.ts` | `BackgroundService` | `sendImage(tmdbPath)` (deduped) / `getImage()` | movie-description → AppComponent |
| `play-choice.service.ts` | `PlayChoiceService` | `choose(title, {positionS, durationS})` → Observable emitting `'resume' \| 'restart'` (completes empty on back); `isOpen`, `sendCommand(action)` | movie/show options → play-choice; AppComponent → play-choice |
| `torrent-picker.service.ts` | `TorrentPickerService` | `choose(title, options)` → Observable emitting the picked `TorrentOption` (completes empty on back); `TorrentPickerService.fromYts(t)` / `fromEpisode(t, i)` normalize provider torrents; `isOpen`, `sendCommand(action)` | movie/show options → picker; AppComponent → picker |
| `notification.service.ts` | `NotificationService` | `sendNotification('error', msg)` | any → notification-handler |
| `splash.service.ts` | `SplashService` | `'clearSplash'`, `cleared` flag | splash → section page, picker, slider |
| `library.service.ts` | `LibraryService` | Current profile's data (`…/api/profiles/:id/…`; no profile → `EMPTY`): `library()`, `inWatchlist/addToWatchlist/removeFromWatchlist(ref)`, `state(key)` → `{resume, finished}`, `episodesProgress(ref)`, `saveProgress(key, body)`, `markWatched/markUnwatched(key)`. Static `artworkOf(tmdbItem)` → `{title, posterPath, backdropPath, genreIds}` (sent with every write so rows render without TMDB) | watchlist page, movie/show options, player |
| `profiles.service.ts` | `ProfilesService` | `/api/profiles` client: `list()` → `{profiles, lastUsedId, maxProfiles}`, `get`, `create`, `update`, `setPin(id, pin\|null)`, `remove`, `unlock(id, pin?)` (sets `current`). `current` BehaviorSubject (who's watching), `picker` UI state, `AVATARS` (`src/assets/avatars/avatar-NN.svg`), static `avatarUrl()` / `errorMessage()` | picker, editor, menu, `ProfileGuard` |
| `power.service.ts` | `PowerService` | `sendPowerInstruction(action)` → `:3344/power/:action` | power-page |
| `youtube.service.ts` | `YoutubeService` | `ytUrl`, `ytInstruction` subjects — unused | — |
| `remoteSocket.service.ts` | `RemoteService` | WebSocket to `ws://localhost:5000` — **never injected**; prep for a phone remote | — |

Note: `websocket.service.spec.ts` exists without a matching service.

## Spatial navigation — how focus works (read before touching any page)

Library: `src/plugins/spacialNavigation.js` (vendored js-spatial-navigation; `init, add(config), remove(id), focus(id?), makeFocusable(id?), disable/enable, setDefaultSection`). Fires DOM events `sn:focused`, `sn:unfocused`, `sn:willmove`, …

Pages never call the library directly. They send instructions through `NavigationService`:

```ts
// on view init
this.navigation.updateNavigation('add', {
  id: 'showOptions',                              // section id (unique!)
  selector: '.showOptionsContainer .focusable',   // focusable elements (<button> or tabindex)
  restrict: 'self-only',                          // don't leave except via leaveFor
  leaveFor: { left: '@menu' },                    // '@<sectionId>' or a CSS selector
  enterTo: 'last-focused',
  straightOnly: true,
});
this.navigation.updateNavigation('focus', { sectionId: 'showOptions' });

// on destroy — ALWAYS remove sections you added, or ids collide next time
this.navigation.updateNavigation('remove', { sectionId: 'showOptions' });
```

Rows inside a page are joined with per-element overrides and a `.lastSelected` marker per row, e.g. `data-sn-down=".showOptionsContainer .seasons .lastSelected"`; update `.lastSelected` in the page's `sn:focused` handler.

Section ids in use: `menu`, `slider`, `options`, `showOptions`, `timeSlider`, `optionPannel`, `subs`, `keyboard`, `searches`, `powerControls`, `okBtn`, `torrentPicker`, `profiles`, `profileEditor`, `nameKeyboard`, `avatarChooser`, `confirmDelete`, `pinPad`, `library`. Pages that show the left menu re-register `menu` with their own `leaveFor.right`.

Key handling (bindings live in `keymap.ts` — change keys there only):
- Arrows → library moves focus → `sn:focused` → `AppComponent` adds `.focused` (style hook); page listeners react (scroll rows via `transform`, update position memory, collapse menu…).
- `select` (Enter) → `NavigationService.addCommand('click')` (except on list-page posters → `AppComponent.moviesPageNavigation`, and on a menu item → `MenuServiceService 'navigate'`).
- `back` (Escape) → `addCommand('back')`.
- Every subscriber to `executeCommand()` checks `this.router.url`.
- Programmatic `element.focus()` only produces `sn:focused` when the window has OS focus (matters for headless/offscreen testing). In an offscreen Electron window arrow keys don't move focus either; Enter/Escape and typed keys do (sent with `webContents.sendInputEvent`), so tests move focus with `element.focus()` and add `.focused` themselves.

## Player (`player-page/`)

1. `ngOnInit`: hide menu, read `PlaybackService.current` (none → back). Title/info line from the request (`subtitle` like "S02E04 · …" for episodes, otherwise year + runtime).
2. `registerTorrent(magnet)` → keep `infoHash` → `getTorrent` → `repeat({delay: 4000})` until `files`; > 4 tries → `leavePlayer()` + error.
3. File: episodes → `pickEpisodeFile(files, s, e)` (`SxxEyy`, `s2e5`, `2x05`; works inside season packs; a lone video file is accepted); movies → `pickVideoFile` (mp4 > m4v > mkv > webm, then largest). None → error + `leavePlayer()`.
4. `setupPlayer`: `timeSlider` + `optionPannel` sections; Enter toggles controls / play-pause / opens subtitles / picks a provider tab or subtitle; Escape closes panel → controls → `leavePlayer()`. Before playback is ready, the first Escape leaves (same cleanup). ArrowDown shows controls, ArrowUp on the progress bar hides them, ←/→ on it seek ±30 s.
- Loading / stalls: `pollStats()` hits `GET /torrents/:hash/stats` every second while the spinner is up (before `playerReady`, or after a `waiting` event until `playing`) and shows the stage (connecting to peers → fetching torrent info → downloading / buffering), peer count, download speed and bytes downloaded.
- Progress bar: `.buffered` (light bar behind the yellow `.progress`) = the `video.buffered` range around the playhead, updated on `progress`/`timeupdate`/seek.
- Stats panel: the controls' `.statsBtn` (right-hand `opts.svg` button) toggles `.statsPanel` (top right; stays up while watching): peers (sending), download speed/total, upload, buffered-ahead seconds, resolution, dropped frames. Polled with the same `pollStats()`. Back with controls hidden closes it before leaving the player.
- Clock: `updateClock()` fades the shell's `.clock` out while actually watching (ready, playing, controls hidden) and back in when controls open or playback pauses; reset on destroy.
5. `leavePlayer()` = `removeTorrent(infoHash)` (engine + data deleted) + `location.back()`.
- Resume / progress (when the request has `tmdbId`): `startAt` from the request if set, otherwise `LibraryService.state()` on init → `applyResume()` seeks to the saved position on the first `canplay` (unless within 30 s of the end) and shows "Resuming from …" for 5 s. `saveProgress()` every 15 s while playing, on `pause`, `ended` and in `ngOnDestroy` (before `src` is cleared); never before playback is ready or before the resume seek (it would overwrite the saved point with 0:00). ≥ 90 % = finished → history (server side).
6. `<video>` `error` (undecodable format) → error + leave. After 5 s of video with zero decoded audio bytes → "No sound" banner (Dolby/DTS audio; see root gotchas).
7. Subtitles: `.ccBtn` → `fetchSubs()` → providers enabled for this kind (movie/episode); tabs shown when more than one; `loadSubtitles(provider)` searches by IMDb id (+season/episode); choosing one appends a `<track>` pointing at `SubtitlesService.fileUrl()`. The provider choice is remembered.

## Recipes

**Add a new page/route**
1. `ng g c my-page` (adds to `AppModule.declarations`), add the route in `app-routing.module.ts`.
2. In `ngAfterViewInit`: register nav section(s) + `focus`; subscribe to `navigation.executeCommand()` guarded by `this.router.url`.
3. Handle `'back'` (usually `location.back()`), `menuService.sendInstruction('hide'|'show'|'collapse')` as needed.
4. In `ngOnDestroy`: remove sections, unsubscribe, remove window/document listeners.
5. Menu entry: `<button class="tabGroup element menuItem" data-destination="x">` in `menu.component.html` + a case in `MenuComponent.navigate()`.
6. If the component's host is a flex item of `.pageContainer`/`.masterContainer` and contains wide rows, give it `:host { display: block; min-width: 0; }`.

**Add a row**: append `new Category(name, {url, params: {}})` to `categories` or `showCategories` (use `<<api_key>>`). Paging and slider wiring are automatic.

**Add another section (e.g. anime)**: add a `MediaType`, a `Catalog` in `MoviesService.catalogs`, routes with `data.media`, an enrichment branch in `MoviesPageComponent`, and a detail component.

**Call a new server endpoint**: method in the relevant service using `` `${STREAMING_SERVER}/…` `` from `server-config.ts`.

**Don't name an element `.description`** (or `.menuItem`, `.element`, `.tabs`) outside the menu: `MenuComponent` queries those document-wide (e.g. collapsing sets `display:none` on every `.description`). Menu items rendered after a collapse (the profile entry) rely on the `.menuContainer:not(.expended) .description { display: none }` rule.

**Styling**: per-component SCSS; global fonts in `src/styles.scss`. Focus state is the `.focused` class (outline disabled globally). Layout assumes a 1440px-wide viewport.
