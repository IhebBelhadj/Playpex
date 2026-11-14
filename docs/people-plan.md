# People: plan

Status (2026-11-14): **steps 1–5 built** (uncommitted), decisions A–F taken as recommended. Server: `GET /catalog/people/{personId}` (`lib/catalog.js` `person`, `mergeCredits`, `knownFor`), `knownFor` on search results, `CatalogPersonDetails` / `CatalogPersonCredit` / `CatalogPersonRole` in `openapi.yaml`, tests in `test/catalog.test.js`, `docs/api/catalog.md`. TV: `core.person` (`person-page/`), cast and guest-star cards open it, search's person results open it with known-for subtitles and People first for a name (the "With <name>" row gone); scenario `scripts/scenarios/people.js` (19 checks). Dashboard: People in Search (group and tab), `/people/:personId`. Phone: People in search, `app/person/[id].tsx`, cast taps (type-checked, not tried on a phone yet). Deviations: the TV focuses the first title, not the Biography tile (Up reaches it); posterless titles go last in every row (also unreleased ones); kids profiles get no extra filtering (the catalog has none for them either: `include_adult` is always false). Step 6 is later, with the rows plan.

## 1. Goal

1. **A person has a page.** Enter on a card in a Cast or Guest stars row (movie, show, episode) opens that person's page: their face, who they are, and their movies and shows in rows. Enter on one of those opens its page over the person's, and Back comes back to the same card.
2. **People can be searched on every client.** The TV already finds people. The dashboard and the phone find them too, and on every client a person result opens the person page.

Non-goals: following a person (new titles of an actor as a row: a later row source of the rows plan, `core.person`, §7); people from plugins or Stremio add-ons (TMDB only); editing or fixing people.

## 2. What exists today

| What | Where | Gap |
|---|---|---|
| People in search | server `GET /catalog/search/{kind}`, `kind` `multi` or `person` (`lib/catalog.js` `search`, `person()`: `CatalogPerson {personId, name, profilePath, knownForDepartment}`) | no "known for" titles on a result |
| A person's titles | `GET /catalog/people/{personId}/credits` (`personCredits`: TMDB `combined_credits`, cast with `character`, crew with `job` / `department`) | no details: biography, dates, place; one title appears once per role |
| TV search | `search-page`: chip **People**, rows Movies / TV shows / People under **All**; Enter on a person adds a row "With <name>" under the People row (`showCredits`) | no page: the row is lost on the next search, can't be reached from a title |
| TV cast rows | `movie-options` (`casts`), `show-options` (`cast`), `episode-page` (`cast`, `guests`): `px-card variant="portrait"` | no `pxSelect`: Enter does nothing |
| Dashboard search | `apps/dashboard/src/lib/search.ts` `useCatalogSearch` | **drops people** (filters `mediaType` to movie / tv) |
| Phone search | `apps/mobile/src/state/search.ts` `useTitleResults` → `titlesOf` | drops people |
| Phone cast | `app/title/[mediaType]/[id].tsx`: a cast row (15) | not tappable |

## 3. Server and protocol

### 3.1 A person's page: `GET /catalog/people/{personId}`

One TMDB call: `/person/{id}?append_to_response=combined_credits,external_ids` (the server's language, as every catalog call; cached like a title's page). Answers **`CatalogPersonDetails`**:

```js
{
  personId: 17419,
  name: 'Bryan Cranston',
  profilePath: '/7Jahy5LZX2Fo8fGJltMreAI49hC.jpg',
  knownForDepartment: 'Acting',
  biography: '…',                    // '' when TMDB has none in the language (decision C)
  birthday: '1956-03-07', deathday: null, placeOfBirth: 'Hollywood, California, USA',
  imdbId: 'nm0186505',
  credits: [                          // one entry per title, roles merged
    { ...CatalogTitle, roles: [{ character: 'Walter White' }], episodeCount: 62, order: 0 },
    { ...CatalogTitle, roles: [{ job: 'Director', department: 'Directing' }, { job: 'Producer', department: 'Production' }] }
  ],
  knownFor: [1396, 18181]            // tmdb ids of their best known titles (§3.3), in order
}
```

- **Roles merged per title** (`mediaType` + `tmdbId`): an actor who also directed an episode is one entry with two roles. Clients group by role themselves (§4.2).
- **Left out**: talk shows, news, award shows and the like (TMDB genres 10767 Talk, 10763 News, and `character` "Self" / "Himself" / "Herself" with no other role), unless that's all they have: a show host's page isn't empty (decision B). Titles with no poster go to the end.
- `include_adult` false, as the catalog's search; kids profiles: titles filtered like every catalog answer for them.
- 404 `NOT_FOUND` for an unknown id; upstream failures 502, as the other catalog routes.

`GET /catalog/people/{personId}/credits` stays for older clients (the TV's search uses it until step 3).

### 3.2 Search results say who they are

`CatalogPerson` gets **`knownFor`**: up to three titles from TMDB's `known_for` (`{mediaType, tmdbId, title}`), so a result reads "Bryan Cranston · Breaking Bad, Malcolm in the Middle" and two people with one name can be told apart. Optional in the schema: older servers don't send it.

### 3.3 Known for

TMDB's `known_for` only exists on search results. On the person page the server picks it: their cast credits (or crew, for someone known for directing / writing) weighted by `voteCount` and billing (`order` ≤ 3 counts double; a show's `episodeCount` ≥ 10 counts double), the first eight.

### 3.4 Contract

