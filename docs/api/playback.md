# Playing a torrent

Playing anything is the same few steps: find a release (a torrent), add it to the server, wait for its file list, choose a file, stream it over HTTP byte ranges, tell the server you're still watching, and release it when you're done. Every request here carries the device token ([auth](auth.md)).

## 1. Finding something to play

The server has no media library: titles come from public catalogs, releases from torrent providers.

| What | Where | Notes |
|---|---|---|
| Titles, posters, seasons, episodes, cast | **TMDB**, called by the client with its own key | The server will proxy it later (plan §12 G: `/api/v1/catalog/*`, the key in server settings). Until then each client needs a TMDB key. Movies need TMDB's `imdb_id`, shows their `external_ids.imdb_id` |
| A movie's torrents, rating, runtime | `GET /movies/{imdbId}` | YTS `movie_details.json` passed through: `data.movie.torrents[]` (`hash`, `quality`, `type`, `size`, `seeds`…), `rating`, `runtime`. YTS gives hashes, not magnets: post the bare `hash` as the `link` (or a magnet built from it); the server adds its own public tracker list to every torrent |
| An episode's torrents | `GET /shows/{imdbId}/torrents?title=&season=&episode=` | EZTV + TheRARBG merged, **ranked best first** (playable video, then supported audio, seeders, single episode before season pack, 1080p first). `title` = the show's English name without the year (TMDB `name` with `language=en-US`), used to match release names. Each torrent has `magnet`, `hash`, `seeds`, `size`, `quality`, `codec`, `audio`, `playable`, `pack` |
| "Find releases" lists (most seeded first) | `GET /releases/providers?kind=movie\|tv\|adult`, `GET /releases/browse?kind=&provider=&q=&quality=&playable=1&page=&imdb=` | one provider's list with filters and paging; `imdb` (optional) lets EZTV list one show |
| IMDb ratings | `GET /imdb/{imdbId}`, `GET /imdb/{imdbId}/episodes` | series, season means, episodes |
| 18+ section | `/adult/*` | releases and a pluggable metadata catalog. Hide it for kids profiles (`profile.isKid`) and when `GET /server` says `features.adult: false` |

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

Each entry of `files[]`: `{ name, path, link, length, offset, selected }`.

- **A movie**: the largest file with a video container you can play. The TV app prefers `mp4` > `m4v` > `mkv` > `webm`, then size.
- **An episode**: match `SxxEyy` in `path` (also `s2e5`, `2x05`; regex used by the TV app, with `S` and `E` replaced by the season and episode numbers: `(s0*S[ ._-]*e0*E|\b0*Sx0*E)(?!\d)`, case-insensitive). Season packs hold every episode of the season; a torrent with a single video file is that episode.
- Skip samples, `.nfo`, `.txt`, images. `.avi` (XviD) rarely plays in browsers.

## 5. Streaming

First decide whether to play the file as it is or the server's transcoded stream ([next section](#choosing-direct-play-or-the-transcoded-stream)); both start from the file's `link`. The file's URL is the server's origin + `link`:

```
http://192.168.1.20:28470/api/v1/torrents/dd8255ec…/files/Big%20Buck%20Bunny%2FBig%20Buck%20Bunny.mp4
```

