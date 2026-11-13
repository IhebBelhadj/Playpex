# Rows and recommendations: plan

Status (2026-11-13): **in progress, steps 1–3 built** (uncommitted). Decisions A–G (§9) taken as recommended when the work started; H–J added the same day for Stremio catalogs and recommendation add-ons (§4.1–§4.3). Built: `packages/protocol/rows.js`, `contributes.rows` / `rowFill` / `joinsSetting` (**SERVER_PLUGIN_API 1.6**), the routes in `openapi.yaml`, `docs/api/rows.md`; the server's `row_layouts` / `profile_row_layouts` (migration 0020), `lib/services/layouts.js`, `lib/rows/` (defaults, resolver), `lib/routes/rows.js`, the admin's `/admin/sections/*`, `recommendations.because()`; the Stremio adapter's offers (one per catalog, params from extras with options, joining where its "Show in" says through `joinsSetting`, the 4-row cap gone for layouts). Tests: `test/rows.test.js`, `test/rows.protocol.test.js`, the contract test, `test/stremio.test.js`. Deviations: a row's items are `GET /sections/{section}/rows/{rowId}/items` (the section in the path); `plugin.all` expands to the offers that *join* the section (offered-only rows are placed one by one); `core.newEpisodes` / `core.genreForYou` wait for step 6. Step 3 (the TV) built the same day: `apps/tv/src/app/sections.service.ts` (`SectionRowsService`: a section's rows from `GET /sections/{section}/rows`, each row's pages from its items route, asked again on a profile change, `rows.changed`, `plugin.changed` and `session.ended`), `catalog.ts` (rows by the server's ids, `RowItem` cards), `categories.ts` gone, a **Home** section (`core.home`, `/home/list`, menu order 15, where the TV opens after "Who's watching?"), plugin rows drawn where their entry is (a card opening a TMDB title is described like the core's, another by its own `info`), `<rows-editor>` (`rows-editor/`); scenario `apps/tv/scripts/scenarios/sections.js` (28 checks), `rows.js` and `catalog.js` adapted; `plugins/hello` 1.1.0 offers a row (`contributes.rows`). Deviations in step 3: Edit rows is the section toolbar's **Rows** button (a panel: Up, Down, Hide / Show per row, Reset to default) and the remote's **menu key** on a card (keymap `options`: Move row up, Move row down, Hide row, Edit rows…), not press-and-hold Enter (Enter selects on key down) or Settings › Rows (hidden rows are listed, and brought back, in the panel); a hidden row stays in the layout (`RowEntry.hidden`) so Show puts it back where it was; layout answers carry each entry's `label`; the server publishes `rows.changed` when a layout is written; an older server (no `/sections`) gets four catalog lists per section and its plugins' slot rows. Continue watching on the TV (the same day, asked by the user): each card says where it is on its picture ("S1 E5 · 1 h 12 min left", "Next: S2 E1"), the info on top has the resume line with the episode's name, Enter on a show's card opens that episode's page (or the next one's), and a show's Play goes back there ("Resume S1 E4"); scenario `apps/tv/scripts/scenarios/continue.js`. Next: step 4 (the dashboard).

## 1. Goal

What a profile sees on its home and sections, and in what order, becomes the server's and the person's choice, not code in each client. Recommendations from what the profile watched become rows like any other.

1. **One list of rows per section**, kept on the server. A section is Home, Movies or TV shows. A row is a TMDB list or discover query, a personal row (Continue watching, For you, Because you watched…, New episodes), a library row (On this server), or a plugin's row (Trakt, a Stremio catalog…).
2. **The admin sets the default layout** on the dashboard. **Each profile can change its own**: move, hide, add rows. Clients show the result and draw no rows of their own.
3. **A recommendation engine on the server** that every client gets the same way. It has one profile model per profile, several candidate sources, and scoring with explanations ("Because you watched Dune"). Its feedback is likes, dislikes, "Not interested", and what was abandoned.
4. **TMDB stays the base.** Titles and their pages are TMDB's, as now. Rows only choose which titles to list. A row from Cinemeta or Trakt opens the same TMDB page as a row of Playpex's own (`docs/plugins/stremio.md`).

Non-goals: replacing TMDB as the catalog; a learned model trained across profiles or servers (each server is one household, and no data leaves it); recommendations for adults plugins (their plays are `tracking: 'none'` and never seed anything).

## 2. What exists today

| What | Where | Problem |
|---|---|---|
| Movies / TV shows rows | `apps/tv/src/app/categories.ts`: 8 movie rows, 9 show rows, hard-coded catalog queries | fixed; only the TV has them |
| Home, Movies, Shows rows on the phone | `apps/mobile/src/lib/catalog.ts` `ROWS`, `app/(tabs)/index.tsx` | another list, different from the TV's |
| Recommendations on the phone | `apps/mobile/src/lib/recommend.ts`: favourite genres from the history, `/similar` of the last title, discover by genre | computed in the client, per client; the TV has none |
| Recommendations on the server | `apps/server/lib/services/recommendations.js`: seeds from the history (≥ 70 % watched) and likes, recency decay (half-life 45 days), TMDB `/recommendations` of the top 10 seeds, genre affinity boost, `because` per item, kids filter | **built and tested, but no route exposes it**: no client sees it |
| Plugin rows | slots `core.movies.rows`, `core.shows.rows` (TV `ui/slots/slots.ts`, mobile `useSlotRows`): always after the section's own rows; rows carry a `key` | can't be ordered or hidden per profile |
| Stremio catalogs | the bridge's placement settings `c<8hex>` (Movies, TV shows, own section, search only, hidden) | a second, plugin-only notion of "where a row goes" |
| Continue watching, My list, Watched | `GET /profiles/{id}/library` → the TV's Watch list page, the phone's Home | not placeable in sections |
| Per-profile settings | `profile_settings` + the key registry `packages/protocol/settings.js` (settings plan, done) | the store this plan uses for overrides |

## 3. Rows

A **row definition** says what fills a row. It is the same everywhere: in a layout, in the API and in the editors.

```js
{
  id: 'r_8f3a…',                 // stable, given by the server when the row is added
  source: 'core.list',           // which kind (the registry below)
  params: { mediaType: 'movie', list: 'popular' },
  title: 'Trending',             // optional: else the source's own title ("Because you watched {title}")
  variant: 'poster'              // optional: poster | landscape | top10
}
```

The core's sources (`packages/protocol/rows.js`, shared like `settings.js`):

| Source | Params | Fills with |
|---|---|---|
| `core.list` | `mediaType`, `list` (popular, top_rated, trending, now_playing, upcoming, airing_today, on_the_air) | `/catalog/lists/…` |
| `core.discover` | a `BrowseQuery` (genres any / all, era, min score, language, sort, `withoutGenres`, `minVotes`) | `/catalog/discover/…` (today's TV genre rows are these) |
| `core.continue` | `mediaType?` | the profile's resume points |
| `core.watchlist` | `mediaType?` | My list |
| `core.forYou` | `mediaType?` | the engine's top picks (§5) |
| `core.because` | `mediaType?`, `count` (1–3) | **expands** into up to `count` rows, one per strongest recent seed: "Because you watched {title}" |
| `core.newEpisodes` | — | aired episodes of shows the profile follows that it hasn't seen (§5.4) |
| `core.genreForYou` | `mediaType` | the profile's top genre, best rated unseen first: "{Genre} for you" |
| `core.library` | `mediaType?`, `order` (added, unwatched) | On this server |
| `plugin` | `plugin`, `row` (an offer's key), `values` (its params: a genre…) | one row a plugin offers (`contributes.rows`, §4.1) |
| `plugin.all` | `plugin` | **expands** into every row the plugin offers to join this section (`joins` / `joinsSetting`) that the layout doesn't place on its own, in the plugin's order (and a plugin with only the old slots: that slot's answer). What a plugin joins with; follows add-ons whose catalogs change (§4.2) |

Personal sources (`core.continue`, `core.forYou`, `core.because`, `core.newEpisodes`, `core.genreForYou`, `core.watchlist`) are empty for a profile with no data and are then left out of the answer. A new profile sees the catalog rows only, as today.

Every entry may also carry `hideWatched` (drop titles the profile watched or dismissed). It defaults to on for personal rows, core or plugin (§4.1 `personal`), and is off otherwise. It applies to a plugin's cards that open a core title page (`core.movie` / `core.show` intents with a TMDB id), which is what a Stremio catalog's `tt` items are.

## 4. Layouts

A **layout** is the ordered list of row definitions of one section: `home`, `movies` or `shows`. Plugins' own sections (Velvet, a Stremio add-on's) keep their screens and aren't layouts.

- **Default layout** (the admin's): in the server's DB, table `row_layouts (section, rows json, updated_at)`. Its first version is today's rows:
  - Movies and TV shows: the TV's `categories.ts`, as `core.list` / `core.discover`, after `core.continue` and `core.because`.
  - Home: the phone's Home (For you, Continue watching, Because you watched, the two Top 10s, New in cinemas…).
- **A profile's layout**: the default unless the profile changed it. It's stored in its own table, `profile_row_layouts (profile_id, section, rows json, updated_at)`, deleted with the profile (decision I: not `profile_settings`, whose `GET /settings` answers every key to every client). It holds a full list, not a diff: a diff can't say "this row goes first" once the default moves under it. When the default changes, a profile that changed its layout keeps it. "Reset to default" deletes the row.
- **Plugin rows join by themselves.**
  - A plugin that offers rows for a section joins it as one `plugin.all` entry at the end of the default layout, and of every profile's own layout, marked `new` (shown once on the dashboard: "Trakt added rows to Movies"). Splitting it into single `plugin` rows is the dashboard's "Choose rows".
  - A row whose plugin is uninstalled, or hidden from the profile, drops out of the answer but stays in the layout, so reinstalling puts it back in place.
  - A `plugin` row whose offer is gone (a catalog the add-on dropped) is left out silently; a `plugin.all` entry simply expands to what the plugin offers now.

### 4.1 Plugin rows: declared offers (decision H)
Today a plugin's rows come from slot contributions: at most 3 per slot, each answering at most 4 rows, so 12 rows per section, all fetched together, in a place the plugin picks. The Stremio adapter cuts each section at 4 catalogs. Layouts need to know what a plugin offers **without calling it**, and to fill **one row at a time**. Manifests get `contributes.rows` (**SERVER_PLUGIN_API 1.6**):

```js
rows: [{
  key: 'trending',                  // stable: layouts keep it (^[a-z0-9][a-z0-9._-]{0,39}$)
  title: 'Trending on Trakt',       // @i18n allowed
  sections: ['home', 'movies'],     // where it may go
  joins: ['movies'],                // where its plugin.all entry puts it by default ([]: offered only)
  data: 'row', args: { list: 'trending' },
  params: [{ key: 'genre', label: 'Genre', options: [['action', 'Action'], …], required: false }],
  personal: false,                  // its answer depends on the profile (an account): cached per profile, hideWatched on
  candidates: false,                // its titles may feed For you (§5.2), when the admin says so
  variant: 'poster'
}]
```

- The handler is called with `args` plus `{ key, values, page }` and answers a `rowFill`: `{ items: Card[] ≤ 100, last, title? }`. A `title` overrides the offer's (an add-on's "Because you watched …" catalog names its seed).
- At most 200 offers per plugin. `plugin.all` expands to at most 30 rows per section.
- Calls go through the server (`GET /rows/{id}/items`), not the client's `POST /plugins/{id}/data`: the server rewrites images, applies `hideWatched` and the kids rules, and caches (2 min; per profile when `personal`).
- The slots `core.movies.rows` / `core.shows.rows` stay for plugins that don't declare rows (a `plugin.all` entry expands to that slot's answer) and for clients older than layouts. Plugins move to `contributes.rows` at their own pace: Trakt and Velvet's TheSexTube rows when their next versions ship.

### 4.2 Stremio catalogs
The bridge (`docs/stremio-bridge-plan.md` §8.1) synthesizes one offer per catalog:

| Catalog | Offer |
|---|---|
| `key` | its `c<8 hex>` key, stable while its type and id are |
| `sections` | `movie`: Home, Movies · `series`: Home, TV shows · `anime`: Home, TV shows · other types (`tv`, `channel`, custom): Home |
| `joins` | Movies / TV shows for `movie` / `series` catalogs, as their default placement today; nothing for others (they keep their own section) |
| `params` | each `extra` with `options` (a genre, a year…): a choice, `required` as the add-on says. A required genre catalog becomes placeable (today it's hidden): the admin picks the genre when adding it. `skip` is paging. A catalog that requires `search`, or an extra without options, offers no row (Search keeps it) |
| `personal` | on for a configured add-on (an address with a path before `manifest.json`: it often holds an account); the admin can switch it off |
| `candidates` | on for every catalog: the admin decides per row (§5.2) |
| paging | `skip` as now (the adapter learns a catalog's page size from its first page) |

The placement setting keeps *Its own section*, *Search only* and *Hidden* (no offer, no section). *Movies* and *TV shows* fold into layouts: decision D, migration in step 8. The 4-row cap goes.

### 4.3 Recommendation add-ons
Stremio has add-ons that recommend: catalogs built from an account (a Stremio library, Trakt, an AI service), sometimes renamed and replaced every day. For Playpex they are catalogs like any other, with these rules:

- **One account, one plugin.** A configured add-on address is its own plugin already (`idFor` hashes the configuration). The dashboard's Add dialog asks *For everyone* or *For one profile* when the address is configured, and the second sets the plugin's profiles (shown to that one only). Its rows then join the default layout but answer only that profile.
- **Catalogs that change.** The bridge re-reads the add-on daily and on "Check for updates"; a manifest with other catalogs is rebuilt (fewer or other rows apply at once, as today). The `plugin.all` entry follows; a single `plugin` row whose catalog went is left out.
- **What they know.** Only what their own account holds (their Stremio library, their Trakt history). Playpex sends an add-on nothing about what a profile watches; a Trakt-based add-on learns from Playpex plays through the Trakt plugin's scrobbling, when that profile has linked it.
- **Feeding For you.** A row entry can be marked *Also use for For you* (dashboard, default off): its titles that map to TMDB become candidates of the engine (§5.2), scored and explained like the rest ("Recommended by <add-on>" when nothing in the profile explains it better). Without it, the add-on's row shows its own ranking untouched, except `hideWatched`.
- **Adults add-ons** (`behaviorHints.adult`) are adults plugins: never kids profiles, never candidates, plays `tracking: 'none'` (§1 non-goals).
- **Kids profiles**: the same layout rules. Adults plugins never reach them anyway. `core.*` rows apply the kids filter the recommendations service already has.

## 5. The recommendation engine

`lib/recommendations/` replaces `lib/services/recommendations.js`, which keeps its tests as the floor. Everything runs on the server, per profile, from the server's own data and TMDB (no model shared across servers, nothing sent anywhere but TMDB's usual calls).

### 5.1 The profile's taste
Built from these signals:
- **Watched**: a history entry ≥ 70 % watched, or a show with ≥ 2 episodes watched.
- **Liked**: ×2. **Disliked**: excluded, and its features count negatively.
- **Not interested** (§6): excluded, counts weakly against its features.
- **Abandoned**: started, < 15 % watched, not resumed in 14 days. It counts weakly against its features and is never a seed.

Each signal is weighted by recency (half-life 45 days, as now). For a show, the weight grows with the share of episodes watched, capped so a binge doesn't drown the rest.

The taste vector is TMDB features of the watched titles, cached per title, 7 days:
- genres
- **keywords** (`/keywords`: "time travel", "heist"… the strongest signal TMDB gives)
- directors and writers
- the top 5 cast
- original language
- decade

### 5.2 Candidates
Pooled, de-duplicated, at most ~600 per profile:
- **TMDB `/recommendations` and `/similar`** of the top 15 seeds: today's source, widened.
- **Discover by taste**: the top 3 keywords, the top 2 people, the top genre pair, each sorted by rating with a vote floor.
- **Trending** this week: the popularity prior. It keeps the picks current.
- **Plugins' rows marked *Also use for For you*** (§4.3): their titles that map to TMDB (a Stremio catalog's `tt` items through `tmdb.find`, cached), fetched with the profile, at most 100 per row and 300 in all. Rows the profile can't see (plugin hidden, adults) never feed it.
- **Plugins' own candidates**, later: a hook `recommendations.candidates` for plugins without a row to offer (Trakt's recommendations for the linked account). Either way they are only candidates: the engine scores them like any other, and their `because` is the plugin when no seed explains them better.

### 5.3 Scoring
- `score = similarity(taste, candidate) × quality × freshness + seedVotes`
  - **similarity**: the cosine of the feature vectors (keywords and people weighted over genres).
  - **quality**: a Bayesian mean of TMDB's vote (penalises 9.0 from 12 votes).
  - **freshness**: a gentle boost for titles from the last 2 years.
  - **seedVotes**: today's rank-weighted sum, kept.
- **Diversity**: the final list is re-ranked with MMR, so For you isn't 20 Marvel films. At most 3 titles per collection or franchise (TMDB `belongs_to_collection`).
- **Exclusions**, as now: anything watched, in progress, disliked, Not interested, adult, already a seed. Kids profiles keep family, animation and kids titles.
- **Explanation**: each item keeps the seed or feature that contributed most: "Because you watched Dune", "Because you like heist films", "With Florence Pugh". Clients show it on the focused title.

### 5.4 New episodes
Shows with an episode watched in the last 180 days, or on My list. Their next aired, unseen episode (TMDB `next_episode_to_air` / `last_episode_to_air`, cached 12 h) makes a row of episode cards, newest first. "New" is from the profile's last watched episode, not the calendar.

### 5.5 When it runs
- Computed **in the background**: after a play ends (debounced 10 min), after a rating, once a night.
- Kept in `recommendation_cache (profile_id, media_type, items json, built_at)`. A row request answers from the cache at once. A profile with no cache gets the old engine's answer while the new one builds.
- Cost: about 15 seeds × 2 TMDB calls plus about 8 discover calls a build, all cached. It's well inside TMDB's limits for a household.

### 5.6 Checking it works
`test/recommendations.test.js` runs fixed profiles (a sci-fi watcher, a kids profile, a binge of one show, dislikes) against recorded TMDB answers: no watched title, collection caps, kids filter, explanations present. Plus one offline measure: hold out each profile's last 5 watched titles, and report how many of them reach the top 40 (hit rate). This is to compare versions of the engine, not a target.

## 6. Feedback in the clients
- **Not interested**: a new action on title pages, poster long-press on the phone, and the TV's options. It goes in a new table `dismissed (profile_id, media_type, tmdb_id, at)`, undone from the Watch list's Watched page.
- Likes and dislikes exist already (`ratings`); For you shows how to reach them ("Rate what you watched to improve this") while the profile has fewer than 5 seeds.

## 7. API (`openapi.yaml`, client guide `docs/api/rows.md`)

| Route | What |
|---|---|
| `GET /sections/{section}/rows?profile=` | the profile's resolved layout: rows in order, expanded (`core.because`, `plugin.all` → their rows), empty personal rows and unavailable plugin rows left out. Each row is `{ id, title, variant, source, plugin?, kind, personal }` (`kind`: `titles` or `cards`), plus `items` for the first rows when they are at hand (the cache), so a section draws without a call per row |
| `GET /rows/{id}/items?profile=&page=` | one row's page, every source alike: `{ kind, items, last, title? }`. `titles`: catalog titles (with `because` when personal; episode cards for `core.newEpisodes`); `cards`: a plugin's cards, images through the server, `hideWatched` applied. The row id names the layout entry and its expansion (`r_8f3a…~c1a2b3c4`), so it stays valid while the layout does |
| `GET /sections/{section}/layout?profile=` / `PUT` | the profile's layout to edit (`PUT` writes `rows.<section>`; `DELETE` resets) |
| `GET /rows/sources` | what can be added: the core's sources with their params, and every plugin row on offer, by section |
| `GET /admin/sections/{section}/layout` / `PUT` | the default layout (dashboard) |
| `POST /profiles/{id}/dismissed`, `DELETE …/{mediaType}/{tmdbId}` | Not interested |

The plugin slot routes stay: clients already call them, and old clients keep working, showing their own rows until they update. `GET /plugins` gets `capabilities.rows: true` so a client knows the server has layouts.

## 8. Clients and dashboard
- **TV**: Movies and TV shows read `GET /sections/…/rows`. `categories.ts` and the slot's "after the categories" placement go. A plugin row is drawn where its layout entry is.
  - A **Home** section, first in the menu, opens on start (§9 B).
  - **Edit rows** (built differently, see the status): the toolbar's Rows button opens a panel (Up, Down, Hide / Show per row, Reset to default); the menu key on a card: Move row up, Move row down, Hide row, Edit rows…
- **Phone**: Home, Movies and Shows read the same. `ROWS` and `lib/recommend.ts` go. Long-press a row's title: Move, Hide. Settings › Rows.
- **Dashboard**:
  - Settings › Rows: the default layout per section, drag to order, **Add row** (a TMDB list, a discover query built with the Browse filters, a personal row, a plugin's row), rename, variant.
  - Profiles › (a profile) › Rows: the same editor on that profile's layout, with Reset to default.
  - The Stremio tab's placement choice adds the row to the layout.

## 9. Decisions

| | Question | Recommendation |
|---|---|---|
| A | Who can change a profile's rows: anyone using the profile, or only the admin? | **Anyone using the profile**, on its clients and the dashboard. Rows are a viewing preference, like subtitles, not setup. Kids profiles: only the admin (dashboard), so a kid can't unhide what the admin hid |
| B | A Home section on the TV? | **Yes**, first in the menu and where the TV opens after "Who's watching?": For you, Continue watching, Because you watched, New episodes, the Top 10s, then plugin rows. It's what the phone has and what recommendations need to be seen. Movies and TV shows stay as they are |
| C | A full list per profile, or a diff from the default? | **A full list** (§4), with "Reset to default" |
| D | Stremio placements: keep both mechanisms or fold them into layouts? | **Fold** Movies / TV shows into layouts (§4) |
| E | Engine features: TMDB keywords and people, or genres only? | **Keywords and people**: genres alone are what makes today's suggestions feel generic |
| F | Plugins feeding candidates (`recommendations.candidates`)? | **Later**, after the engine's own version ships; Trakt first |
| G | Episodes of New episodes: from TMDB only, or also files arriving on the server? | **Both**: a file of the next episode landing in the library puts it first with "On this server" |
| H | Plugin rows: keep slot contributions, or declared offers filled one row at a time? | **Declared offers** (§4.1, plugin API 1.6), slots kept for old plugins and clients. A Stremio add-on can have 50 catalogs; slots cap a plugin at 12 rows a section, fetched together |
| I | A profile's layout: a profile setting, or a table? | **Its own table** (§4): `GET /settings` sends every profile setting to every client, and a layout is a list of up to 60 entries |
| J | A configured (personal) Stremio add-on: for the household, or for one profile? | **Ask on install** (§4.3), *For one profile* preselected when the address is configured |

## 10. Steps

1. **Protocol**: `rows.js` (sources, params, validation), the layout and row schemas, `contributes.rows` and `rowFill` (plugin API 1.6), the routes in `openapi.yaml`, types; `docs/api/rows.md`.
2. **Server, layouts**: `row_layouts`, `profile_row_layouts`, the default layouts (today's TV and phone rows), the resolver (`plugin.all` joining and expanding, dropping, `core.because` expanding, `hideWatched`), `/sections/*`, `/rows/*`, `/admin/sections/*`. The existing recommendations service backs `core.forYou` / `core.because` for now. The Stremio adapter's offers (§4.2: one per catalog, params from extras, the 4-row cap gone). Tests, the bridge's included.
3. **TV** (built): the sections on the resolved rows, `categories.ts` gone, the Home section, Edit rows (the Rows panel and the menu key; hidden rows listed there rather than in Settings › Rows). Checked with the scenario `sections.js` (and `rows.js`, `catalog.js`, `menu.js`) against a server with layouts and, for `rows.js`, one without.
4. **Dashboard**: Settings › Rows, Profiles › Rows, the Stremio tab's placement.
5. **Phone**: the tabs on the resolved rows, `ROWS` / `recommend.ts` gone, row editing.
6. **Engine v2** (§5): taste vectors, candidate pools, scoring, diversity, explanations, the cache and its background builds, New episodes, Genre for you; the recorded-profile tests and the hit-rate report.
7. **Feedback**: Not interested (`dismissed`), abandoned plays as negatives, the "rate to improve" hint.
8. **Stremio migration** (§4.2: *Movies* / *TV shows* placements into layouts), *For one profile* on install (§4.3), *Also use for For you* feeding the engine, and the plugin author guide's part on rows (`contributes.rows`; `key` must stay stable).
9. **Docs**: this plan's status, the TV / server / mobile / dashboard guides, the root guide.

Steps 1–3 give the visible change (ordered, editable rows and For you on the TV); 6 is where the recommendations get noticeably better. Each step leaves every client working.
