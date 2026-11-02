---
title: "Server code"
description: "server.js, the sandbox it runs in, and the playpex host API."
group: Build plugins
order: 3
---

Your `server.js` is one bundled file, run by the server in a QuickJS interpreter compiled to WebAssembly: one per plugin, in its own worker. Bundle your libraries into it, with esbuild (`--format=iife`) or any bundler.

## The sandbox

- The language and one global, **`playpex`**. There's no `require`, `process`, `fs`, `fetch` or `setTimeout`; plain-JavaScript npm libraries work once bundled.
- Every host call is **async** and returns a promise.
- Limits: 64 MB of memory, **2 seconds of CPU per call** (waiting for the network doesn't count), 4 calls at once. A plugin that crashes or keeps timing out is switched off and the dashboard says why; the server carries on.

## The context

Every handler receives a context:

```js
{ profile: { id, kids } | null, device: { id, name } | null, locale }
```

No tokens, no names of other profiles.

## Host API

| Call | Needs | Notes |
|---|---|---|
| `playpex.http.request({ url, method?, headers?, body?, responseType?, timeoutMs? })` | `network` | HTTPS only, to your declared hosts; returns `{ status, headers, body }`. `responseType` is `text`, `json` or `bytes`. Rate limited per host. 10 s timeout, 8 MB answers. |
| `playpex.store.get / set / delete / list` | `storage` | JSON values, within your quota |
| `playpex.secrets.get(name)` | `secrets` | what the admin entered, or null |
| `playpex.settings.get(key, ctx)` | | your settings, for the context's profile |
| `playpex.tmdb.*` | | The Movie Database through the server: no key of your own |
| `playpex.imdb.title(id)` / `episodes(id)` | | IMDb ratings, cached 6 h |
| `playpex.library.find(titleRef, ctx)` | `library` | what's on this server for a title: counts, never paths |
| `playpex.names.parse / describe / matches / rank` | | the core's reading of release names |
| `playpex.html.select`, `playpex.torrent.info` | | read HTML and `.torrent` files without a parser of your own |
| `playpex.iptv.m3u(…)`, `playpex.iptv.xmltv(…)` | hosts you may reach | parse IPTV playlists and guides |
| `playpex.log.info / warn / error(message, fields?)` | | into the server's log, tagged with your id |
| `playpex.i18n.t(key, vars?)` | | your strings in `ctx.locale` |
| `playpex.notify.send(…)` | `notify` | see [Events, jobs and accounts](events-and-jobs) |
| `playpex.plugins.call(id, name, args)` | `requires` | a data handler another plugin exports |
| `playpex.hooks.on(name, handler)` | `hooks` | see [Hooks](hooks) |
| `playpex.events.on(name, handler)` | `events` | |
| `playpex.schedule.every(name, interval, handler)` | `schedule` | |
| `playpex.watchlist.*`, `watched.*`, `ratings.*`, `downloads.*` | `write` | |
| `playpex.data(name, handler)` | | answers for your screens and slots |

Never available: the database, devices, sign-in, the server's settings, the file system and anything about the computer.

## The catalog without a key

The server answers TMDB and IMDb calls with its own key and cache, shared by every plugin:

```js
var movie = await playpex.tmdb.movie(157336, { append_to_response: 'credits' });
var found = await playpex.tmdb.search('tv', 'breaking bad', { first_air_date_year: 2008 });
var poster = playpex.tmdb.image(movie.poster_path, 'w342');   // a URL, no call
var onServer = await playpex.library.find({ kind: 'movie', tmdbId: 157336 }, ctx);
```

`tmdb.get(path, params)` reaches any catalog path; `movie`, `tv`, `person`, `season`, `episode`, `search`, `discover`, `trending` and `find` are shortcuts.

## Release names

`playpex.names.parse('Sintel.2010.1080p.BluRay.x264')` reads a release name into its title, year, quality, codec and episode; `names.matches` tells whether a name is the title you were asked for, however it's spelt; `names.rank` sorts releases in the order the server streams best. Use them instead of your own parsing.

## Errors

`http.request` returns non-2xx answers with their `status`; only refusals, network failures and timeouts throw, with `err.code` (`RATE_LIMITED`, `TIMEOUT`…). A handler that throws, times out or answers out of shape is skipped: the feature carries on without it.
