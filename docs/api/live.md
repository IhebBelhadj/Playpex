# Live TV

TV channels come from the server's **live plugins** (plugins with `live.channels`: an M3U / IPTV plugin, a broadcaster's service). The server keeps their channels, asks them for programmes and for a channel's stream when it plays, and hands you a media ref: you never see a provider's address, token or header. Shapes: `LiveProvider`, `LiveChannel`, `LiveChannels`, `LiveProgramme` in the OpenAPI spec.

Every call takes the profile (`?profile=`): a kids profile gets no `audience: adults` plugin and no channel marked `audience: adults`, and a plugin the admin hid from the profile isn't there.

## Is there any?

`GET /plugins` answers `capabilities.live: true` when some plugin has channels for the profile. Then:

```
GET /api/v1/live?profile=p1
→ { "providers": [{ "plugin": "m3u", "name": "Live TV (M3U)", "guide": true, "channels": 312, "updatedAt": "…", "error": null }] }
```

`channels` is `null` until something asked for them. A plugin's screens (`GET /plugins`) include its **guide** screen (`template: "guide"`) when it has one: that's the screen to draw for its menu entry ([plugins](plugins.md)).

## Channels

```
GET /api/v1/live/m3u/channels?profile=p1[&group=News][&q=bbc]
→ { "plugin": "m3u", "name": "…", "guide": true,
    "channels": [{ "id": "bbcone.uk", "number": 101, "name": "BBC One", "logo": "/live/m3u/logos/…", "group": "News" }, …],
    "groups": [{ "name": "News", "count": 40 }, …], "updatedAt": "…", "error": null }
```

- Up to 5000 channels, one per `id` (stable: keep it for favourites and "last channel"), each with a `number` (the plugin's, else the server numbers them after the highest).
- `logo` is an https URL, or a **path under the API prefix** (`/live/{plugin}/logos/…`, `/plugins/{plugin}/assets/…`): the server fetches logos on plain-http hosts and ones the plugin may reach. Prefix it with `<server>/api/v1`.
- `group` and `q` (each word starts a word of the name, number or group) filter the list; `groups` counts all of them in their order.
- The server keeps the list 6 hours (then refreshes it in the background) and asks again at once when the admin changes the plugin's settings: refetch on the event `plugin.changed`. `error` is why the last refresh failed (the list before it is kept); a plugin that failed with nothing kept answers `502 PLUGIN_FAILED`.

## The guide

```
GET /api/v1/live/m3u/guide?profile=p1&channels=bbcone.uk,itv1.uk&from=2026-10-25T21:00:00Z&to=2026-10-26T00:00:00Z
→ { "from": "…", "to": "…", "programmes": [{ "channel": "bbcone.uk", "start": "…", "end": "…", "title": "Newsnight",
    "subtitle"?, "description"?, "category"?, "episode"?: "S2 E5", "image"? }, …] }
```

- At most **200 channels** and **48 hours** per call (`400 INVALID` past them); programmes overlapping the window, by channel then start.
- A plugin without a guide (`guide: false`) answers none: draw channels as a plain list.
- Answers are kept 15 minutes per window: ask for whole half hours (e.g. from the current half hour) so clients share them. The first call after a refresh may take a few seconds (a guide can be tens of MB the server downloads and parses); the server warms the first window itself when channels load.
- There is no catch-up (programmes before now can't be played) in this version.

## Playing a channel

```
POST /api/v1/live/m3u/channels/bbcone.uk/play?profile=p1
→ { "channel": { … }, "source": { "kind": "media", "ref": "h_…", "format": "hls", "label": "BBC One", "live": true } }
```

The server asks the plugin for the channel's stream **now** (IPTV addresses carry tokens that expire: don't keep a ref for later; ask again each time the user tunes) and answers it as a media ref, played like any plugin stream ([playback: plugins' streams](playback.md#plugins-streams-hls-and-live)):

- `format: hls` → `GET /media/{ref}/index.m3u8` with an HLS player;
- `format: live` → one continuous Matroska stream on `GET /media/{ref}` (the server's ffmpeg remuxes the provider's MPEG-TS; `503 TRANSCODER_UNAVAILABLE` without ffmpeg).

It's always live: no timeline, no seeking, no resume point, history or progress. Live viewers count against the server's `streaming.maxLive` (default 2, per device and stream): past it the stream answers `503 BUSY`. **Release** a channel when the user leaves or switches (`DELETE /media/{ref}`) before tuning the next one, so a two-stream limit still lets one device zap. `502 PLUGIN_FAILED`: the plugin can't play it now (show its message).

## What Playpex TV does

The guide screen: lines are channels (number, logo, name), each its programmes sized by length over a 3-hour window from the current half hour, an amber line at now; ↑/↓ move between channels to the programme nearest in time, ←/→ along a channel; Later / Earlier move the window; a group panel narrows it; the focused programme's details on top. Enter on what's on now plays the channel; on a later programme shows its details. In the player: a channel banner (number, logo, name, now and next with the programme's progress) at the start and on each change; ↑/↓ (and the media keys next / previous) change channel within the list it came from (presses add up, the switch happens a moment after the last); OK opens a mini guide of that list. The search page has a chip per live plugin finding its channels by name.