- **Use `link` as given** (it is already URL-encoded); don't build it from `path` yourself.
- Give that URL to your media player with the token: an `Authorization: Bearer` header (ExoPlayer `DefaultHttpDataSource.setDefaultRequestProperties`, AVPlayer `AVURLAssetHTTPHeaderFieldsKey`, mpv `--http-header-fields`), or `access_token=<token>` in the query when the player can't set headers (HTML `<video>`). Local clients add `device=<deviceId>` instead. (Use `?` or `&` depending on whether the URL already has a query.)
- The route answers `Range` requests with `206` and `HEAD` with the length, like a static file. Streaming a file **selects it**: from then on the server downloads only that file of the torrent, in the order the player asks for it, and fetches the file's last 2 MB early (where MKV keeps its index).
- Start-up depends on the swarm: a few seconds on a healthy torrent, much longer on a poor one. Show progress from `/stats` while the player buffers.
- What the file holds is whatever the release holds: containers and codecs are not converted, except the audio when you ask for it ([next section](#choosing-direct-play-or-the-transcoded-stream)).

## Choosing direct play or the transcoded stream

Many releases carry Dolby (AC-3, E-AC-3), DTS or TrueHD audio. If your player decodes it, play the file directly. If not (browsers, Electron), the server can re-encode **only the audio** to AAC stereo with ffmpeg and stream that (`features.transcode` in `GET /server` says ffmpeg is there).

**Today the client decides**; a server-side decision per device is planned (plan §6.5: `GET …/files/{path}/playback`, from your declared `capabilities`).

1. **Probe** the file: `GET /api/v1/torrents/{infoHash}/probe/{path}` (same path as the file's `link`, with `/probe/` instead of `/files/`):
   ```json
   { "duration": 2732.5, "video": "h264",
     "audio": [ { "index": 0, "codec": "eac3", "language": "eng", "title": null, "channels": 6, "default": true } ],
     "transcode": true }
   ```
   `transcode: true` means "Chromium can't play the default audio track". Decide from `audio[].codec` against what your player decodes. Probing reads the start of the file through the torrent, so it can take a few seconds. `502 PROBE_FAILED` / `503 TRANSCODER_UNAVAILABLE`: play directly.
2. **Transcoded stream**: `GET /api/v1/torrents/{infoHash}/transcode/{path}?t=<seconds>&audio=<index>` → live Matroska (`video/x-matroska`): video copied, audio AAC stereo, starting at `t`. `audio` = the `index` of the track to hear from the probe (the one with `default: true` unless the user chose another), not its position in the list.
   - It is **not byte-seekable**. To seek: `GET /api/v1/torrents/{infoHash}/keyframe/{path}?t=<target>` → `{ "time": 1201.4 }` (the keyframe at or before the target, where video and audio both start), then request `/transcode/…?t=1201.4` again and treat it as starting at 1201.4 s: your player's position 0 is `time` in the file. Subtitles cues (file time) must be shifted by the same offset.
   - The stream has no total duration: take it from the probe.
   - The server runs at most 2 transcodes at once (setting). A new transcode from the same device and file replaces the previous one (a seek), anything else past the limit gets `503 BUSY`.

## Subtitles

1. `GET /api/v1/subtitles/providers` → `[{ id, name, description, supports: {movie, episode}, enabled }]` (`enabled: false` = needs an API key on the server). Let the user choose; remember the choice on the device.
2. `GET /api/v1/subtitles/search?provider=&imdb_id=tt…&season=&episode=&languages=en,fr` → `{ provider, subtitles: [{ provider, ref, language, languageName, name }] }`. Languages are ISO 639-1. `unsupported: true` = this provider doesn't cover that kind of title.
3. `GET /api/v1/subtitles/file?provider=&ref=&lang=` → **WebVTT** (`text/vtt`), whatever the original format or code page. Load it as a side track (`<track>`, ExoPlayer `SubtitleConfiguration`, AVPlayer needs it muxed or rendered by you). Add `&access_token=` when your player fetches it without your headers.

Subtitles embedded in the file (MKV) are not extracted by the server.

## Leases, keepalive and releasing

The server keeps a torrent running while at least one device holds a **lease** on it; that's how two devices can watch the same torrent and why a crashed client doesn't leave a torrent downloading forever. Every torrent is also a **download** the server keeps afterwards ([below](#downloads)): leases decide whether it runs, never whether it is deleted.

| Request | Lease |
|---|---|
| `POST /torrents` | taken |
| any `files/`, `probe/`, `keyframe/`, `transcode/` request | taken or refreshed; an open stream keeps it alive |
| `POST /torrents/{infoHash}/keepalive` | refreshed |
| `DELETE /torrents/{infoHash}` | **released** (`{ok: true}` even without a lease) |

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

## Downloads

The server keeps every torrent it has played or been asked to download, like a torrent client: `GET /downloads` (all, with `state`, `intent`, progress, speeds, the `title` a player named), `GET /downloads/{infoHash}` (+ `files`). Events `download.added` / `download.updated` / `download.removed` ([events](events.md)) keep a list live.

| `state` | |
|---|---|
| `downloading`, `seeding`, `checking` | running (`checking`: the engine verifies data on disk) |
| `queued` | waits for room (the server runs `downloads.maxActive` downloads at once, or they are paused by the admin) |
| `paused` | stopped, data kept (a player left, or someone paused it) |
| `completed` | every selected file is done; playing it reads the file from disk |
| `error` | `error` says why; start it again |

`intent`: `stream` (a player; it pauses when the last one leaves) or `download` (runs to the end without a player: `POST /downloads {link}`, or `POST /downloads/{infoHash}/start` on a known one). A client may add downloads (`POST /downloads` `{link, files?}` or a multipart `.torrent`), start / pause them, choose files (`PUT /downloads/{infoHash}/files {files: [paths] | null}`) and set "remove when watched" (`PATCH /downloads/{infoHash} {removeWhenWatched}`: deleted with its data once a player reached 90 %); only the admin removes one (`DELETE /downloads/{infoHash}?data=keep|delete`). A "Download" button in a client is `POST /downloads`, then the `download.updated` events for its progress.

## Progress and resume

Saving where the user stopped is per **profile** ([profiles](profiles.md#playback-progress-and-resume)): `PUT /profiles/{id}/progress/{mediaType}/{tmdbId}` every ~15 s while playing and on pause / exit, with `infoHash` and `filePath` so a later resume can play the same release. Separate from the keepalive, which is per device and only lives as long as the lease.

## Trailers

`/youtube/{videoId}` exists but is **broken** past the first ~1 MB (YouTube's proof-of-origin checks). Play trailers with YouTube's own player (IFrame API, the YouTube app or SDK) using `yt_trailer_code` (YTS) or TMDB's `videos`.
