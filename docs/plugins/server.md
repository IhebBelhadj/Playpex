# `server.js`: the sandbox, the host API, hooks, events

Your `server.js` is **one bundled file** (esbuild, `--format=iife` or plain script) run by the server in a **QuickJS interpreter compiled to WebAssembly**, one per plugin, in a worker thread (docs/plugins-plan.md §4.1). The run-time shapes are in `packages/protocol/plugin-api.schema.json`; the host validates every answer against them, and an answer that doesn't match counts as the handler failing.

## The sandbox

- The language and one global, **`playpex`**. No `require`, `process`, `fs`, `fetch`, `setTimeout`: Node built-ins don't exist; plain-JS npm libraries (parsers) work when bundled.
- Every host call is **async** (a promise); handlers may be `async`.
- Limits (`LIMITS` in `plugins.js`): 64 MB of memory, **2 s of CPU per call** (waiting for HTTP doesn't count), 4 calls at once. A plugin that crashes, runs out of memory or keeps timing out is disabled (state `failed`, the dashboard says why); the server carries on.

## Context

Every handler gets a context: `{ profile: { id, kids } | null, device: { id, name } | null, locale }`. No tokens, no names of other profiles. Requests of kids profiles never reach an `audience: adults` plugin.

## Host API (`SERVER_PLUGIN_API` 1)

| Call | Needs | Notes |
|---|---|---|
| `playpex.http.request({ url, method?, headers?, body?, responseType?, timeoutMs? })` → `{ status, headers, body }` | `network` | HTTPS only, host in `network` (or the admin's host of a `url` setting with `grantsHost`: http and its port too); a non-2xx answer is returned with its `status` (only refusals, network failures and timeouts throw, with `err.code`); resolved addresses must be public (checked after DNS and on every redirect, ≤ 5); 10 s timeout (`timeoutMs`: a shorter one, ≥ 1000: a hook asking several sites keeps one slow site from sinking the others), 8 MB answer cap, no shared cookies. `responseType` `text` (default) · `json` · `bytes` (`Uint8Array`). **Rate limited** per host (2/s, burst 10, 4 in flight; stricter with `permissions.rateLimit`): over it the call waits, past 10 s it fails `RATE_LIMITED` |
| `playpex.store.get(key)` / `set(key, value)` / `delete(key)` / `list(prefix)` | `storage` | JSON values, your quota |
| `playpex.secrets.get(name)` | `secrets` | what the admin entered, or null |
| `playpex.settings.get(key, ctx)` | | your `contributes.settings`, for the context's profile / device |
| `playpex.tmdb.*` | | TMDB through the server ([below](#core-data-tmdb-imdb-library)): no key or `network` entry of your own |
| `playpex.imdb.title(id)` / `episodes(id)` | | IMDb ratings (`{ id, rating, votes }`; `episodes`: `seasons[]` with each episode's), cached 6 h |
| `playpex.library.find(titleRef, ctx)` | `library` | what's on this server for a title, as the context's profile may see it (below); counts, never paths |
| `playpex.names.parse / describe / matches / rank`, `playpex.html.select`, `playpex.torrent.info` | | the core's reading of release names, HTML and `.torrent` files ([below](#release-names-html-torrent-files)): no parser of your own |
| `playpex.iptv.m3u(url \| { url } \| { text })`, `playpex.iptv.xmltv(url, { channels, from, to })` | hosts you may reach | IPTV playlists and guides fetched and parsed by the host ([below](#live-tv-m3u-and-xmltv)) |
| `playpex.log.info / warn / error(message, fields?)` | | into the server log, tagged with your id |
| `playpex.i18n.t(key, vars?)` | | your strings in `ctx.locale` |
| `playpex.notify.send(profileIds \| 'all', { text, tone?, key? })` | `notify` | below |
| `playpex.plugins.call(id, name, args, { profileId? })` | `requires` | a data handler another plugin `exports`: runs in its sandbox with its permissions (for that profile, its audience and hidden rules applying), answers its `data`; `PERMISSION_DENIED` (not in your `requires`, not exported), `NOT_RUNNING` (not installed or off), `CALL_FAILED` (its handler failed) |
| `playpex.hooks.on(name, handler)` | `hooks` | below |
| `playpex.events.on(name, handler)` | `events` | below |
| `playpex.schedule.every(name, interval, handler, { atStart? })` / `cancel(name)` | `schedule` | below |
| `playpex.watchlist.*`, `watched.*`, `progress.set`, `ratings.*`, `downloads.add / list` | `write` | below |
| `playpex.profiles.list(permission?)` | | the profiles granted that personal permission (`[{ id, kids }]`): who a job acts for |
| `playpex.link.status(name, profileId?)` | `link` | below |
| `playpex.data(name, handler)` | | answers for the screens / slots / actions in `contributes` ([tv.md](tv.md)) |

Never available: the database, other plugins (but what they export to you), devices, auth, `settings.json`, the file system, process or OS information, ports other than HTTPS.

## Core data: TMDB, IMDb, library

What the server already reads for itself, answered by its own clients (`apps/server/lib/plugins/core.js`): no API key to ask the admin for, no `permissions.network` entry, the server's cache (6 h) shared by every plugin. Rate limited per plugin and service (10/s, burst 20, 4 in flight: `LIMITS.core`); over it the call waits, past 10 s it fails `RATE_LIMITED`.

```js
var movie = await playpex.tmdb.movie(550, { append_to_response: 'credits,external_ids' });
var found = await playpex.tmdb.search('tv', 'breaking bad', { first_air_date_year: 2008 });
var poster = playpex.tmdb.image(movie.poster_path, 'w342');   // a URL, no call
var onServer = await playpex.library.find({ kind: 'movie', tmdbId: 550 }, ctx);   // { fileCount, episodes }
```

| Call | TMDB path |
|---|---|
| `tmdb.get(path, params?)` | any catalog GET: `/movie`, `/tv`, `/search`, `/discover`, `/find`, `/person`, `/company`, `/collection`, `/genre`, `/configuration`, `/trending`, `/network`, `/keyword`, `/certification`, `/watch`, `/review`, `/credit` and what's under them (not `account_states` / `rating`) |
| `tmdb.movie(id, params?)` · `tv(id, params?)` · `person(id, params?)` | `/movie/{id}` · `/tv/{id}` · `/person/{id}` |
| `tmdb.season(id, season, params?)` · `episode(id, season, episode, params?)` | `/tv/{id}/season/{n}` · `…/episode/{n}` |
| `tmdb.search(kind, query, params?)` · `discover(kind, params?)` | `/search/{movie\|tv\|person\|multi\|company\|collection\|keyword}` · `/discover/{movie\|tv}` |
| `tmdb.trending(kind?, window?, params?)` | `/trending/{all\|movie\|tv\|person}/{day\|week}` (default `all`, `week`) |
| `tmdb.find(externalId, source?, params?)` | `/find/{id}`, `external_source` `imdb_id` by default |
| `tmdb.image(path, size?)` | `https://image.tmdb.org/t/p/{size}{path}` (default `w342`; null without a path) |

- Answers are TMDB's JSON as is (`language` `en-US` unless you pass one: `{ language: ctx.locale }`).
- `params`: plain strings, numbers and booleans (≤ 30, ≤ 500 characters each); `api_key` and session ids are refused (`INVALID`), as are paths outside the list.
- `include_adult` is passed on only for an `audience: adults` plugin; for any other it is always `false` (your screens reach kids profiles).
- Errors: `PROVIDER_NOT_CONFIGURED` (the server has no TMDB key: the admin sets one in the dashboard's Settings), `NOT_FOUND` (TMDB's 404), `UPSTREAM` (any other failure), `INVALID`.
- `library.find(titleRef, ctx)` → `{ mediaType, tmdbId, fileCount, episodes: [{ season, episode, fileCount }] }`: files on this server for a movie, a show (its episodes) or one episode (`fileCount` of that episode). Pass the handler's `ctx`: a kids profile, or no profile, never counts files of adults-only folders. Needs `permissions.library`.

## Release names, HTML, .torrent files

What the core knows about releases, for source plugins (`apps/server/lib/plugins/utilities.js`): the same reading the server uses for its own sources, so your matching and ranking stay as good as the core's. No permission; rate limited per plugin like the core data (`LIMITS.core`). Bad arguments fail `INVALID`.

```js
var p = await playpex.names.parse('Severance.S02E10.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.H.265-FLUX');
// { title: 'Severance', year: null, season: 2, episode: 10, episodeEnd: null, pack: false,
//   resolution: '2160p', source: 'web-dl', codec: 'hevc', audio: 'eac3', hdr: true }
var kind = await playpex.names.matches(release.name, input.title);   // 'episode' | 'pack' | 'movie' | null
var kinds = await playpex.names.matches(results.map(function (r) { return r.name; }), input.title);   // one call for a list
var best = await playpex.names.rank(releases);                        // [{ name, seeds, … }] in the core's order
var rows = await playpex.html.select(page, 'table.list tr', { name: 'a.title', link: 'a.title@href', seeds: 'td.seeds' });
var info = await playpex.torrent.info(r.body);                        // a .torrent's bytes (responseType 'bytes')
```

| Call | Answers |
|---|---|
| `names.parse(name)` | `{ title, year, season, episode, episodeEnd, pack, resolution, source, codec, audio, hdr }` (`codec` `h264` · `hevc` · `av1` · `xvid`; `audio` `aac` · `ac3` · `eac3` · `truehd` · `dts` · `opus` · `mp3` · `flac`; null = the name doesn't say). A path (`Show/Season 2/03.mkv`) is read like the library reads one |
| `names.describe(name)` | `{ quality, codec, audio, playable }`: how it plays in the TV app's Chromium (`audio` `supported` · `unsupported` (Dolby / DTS) · `unknown`; `playable` false for HEVC, 10-bit, XviD, 4K) |
| `names.matches(name, titleRef)` | an episode → `episode` (exactly it: "Breaking Brad", ranges and other shows refused), `pack` (its season), null; a show → `episode` / `pack` when the name is one of its; a movie → `movie` (title, year ± 1) or null. A list of names (≤ 1000) answers a list, for one call's share of the rate limit: match a site's whole answer at once |
| `names.rank(items)` | the same items (≤ 1000, each with a `name`; `seeds`, `pack` read when there) in the core's streaming order: plays here → audio that decodes → ≥ 10 seeds → single files before packs → resolution → seeds |
| `html.select(html, selector, fields?)` | for each match of the CSS selector (≤ 500): `{ text, attributes }`, or with `fields` (`{ key: 'css' \| 'css@attr' \| '@attr' \| '' }`, ≤ 30) an object of those (text trimmed, null when missing). Parsed on the host (`node-html-parser`): HTML ≤ 4 MB, without spending your 2 s of CPU |
| `torrent.info(bytes)` | a `.torrent` file (`Uint8Array`, ≤ 4 MB) → `{ infoHash, name, size, pieceLength, files: [{ index, path, size }] }`: for sites that only offer `.torrent` downloads (answer a `magnet` source with its `infoHash`, and `fileIndex` / `fileName` for the file to play) |

## Live TV: M3U and XMLTV

IPTV files are big (tens of thousands of channels, a guide of 50 MB+), too big for your 2 s of CPU and 64 MB: the host fetches and parses them for you, **as you** (the hosts you may reach: declared, or granted by the admin's `url` setting), gzip allowed, ≤ 200 MB, kept on disk 6 h per URL (an older copy is used when the source fails), parsed once.

| Call | Answers |
|---|---|
| `playpex.iptv.m3u(url \| { url } \| { text })` | `{ channels: [{ id, name, url, number?, group?, logo?, tvgId?, tvgName?, country?, language?, userAgent?, referrer? }] (≤ 5000), epg: [urls] (the playlist's url-tvg), total (entries read), truncated }`. Ready for a `Channel`: `id` already matches its pattern and is unique, `name` ≤ 100, `group` ≤ 60, `number` an integer, `country` two capital letters; `language` is the playlist's text (keep it in `languages` only when it's a 2–3 letter code); `userAgent` / `referrer` (from `#EXTVLCOPT`) are meant as your source's `User-Agent` / `Referer` headers. `#EXTINF` attributes (`tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`), `#EXTGRP`, `#EXTVLCOPT:http-user-agent` / `http-referrer`; catch-up attributes are ignored; only http(s) streams. `id` is stable: the `tvg-id` when unique in the list, else a hash of the name and group. A playlist fetched from a `url` setting with `streamHosts` teaches the host the hosts it lists. `text` (≤ 8 MB): a playlist you fetched yourself |
| `playpex.iptv.xmltv(url, { channels: [{ id, tvgId?, name? }] (≤ 200), from, to (≤ 48 h) })` | `{ programmes: Programme[] (with your ids, ready for `live.guide`), matched (how many of the channels were found) }`: `from` / `to` are `Date`s or ISO strings (pass `live.guide`'s through); each channel by its `tvgId`, else by its name (`"BBC One HD"` ↔ `"BBC One"`); descriptions ≤ 600 characters, images https only |

Hosts: the URL must be one you may reach (`network`, a `grantsHost` setting); with `streamHosts`, the hosts the admin's playlist lists (its streams, logos and `url-tvg` guide) count too, so `iptv.xmltv(answer.epg[0], …)` works. Several `url` settings may grant hosts.

A `Channel` carries no URL (`additionalProperties: false`): in `live.stream`, find the channel's entry again by its `id` (call `iptv.m3u` again: it answers from the host's cache), or keep a module-level map (your sandbox lives until the plugin is reloaded or the server restarts: never rely on it alone). An HLS channel's playlist may name segment and key hosts the M3U never lists: when its URL is on a host the admin gave you, the server follows those parts on any public host. Answers are checked whole: one channel out of shape fails the whole `live.channels` (the server only drops repeated ids itself), so build channels from the fields above. Live hooks get no profile (`ctx.profile` null: channels are the server's); read settings with `settings.get(key, ctx)` as usual. After a settings change the server forgets your channels and asks again (without `refresh`; `refresh: true` is the admin's Refresh button).

The first call on a big guide may take seconds (download and parse); the server warms the first window when your channels load. [`plugins/m3u`](../../plugins/m3u) is the reference live plugin: `live.channels` from `iptv.m3u`, `live.guide` from `iptv.xmltv`, `live.stream` answering a `live` source.

## Hooks

Named stages of core features. Each has an input / output schema (`$defs/hooks/<name>` in `plugin-api.schema.json`), a timeout (`HOOKS` in `plugins.js`) and one failure rule: **a handler that throws, times out or answers out of schema is skipped**, the feature works without it. The core's own sources (the library, the server's downloads) are handlers of the same stages; a plugin can't remove them. The core reads no torrent site: torrents and streams come only from plugins.

```js
playpex.hooks.on('play.collect', async function (input, ctx) {
  var t = input.title;                                  // { kind, tmdbId, imdbId, season, episode, title, year }
  var r = await playpex.http.request({ url: 'https://api.example.com/find?imdb=' + t.imdbId, responseType: 'json' });
  return r.body.items.map(function (i) {
    return { kind: 'magnet', infoHash: i.hash, label: i.name, quality: '1080p', size: i.size, seeds: i.seeders };
  });
});
```

| Hook | Input → output |
|---|---|
| `play.collect` (8 s) | `{ title }` → `Source[]` (≤ 50) |
| `play.rank` (1 s) | `{ title, sources: RankedSource[] }` → `{ order?: [ids], hide?: [{ id, reason }] }`: listed ids first, the rest after in their order; hidden ones show "Hidden by <plugin>: <reason>" in the picker |
| `play.before` (1 s) | `{ title, source: RankedSource }` → `{ action: 'continue' }` · `{ action: 'ask', question, yes?, no? }` · `{ action: 'refuse', reason }` |
| `releases.providers` (10 s) | `{ kind, title?, query?, filters?, page }` → `{ releases: Release[] (≤ 500), last }`. `kind`: `movie` / `show` / `episode` for the core's Find releases, or your own screens' kinds; `title` when the list is about one title (`{ kind, imdbId }`: a show's own torrents) |
| `sources.search` (15 s) | `{ query, kind: movie \| show \| any, page }` → `{ results: [{ source, title?, year?, season?, episode?, poster? }] (≤ 100), last }`: your streams and files (or torrents) for keywords, for the dashboard's Search. `query` comes as plain words (`Breaking.Bad` → `Breaking Bad`); `poster` an https image. Each `source` is checked like `play.collect`'s (a kind in `sources`, a host in `network`) and given to the client as a ref. Needs `permissions.sources`. Not for `audience: adults` plugins |
| `subtitles.providers` (8 s) | `{ title, languages, fileName?, size? }` → `Subtitle[]`; the core fetches each `url` (a declared host) and converts it to WebVTT |
| `metadata.details` (5 s) | `{ title, details: { title, originalTitle?, year?, imdbId?, genres, runtime? } }` → `{ ratings?: [{ source, value, max, votes?, url? }] (≤ 3), tags?: [string] (≤ 10), links?: [{ label, url }] (≤ 5), lines?: MetaItem[] (≤ 3) }`: a **metadata provider**'s additions to a movie's / show's page (your rating, tags, links to your site, meta-line items). Additions only: the core's details are never overridden |
| `metadata.title` (3 s) | `{ title }` → `{ meta?: MetaItem[] }` (≤ 3: another score, a tag). **Kept through API 2**: new plugins use `metadata.details` (its `lines`); a plugin with both is asked only `metadata.details` |
| `player.markers` (3 s) | `{ title, duration, fileName?, size? }` → `Marker[]`: `{ kind: intro \| recap \| credits \| chapter, start, end?, label? }` in seconds. Intro / recap: the player's "Skip"; credits: Up next starts there |
| `play.resolve` (check 3 s, resolve 10 s) | `{ mode: 'check', hashes }` → `{ hashes: { <hash>: { cached, label? } } }`: one batched call per Play, the picker shows "Cached on <label>"; `{ mode: 'resolve', title, source }` (the magnet source the user picked) → `{ source: <http source> \| null }`. Needs `sources: ['http']`. Resolves anyone's torrents: the core's and other plugins' |
| `live.channels` (30 s) | `{ refresh? }` → `{ channels: Channel[] }` (≤ 5000): `{ id, name (≤ 100), number? (1–99999), logo?, group? (≤ 60), country? (2 letters), languages? (2–3 letter codes), audience? }`; `id` stable across refreshes (`[A-Za-z0-9._:@-]`), `logo` an http(s) URL or `assets/…`. The server keeps them per plugin (6 h, then again in the background; again after a settings change; `refresh: true` when the admin pressed Refresh: skip your own cache), numbers the ones without a number, drops repeated ids; a kids profile never gets `audience: adults` channels. Goes with `live.stream` |
| `live.guide` (30 s) | `{ channels: [ids] (≤ 200), from, to (≤ 48 h) }` → `{ programmes: Programme[] }` (≤ 20000): `{ channel, start, end, title, subtitle?, description?, category?, episode?, image? }`, ISO dates. Asked per window by the guide and the player's banner; kept 15 min |
| `live.stream` (10 s) | `{ channel }` (as you listed it, without its URL: look it up by `id`) → `{ source: <an hls or live source> \| null }`: asked when the user tunes, so tokens in IPTV URLs are fresh. `null`: it can't play now |
| `library.match` (10 s) | `{ file: { relPath, folderKind, parse?, ids?, size?, duration? } }` → `{ identity: { kind: 'movie', tmdbId } \| { kind: 'episode', showTmdbId, season, episode, episodeEnd? } \| null }`. Runs only for the library folders the admin set to your plugin (their "information provider"); null → the core's own rules; the admin's own match always wins. Needs `files` |

How the core uses the answers (step P3):

- **Sources**: a `magnet` keeps only its info hash and name; the torrent gets the server's own trackers (a tracker list could make the torrent client reach addresses your sandbox may not). An `http` source becomes a media ref `r_…`: the server streams it with your `headers`, checking your `network` hosts and the address rules on every request and redirect; the client never sees the URL or the headers. Give `size` when you know it (else the server asks the source for one byte to learn it); the source must answer `Range` requests with `206`. A ref lives an hour after its last use.
- **`play.rank`** sees every source (the core's and other plugins'); hidden ones are listed to the user as "Hidden by <your name>: <reason>". Plugins run in id order, each on the previous one's result.
- **`play.before`** runs when the user picks a source: the first `refuse` (by plugin id) wins, else the first `ask`; the user's yes runs the hooks again with the question answered.
- **`play.resolve`**: `check` gets every torrent of the Play (≤ 200 hashes, 3 s); the first resolver (by id) to say `cached` serves it. `resolve` runs only when the user picks that torrent; `null`, a failure or a source you may not use plays the torrent itself.
- **`releases.providers`**: listed in the core's movie and TV "Find releases" as a source named after your plugin (hook kinds `movie` and `show`), only for the kinds of your manifest's `contributes.releases.kinds` (`["movie"]`, `["show"]`; default both); answer `{ releases: [], last: true }` for a kind you don't serve. The sources are listed by plugin id, the first the default. With no such plugin the TV hides Find releases. Not for `audience: adults` plugins (those lists have no profile).
- **`sources.search`**: a source in the dashboard's Search (Streams & files) named after your plugin, asked with every other at once; answer within the timeout (a search that reads each result's details: fewer per page). The core marks each result whose name (your `label` and `title` together) holds every keyword (`matches`): don't filter loosely matching ones away, the user can ask for them. Reference: `plugins/archive` (also `play.collect`, so its films show in a title's Play).
- **`subtitles.providers`**: listed in the player's subtitle sources; `languages` is the 639-1 codes asked, or empty for all. Formats: `srt`, `vtt`, `ass` / `ssa` (converted to WebVTT); `sub` isn't read yet.
- **`metadata.details`** / **`metadata.title`**: asked when a client opens a title (`GET /catalog/titles/{mediaType}/{tmdbId}/extras`, the context's profile), every provider at once; the answers are listed in the admin's order (dashboard Settings › Metadata: drag order, a switch per provider: a switched-off one isn't asked). Ratings show on the meta line as "<source> <value on a 10 scale>", then up to two tags and your lines; links are for clients that open them (a TV doesn't). Cache what you fetch (a title page is opened often): the store, or a module-level map.
- **`player.markers`**: asked once the player knows the length; markers past the duration are dropped.
- **`library.match`** runs only for folders whose "information provider" is your plugin; `parse` is the core's own reading of the name, `ids` what its nfo / name tags gave.

`RankedSource` is what ranking sees of any source: `{ id, type: file | download | torrent | plugin, provider, label, quality, size, codec, audio, seeds, playable }`, never a magnet, path, URL or media ref.

### Sources

| Kind | You give | How it plays |
|---|---|---|
| `magnet` | `magnet` or `infoHash` (+ `fileIndex` / `fileName`: the file to play, honoured by the player through the server's file choice), `label`, `quality?`, `size?`, `seeds?`, `peers?`, `codec?`, `audio?`, `notes?` | as the core's torrents: leases, paused when left, never deleted; its separate audio / subtitle files and other videos are switchable in the player |
| `http` | `url` (HTTPS; plain http only on a host the admin granted), `headers?` (sent by the server only; not `Host`, `Cookie`, `Range`…), `label`, `size?`, `container?`, codecs | the server proxies it as a media ref `r_…` with ranges passed through, the host checked on every request and redirect; **the client never sees the URL**; ffprobe and the Dolby → AAC conversion work on it. The ref lives 1 h; Resume collects again |
| `hls` | `url` (an HTTPS `.m3u8`, or plain http on a host the admin gave you: master or media playlist, VOD or live), `headers?`, `label`, `live?` (else read from the playlist), `quality?`, codecs | a media ref `h_…` (format `hls`): the server fetches the playlist as you, **rewrites every URI in it** (variants, segments, `#EXT-X-KEY` / `-MAP` / `-MEDIA`…) to itself and streams the parts through with your `headers`; every host a playlist names (CDNs, key servers) must be in `network` (`*.cdn.example` is fine; a playlist on a host the admin gave you may name any public host), and the address rules apply on every request and redirect. Players play it with hls.js (AES-128 keys, fMP4, audio renditions, WebVTT subtitles work). A title's Play shows it in the Stream group |
| `live` | `url` (HTTPS, or plain http on a host the admin gave you: a continuous MPEG-TS, or a live `.m3u8`), `headers?`, `label`, `format?` (`ts` / `hls`; else by the URL's extension), codecs | a `.m3u8` plays as `hls` above (live); a continuous stream becomes an `l_…` ref the server's ffmpeg remuxes (video copied, audio AAC) for one viewer each. Live sources are for play effects and `live.stream` (channels), **not a title's Play**: `play.collect` answers carrying one are dropped (an error in the server's answer). At most `streaming.maxLive` live streams play at once |

Your sources are ranked with the core's, carry your `notes` ("From Real-Debrid") and never autoplay over a file on the server. **Every plugin's torrents are ranked together** by the core, as it ranks its own sites: one per info hash (the best seeded copy), packs marked, in the streaming order of `names.rank`; your own order counts only among equals, so give the 50 best (rank them with `names.rank` when you found more), not a sorted list. Reorder or hide with `play.rank`. The torrent sites the core used to read are plugins in `plugins/torrents/` (YTS, EZTV, TheRARBG, The Pirate Bay; their own repository): read them for a source plugin's shape.

## Events

Observe only: the core doesn't wait for you, can't be changed by you, and a failing handler is only counted. **At most once, in order**; a queue of 100 per plugin, the oldest dropped when it's full, and the next event carries `dropped: n` (reconcile on a schedule when you see it).

```js
playpex.events.on('playback.progress', function (e) {   // { name, time, context, data, by?, dropped? }
  // e.data = { title, position, duration, source: 'file' | 'download' | 'torrent' | 'plugin' }
});
```

| Family | Events | `data` |
|---|---|---|
| `playback` (personal) | `playback.started`, `.progress` (every 60 s and on pause / seek), `.paused`, `.ended` (left), `.finished` (≥ 90 %) | `{ title, position, duration, source }`: never the magnet, path or ref |
| `downloads` | `download.added`, `.completed`, `.removed` | `{ title?, name, size?, state }` |
| `library` | `library.changed` | `{ added: [titleRef], removed: [titleRef] }` |
| `watchlist` | `watchlist.added`, `.removed`, `watched.set`, `watched.cleared`, `rating.set` | `{ title, rating? }`, with `by` (`user` or `plugin:<id>`) |

You get `playback` events only of profiles the admin granted you `events.playback` for (the dashboard: Plugins › <name> › Profiles; off until switched on). They come from the player's reports: `started` on the first, then `progress` (about every minute), `paused`, `finished` the first time past 90 %, `ended` when the player is left. Plays of titles the TV doesn't name (18+, `tracking: 'none'`, every play of an `adults` plugin) send none. Your own writes never come back to you; another plugin's come with its `by`. A kids profile's events never reach an `adults` plugin.

## Schedules

```js
playpex.schedule.every('sync', '1h', async function (ctx) {          // ctx.profile is null
  var profiles = await playpex.profiles.list('write.watchlist');      // the profiles granted it: [{ id, kids }]
  …
}, { atStart: true });                                               // first run 1 min after the server started, else one interval after
```

Intervals `5m` and up (`s`, `m`, `h`, `d`, or milliseconds), 10 % jitter, never two runs of a job at once (a run still going skips the next), at most 5 min per run (CPU counts like any call). Declared again each time `server.js` loads, so they survive restarts. The dashboard shows each job's last run, duration and error.

## Writes

Through the core's services, so its rules apply; only for profiles the admin granted the scope (`write.<scope>`, per profile in the dashboard; otherwise `PERMISSION_DENIED`); emitted as events with `by: plugin:<id>`. Titles are titleRefs with a TMDB id (`{ kind: 'movie' | 'show' | 'episode', tmdbId, season?, episode?, title? }`); the server adds the poster from TMDB when it has a key.

| Scope | Calls |
|---|---|
| `watchlist` | `watchlist.add(profileId, titleRef)`, `remove(profileId, titleRef)`, `list(profileId)` → `[{ title, addedAt }]` (an episode counts as its show) |
| `watched` | `watched.set(profileId, titleRef, { at? })` (history + watched mark; `at` when it was watched), `watched.clear`, `progress.set(profileId, titleRef, position, duration, { at? })` (a resume point; kept only if newer than the core's: answers `false` otherwise) |
| `ratings` | `ratings.set(profileId, titleRef, 1–10)`, `clear`: the core keeps likes and dislikes (6–10 like, 1–5 dislike); `rating.set` events carry 10 for a like, 1 for a dislike |
| `downloads` | `downloads.add({ magnet \| infoHash \| url, title, ref? })` → `{ infoHash }` (the core's queue and limits; added by `plugin:<id>`), `downloads.list()` (yours only) |

`adults` plugins have only `downloads`. Not a personal permission: a download is the server's.

## Account linking

With a `deviceCode` link in the manifest, the admin presses **Link** in the dashboard (Plugins › <name> › Accounts: per profile for `profile` scope, once for `server` scope), the dashboard shows the code and its URL (whoever owns the account enters it on their phone), the host polls the token URL (at the interval the service gives, slower on `slow_down`), stores the tokens with your secrets and refreshes them when they're within 5 minutes of expiring. Requests go out as your plugin (its hosts and address rules), form-encoded as RFC 8628 says, or JSON with `"body": "json"` (Trakt); the token request carries the code as both `device_code` and `code`. The client id is your secret named by `clientIdSecret` (a `secret` setting the admin fills in first). You read the link:

```js
var s = await playpex.link.status('trakt', ctx.profile.id);   // { linked, accessToken, expiresAt }
if (s.linked) {
  await playpex.http.request({ url: 'https://api.trakt.tv/sync/watchlist', headers: { Authorization: 'Bearer ' + s.accessToken, 'trakt-api-key': await playpex.secrets.get('traktClientId') } });
}
```

A service without a device flow: declare the link with `"custom": "<data name>"`. On **Link** the dashboard calls that handler; it answers (`$defs/linkStart`) either a code `{ code, url, qr?, poll, expiresIn? }`, and the dashboard shows it and calls `poll` every 5 s, or a form `{ form: [{ key, label, secret?, help? }], submit }` (an API key the service shows on its account page), and the dashboard calls `submit` with what the admin typed. `poll` / `submit` answer `{ state: 'pending' | 'done' | 'failed', message? }`; store the tokens yourself (`store`) and the core marks the link linked on `done`. Clients never show any of it: when an account isn't linked, your screens show your own empty state ("Not linked yet: ask the server's admin").

## Notifications

`playpex.notify.send(profileIds | 'all', { text, tone?, key? })` (needs `notify`) → `{ sent: [ids], limited: [ids] }`: a toast (≤ 120 characters) on those profiles' clients, shown once per device and kept 24 h for devices that aren't on; one per `key`, the newest wins. 10 per hour per plugin and profile (more are `limited`); never to kids profiles from an `adults` plugin. Clients get them with `GET /plugins/notifications?profile=` ([client guide](../api/plugins.md)).

## Data handlers

`playpex.data(name, async function (args, ctx) { return { data, effects? }; })`. The core calls them at `POST /api/v1/plugins/<id>/data/<name>` (≤ 1 MB each way, rate limited per device) for your screens, slot contributions, card / action calls and paged rows. What `data` holds depends on the caller: [tv.md](tv.md).
