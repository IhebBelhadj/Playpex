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
| `playpex.http.request({ url, method?, headers?, body?, responseType? })` → `{ status, headers, body }` | `network` | HTTPS only, host in `network`; resolved addresses must be public (checked after DNS and on every redirect, ≤ 5); 10 s timeout, 8 MB answer cap, no shared cookies. `responseType` `text` (default) · `json` · `bytes` (`Uint8Array`). **Rate limited** per host (2/s, burst 10, 4 in flight; stricter with `permissions.rateLimit`): over it the call waits, past 10 s it fails `RATE_LIMITED` |
| `playpex.store.get(key)` / `set(key, value)` / `delete(key)` / `list(prefix)` | `storage` | JSON values, your quota |
| `playpex.secrets.get(name)` | `secrets` | what the admin entered, or null |
| `playpex.settings.get(key, ctx)` | | your `contributes.settings`, for the context's profile / device |
| `playpex.tmdb.*`, `playpex.imdb.title(id)` / `episodes(id)` | | read-only core data |
| `playpex.library.find(titleRef)` | `library` | what's on the server for a title (metadata, never paths) |
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

## Hooks

Named stages of core features. Each has an input / output schema (`$defs/hooks/<name>` in `plugin-api.schema.json`), a timeout (`HOOKS` in `plugins.js`) and one failure rule: **a handler that throws, times out or answers out of schema is skipped**, the feature works without it. The core's own sources (library, downloads, YTS, EZTV, TheRARBG) are handlers of the same stages; a plugin can't remove them.

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
| `releases.providers` (10 s) | `{ kind, title?, query?, filters?, page }` → `{ releases: Release[], last }`. `kind`: `movie` / `show` / `episode` for the core's Find releases, or your own screens' kinds |
| `subtitles.providers` (8 s) | `{ title, languages, fileName?, size? }` → `Subtitle[]`; the core fetches each `url` (a declared host) and converts it to WebVTT |
| `metadata.title` (3 s) | `{ title }` → `{ meta?: MetaItem[] }` (≤ 3: another score, a tag) |
| `player.markers` (3 s) | `{ title, duration, fileName?, size? }` → `Marker[]`: `{ kind: intro \| recap \| credits \| chapter, start, end?, label? }` in seconds. Intro / recap: the player's "Skip"; credits: Up next starts there |
| `play.resolve` (check 3 s, resolve 10 s) | `{ mode: 'check', hashes }` → `{ hashes: { <hash>: { cached, label? } } }`: one batched call per Play, the picker shows "Cached on <label>"; `{ mode: 'resolve', title, source }` (the magnet source the user picked) → `{ source: <http source> \| null }`. Needs `sources: ['http']`. Resolves anyone's torrents: the core's and other plugins' |
| `library.match` (10 s) | `{ file: { relPath, folderKind, parse?, ids?, size?, duration? } }` → `{ identity: { kind: 'movie', tmdbId } \| { kind: 'episode', showTmdbId, season, episode, episodeEnd? } \| null }`. Runs only for the library folders the admin set to your plugin (their "information provider"); null → the core's own rules; the admin's own match always wins. Needs `files` |

How the core uses the answers (step P3):

- **Sources**: a `magnet` keeps only its info hash and name; the torrent gets the server's own trackers (a tracker list could make the torrent client reach addresses your sandbox may not). An `http` source becomes a media ref `r_…`: the server streams it with your `headers`, checking your `network` hosts and the address rules on every request and redirect; the client never sees the URL or the headers. Give `size` when you know it (else the server asks the source for one byte to learn it); the source must answer `Range` requests with `206`. A ref lives an hour after its last use.
- **`play.rank`** sees every source (the core's and other plugins'); hidden ones are listed to the user as "Hidden by <your name>: <reason>". Plugins run in id order, each on the previous one's result.
- **`play.before`** runs when the user picks a source: the first `refuse` (by plugin id) wins, else the first `ask`; the user's yes runs the hooks again with the question answered.
- **`play.resolve`**: `check` gets every torrent of the Play (≤ 200 hashes, 3 s); the first resolver (by id) to say `cached` serves it. `resolve` runs only when the user picks that torrent; `null`, a failure or a source you may not use plays the torrent itself.
- **`releases.providers`**: listed in the core's movie and TV "Find releases" as a source named after your plugin (hook kinds `movie` and `show`); answer `{ releases: [], last: true }` for a kind you don't serve. Not for `audience: adults` plugins (those lists have no profile).
- **`subtitles.providers`**: listed in the player's subtitle sources; `languages` is the 639-1 codes asked, or empty for all. Formats: `srt`, `vtt`, `ass` / `ssa` (converted to WebVTT); `sub` isn't read yet.
- **`player.markers`**: asked once the player knows the length; markers past the duration are dropped.
- **`library.match`** runs only for folders whose "information provider" is your plugin; `parse` is the core's own reading of the name, `ids` what its nfo / name tags gave.

`RankedSource` is what ranking sees of any source: `{ id, type: file | download | torrent | plugin, provider, label, quality, size, codec, audio, seeds, playable }`, never a magnet, path, URL or media ref.

### Sources

| Kind | You give | How it plays |
|---|---|---|
| `magnet` | `magnet` or `infoHash` (+ `fileIndex` / `fileName`), `label`, `quality?`, `size?`, `seeds?`, `peers?`, `codec?`, `audio?`, `notes?` | as the core's torrents: leases, paused when left, never deleted |
| `http` | `url` (HTTPS), `headers?` (sent by the server only; not `Host`, `Cookie`, `Range`…), `label`, `size?`, `container?`, codecs | the server proxies it as a media ref `r_…` with ranges passed through, the host checked on every request and redirect; **the client never sees the URL**; ffprobe and the Dolby → AAC conversion work on it. The ref lives 1 h; Resume collects again |

Your sources are ranked with the core's, carry your `notes` ("From Real-Debrid") and never autoplay over a file on the server.

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

You get `playback` events only of profiles the admin granted you `events.playback` for (the dashboard: Plugins › <name> › Settings › Profiles; off until switched on). They come from the player's reports: `started` on the first, then `progress` (about every minute), `paused`, `finished` the first time past 90 %, `ended` when the player is left. Plays of titles the TV doesn't name (18+, `tracking: 'none'`, every play of an `adults` plugin) send none. Your own writes never come back to you; another plugin's come with its `by`. A kids profile's events never reach an `adults` plugin.

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

With a `deviceCode` link in the manifest, the admin presses **Link** in the dashboard (Plugins › <name> › Settings › Accounts: per profile for `profile` scope, once for `server` scope), the dashboard shows the code and its URL (whoever owns the account enters it on their phone), the host polls the token URL (at the interval the service gives, slower on `slow_down`), stores the tokens with your secrets and refreshes them when they're within 5 minutes of expiring. Requests go out as your plugin (its hosts and address rules), form-encoded as RFC 8628 says, or JSON with `"body": "json"` (Trakt); the token request carries the code as both `device_code` and `code`. The client id is your secret named by `clientIdSecret` (a `secret` setting the admin fills in first). You read the link:

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
