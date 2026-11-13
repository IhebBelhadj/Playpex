# Rows and recommendations: plan

Status (2026-11-12): **proposed**, nothing built. Decisions A–G (§9) carry a recommendation each, not yet confirmed.

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
| `plugin` | `plugin`, `slot data`, `key` | one row of a plugin's slot contribution, by its `key` |

Personal sources (`core.continue`, `core.forYou`, `core.because`, `core.newEpisodes`, `core.genreForYou`, `core.watchlist`) are empty for a profile with no data and are then left out of the answer. A new profile sees the catalog rows only, as today.

## 4. Layouts

A **layout** is the ordered list of row definitions of one section: `home`, `movies` or `shows`. Plugins' own sections (Velvet, a Stremio add-on's) keep their screens and aren't layouts.

- **Default layout** (the admin's): in the server's DB, table `row_layouts (section, rows json, updated_at)`. Its first version is today's rows:
  - Movies and TV shows: the TV's `categories.ts`, as `core.list` / `core.discover`, after `core.continue` and `core.because`.
  - Home: the phone's Home (For you, Continue watching, Because you watched, the two Top 10s, New in cinemas…).
- **A profile's layout**: the default unless the profile changed it. It's stored as a profile setting, `rows.<section>`, in `profile_settings`. It holds a full list, not a diff: a diff can't say "this row goes first" once the default moves under it. When the default changes, a profile that changed its layout keeps it. "Reset to default" deletes the setting.
- **Plugin rows join by themselves.**
  - A plugin installed later puts its rows at the end of the default layout, and of every profile's own layout, marked `new` (shown once on the dashboard: "Trakt added 2 rows to Movies").
  - A row whose plugin is uninstalled, or hidden from the profile, drops out of the answer but stays in the layout, so reinstalling puts it back in place.
  - A plugin row with a key no longer in the plugin's answer is dropped silently.
- **Kids profiles**: the same layout rules. Adults plugins never reach them anyway. `core.*` rows apply the kids filter the recommendations service already has.

### Stremio catalogs
The bridge's placement setting keeps three of its values: *Its own section*, *Search only*, *Hidden*. *Movies* / *TV shows* become plain `plugin` rows in that section's layout. A migration of the Stremio adapter (`contributes.migrate`, plugin API 1.5) moves each catalog placed in Movies or TV shows into the matching layout and drops the two values. One notion of where a row goes, not two.

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
- **Plugins**, later: a hook `recommendations.candidates`, for Trakt's recommendations for the linked account. These are only candidates: the engine scores them like any other.

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
| `GET /sections/{section}/rows?profile=` | the profile's resolved layout: rows in order, expanded (`core.because` → its rows), empty personal rows and unavailable plugin rows left out. Each row is `{ id, title, why?, variant, source, fill }`: `fill` is `{ items: '/rows/{id}/items' }` for core rows, or the plugin's own slot call (`{ plugin, data, args }`) so clients keep drawing plugin cards as they do |
| `GET /rows/{id}/items?profile=&page=` | a core row's page of titles (catalog titles, with `because` when personal; episode cards for `core.newEpisodes`) |
| `GET /sections/{section}/layout?profile=` / `PUT` | the profile's layout to edit (`PUT` writes `rows.<section>`; `DELETE` resets) |
| `GET /rows/sources` | what can be added: the core's sources with their params, and every plugin row on offer, by section |
| `GET /admin/sections/{section}/layout` / `PUT` | the default layout (dashboard) |
| `POST /profiles/{id}/dismissed`, `DELETE …/{mediaType}/{tmdbId}` | Not interested |

The plugin slot routes stay: clients already call them, and old clients keep working, showing their own rows until they update. `GET /plugins` gets `capabilities.rows: true` so a client knows the server has layouts.

## 8. Clients and dashboard
- **TV**: Movies and TV shows read `GET /sections/…/rows`. `categories.ts` and the slot's "after the categories" placement go. A plugin row is drawn where its layout entry is.
  - A **Home** section, first in the menu, opens on start (§9 B).
  - **Edit rows**: from a row's title, press and hold Enter (or the options key): Move up, Move down, Hide. Settings › Rows lists hidden ones and Reset.
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

## 10. Steps

1. **Protocol**: `rows.js` (sources, params, validation), the layout and row schemas, the routes in `openapi.yaml`, types; `docs/api/rows.md`.
2. **Server, layouts**: `row_layouts`, the default layouts (today's TV and phone rows), `rows.<section>` profile settings, the resolver (plugin rows joining, dropping, `core.because` expanding), `/sections/*`, `/rows/*`, `/admin/sections/*`. The existing recommendations service backs `core.forYou` / `core.because` for now. Tests.
3. **TV**: the sections on the resolved rows, `categories.ts` gone, the Home section, Edit rows, Settings › Rows. Screenshots before / after (`npm run screens`).
4. **Dashboard**: Settings › Rows, Profiles › Rows, the Stremio tab's placement.
5. **Phone**: the tabs on the resolved rows, `ROWS` / `recommend.ts` gone, row editing.
6. **Engine v2** (§5): taste vectors, candidate pools, scoring, diversity, explanations, the cache and its background builds, New episodes, Genre for you; the recorded-profile tests and the hit-rate report.
7. **Feedback**: Not interested (`dismissed`), abandoned plays as negatives, the "rate to improve" hint.
8. **Stremio migration** (§4) and the plugin author guide's part on rows (`key` must stay stable).
9. **Docs**: this plan's status, the TV / server / mobile / dashboard guides, the root guide.

Steps 1–3 give the visible change (ordered, editable rows and For you on the TV); 6 is where the recommendations get noticeably better. Each step leaves every client working.
