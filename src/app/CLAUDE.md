# Angular UI (`src/app`) — Agent Guide

Single NgModule app (`app.module.ts`), Angular 14, no lazy loading, no standalone components. Everything is driven by keyboard via spatial navigation and coordinated through RxJS Subjects in root services. See the root [`CLAUDE.md`](../../CLAUDE.md) for the overall architecture, data sources and ports.

## Layout of the shell (`app.component.html`)

```
<splash>                         full-screen intro video; emits 'clearSplash' when done
.masterContainer (flex row)
  <menu>                         left nav: current profile (→ /profiles) / Search / Movies / Tv shows / Watch list / 18+ (not for kids) / Settings*  (*placeholder)
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
| `/adult` | — (`AdultLayoutGuard` redirect) | Opens the profile's 18+ layout: `/adult/browse` (posters, default) or `/adult/releases` (compact). All `/adult/*` routes: `AdultGuard` (no profile → `/profiles`, kids → `/movies/list`) |
| `/adult/browse` | `AdultBrowseComponent` (`adult-browse/`) | 18+ poster layout: metadata provider rows (like the movies page), search, studio / release-period filters |
| `/adult/title/:provider/:id` | `AdultTitleComponent` (`adult-title/`) | One 18+ title: details, performers, Play (torrents by title + year), Find releases, More from <studio> |
| `/adult/releases` | `AdultPageComponent` (`adult-page/`) | 18+ compact layout: one torrent source's releases, most seeded first, search and filters |
| `/player` | `PlayerPageComponent` (`player-page/`) | Plays `PlaybackService.current` (movie or episode); subtitle side panel with provider tabs |
| `/search` | `SearchPageComponent` (`search-page/`) | On-screen keyboard, filter chips (All / Movies / TV shows / Anime / People), TMDB search with one row per result type |
| `/ytplayer/:id` | `YoutubeComponent` (`youtube/`) | Trailer player (server side currently broken, see root CLAUDE.md) |
| `/power` | `PowerPageComponent` (`power-page/`) | Quit / Sleep / Shutdown / Restart → Electron :3344 |

`movies`, `shows`, `watchlist`, `player`, `search`, `ytplayer` are guarded by `ProfileGuard` (no current profile → `/profiles`). The current profile is in-memory only: every app start goes through "Who's watching?".

Reached from: start → `/profiles` → Enter on a profile → `/movies/list`. List page → Escape with the menu expanded & focused → `/power`. Menu "Search" → `/search`, "Movies" → `/movies/list`, "Tv shows" → `/shows/list`, "Watch list" → `/watchlist`, "18+" → `/adult` → the profile's layout (item hidden for kids profiles). Poster Enter → the catalog's detail URL.

## Component index

| Folder | Class / selector | Key responsibilities |
|---|---|---|
| `app.component.*` | `AppComponent` / `app-root` | **Input hub**: `spatialNavigation.init()`, executes `NavigationService.updateNavigation` instructions, toggles `.focused` on `sn:focused`/`sn:unfocused`, maps the `select` action (Enter)→`click` / `back` (Escape)→`back` via `keymap.ts`. Select on a list page poster → `moviesPageNavigation()` (GSAP out → `catalog.detailUrl(id)`; movies also go on `movieAppHistory`). Background crossfade/Ken-Burns via GSAP. |
| `menu/` | `MenuComponent` / `menu` | Expand/collapse/hide/show via `MenuServiceService`; auto-expands when a `.menuItem` is focused. `navigate()` routes by `data-destination`. Active tab from the URL (`/movies`, `/shows`). |
| `movies-page/` | `MoviesPageComponent` / `movies-page` | Generic section page (see above). Seeds rows in category order, fetches each category once, appends pages on request, enriches the focused item (`enrichMovie` / `enrichShow`), clears a selection left over from the other section. Host has `min-width: 0` (flex item). |
| `movies-slider/` | `MoviesSliderComponent` / `movies-slider` | Renders the catalog's non-empty rows, registers `slider` + `menu` sections, scrolls rows/columns with `transform`, requests the next page 10 items before a row's end (`limit = 20`), restores position from `catalog.navigationData`. Each row's aligned poster (`reached`) carries `.lastSelected`; posters' `data-sn-up/down` point at the neighbour row's `.lastSelected` (keys and wheel land there, no sideways jump). Mouse hover doesn't change `reached`; opening a poster does (`AppComponent.moviesPageNavigation`). Rows other than the current one get `data-pointer-hover="off"`. Back → expand menu / go to `/power`. |
| `movie-description/` | `MovieDescriptionComponent` / `movie-description` | Title, year, qualities or season count, IMDb/TMDB score, genres, overview; pushes `backdrop_path` to `BackgroundService`. Listens to `checkSelection()` and `onDescriptionUpdate()`. |
| `movie-options/` | `MovieOptionsComponent` / `app-movie-options` | Movie detail (`options` + `menu` sections): credits, similar, trailer, YTS play data. Play → torrent picker (YTS `torrents`) → `PlaybackService.playMovie(movie, torrent)` → `/player`; Enter on a similar title opens it. Back pops `movieAppHistory`. Scrolls **natively**: adds `.nativeScroll` to `.pageContainer` (vertical `scrollTo`, `ensureSectionVisible`) and the cast/similar rows are `overflow-x: auto` (`scrollRowTo`, focused item ~⅓ in); no transforms. |
| `show-options/` | `ShowOptionsComponent` / `app-show-options` | Show detail (`showOptions` + `menu` sections). Loads `getTvDetails` (incl. `external_ids.imdb_id`, videos); seasons sorted with Specials last; focusing a season loads it (`switchMap`, latest wins); episodes flagged `upcoming` if not aired. Enter on an episode / "Play" → `TorrentService.findEpisodeTorrents` → torrent picker (server ranking, first = "Best match") → `PlaybackService.play({...season, episode})` → `/player`. Rows scroll with `scrollRowTo` (focused item ~⅓ in) and `ensureRowVisible` (slides `.pageContainer` up). |
| `player-page/` | `PlayerPageComponent` / `app-player-page` | See "Player" below. |
| `search-page/` | `SearchPageComponent` / `app-search-page` | Virtual keyboard (`.keyboardBtn`, `data-fct` = del/space/num/char) → TMDB search when the query has ≥ 3 chars (debounced, latest wins). Filter chips (`.filterChip[data-filter]`, Enter/click selects): **All** = `search/multi` → rows Movies / TV shows / People; **Movies** / **TV shows** / **People** = `search/movie|tv|person`; **Anime** = movie + tv searches filtered to genre 16 + `original_language: 'ja'` → Anime series / Anime movies; **18+** = movie + tv searches with `include_adult=true`, only `adult: true` results. TMDB ranks all regular results before adult ones, so `searchAdult()` reads page `regular total / 20 + 1` (−1…+3), the last two pages and page 1 (queries with > 10,000 regular matches can't reach them: TMDB stops at page 500) → Adult movies / Adult TV shows (the other filters never include adult titles; the chip is hidden and the filter refused for kids profiles). Empty rows are dropped; no result → a note. Enter: movie → `/movies/movie/:id` (via history stack), show → `/shows/show/:id`, person → `combined_credits` row "With <name>" under theirs (badge "TV" on series). Rows scroll with `transform` just enough to show the focused item; the page slides up for lower rows; paddles for the mouse. Up/down via `data-sn-up/down` → neighbour row's `.lastSelected`. Sections `keyboard`, `searchFilters`, `searches`. State (`SearchState`: query, filter, rows, focusKey) in `MoviesService.searchData`, restored when coming back from a title; Back clears it. |
| `youtube/` | `YoutubeComponent` / `youtube` | `<video class="ytPlayer">` ← `STREAMING_SERVER/youtube/:id?type=video&quality=136`, hidden `<video class="audioTrack">` ← `?type=audio`, synced on `timeupdate`. ←/→ seek 5s. |
| `power-page/` | `PowerPageComponent` / `power-page` | `.powerBtn[data-instruction]` → `PowerService`. |
| `torrent-picker/` | `TorrentPickerComponent` / `torrent-picker` | Modal list of torrents (quality, codec/source tags, size, seeds, playability/audio warnings). Own `torrentPicker` section (`restrict: self-only`); while open `AppComponent` forwards select/back to it instead of the pages; restores the previous focus on close. Options scroll natively. |
| `play-choice/` | `PlayChoiceComponent` / `play-choice` | Same frame and key handling as the torrent picker (`playChoice` section; `AppComponent` forwards select/back while `PlayChoiceService.isOpen`). Two options: **Resume** (time + amber bar) and **Play from the beginning**. Used by Play on the movie page and Enter/Play on an episode, only when `LibraryService.state()` has a resume point. Resume with a saved `infoHash` plays that same release directly (bare hash as the magnet, no torrent picker) so the position matches; otherwise and for "from the beginning" the torrent picker follows. The choice reaches the player as `PlaybackRequest.startAt` (seconds; 0 = from the start). |
| `notification-handler/` | `NotificationHandlerComponent` / `notification-handler` | Shows `NotificationService` `type: 'error'` messages; `okBtn` section (`restrict: self-only`) traps focus. |
| `splash/` | `SplashComponent` / `splash` | Plays the intro video, fades out, emits `'clearSplash'` (`SplashService.cleared` flips to true). The picker ignores Enter/Escape until then; the slider focuses its first poster when it opens after the splash with no row visited (`focusFirstWhenReady`). |
| `profile-picker/` | `ProfilePickerComponent` / `app-profile-picker` | Full-screen (z 10, under the splash) "Who's watching?": tiles + "Add Profile" (hidden at `maxProfiles`) + "Manage Profiles" (toggles edit overlays; `ProfilesService.picker.managing`). Enter: managing → editor; locked → `<pin-pad>`; else `unlock` → GSAP out → `/movies/list`. Back: leave manage mode, else `/power`. Focus restored from `picker.focusId` (last focused/edited) or the server's `lastUsedId`. Section `profiles`. |
| `profile-editor/` | `ProfileEditorComponent` / `app-profile-editor` | Edits locally, sends on Save (`update`, then `setPin` if the PIN changed; `create` for new). Overlay panels, each its own `restrict: self-only` section opened/removed on demand: the name keyboard (`<text-keyboard>`), `avatarChooser`, `confirmDelete`; PIN via `<pin-pad>`. Back closes the panel, else cancels. Section `profileEditor`. |
| `watchlist-page/` | `WatchlistPageComponent` / `app-watchlist-page` | Laid out like the movies page: a title-info header (as `<movie-description>`: name; year, Movie/Series chip, runtime or season count, TMDB score; genres; the profile's status line + amber progress line for resumes; overview). Details come from TMDB (`getTmdbMovieDetails` / `getTvDetails`) for the focused card, debounced 150 ms and cached per title and category-style rows below (same 180×270 posters, `sliderContainer` 370 px; **movement system**: `pxStack="watchlist" motion="transform"` of `pxRow`s, focused row moved to the top, focused poster to the row start; wheel steps a row / a poster). One `GET …/library` call → rows, empty ones left out: "Continue watching series" / "Continue watching movies" (most recently watched kind first; amber line on the poster), "My list", "Watched this week / this month / earlier". The shell backdrop follows focus (`BackgroundService`). Enter: show → `/shows/show/:id`; movie → `getTmdbMovieDetails` + `addMovieToHistory` → `/movies/movie/:id`. Back: menu, then `/movies/list`. Focus and row offsets restored on return (`PositionStore`). Section `library` (`pxSection` on the page; + re-registers `menu`, right → `['stack:watchlist', '@library']`). Amber `#FFC107` means "progress" here and on episode thumbnails — keep it for that. |
| `text-keyboard/` | `TextKeyboardComponent` / `text-keyboard` | Full-screen on-screen keyboard (A–Z, 0–9, space/del/clear/done; physical typing too). Inputs `title, placeholder, value, maxLength, capitalizeWords` (on-screen capitals start words — names — or type lower case — searches), `doneLabel`; outputs `(done)` text / `(cancelled)` on back. Owns section `textKeyboard` (trapping `pxSection`; keys are a `pxGrid` + a one-line `pxGrid`, entered `nearest`); hosts ignore click/back while it is open. Used by the profile editor (name) and the 18+ page (search) |
| `adult-page/` | `AdultPageComponent` / `app-adult-page` | **Compact layout** (`/adult/releases`). Left rail (section `adultFilters`): search field → `<text-keyboard>` (search on Done), Clear search, **Source** chips (`/api/adult/providers`, default The Pirate Bay), **Quality** chips (Any/4K/1080p/720p/SD), "Only releases that play here" switch, "Poster view" (saves `layout: 'posters'`). Right (section `adultReleases`): `/api/adult/browse` list, seed count as each row's headline + seed meter (√ of the top count), cleaned title, studio/year/split scenes/age, raw release name, quality/size tags and "May not play" / "Probably no sound". Movement system: rail = `pxSection` (right → `['grid:adult-releases', '@adultReleases']`), list = `pxGrid="adult-releases"` (`align="third"`, scrolls natively, `nearEnd` 8 rows before the end or when scrolled near it → next page of paged sources). Enter → `PlaybackService.play({title, subtitle, magnet, adult: true})` → `/player` (nothing saved to the profile). Back: list → rail → menu → `/movies/list`. State in `AdultService.state` (restored after the player, reset when the profile changes); the focused release lives in `PositionStore` (cleared when the list is new). Own fixed wine-tinted backdrop over the shell's (`:host::before`, z −1 inside `.masterContainer`) |
| `adult-browse/` | `AdultBrowseComponent` / `app-adult-browse` | **Poster layout** (`/adult/browse`), built like the watch list: toolbar (section `adultToolbar`: 18+ seal, search field → `<text-keyboard>`, filter button → filter panel, Clear, "List view" which saves `layout: 'compact'`), title info of the focused poster (provider details debounced 150 ms and cached: runtime, performers; backdrop → `BackgroundService` as a full URL), 180×270 poster rows (section `adultPosters`; **movement system**: `pxStack="adult-browse" align="row-top" motion="transform"` of `pxRow`s (translated; wheel steps a row / a poster), paddles = `pxRow.page()`, `nearEnd` 6 posters before the end). Toolbar down / menu right → `['stack:adult-browse', '@adultPosters', …]`, so an empty result lands on the empty state's button. Rows: no filter → the provider's `home` rows; studio/period → Popular / Newest / Top rated within them (`discover`); search → one "Results for …" row. Filter panel (section `adultFilterPanel`, trapping `pxSection` over a `pxStack` of `pxGrid`s): studio grid + release periods (from the provider), applied by "Show titles", back cancels. Enter → `/adult/title/:provider/:id` (`AdultService.openedTitle` renders it at once). Back: posters → toolbar → menu → `/movies/list`. State in `AdultService.browseState` (rows, filters), rebuilt when the profile's provider changes; focused poster and offsets in `PositionStore` (cleared on a search / filter change) |
| `adult-title/` | `AdultTitleComponent` / `app-adult-title` | Section `adultTitle` (`pxSection`; the page is a `pxStack` of the actions `pxGrid` and the "More from" `pxRow align="third"`). Title, year, studio, runtime, provider rating, overview, performer portraits, **Play** → `TorrentService.findAdultTorrents(title, year)` → torrent picker → `PlaybackService.play({…, adult: true})`; **Find releases** → compact layout searched for the title; "More from <studio>" (provider row `studio:<id>`, only for the provider's own studios; Enter opens that title on the same page). Back → `location.back()` |
| `pin-pad/` | `PinPadComponent` / `pin-pad` | 4-digit PIN overlay (keypad + number keys/Backspace). `(completed)` then waits for the host to close it or call `fail(msg)` (shake + message); `(cancelled)` on Cancel/back. Section `pinPad`; hosts ignore click/back while it is open. |
| `clock/` | `ClockComponent` / `clock` | 12h clock, refresh every 10s. |
| `descrition-viewer/` | `DescritionViewerComponent` | Unused CLI stub (typo in name is real). |
| `catalog.ts` | `Catalog`, `MediaType` | Section state (see above). |
| `categories.ts` | `Category`, `categories[]`, `showCategories[]` | Rows: name + TMDB URL with `<<api_key>>` placeholder. **Add/remove a row here**; array order = display order. |
| `pointer.service.ts` | `PointerService`, `isPointerFocus()`, `pagedIndex()` | **Mouse**, layered on the keyboard model (`init()` from `AppComponent`). Real movement over a navigable element → `spatialNavigation.focus(el)` (respecting `restrict: 'self-only'` + `leaveFor`, so modals trap the mouse too); left click → focus + synthetic `select` keydown/keyup (elements inside `[data-pointer="own"]` handle the click themselves, e.g. the player timeline); right click / mouse button 3 → `back`; wheel: over `motion="transform"` containers → `FocusEngine.wheel()` steps them (a row, a poster); elsewhere on pages migrated to the movement system (a `[data-px-native-wheel]` element on screen) the browser scrolls natively (stack vertically, rows sideways with a trackpad / shift + wheel; focus doesn't move), elsewhere → up/down keys (hover focus pauses 350 ms after each step while rows slide); off while `wheelNavigation = false` (the player). Content scrolling under the cursor pauses hover focus for 150 ms. Feeds `FocusEngine` (`pointerActive()`, hover = `focus(el, 'pointer')`, `leads()` for `canReach`). Cursor: `body.pointer-hidden` after any real key press, removed on mouse movement (the first nudge only reveals it); `body.pointer-pressed` while the button is down. `moved` Subject (player shows controls, hides them + the cursor after 3 s idle). Unmigrated pages that scroll rows on focus skip it when `isPointerFocus()` (the row would slide under the cursor); `pagedIndex()` is their paddle helper. Containers with `data-pointer-hover="off"` (rows peeking in below the current one) ignore hover; a click brings the row in at its `.lastSelected` without selecting. |
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
| | | `search(kind, query)` (`multi`/`movie`/`tv`/`person`), `getPersonCredits(id)`; `searchData` BehaviorSubject<`SearchState`> | search-page |
| `playback.service.ts` | `PlaybackService` | `current: PlaybackRequest` (`title, subtitle?, year?, runtimeMinutes?, magnet, imdbId?, season?, episode?, mediaType?, tmdbId?, artwork?, startAt?` — `mediaType/tmdbId/artwork` let the player resume and save progress; `startAt` = the user's Resume / from-the-beginning choice, unset = resume automatically); `play(request)`; `playMovie(movie, torrent, startAt?)` builds the magnet (torrent needs only `hash`) + fills `tmdbId`/`artwork` | movie/show options → player |
| `torrent.service.ts` | `TorrentService` | `registerTorrent(magnet)`, `getTorrent(hash)`, `deselectTorrent(hash)`, `removeTorrent(hash)`, `findEpisodeTorrents(imdbId, title, season, episode)` | player, show-options |
| `subtitles.service.ts` | `SubtitlesService` | `getProviders()`, `search(provider, {imdbId, season?, episode?}, languages)`, `fileUrl(subtitle)` (WebVTT), `preferredProvider` (localStorage) | player |
| `menu-service.service.ts` | `MenuServiceService` | `sendInstruction('collapse'\|'expand'\|'hide'\|'show'\|'navigate', source)`; `menuState` | pages → menu |
| `background.service.ts` | `BackgroundService` | `sendImage(tmdbPath or full URL)` (deduped) / `getImage()` | movie-description → AppComponent |
| `play-choice.service.ts` | `PlayChoiceService` | `choose(title, {positionS, durationS})` → Observable emitting `'resume' \| 'restart'` (completes empty on back); `isOpen`, `sendCommand(action)` | movie/show options → play-choice; AppComponent → play-choice |
| `torrent-picker.service.ts` | `TorrentPickerService` | `choose(title, options)` → Observable emitting the picked `TorrentOption` (completes empty on back); `TorrentPickerService.fromYts(t)` / `fromEpisode(t, i)` normalize provider torrents; `isOpen`, `sendCommand(action)` | movie/show options → picker; AppComponent → picker |
| `notification.service.ts` | `NotificationService` | `sendNotification('error', msg)` | any → notification-handler |
| `splash.service.ts` | `SplashService` | `'clearSplash'`, `cleared` flag | splash → section page, picker, slider |
| `library.service.ts` | `LibraryService` | Current profile's data (`…/api/profiles/:id/…`; no profile → `EMPTY`): `library()`, `inWatchlist/addToWatchlist/removeFromWatchlist(ref)`, `state(key)` → `{resume, finished}`, `episodesProgress(ref)`, `saveProgress(key, body)`, `markWatched/markUnwatched(key)`. Static `artworkOf(tmdbItem)` → `{title, posterPath, backdropPath, genreIds}` (sent with every write so rows render without TMDB) | watchlist page, movie/show options, player |
| `profiles.service.ts` | `ProfilesService` | `/api/profiles` client: `list()` → `{profiles, lastUsedId, maxProfiles}`, `get`, `create`, `update`, `setPin(id, pin\|null)`, `remove`, `unlock(id, pin?)` (sets `current`). `current` BehaviorSubject (who's watching), `picker` UI state, `AVATARS` (`src/assets/avatars/avatar-NN.svg`), static `avatarUrl()` / `errorMessage()` | picker, editor, menu, `ProfileGuard` |
| `adult.service.ts` | `AdultService` | **Preferences** (per profile, server `preferences.adult`; Settings will edit them): `preferences` → `{ layout: 'posters'\|'compact', metadataProvider: id\|null }`, `setPreferences(patch)`, `layoutUrl()`. **Catalog** (`/api/adult/meta`): `metaProviders()`, `metaProvider()` (the profile's if enabled, else the default), `home`, `row`, `discover`, `searchTitles`, `studios`, `title`. **Releases**: `providers()`, `browse(...)`. State: `state` (compact), `browseState` (posters), `openedTitle`; reset when the profile (id) changes | adult pages |
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

Unmigrated pages join rows with per-element overrides and a `.lastSelected` marker per row, e.g. `data-sn-down=".showOptionsContainer .seasons .lastSelected"`, updated in the page's `sn:focused` handler. Migrated pages use the **movement system** instead (below).

Section ids in use: `menu`, `slider`, `options`, `showOptions`, `timeSlider`, `optionPannel`, `subs`, `keyboard`, `searches`, `searchFilters`, `powerControls`, `okBtn`, `torrentPicker`, `profiles`, `profileEditor`, `textKeyboard`, `avatarChooser`, `confirmDelete`, `pinPad`, `library`, `adultFilters`, `adultReleases`, `adultToolbar`, `adultPosters`, `adultFilterPanel`, `adultTitle`. Pages that show the left menu re-register `menu` with their own `leaveFor.right` (`FocusEngine.target([...])` for fallback chains / container targets). Migrated pages declare their own sections with `pxSection` (same ids).

Key handling (bindings live in `keymap.ts` — change keys there only):
- Arrows → library fires `sn:willmove` → `FocusEngine` moves inside movement containers, else the library moves focus → `sn:focused` → `AppComponent` adds `.focused` (style hook), `FocusEngine` remembers + scrolls, page listeners react (unmigrated pages scroll rows via `transform`; position memory, menu collapse…).
- `select` (Enter) → `NavigationService.addCommand('click')` (except on list-page posters → `AppComponent.moviesPageNavigation`, and on a menu item → `MenuServiceService 'navigate'`).
- `back` (Escape) → `addCommand('back')`.
- Every subscriber to `executeCommand()` checks `this.router.url`.
- Programmatic `element.focus()` only produces `sn:focused` when the window has OS focus (matters for headless/offscreen testing); `SpatialNavigation.focus(el)` (global `window.SpatialNavigation`) always does. Real keys work in an offscreen Electron window when sent with Electron's key names: `webContents.sendInputEvent({type:'keyDown', keyCode:'Right'})` (`Left/Up/Down`, `Return`, `Escape`), **not** `'ArrowRight'` (silently ignored).

## Movement system (`movement/`) — focus movement and native scrolling

Plan and rationale: [`docs/movement-system-plan.md`](../../docs/movement-system-plan.md). Migrated so far: `adult-browse`, `adult-title`, `adult-page`, `text-keyboard` (so also the profile editor's name panel), `watchlist-page`. Everything else still uses transforms + `data-sn-*` (see above); both coexist.

Principles: movement **inside** a container is **by index**, geometry (the library) only between sections; focus drives scroll for keys, scroll never drives focus for the mouse; wiring is declarative in templates. **How** a container moves is its **motion** (`motion.ts`), chosen per container, everything else (engine, memory, paging, handoff) is shared:
- `motion="scroll"` (default): the container really scrolls (`overflow: auto`, hidden scrollbars), native wheel / trackpad / momentum, CSS snapping; glides are rAF tweens (`Scroller`). For detail pages, lists, panels.
- `motion="transform"`: the container clips, its track is moved with `translate3d` + a CSS transition (runs on the compositor: stays smooth while the page is busy). The browser can't scroll it, so `FocusEngine.wheel()` steps it: vertical wheel = one row of the stack, sideways (trackpad, tilt, shift + wheel) = one poster of the row under the cursor, focus unchanged. **For category pages** (cards in rows): 18+ posters, watch list, later the movies / TV rows.

| Piece | What it does |
|---|---|
| `pxItem` `[pxItemKey]` | Marks an item of a container; the key is what positions are remembered by. Must also be in a nav section (`pxSection` picks up `[data-px-item]` and `.focusable`). |
| `pxRow="key"` (`exportAs: 'pxRow'`) | Horizontal scroll container (adds `.px-scroll-x`). Left/right = index ± 1; `align` `start` (posters) / `third` (cast, episodes) / `nearest` / `center`; `[loadAhead]` / `[loadAheadPx]` → `(nearEnd)` on focus or scroll near the end; `page(±1)` for paddles (`#r="pxRow"`, paddles are siblings inside `.pagedRow`; `atStart`/`atEnd` classes from the real scroll). |
| `motion="scroll"\|"transform"` (any container) | See above. Nested containers inherit their parent's (rows take their stack's). A transform stack needs a `pxTrack` child wrapping its rows (the host clips, things beside the track such as the `.overlay` stay put); a transform row is its own track and relies on an ancestor (its stack) to clip. Positions are offsets either way (`Motion.offset/viewport/moveTo/moveBy/toContent`), so containers never read `scrollLeft` themselves. |
| `pxStack="id"` | Vertical sequence of entries (rows, grids or single items; adds `.px-scroll-y`). Up/down = neighbour entry's remembered item, empty entries skipped. `align="row-top"` (adds room after the last row so it can reach the top) or `nearest`. `[snap]` (default on for `row-top` with scroll motion; transform stacks step by rows anyway): wheel / trackpad scrolling snaps to the entries' blocks (CSS `scroll-snap`, `.px-snap-y` / `.px-snap-point`; the Scroller adds `.px-snap-paused` while it glides). `pxStackItem` marks the block to align (a row's section with its title). |
| `pxGrid` | 2D / one-column list (chips, keyboards, the release list, short button lines). Sideways within a visual line, up/down to the nearest entry of the next line (`columns="auto"` reads lines from layout). Doesn't style overflow: the page decides whether it scrolls. |
| `pxSection="id"` | Spatial-nav section added on init, removed on destroy, re-added when `[leaveFor]` changes. Targets: `'@section'`, a CSS selector, `'stack:<id>'` / `'row:<id>'` / `'grid:<id>'` (entered at the remembered item) or an array tried in order. `[trap]="true"` = modal. Don't nest sections. |
| `enter="remembered"\|"nearest"` (any container) | Entering a container: its remembered entry (default) or the on-screen entry nearest to where focus comes from (keyboards, filter grids). |
| `FocusEngine` | Window listeners (`sn:willmove`, `sn:focused`, keydown, capture). Asks the innermost container for the next item, cancels the library's move when it has one; drops key repeats closer than a frame. `focus(el, cause)`: `key` (remember + glide), `pointer` (no scroll, not remembered), `select` (Enter/click: remember, no scroll), `restore` (instant). `restore('stack:<id>')` on page entry; `target([...])` builds a library `leaveFor` value (the library calls functions, a small Playpex patch). First arrow after the mouse scrolled: continues from the on-screen item nearest to the alignment point instead of jumping back. |
| `Scroller` | rAF tween per container and axis (easeOutCubic, 250 ms), re-targets a running tween (held keys glide), instant with `prefers-reduced-motion` / hidden windows, stops when the user wheels or drags. Pure alignment helpers (`alignedScroll`, `offsetWithin` — offsets, transforms ignored). |
| `PositionStore` | `<stack>/<row>` and `<id>` → `{key, index, scrollLeft, scrollTop}`, in root (survives the player / title pages), cleared on profile change. Pages `clear(id)` when their data is replaced (new search / filter). |

**Migrating a page** (see the 18+ pages for complete examples):
1. Template: `data-px-native-wheel` on the page root (the wheel scrolls natively while it's on screen); `pxSection` on each focus area (same ids as before); rows → `pxStack` + `pxStackItem` + `pxRow` + `pxItem`; paddles → `r.page(±1)`; drop `data-sn-up/down`, `.lastSelected` and `atStart` bindings.
2. Component: delete `transform` scrolling, `neighbour()`, `pageRow()`, `isPointerFocus()` checks and focus keys; keep the `sn:focused` listener only for **data** (description, backdrop); paging from `(nearEnd)`; initial / return focus = `engine.restore('stack:<id>')` (falls back to the first on-screen item); register `menu` with `leaveFor.right: engine.target(['stack:<id>', '@<section>'])`.
3. SCSS: the scroll container needs a definite size (`height`, or flex `min-height: 0`); rows need room for the focused item's zoom inside them (`padding` + negative `margin`, `scroll-padding-inline` = the padding; posters 180×270 ×1.1 → `16px 10px`, keeps the previous poster hidden) and the stack the same sideways room; remove the old `transition`s on transformed wrappers.
4. Verify with the checklist in the plan (§9).

Picking the motion for a new page: category rows of posters → `transform` on the stack (+ `pxTrack` on the rows' wrapper); anything else → leave the default.

Tests: `src/app/movement/*.spec.ts` (`CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --include src/app/movement`).

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

**Mouse**: hover/click/back work automatically for anything in a spatial-nav section. Pages on the movement system get native wheel scrolling and correct hover for free; on the others, if a page moves content when focus changes, guard it with `isPointerFocus()`. Mouse-only controls (row paddles `.pagedRow > .rowPaddle`, global styles) are plain `(click)` elements outside any section; show them only under `body:not(.pointer-hidden)`. Decorative layers over content need `pointer-events: none` (all `.overlay` elements have it globally).

**Rows next to the menu**: on the movies page `.sliderContainer` uses `overflow: clip` + `overflow-clip-margin: 10px` (posters scrolled off to the left would otherwise show over the menu; the margin keeps the focused poster's zoom whole). Migrated pages (watch list, 18+) get the same from the scrolling stack and rows themselves: 10px of padding (with matching negative margins) is room for the 9px zoom and keeps the previous poster (10px gap) hidden.

**Styling**: per-component SCSS; global fonts in `src/styles.scss`. Focus state is the `.focused` class (outline disabled globally). Layout assumes a 1440px-wide viewport.
