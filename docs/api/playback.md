# Playing a torrent

Playing anything is the same few steps: find a source (`POST /play/sources`; a file the server has plays by its media ref at once), else add a torrent to the server, wait for its file list, choose a file, stream it over HTTP byte ranges, tell the server you're still watching, and release it when you're done. Every request here carries the device token ([auth](auth.md)).

## 1. Finding something to play

**Ask the server first**: `POST /play/sources` answers every way to play one movie or episode, best first, in one call:

```http
POST /api/v1/play/sources
Content-Type: application/json

{ "kind": "episode", "tmdbId": 1396, "imdbId": "tt0903747", "title": "Breaking Bad", "year": 2008,
  "season": 1, "episode": 1, "profileId": "…" }
```

```json
{ "request": "8c1f…",
  "sources": [
    { "id": "f_3c1…", "type": "file", "provider": "library", "label": "Breaking Bad - S01E01.mkv", "ref": "f_3c1…",
      "quality": "1080p", "size": 1460000000, "playable": "audio-converted", "badges": ["on-server", "best"],
      "notes": ["Sound converted by the server"], "group": "server", "readiness": "instant" },
    { "id": "torrent:9f2…", "type": "torrent", "provider": "eztv", "label": "Breaking.Bad.S01E01.720p…", "infoHash": "9f2…",
      "magnet": "magnet:?xt=…", "seeds": 120, "quality": "720p", "playable": "yes", "badges": [], "notes": [],
      "group": "torrent", "readiness": "seconds" } ],
  "groups": [ { "group": "server", "best": "f_3c1…", "count": 1, "readiness": "instant" },
              { "group": "torrent", "best": "torrent:9f2…", "count": 1, "readiness": "seconds" } ],
  "hidden": [],
  "policy": { "autoplay": null },
  "errors": [] }
```

