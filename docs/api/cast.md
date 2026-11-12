# Casting

Start playback on another Playpex screen (a TV, later a phone) from your client, follow it and drive it; or be a screen others cast to. The server only carries what to play: the screen streams it from the server like its own Play. Design and reasons: `docs/cast-plan.md`.

## Sending a cast

1. **The screens**: `GET /cast/screens` → `[CastScreen]`, the devices whose events socket takes casts now:
   ```json
   [{ "deviceId": "…", "name": "Living room", "kind": "tv", "self": false, "online": true,
      "accepts": { "media": true, "magnet": true, "embed": true },
      "playing": { "castId": "…" | null, "sessionId": "…" | null, "title": "Inception", "state": "playing", "positionS": 812 } | null }]
   ```
   `self` is your own device: leave it out of a "Play on…" list.
2. **Resolve what to play yourself**, as for your own player: a media ref from `POST /play/sources` (a library file, a download's file, a plugin's stream: refs are the server's, not your device's, so the screen plays the one you got), a torrent's magnet, or a YouTube video.
3. **Cast**: `POST /cast/screens/{deviceId}/play` with a `CastRequest`:
   ```jsonc
   {
     "title": "Breaking Bad", "subtitle": "S01E03 · …And the Bag's in the River",
     "item": { "mediaType": "tv", "tmdbId": 1396, "imdbId": "tt0903747", "season": 1, "episode": 3 },
     "artwork": { "posterPath": "/…", "backdropPath": "/…" },
     "source": { "ref": "f_…", "format": "file" },   // or { "magnet": "magnet:?…", "file": { "name": "…" } }
                                                      // or { "embed": { "provider": "youtube", "id": "dQw4w9WgXcQ" } }
     "positionS": 812,                // unset: the profile's resume point
     "profileId": "…",                // who watches; unset: the screen's own profile
     "pin": "1234",                   // a locked profile your device hasn't opened
     "pluginId": "…",                 // the plugin the source came from, if any
     "tracking": "full"
   }
   ```
   → `202 { castId, delivered }`. Refusals: `403 CAST_REFUSED` (casting is off on the server; a locked profile without its PIN; an adults plugin's source as a kids profile, or to a screen showing one), `403 FORBIDDEN` (a wrong PIN), `404 NOT_FOUND` (the profile, or a plugin's source that expired: find it again), `409 DEVICE_OFFLINE`, `422 UNSUPPORTED` (the screen doesn't play that kind of source).

   A locked profile: your device may cast as it once it opened it (`POST /profiles/{id}/unlock` with the PIN, for 12 hours), the admin always. An adults plugin's source always plays with `tracking: "none"`. A new cast to a screen replaces what was cast there.
4. **Follow it**: on your [events socket](events.md) (`?topics=cast`), `cast.updated` and, at the end, `cast.ended`, both a `Cast`:
   ```json
   { "castId": "…", "deviceId": "<screen>", "from": { "deviceId": "<you>", "name": "Pixel 8" },
     "sessionId": "…" | null, "state": "opening" | "playing" | "paused" | "buffering" | "ended" | "failed",
     "positionS": 812, "durationS": 2820, "title": "Breaking Bad · S01E03", "profileId": "…", "error": null, "startedAt": "…" }
   ```
   `GET /cast/{castId}` answers the same (you, the screen and the admin). `failed` carries `error`, for people.
5. **Drive it**: `POST /cast/{castId}/commands { action: pause | resume | toggle | seek | seekBy | stop, positionS?, deltaS? }` → `202 { delivered }`; only you (the sender), the screen and the admin. Through the screen's session when it has one (`POST /sessions/{id}/commands` also accepts you for that session), else straight to the screen.

"Continue on <screen>": cast with `positionS` = where you are, then close your own player. "Continue here": `stop` the cast, then open your player at its last `positionS`.

Playpex's own senders, for reference: the dashboard (a cast button in its top bar picks where Play sends: this browser or a screen; a bar under every page drives what plays on the screens; its player's "Continue on a screen") Playpex TV (its player's "Play on another screen": what it plays, at its position, as its profile, then its player closes) and Playpex Mobile (a cast button in its top bar: while a screen is chosen, Play sends there; a mini player and a remote follow `cast.updated`; "Continue on phone" stops the cast and opens the phone's player at its last `positionS`; its player's "Play on a screen"). **Share to Playpex** (Playpex Mobile): another app's Share sheet sends a link; the app reads it with `POST /links/inspect` ([search](search.md)) and casts what it found: a YouTube video as an `embed`, a video file or stream by its ref, a magnet or a `.torrent`'s info hash as a `magnet`. A YouTube video plays on screens only (the phone has no embed player). Straight to a screen, without the sheet: through that screen's direct share target in Android's Share sheet (the app keeps one sharing shortcut per screen that's on, `screen:<deviceId>`), or with the phone's device setting `cast.shareTo` (a screen's device id; `null`: ask each time) when that screen is on and takes what the link holds. The admin's `GET /sessions` says which sessions a cast opened: `cast { castId, from }` (null for what a device opened itself).

## The YouTube app's Cast list

With the server setting `cast.youtube` on (off by default), every screen whose events socket takes `embed` casts gets a YouTube receiver on the server: phones on the same Wi-Fi see "Playpex - <screen>" when they tap Cast in the YouTube app. What they cast reaches the screen as an ordinary `cast.play` (from "YouTube · <account>", an `embed` source, `tracking: "none"`, the screen's own profile); YouTube's remote arrives as `session.command`s with the cast's id. A screen does nothing more than for any embed cast: report its state (`POST /cast/{castId}/state`) on play, pause and seek, and its position every 15 s; YouTube's progress bar and Up next follow those reports. `GET /cast/youtube/code` gives the calling screen its "Link with TV code" (12 digits, changes every 5 minutes; `null` while it isn't in the list), for phones on another network. `GET /cast/youtube` (admin) lists the receivers and the phones connected to each. The YouTube app casts only while the phone is on Wi-Fi.

## Being a screen

1. **Open the events socket with `?control=playback,cast&accepts=media,magnet,embed`** (only what your player plays; a client without a device token adds `?device=<id>`). While it's open you're in `GET /cast/screens`. Let the user turn it off (Playpex TV: the device setting `cast.allowed`).
2. **`cast.play`** (`CastPlayEvent`) comes to your sockets only:
   ```json
   { "castId": "…", "from": { "deviceId": "…", "name": "Pixel 8" }, "profileId": "…" | null, "adults": false, "request": { …CastRequest } }
   ```
   Open your player with it, over what you play. Play as `profileId` (the server checked it; take it even when another profile is picked on the screen), or as the profile picked on the screen when it's null. Refuse an `adults` cast while a kids profile is picked. Say who cast it ("Cast from Pixel 8 · Anna").
3. **Report**: put `castId` in every keepalive of that player ([playback](playback.md#leases-keepalive-and-releasing)); the sender then follows your session. Send one as soon as the video plays, not a minute later. What has no session (an embedded YouTube video) reports itself: `POST /cast/{castId}/state { state, positionS?, durationS? }` on play, pause and seek and every 15 s. A cast you can't play: `{ "state": "failed", "error": "…" }`; when your player closes: `{ "state": "ended" }`.
4. **Commands**: `session.command` as in [Control from the server](remote.md#playback-commands); one with `castId` and `sessionId: null` is for the player of that cast.
