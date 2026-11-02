---
title: "Hooks"
description: "The stages of Play, metadata, subtitles, search and live TV that a plugin joins."
group: Build plugins
order: 4
---

Hooks are named stages of core features. Each has a fixed input and output, a timeout, and one rule: **a handler that throws, times out or answers out of shape is skipped**. The core's own sources run in the same stages, and a plugin can't remove them.

```js
playpex.hooks.on('play.collect', async function (input, ctx) {
  var t = input.title;                      // { kind, tmdbId, imdbId, season, episode, title, year }
  var r = await playpex.http.request({ url: 'https://api.example.com/find?imdb=' + t.imdbId, responseType: 'json' });
  return r.body.items.map(function (i) {
    return { kind: 'http', url: i.url, label: i.name, quality: '1080p', size: i.size };
  });
});
```

## The hooks

| Hook | Timeout | Input → output |
|---|---|---|
| `play.collect` | 8 s | `{ title }` → up to 50 sources |
| `play.rank` | 1 s | `{ title, sources }` → `{ order?, hide?: [{ id, reason }] }` |
| `play.before` | 1 s | `{ title, source }` → continue, ask a question, or refuse with a reason |
| `play.resolve` | 3 s / 10 s | check which torrents a service has cached, then turn the chosen one into a direct stream |
| `releases.providers` | 10 s | `{ kind, title?, query?, page }` → `{ releases, last }`: a Find releases list |
| `sources.search` | 15 s | `{ query, kind, page }` → `{ results, last }`: your streams in the dashboard's Search |
| `subtitles.providers` | 8 s | `{ title, languages, fileName? }` → subtitles; the core fetches and converts them |
| `metadata.details` | 5 s | `{ title, details }` → up to 3 ratings, 10 tags, 5 links, 3 meta lines |
| `player.markers` | 3 s | `{ title, duration }` → intro, recap, credits and chapter markers |
| `live.channels` | 30 s | → `{ channels }`, up to 5000 |
| `live.guide` | 30 s | `{ channels, from, to }` → `{ programmes }` |
| `live.stream` | 10 s | `{ channel }` → `{ source }`, asked when someone tunes in |
| `library.match` | 10 s | `{ file }` → `{ identity }`, for the folders the admin set to your plugin |

## Sources

| Kind | You give | How it plays |
|---|---|---|
| `magnet` | `magnet` or `infoHash`, `label`, `quality?`, `size?`, `seeds?` | as the server's own torrents: kept, paused when left |
| `http` | `url` (HTTPS), `headers?`, `label`, `size?` | the server proxies it; **the client never sees the URL or headers** |
| `hls` | `url` of an `.m3u8`, `headers?`, `label` | the server rewrites the playlist to itself and streams the parts |
| `live` | `url` of a continuous stream, `label` | for channels: the server remuxes it for one viewer |

Every plugin's torrents are ranked together by the core, one per info hash. Give your best 50; reorder or hide with `play.rank`. Hidden sources show to the user as "Hidden by <your plugin>: <reason>".

## Ratings on title pages

```js
playpex.hooks.on('metadata.details', async function (input) {
  return {
    ratings: [{ source: 'Example', value: 8.4, max: 10, votes: 1200, url: 'https://example.com/t/1' }],
    tags: ['Space', 'Time travel'],
  };
});
```

The admin orders metadata providers, and switches each on or off, in **Settings › Metadata**. Cache what you fetch: title pages are opened often.

## Live TV

A live TV plugin answers three hooks: its channels, their guide for a window of time, and a channel's stream when someone tunes in, so tokens in stream addresses stay fresh. Parse playlists with `playpex.iptv.m3u` and guides with `playpex.iptv.xmltv`. A `guide` screen draws the channels and guide for you (see [Screens and slots](screens)). The **Live TV (M3U)** plugin is the reference.