- `tmdbId`, `imdbId`, `title`, `year` are the movie's, or the **show's** for an episode; `title` is matched against release names (TMDB's English name).
- `type`: `file` (a file of the server's media library), `download` (a file of a torrent the server keeps for this title; `progress` 1 = all on disk), `torrent` (from a provider). **A source with a `ref` plays through `/media/{ref}` directly** (skip steps 2–4: no `POST /torrents`, no polling; the lease is taken by the first `GET /media/{ref}`, kept with `POST /media/{ref}/keepalive`, released with `DELETE /media/{ref}`). A `torrent` plays from its `magnet` (steps 2–5).
- `playable`: `yes`, `audio-converted` (Dolby / DTS sound the server re-encodes, see [audio](#choosing-direct-play-or-the-transcoded-stream)), `maybe` (HEVC / 10-bit / 4K: depends on the hardware), `no`; `notes` say why in words. Like the release fields below, these are judged for a Chromium player.
- `badges` you may show (ignore unknown ones): `best` (the first), `on-server`, `downloading`, `pack`, `hdr`, `plugin` (from a plugin of the server), `cached` (a service a plugin links plays this torrent at once: say "Cached on <`resolver.label`>").
- Plugins on the server ([plugins](plugins.md)) may add sources: torrents, and `type: 'plugin'` streams that play by their `ref` (the server proxies them; there's no URL to see) **as their `format` says**: absent or `file` like a file, `hls` an HLS playlist ([streams](#plugins-streams-hls-and-live)); badge `live` when it is known to be live. `hidden` lists what a plugin hid, with `by` (its name) and `reason`: show "Hidden by <by>: <reason>" under the choices; they can't be played.
- **Show ways to play, not a list of releases**: `groups` sorts the sources by kind, in this order when present: `server` (a library file or a download: on this server), `stream` (a plugin's stream, or a torrent a plugin's service plays at once), `torrent`. Each group names its `best` source (its first in `sources`) and `count`; each source has its `group` and its `readiness`, how soon it plays: `instant` (on disk, a stream), `seconds` (a healthy swarm, a download running), `slow` (few people sharing), `unknown`. Playpex TV shows one lane per group with its best line first ("Plays now", "Starts in seconds", "Few people sharing: may be slow"), the rest one step further; a group with nothing is left out, and with no group at all there is nothing to play this from (say that sources come from the server's admin: plugins on its dashboard).
- A `torrent` a plugin found may name the file of the torrent to play (`file: { name, index }`): play that one once the torrent's files are known.
- With `profileId`, the profile's setting `player.preferLocalFiles` (default on) puts the files on the server that play first, and **`policy.autoplay`** names the source to start without asking (a lone file on the server that plays, or, with `player.autoplayKind` `server` / `stream`, the best of that group when it plays); otherwise show the groups and let the user pick. A kids profile gets no file of an adults-only folder.
- A provider that fails or takes longer than 10 s only drops its own sources (`errors: [{handler, message}]`); the answer comes anyway.
- To resume, prefer the source the progress names (`fileId` → the source `f_<fileId>`; `infoHash` → that torrent).

**Then start it**: send the chosen source (picked, autoplayed or resumed) to `POST /play/start` `{ "request": <the answer's request>, "source": <its id> }` and play what comes back:

- `{ "action": "play", "source": … }`: play this source (the same one, or, for a `cached` torrent, a `plugin` stream with a `ref`).
- `{ "action": "ask", "question", "yes", "no", "by" }`: show the question with those two answers; on yes, send the same request again with `"confirmed": true`; on no, play nothing.
- `{ "action": "refuse", "reason", "by" }`: show the reason, play nothing.
- `404`: the answer is older than 30 min, or the server restarted: ask `/play/sources` again. On a server without `/play/start` (also a `404`), play the source as listed.

**Markers**: once the player knows the video's length, `POST /play/markers` with the same title fields plus `duration` (seconds) and `fileName` answers `{ markers: [{ plugin, kind, start, end?, label? }] }`: between an `intro` / `recap` marker's `start` and `end` show "Skip intro" / "Skip recap" (seek to `end`); a `credits` marker is where "Up next" starts instead of the last 40 s; `chapter`s can mark the timeline. Empty when no plugin marks anything.

The server reads no torrent site of its own (API 2): a title's torrents come from the **source plugins** its admin installed, through `POST /play/sources`. With none, the sources are only files on the server and its downloads, and `GET /plugins` answers `capabilities: { releases: false, sources: false }`: say so ("Nothing to play this from yet", sources are added on the server's dashboard) and hide "Find releases". The routes below are the rest a title page uses.

| What | Where | Notes |
|---|---|---|
| Titles, posters, seasons, episodes, cast, a movie's runtime | `GET /catalog/*` ([catalog](catalog.md)) | TMDB behind the server: no key in the client. A title's page (`/catalog/titles/{mediaType}/{tmdbId}`) has the `imdbId` the requests above take. `GET /movies/{imdbId}` (YTS) and `GET /shows/{imdbId}/torrents` were removed in API 2: they answer `410 GONE` |
| "Find releases" lists (most seeded first) | `GET /releases/providers?kind=movie\|tv`, `GET /releases/browse?kind=&provider=&q=&quality=&playable=1&page=&imdb=` | one source plugin's list with filters and paging (`plugin:<id>`); `imdb` (optional) lets a source list one show (without it, a show's keywords get the IMDb id of the show titled so, from the catalog). Keywords reach sources as plain words ("Breaking.Bad" → "Breaking Bad"); each torrent's `matches` says whether its name holds every keyword, however it's spelt (sites answer loosely: show those first). No source: `[]` and `{ provider: null, torrents: [] }` |
| IMDb ratings | `GET /imdb/{imdbId}`, `GET /imdb/{imdbId}/episodes` | series, season means, episodes |

Release fields that help you choose: `playable: false` = video a typical player can't decode (HEVC 10-bit, XviD, 4K on Chromium); `audio: 'unsupported'` = Dolby / DTS audio (see [audio](#choosing-direct-play-or-the-transcoded-stream)). These are guesses from the release name, made for a Chromium player: a client that decodes HEVC or AC-3 can ignore them.

Show a picker with the first entry marked as the best match, or play the first one directly.

## 2. Adding the torrent

```http
POST /api/v1/torrents
Content-Type: application/json

{ "link": "magnet:?xt=urn:btih:…" }
```

`link` = a magnet, a `.torrent` URL, or a bare 40-character (hex) or 32-character (base32) info hash. Answer: `{ "infoHash": "dd8255ec…" }` (lowercase). A `.torrent` file can be uploaded instead: `POST /upload` (multipart, field `file`).

- Adding is **idempotent**: the same hash from two devices is one torrent on the server.
- It also gives your device a **lease** on the torrent ([below](#leases-keepalive-and-releasing)).
- `503 BUSY`: the server already runs as many torrents as the admin allows (4 by default). Show the error's message; nothing to retry right away.

## 3. Waiting for the file list

The server needs the torrent's metadata from peers first. Poll:

```http
GET /api/v1/torrents/{infoHash}
```

Until the metadata arrives the answer is only `{ "infoHash": "…" }`. Then it has `name`, `length`, `files[]` and `progress`. Poll every 2–4 s; the TV app gives up after about 20 s ("no peers?"). Meanwhile, `GET /api/v1/torrents/{infoHash}/stats` (safe before metadata) gives `peers`, `speed`, `traffic` for a "connecting to peers…" screen.

## 4. Choosing the file

Each entry of `files[]`: `{ name, path, ref, link, length, offset, selected }`. `ref` is the file's **media ref**: everything you do with the file goes through `/media/{ref}` ([next section](#5-streaming)).

**Let the server choose**: poll with what you play, and take the file whose `path` is **`chosen`**:

```http
GET /api/v1/torrents/{infoHash}?season=2&episode=5          (an episode: its file, also inside a season pack)
GET /api/v1/torrents/{infoHash}?fileIndex=3&fileName=…      (a source's `file` hint, from the plugin that found it)
GET /api/v1/torrents/{infoHash}                              (a film: the largest video that isn't an extra or a sample)
```

`chosen` is `null` when no video fits (an episode not in the torrent); it is missing on servers older than this. Then choose yourself:

- **A movie**: the largest file with a video container you can play (`mp4` > `m4v` > `mkv` > `webm`, then size).
- **An episode**: match `SxxEyy` in `path` (also `s2e5`, `2x05`: `(s0*S[ ._-]*e0*E|\b0*Sx0*E)(?!\d)` with `S` and `E` the numbers, case-insensitive). Season packs hold every episode of the season; a torrent with a single video file is that episode.
- Skip samples, `.nfo`, `.txt`, images. `.avi` (XviD) rarely plays in browsers.

The torrent's other files (separate audio tracks, subtitle files, extras) are listed by the file's [tracks](#tracks-audio-subtitles-other-videos).

## 5. Streaming

First decide whether to play the file as it is or the server's transcoded stream ([next section](#choosing-direct-play-or-the-transcoded-stream)); both start from the file's media ref. The file's URL is the server's origin + `/api/v1/media/` + `ref`:

```
http://192.168.1.20:28470/api/v1/media/t_dd8255ec…_3f2a9c0d41b7e865
```

- **Refs are opaque**: use the one the server gives (`TorrentFile.ref`; files on the server's disk will come with theirs from the play sources, plan §6). A torrent's file ref is `t_<infoHash>_<16 hex>`, a file on disk `f_<id>`; the same routes serve both.
- `/media/{ref}` (`/probe`, `/keyframe`, `/transcode`, `/keepalive`, `DELETE`) is the API from now on. The torrent routes (`link` = `/api/v1/torrents/{infoHash}/files/{path}` and its `probe/`, `keyframe/`, `transcode/` siblings) are aliases kept for API v1 clients and servers without refs: a client that meets a `TorrentFile` without `ref` (an older server) uses `link` as given (it is already URL-encoded; don't build it from `path`).
- A file on disk in an adults-only library folder answers `403 FORBIDDEN` to a kids profile: send `profile=<profileId>` with media requests (or a `profileId` in the keepalive).
- Give that URL to your media player with the token: an `Authorization: Bearer` header (ExoPlayer `DefaultHttpDataSource.setDefaultRequestProperties`, AVPlayer `AVURLAssetHTTPHeaderFieldsKey`, mpv `--http-header-fields`), or `access_token=<token>` in the query when the player can't set headers (HTML `<video>`). Local clients add `device=<deviceId>` instead. (Use `?` or `&` depending on whether the URL already has a query.)
- The route answers `Range` requests with `206` and `HEAD` with the length, like a static file. Streaming a file **selects it**: from then on the server downloads only that file of the torrent, in the order the player asks for it, and fetches the file's last 2 MB early (where MKV keeps its index).
- Start-up depends on the swarm: a few seconds on a healthy torrent, much longer on a poor one. Show progress from `/stats` while the player buffers.
- What the file holds is whatever the release holds: containers and codecs are not converted, except the audio when you ask for it ([next section](#choosing-direct-play-or-the-transcoded-stream)).

## Choosing direct play or the transcoded stream

Many releases carry Dolby (AC-3, E-AC-3), DTS or TrueHD audio. If your player decodes it, play the file directly. If not (browsers, Electron), the server can re-encode **only the audio** to AAC stereo with ffmpeg and stream that (`features.transcode` in `GET /server` says ffmpeg is there).

Two ways: **ask the server** (`/playback`, below: what browsers need, since they can't open MKV files in Firefox / Safari), or decide yourself from a probe (the steps after it: what Playpex TV does).

**Ask the server**: `GET /api/v1/media/{ref}/playback?t=<seconds>&audio=<index>&mkv=1&hevc=1&ac3=1&eac3=1&dts=1&truehd=1`, naming only what your player decodes beyond what every browser does (MP4 / WebM / MOV, H.264 / VP8 / VP9 / AV1, AAC / MP3 / Opus / Vorbis / FLAC: a browser can ask `MediaSource.isTypeSupported` / `canPlayType`). The server probes the file and answers:

```json
{ "method": "hls", "url": "/api/v1/media/t_…/hls/3f9c…/index.m3u8", "start": 1198.4, "duration": 2732.5, "audio": 0,
  "notes": ["This browser doesn’t open MKV files: the server repackages it as it plays.", "Its sound is Dolby Digital Plus (E-AC-3): the server converts it to AAC."] }
```

- `direct`: `url` is the file (`GET /media/{ref}`, byte ranges).
- `hls`: a stream the server makes now: video copied, audio AAC stereo, fMP4 segments, an event playlist (it grows until ffmpeg reaches the end; `#EXT-X-ENDLIST` then). Play it with an HLS player (hls.js where the browser has MediaSource, else its own). It starts at `start` seconds of the file (the keyframe at or before `t`): your player's 0 is `start`, subtitles' cues shift by it, and to seek outside what the stream holds ask `/playback` again with `t`. Its parts carry `?device=` (a native HLS player sends no header); they are the asking device's only. One per device and file (asking again replaces it), counted in `streaming.maxTranscodes` (`503 BUSY` past it), gone after `DELETE /media/{ref}` or 90 s without a request. `audio`: another sound track (browsers can't switch a file's tracks themselves) makes it `hls` too.
- `none`: this player can't play it (the video codec: HEVC in Firefox, XviD, VC-1…); `notes` say why in words.

Without ffmpeg the answer is `direct` with a note. The answer also says what the file is, for saving progress: `title` (`{mediaType, tmdbId, season, episode, title, posterPath}`: a library file's match, or the title a download was played as; null when the server doesn't know), `download` (`{infoHash, path}` for a torrent's file) and `fileId` (a library file's id): the `PUT …/progress` body of [Progress and resume](#progress-and-resume). The dashboard's player uses this route (`?device=dashboard-<id>`).

1. **Probe** the file: `GET /api/v1/media/{ref}/probe`:
   ```json
   { "duration": 2732.5, "video": "h264",
     "audio": [ { "index": 0, "codec": "eac3", "language": "eng", "title": null, "channels": 6, "default": true } ],
     "transcode": true }
   ```
   `transcode: true` means "Chromium can't play the default audio track". Decide from `audio[].codec` against what your player decodes. Probing a torrent's file still downloading reads its start through the torrent, so it can take a few seconds; a file on disk (or a finished download) is read directly. `502 PROBE_FAILED` / `503 TRANSCODER_UNAVAILABLE`: play directly.
2. **Transcoded stream**: `GET /api/v1/media/{ref}/transcode?t=<seconds>&audio=<index>` → live Matroska (`video/x-matroska`): video copied, audio AAC stereo, starting at `t`. `audio` = the `index` of the track to hear from the probe (the one with `default: true` unless the user chose another), not its position in the list.
   - It is **not byte-seekable**. To seek: `GET /api/v1/media/{ref}/keyframe?t=<target>` → `{ "time": 1201.4 }` (the keyframe at or before the target, where video and audio both start), then request `/transcode?t=1201.4` again and treat it as starting at 1201.4 s: your player's position 0 is `time` in the file. Subtitles cues (file time) must be shifted by the same offset.
   - The stream has no total duration: take it from the probe.
   - The server runs at most 2 transcodes at once (setting). A new transcode from the same device and file replaces the previous one (a seek), anything else past the limit gets `503 BUSY`.

## Subtitles

1. `GET /api/v1/subtitles/providers` → `[{ id, name, description, supports: {movie, episode}, enabled }]` (`enabled: false` = needs an API key on the server). Let the user choose; remember the choice on the device.
2. `GET /api/v1/subtitles/search?provider=&imdb_id=tt…&season=&episode=&languages=en,fr` → `{ provider, subtitles: [{ provider, ref, language, languageName, name }] }`. Languages are ISO 639-1. `unsupported: true` = this provider doesn't cover that kind of title.
3. `GET /api/v1/subtitles/file?provider=&ref=&lang=` → **WebVTT** (`text/vtt`), whatever the original format or code page. Load it as a side track (`<track>`, ExoPlayer `SubtitleConfiguration`, AVPlayer needs it muxed or rendered by you). Add `&access_token=` when your player fetches it without your headers.

A subtitle file the viewer has (picked on their device): `POST /api/v1/subtitles/convert?lang=` with its bytes as the body (any content type, ≤ 10 MB) → the same WebVTT; SRT, ASS / SSA and WebVTT are read, `lang` (ISO 639-1) helps with old code pages, anything binary answers `501 NOT_SUPPORTED`.

**Subtitle files next to a file on disk** (a library file: `Movie.en.srt`, `Subs/French.srt`, RARBG's `Subs/<name>/2_English.srt`): `GET /api/v1/media/{ref}/subtitles` → `{ subtitles: [{ index, language, languageName, forced, sdh }] }` (empty for a torrent's file), then `GET /api/v1/media/{ref}/subtitles/{index}` → WebVTT, like the providers' files. They need no provider and no network; offer them first.

Subtitles inside the file (MKV) and subtitle files of a torrent: see [tracks](#tracks-audio-subtitles-other-videos).

## Tracks: audio, subtitles, other videos

`GET /api/v1/media/{ref}/tracks` lists everything a player can switch for a file (it takes the lease like the other media routes; the file's own streams need ffmpeg on the server, `probed: false` otherwise):

```jsonc
{ "video": [ { "id": "v:0", "ref": "t_…_1a", "name": "Movie/Movie.mkv", "current": true },
             { "id": "v:f3", "ref": "t_…_9f", "name": "Movie/Extras/Making of.mkv", "kind": "extra" } ],
  "audio": [ { "id": "a:0", "source": "embedded", "index": 0, "language": "en", "codec": "eac3", "channels": 6, "default": true, "play": "convert" },
             { "id": "a:1", "source": "embedded", "index": 1, "language": "fr", "codec": "aac", "channels": 2, "play": "direct" },
             { "id": "a:f2", "source": "file", "ref": "t_…_c3", "name": "Movie/Audio/Commentary.mka", "title": "Commentary", "play": "convert" } ],
  "subtitles": [ { "id": "s:0", "source": "embedded", "index": 0, "language": "en", "codec": "subrip", "play": "text", "available": false,
                   "note": "Ready when the download finishes" },
                 { "id": "s:1", "source": "embedded", "index": 1, "codec": "hdmv_pgs_subtitle", "play": "image" },
                 { "id": "s:f4", "source": "file", "ref": "t_…_77", "name": "Movie/Subs/English.srt", "language": "en", "play": "text", "available": true } ],
  "probed": true }
```

- **Audio**: `play: direct` = a browser decodes it (AAC, MP3, Opus, Vorbis, FLAC); `convert` = through the server's ffmpeg: `GET /media/{ref}/transcode?t=&audio=<index>` for the file's own track, `?audioRef=<ref>` for a separate audio file (it streams while the torrent downloads it; 400 for a ref that isn't one of this video's files); `none` = no ffmpeg. A Chromium client switches `direct` tracks itself with `HTMLMediaElement.audioTracks` (Electron: `--enable-blink-features=AudioVideoTracks`); it lists only the tracks it decodes, in the file's order, so its position is the position among the `direct` ones, not `index`.
- **Subtitles** as WebVTT: the file's own text streams `GET /media/{ref}/subtitles/embedded/{index}` (ffmpeg reads the whole file: a file on disk or a finished download only; `409 CONFLICT` while a torrent's file downloads, hence `available: false`), a separate file `GET /media/{ref}/subtitles/file/{track}` (`track` = the id without `s:`, `f4`; a torrent's file is fetched at once, ≤ 10 MB; a library file's sidecars are listed here too). `play: image` (PGS, VobSub) can't be turned into text: `501 NOT_SUPPORTED`.
- **Other videos** of the torrent (`kind`: `episode` of a pack, `extra`, `video`): play one by its `ref` like any file.
- Track ids stay the same for a file: save the chosen ones with the progress (`audioTrack`, `subtitleTrack`) to come back with them. The profile's settings `player.audioLanguage` / `player.subtitleLanguage` / `player.subtitleForcedOnly` ([settings](settings.md)) say what to start with when nothing was saved.

## Plugins' streams: HLS and live

A plugin's stream (a `type: 'plugin'` source, or a play effect's `media` source: [plugins](plugins.md)) has a `format` (`MediaFormat`; absent = `file`):

| `format` | Ref | How to play it |
|---|---|---|
| `file` | `r_…` | like a file: `GET /media/{ref}` with ranges; probe, transcode and tracks work |
| `hls` | `h_…` | an HLS playlist: **`GET /media/{ref}/index.m3u8`** with an HLS player (hls.js in a browser or Electron: Chromium plays no HLS itself; ExoPlayer, AVPlayer, mpv natively). `GET /media/{ref}` answers `302` to it. VOD or live: a live playlist has no `#EXT-X-ENDLIST` |
| `live` | `l_…` | one continuous Matroska stream on `GET /media/{ref}` (the server's ffmpeg remuxes the plugin's MPEG-TS: video copied, audio AAC stereo): no size, no ranges, no seeking; `503 TRANSCODER_UNAVAILABLE` without ffmpeg |

- The server fetches the playlist **as the plugin** and rewrites every URI in it (variant playlists, segments, `#EXT-X-KEY`, `#EXT-X-MAP`, `#EXT-X-MEDIA`, …) to `r/{token}/{name}` beside it, so your player only ever talks to the server: send the same auth with every request (the `Authorization` header, or a player that keeps the query: `device=` / `access_token=` are not repeated in the rewritten URIs, so prefer a header). Tokens are signed: a client can't ask for anything else through them. Live playlists are fetched again on every request.
- `probe`, `keyframe`, `transcode`, `tracks` and the subtitle routes answer `501 NOT_SUPPORTED` for `hls` / `live` refs: the audio renditions and subtitles of an HLS stream are in its playlist (hls.js: `audioTracks`, `subtitleTracks`).
- **Live** (`format: live`, or an `hls` playlist without an end): show "Live" instead of a timeline, don't seek, save no progress. The server plays at most `streaming.maxLive` live streams at once (one per device and stream; default 2): past it the playlist or the stream answers `503 BUSY`. A live HLS viewer counts while it asks for its playlist (every target duration); release it at once with `DELETE /media/{ref}`.
- Keepalive and release are as for files (`POST /media/{ref}/keepalive`, `DELETE /media/{ref}`); the admin's Activity shows the method `hls` or `live`.

TV channels of live plugins come from `/live/*` and play the same way: [Live TV](live.md).

## Leases, keepalive and releasing

The server keeps a torrent running while at least one device holds a **lease** on it (a file on disk has leases too, for the admin's Activity page, with nothing to start or stop); that's how two devices can watch the same torrent and why a crashed client doesn't leave a torrent downloading forever. Every torrent is also a **download** the server keeps afterwards ([below](#downloads)): leases decide whether it runs, never whether it is deleted.

| Request | Lease |
|---|---|
| `POST /torrents` | taken |
| any `/media/{ref}` request (stream, `probe`, `keyframe`, `transcode`), or the torrent aliases | taken or refreshed (on the torrent for a torrent's file: one lease per torrent, whatever the file); an open stream keeps it alive |
| `POST /media/{ref}/keepalive` (= `POST /torrents/{infoHash}/keepalive`) | refreshed |
| `DELETE /media/{ref}` (= `DELETE /torrents/{infoHash}`) | **released** (`{ok: true}` even without a lease) |

- **While the player is open, paused or not, send a keepalive every 60 s.** A paused player makes no requests, and a lease idle for the server's timeout (10 min by default) is dropped. The body (all optional) is what the admin sees in Activity:
  ```json
  { "positionS": 1201, "durationS": 2732, "paused": false,
    "title": "Breaking Bad · S02E05", "profileId": "…", "file": "Season 2/Breaking.Bad.S02E05.mkv",
    "media": { "mediaType": "tv", "tmdbId": 1396, "season": 2, "episode": 5 } }
  ```
  Send `media` (the TMDB title) when you know it: the server keeps it with the download, so the admin (and later the library) knows what it holds.
- **A keepalive after the lease was dropped** (idle, or the admin stopped the session) takes a new one. **`404` on a keepalive** = the server no longer has the torrent (the admin removed it): stop the player, or add the torrent again and reopen the stream.
- **When the player closes** (back, error, end): `DELETE /torrents/{infoHash}`, also when playback never started. `404` means the torrent is already gone: nothing to do. 30 s after the last lease is released, the server **pauses** the torrent (no traffic; its data stays). Coming back within those 30 s finds it still running; later, `POST /torrents` (or a stream request) runs it again, and a completed one plays straight from disk. Nothing you do as a player deletes data.
- The admin can stop your session from the dashboard: your stream is cut (the player sees a network error) and your lease released.
- **Torrent-wide routes**: `POST /torrents/{infoHash}/start|stop/{index}`, `…/deselect`, `…/pause`, `…/resume` act on the torrent for every device watching it, not on your lease. Players don't need them (streaming selects the file); leave them to admin tools.
- Other `Torrent` fields: `state` (the download's, [below](#downloads)), `progress` = a progress bar as run lengths in percent of the pieces, alternating downloaded / missing and starting with downloaded (`[0, 40, 10, 50]` = nothing, 40 % missing, 10 % downloaded, 50 % missing), `ready` = its files can be streamed now (running and checked, or completed on disk), `interested` = running and still downloading. `GET /torrents` lists only the running ones.
- **Starting again after a pause** may take a moment: depending on the server's engine, it first checks the data already on disk (`state: checking`); stream requests wait for it.
- Season packs: two devices playing two different episodes of the same pack currently undo each other's file selection (plan §14.2): avoid it in tests.

## What's on this server

The server's media library (folders the admin added in the dashboard, plus its download folder), as a client browses it. Every route takes `?profile=<id>`: a kids profile never sees files of adults-only folders (and an unknown profile is a `404`).

| What | Route | Answer |
|---|---|---|
| A Library screen | `GET /library/home` | `movies` and `shows` (one entry per title, by title: `tmdbId`, `title`, `year`, `posterPath`, `backdropPath`, `fileCount`, `quality` (the best file), shows also `episodeCount`, `seasonCount`, `latest` (the episode added last)), `recent` (the 20 titles with the newest files), `other` (`count` and the `folders` holding other videos: files not matched to a movie or a show, and every file of an "other" folder) |
| "On this server" marks | `GET /library/titles/{movie\|tv}/{tmdbId}` | `fileCount` (0 = not on this server) and, for a show, `episodes: [{season, episode, fileCount}]` |
| Browse other videos | `GET /library/folders/{folderId}?path=` | one level: `folders` (subfolders that hold some, with `path` and a `count` at any depth) and `videos` (`ref`, `name`, `size`, `duration`, `quality`), `parent` (the level above; null at the folder itself). Ask again with a `path` you were given |

A movie or an episode on the server plays like any title: `POST /play/sources` lists its files first (`type: 'file'`). An other video plays by its `ref` directly (`GET /media/{ref}`); it has no TMDB title, so there is no progress to save. Refetch on the `library.changed` event ([events](events.md)): a scan found, changed or lost files, or the admin fixed a match or changed a folder.

## Downloads

The server keeps every torrent it has played or been asked to download, like a torrent client: `GET /downloads` (all, with `state`, `intent`, progress, speeds, the `title` a player named), `GET /downloads/{infoHash}` (+ `files`). Events `download.added` / `download.updated` / `download.removed` ([events](events.md)) keep a list live.

| `state` | |
|---|---|
| `downloading`, `seeding`, `checking` | running (`checking`: the engine verifies data on disk) |
| `queued` | waits for room (the server runs `downloads.maxActive` downloads at once, or they are paused by the admin) |
| `paused` | stopped, data kept (a player left, or someone paused it) |
| `completed` | every selected file is done; playing it reads the file from disk |
| `error` | `error` says why; start it again |

`intent`: `stream` (a player; it pauses when the last one leaves) or `download` (runs to the end without a player: `POST /downloads {link}`, or `POST /downloads/{infoHash}/start` on a known one). A client may add downloads (`POST /downloads` `{link, files?}` or a multipart `.torrent`), start / pause them, choose files (`PUT /downloads/{infoHash}/files {files: [paths] | null}`) and set "remove when watched" (`PATCH /downloads/{infoHash} {removeWhenWatched?, label?}`: deleted with its data once a player reached 90 %; a free-text label), its place in the queue (`queuePosition`), a force start past `downloads.maxActive` (`force`: ended by a pause), its own seeding goals (`seedRatio`, `seedMinutes`; null = the server's) and speed limits (`downLimitKBps`, `upLimitKBps`, where the engine can: 501 `NOT_SUPPORTED` otherwise); only the admin removes one (`DELETE /downloads/{infoHash}?data=keep|delete`). Each download also has `queuePosition` (its place while `queued`), `savePath` and `pieceMap` (its pieces in up to 100 slices, each byte the share verified: a progress bar drawn from its pieces). `POST /downloads/preview` (`{link}` or a multipart `.torrent`) tells what a link is before adding it: its name and files when known without the swarm (a `.torrent`, or a torrent the server keeps), and the download the server already has for it. Each also has `forced`, those goals and limits, and `swarm` (`{seeds, peers, at}`: the most any of its trackers counted at the server's last scrape, every 30 minutes; null before one answered). The admin also reads a download's peers, trackers (with each one's scrape), pieces (and where players read) and speed history (`/downloads/{infoHash}/peers|trackers|pieces|speed`, the dashboard's detail pane), adds and removes trackers (`POST …/trackers {add?, remove?}`, kept with the download), announces again (`POST …/reannounce`: 409 while a player reads it) and exports its `.torrent` (`GET …/torrent`). A "Download" button in a client is `POST /downloads` with `media` (`{mediaType, tmdbId, season?, episode?}`, as in the keepalive) and a `title`: the download's `title` then names it, so the title's page finds it again in `GET /downloads` and follows its `download.updated` events (Playpex TV: "Downloading 43 %", then "On this server").

## Progress and resume

Saving where the user stopped is per **profile** ([profiles](profiles.md#playback-progress-and-resume)): `PUT /profiles/{id}/progress/{mediaType}/{tmdbId}` every ~15 s while playing and on pause / exit, with `infoHash` and `filePath` (a torrent's file) or `fileId` (a library file: the id of its `f_` ref) so a later resume can play the same release, and the `audioTrack` / `subtitleTrack` ids the user chose ([tracks](#tracks-audio-subtitles-other-videos)). Separate from the keepalive, which is per device and only lives as long as the lease.

## Trailers

`/youtube/{videoId}` exists but is **broken** past the first ~1 MB (YouTube's proof-of-origin checks). Play trailers with YouTube's own player (IFrame API, the YouTube app or SDK) using a title page's `videos` (`/catalog/titles/…`).