`openapi.yaml`: `getCatalogPerson`, `CatalogPersonDetails`, `CatalogPersonCredit` (`CatalogTitle` + `roles`, `episodeCount`, `order`), `CatalogPerson.knownFor`; `npm run generate -w packages/protocol`; the client guide's catalog part (`docs/api/`) gets the route. Tests in `test/catalog.test.js` on a recorded TMDB answer: merging, the talk-show rule, known for, 404.

## 4. Playpex TV

### 4.1 Screen

`core.person`: path `people/:id`, kind `detail`, `requires: ['profile']`, no frame (it's reached from movies, shows, episodes and search alike), state kept in its entry (the focused card) so Back from a title lands on the same card. Opened with `{ screen: 'core.person', params: { id } }`.

### 4.2 Page (`person-page/`)

```
┌───────────────────────────────────────────────────────────────┐
│ [portrait]  Bryan Cranston                                     │
│             Acting · Born 7 March 1956 in Hollywood, California│
│             Biography, four lines, then "More" ───────────────│ ← px-dialog with all of it
│                                                                │
│ Known for        [poster][poster][poster]…                     │
│ Movies           [poster]… "as Walter White" / year            │
│ TV shows         [poster]… "as Hal · 151 episodes"             │
│ Directing        [poster]… (one row per crew department they have)
│ Writing / Production / …                                       │
└───────────────────────────────────────────────────────────────┘
```

- A scrolling `pxStack` like the movie page: the header (a `pxSection` with one item, **More**, only when the biography is cut), then `px-card-row`s (`tone="detail"`, `align="third"`, `variant="compact"` posters; subtitle: the character or job, else the year).
- Rows: **Known for**, **Movies** and **TV shows** as cast (newest first; unreleased ones dimmed at the start, "Coming 2027"), then one row per crew department (Directing, Writing, Production, Creator…) in the order of how many titles each has. A row with nothing isn't drawn.
- "On this server" marks on cards, as in the sections (the library service's lookup).
- Backdrop: the person's best known title's backdrop, through `BackgroundService` (people have no backdrops of their own).
- Died: "1956 – 2024" beside the name, no other treatment.
- Loading: the header from the card that opened it (name, picture: passed in the open's `data`) while the page loads; then the rest. Failure: "Couldn't load Bryan Cranston's page" + Retry.

### 4.3 Cast cards open it

`(pxSelect)="openPerson(person)"` on the cast rows of `movie-options`, `show-options` and `episode-page` (cast and guest stars). The episode page's director / writers line stays text (decision D).

### 4.4 Search

- Enter on a person result opens `core.person`; the inline "With <name>" row (`showCredits`) goes (decision A).
- A person card's subtitle: their department, or their `knownFor` titles when the server sends them.
- **All** keeps the order Movies, TV shows, People, except when TMDB's best `multi` result is a person: then People comes first (decision E).

### 4.5 Scenario

`apps/tv/scripts/scenarios/people.js` (on the :28490 copy): Breaking Bad's show page → Cast → Enter on Bryan Cranston → his page (rows Known for, Movies, TV shows); Enter on a movie → its page; Back → the same card; the episode page's guest star → their page; search "bryan cranston" → People → Enter → the page; the biography's More. Screenshots `person-top.png`, `person-rows.png`.

## 5. Dashboard

- Search: a **People** group (faces, name, known for) in All and its own filter, from `useCatalogSearch` without the filter that drops them.
- A person view at `/people/:id`: header and the same rows as a poster grid per role; a title opens what the dashboard's Search does for a title today (its sources, play, download).
- Title views that list cast (if any by then) link to it.

## 6. Playpex Mobile

- `features/search`: a People row in the results (`titlesOf` keeps people apart, a `peopleOf`).
- `app/person/[id].tsx`: header, biography (expandable), horizontal rows by role as on the TV; a title opens `title/[mediaType]/[id]`.
- The title screen's cast row: tap → the person screen.

## 7. Steps

1. **Server + protocol**: `GET /catalog/people/{personId}`, `knownFor` on search results, schemas, generated types, tests, client guide.
2. **TV person page** + cast / guest-star cards opening it; scenario `people.js`; `apps/tv/src/app/CLAUDE.md` (route table, `person-page/` entry).
3. **TV search**: person results open the page, known-for subtitles, People first for a name (if E is taken).
4. **Dashboard**: People in Search, `/people/:id`.
5. **Phone**: People in search, the person screen, cast taps (built, tried on a phone when the mobile work is).
6. Later, with the rows plan: a `core.person` row source ("More with Bryan Cranston") and following people.

## 8. Decisions

| | Question | Recommendation |
|---|---|---|
| A | Keep the search page's inline "With <name>" row beside the page? | **No**: one way to see a person, the page; the row is lost on the next search anyway |
| B | Talk shows, news, award shows and "Self" appearances on a person's page? | **Left out** unless they're all the person has |
| C | Biography in the server's language missing: fall back to English? | **Yes**: a second call (`language=en-US`) only when the first answer's biography is empty |
| D | The episode page's director / writers: links to their pages too? | **Not now**: they're a text line in `px-title-info`; making them focusable adds a stop on every episode page. Crew is on the person page from a cast card or search |
| E | People first in All when the query is a person's name? | **Yes**, when TMDB's best `multi` result is a person |
| F | Where the person page lives on the TV: its own screen or a panel over the title? | **Its own screen** (`core.person`): it has rows, opens titles, and is reached from search too |
