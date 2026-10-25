# The catalog: movies, shows, people

A client never needs a TMDB key of its own: the server answers the catalog (titles, posters, seasons, episodes, cast, search) under **`/api/v1/catalog/*`**, from TMDB, in Playpex's own shapes (`Catalog*` in `openapi.yaml`). The server keeps the key (the admin's, else the app key Playpex ships), the cache, the language and the region (the dashboard's Settings › Metadata). The answers are ours, not TMDB's JSON, so the provider behind them can change without changing clients.

Titles are **`(mediaType, tmdbId)`** everywhere in the API (`mediaType` `movie` | `tv`): the watch list, progress, downloads, the play pipeline and the library all name a title that way.

## Routes

| What | Route | Answer |
|---|---|---|
| Where it comes from | `GET /catalog` | `{ provider: 'tmdb', imageBase, language, region }` |
| Genres | `GET /catalog/genres/{movie\|tv}` | `{ genres: [{ id, name }] }` (the ids `discover` takes) |
| A list | `GET /catalog/lists/{mediaType}/{list}?page=` | `CatalogPage`. Movies: `popular`, `top_rated`, `now_playing`, `upcoming`, `trending`; shows: `popular`, `top_rated`, `airing_today`, `on_the_air`, `trending` (of the week) |
| By filters | `GET /catalog/discover/{mediaType}?sort=&genres=&withoutGenres=&language=&minVotes=&minRating=&from=&to=&page=` | `CatalogPage`. `sort`: `popularity` (default), `rating`, `newest`; `genres`: ids, `,` = all of them, `\|` = any; `language`: the original language (ISO 639-1); `from` / `to`: release dates (movies) or first air dates (shows), `YYYY-MM-DD` |
| Search | `GET /catalog/search/{multi\|movie\|tv\|person}?q=&page=` | `CatalogPage`; `multi` mixes movies, shows and people (tell them apart by `mediaType`) |
| A title's page | `GET /catalog/titles/{mediaType}/{tmdbId}` | `CatalogDetails`: the list fields + `imdbId`, `genres`, `runtime` (minutes; a show's usual episode), `tagline`, `status`, `videos` (trailers: `site` YouTube, `key`); shows also `seasonCount`, `episodeCount`, `seasons` |
| Cast and crew | `GET /catalog/titles/{mediaType}/{tmdbId}/credits` | `{ cast: [{ personId, name, character, profilePath, creditId, order }], crew: [{ …, job, department }] }` |
| Similar titles | `GET /catalog/titles/{mediaType}/{tmdbId}/similar?page=` | `CatalogPage` |
| A season | `GET /catalog/titles/tv/{tmdbId}/seasons/{n}` | `CatalogSeason`: `episodes: [{ seasonNumber, episodeNumber, name, overview, airDate, runtime, stillPath, voteAverage, crew, guestStars }]` (`airDate` null: not announced yet). Season 0 = specials |
| What metadata providers add | `GET /catalog/titles/{mediaType}/{tmdbId}/extras?profile=` | `{ providers: [{ plugin, name, ratings: [{ source, value, max, votes, url }], tags, links: [{ label, url }], lines }], errors: [{ plugin, code }] }`: the server's metadata plugins (Trakt…) for that profile, in the admin's order ([below](#metadata-providers)) |
| A person's titles | `GET /catalog/people/{personId}/credits` | `{ cast: [CatalogTitle + character], crew: [CatalogTitle + job, department] }` |

A **`CatalogTitle`** (an item of a list): `mediaType, tmdbId, title` (in the catalog's language), `originalTitle, releaseDate` (a movie's release, a show's first air date), `year, overview, posterPath, backdropPath, genreIds, voteAverage` (TMDB's score, 0–10), `voteCount, originalLanguage`. A **`CatalogPerson`**: `mediaType: 'person', personId, name, profilePath, knownForDepartment`. Pages: `{ page, totalPages (≤ 500), totalResults, results }`.

```sh
curl -s "$S/catalog/search/multi?q=heat" -H "$H" | jq '.results[] | {mediaType, tmdbId, title, year}'
curl -s "$S/catalog/titles/tv/1396" -H "$H" | jq '{title, imdbId, seasonCount, seasons: [.seasons[] | {seasonNumber, episodeCount}]}'
curl -s "$S/catalog/discover/movie?genres=35&from=1990-01-01&to=1999-12-31&sort=rating&minVotes=300" -H "$H"
```

## Metadata providers

A server's admin can install **metadata providers** (plugins with `metadata.details`, e.g. Trakt) that add to a title's page: their ratings, tags, links and meta-line items, never replacing the catalog's own fields. They answer per profile (a kids profile never gets an adults plugin's), so ask `…/extras?profile=<id>` once a title is open, next to its page: it may take a few seconds (each provider has 5 s), and the page shouldn't wait for it. `providers` lists only those that added something, in the admin's order (Settings › Metadata); show a rating as `source` + `value` on its `max` scale (Playpex TV: on a 10 scale, after the source's name); `links` are for clients that can open them; `lines` are meta-line items (`text`, `chip`, `score` with a `label`, `seal`), as plugins' `core.title.meta` items. A provider that failed or was late is only in `errors`. Ask again on the `plugin.changed` event. (`POST /plugins/meta`, the older route for `metadata.title` only, stays through API 2.)

## Images

Image fields are **paths** (`/xyz.jpg`). The URL is `imageBase` + a size + the path, e.g. `https://image.tmdb.org/t/p/w342/xyz.jpg`. Sizes: posters `w92 w154 w185 w342 w500 w780`, stills `w92 w185 w300`, profiles `w45 w185 h632`, backdrops `w300 w780 w1280`, and `original`. Pick the smallest that covers what you draw (Playpex TV: `tmdbImageBase()`, `apps/tv/src/app/ui/images.ts`). Images load from the image host directly; they need no key.

## Caching, errors, what's left out

- The server caches a title's page, credits and seasons for 6 h, lists, discover and search for 1 h. Clients may cache as long; refetch when the user asks.
- **Never adult titles** (the server never asks for them; `audience: adults` plugins have catalogs of their own).
- Errors: a bad parameter → **400 `INVALID`** (before any call upstream); a title TMDB doesn't have → **404 `NOT_FOUND`**; TMDB down or refusing → **502 `UPSTREAM`**. Show what you have and let the user retry.
- A title's IMDb rating is `GET /imdb/{imdbId}` (and a series' seasons and episodes: `/imdb/{imdbId}/episodes`), with `imdbId` from its page.

## Before the catalog moved to the server

Until providers plan step 6 (API 2, 2026-10-25), clients called TMDB themselves with a key in their code. A client written then still works (the server never needed its TMDB calls), but should move to `/catalog/*`: one key on the server, its cache, its language, and no secret in the client.
