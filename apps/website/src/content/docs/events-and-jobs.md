---
title: "Events, jobs and accounts"
description: "React to what happens, run background jobs, write to people's lists, link accounts and notify."
group: Build plugins
order: 5
---

## Events

Events tell you what happened; you can't change it, and the core doesn't wait for you.

```js
playpex.events.on('playback.progress', function (e) {
  // e.data = { title, position, duration, source }
});
```

| Family | Events |
|---|---|
| `playback` (personal) | `playback.started`, `.progress` (about every minute, and on pause or seek), `.paused`, `.ended`, `.finished` (90 % watched) |
| `downloads` | `download.added`, `.completed`, `.removed` |
| `library` | `library.changed`: titles added and removed |
| `watchlist` | `watchlist.added`, `.removed`, `watched.set`, `watched.cleared`, `rating.set`, with `by` |

Events arrive at most once and in order, from a queue of 100 per plugin; when it overflows, the next event carries `dropped: n`. You get `playback` events only for the profiles the admin switched on for you.

## Schedules

```js
playpex.schedule.every('sync', '1h', async function (ctx) {
  var profiles = await playpex.profiles.list('write.watchlist');
  // …
}, { atStart: true });
```

Intervals from `5m`, with 10 % jitter; a run never overlaps the previous one, and lasts at most 5 minutes. Declare schedules each time `server.js` loads; the dashboard shows each job's last run and error.

## Writes

Writes go through the server's own rules, and only for profiles the admin granted that scope:

| Scope | Calls |
|---|---|
| `watchlist` | `watchlist.add(profileId, titleRef)`, `remove`, `list` |
| `watched` | `watched.set(profileId, titleRef)`, `clear`, `progress.set(profileId, titleRef, position, duration)` |
| `ratings` | `ratings.set(profileId, titleRef, 1–10)`, `clear` |
| `downloads` | `downloads.add({ magnet \| url, title })`, `downloads.list()` |

A title is `{ kind: 'movie' | 'show' | 'episode', tmdbId, season?, episode? }`. Your writes come back to other plugins as events with `by: plugin:<id>`, never to you.

## Linking an account

Declare a device-code link in the manifest and the dashboard runs the whole flow: the admin presses **Link**, the account's owner enters a code on the service's site, and the server keeps and refreshes the tokens.

```js
var s = await playpex.link.status('trakt', ctx.profile.id);   // { linked, accessToken, expiresAt }
if (s.linked) {
  await playpex.http.request({
    url: 'https://api.trakt.tv/sync/watchlist',
    headers: { Authorization: 'Bearer ' + s.accessToken, 'trakt-api-key': await playpex.secrets.get('traktClientId') },
  });
}
```

A service without a device flow can use a link with `"custom": "<data name>"`: your handler answers a code to show, or a form for an API key.

## Notifications

```js
await playpex.notify.send('all', { text: 'Your watch list is in sync', tone: 'success', key: 'sync' });
```

A short toast on those profiles' screens, kept 24 hours for screens that are off; one per `key`, the newest wins; 10 per hour per plugin and profile.
