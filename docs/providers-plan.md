# Providers as plugins: sources, tracks, metadata, live TV

Status (2026-10-24): **steps 1–3 built**. **Step 3** (tracks): `GET /media/{ref}/tracks` (`lib/media/tracks.js`: the file's own audio / subtitle streams from ffprobe with `play` direct / convert / text / image / none, a torrent's audio and subtitle files matched to the video by the library's sidecar rules over its path list (`lib/media/files.js#companions`), a disk file's sidecars, the torrent's other videos without samples), `GET …/subtitles/embedded/{index}` (ffmpeg → WebVTT, cached; a file on disk only, 409 while a torrent's file downloads: decision G as recommended), `GET …/subtitles/file/{track}` (a torrent's subtitle file fetched on demand, a sidecar), `…/transcode?audioRef=` (two ffmpeg inputs), a stream download keeping the playing video's chosen tracks selected (`torrents/client#streamSelection`), the server's file choice as **`GET /torrents/{hash}` `chosen`** (`?season&episode`, a plugin's `fileIndex` / `fileName`; `lib/media/files#choose`, also the downloads handler's) instead of `PlaySource.file` `{ path, size }` (a provider's torrent has no file list before its metadata: the choice can only be made then), profile settings `player.audioLanguage` / `player.subtitleLanguage` / `player.subtitleForcedOnly`, resume points with `audioTrack` / `subtitleTrack` (migration `0015_progress_tracks`); the TV shell's `AudioVideoTracks` switch (measured: Electron 44 lists and switches the AAC / Opus tracks of MKV and MP4, and leaves out those it can't decode, so the player maps by position among the `direct` ones), the player's **"Audio & subtitles"** button and panel (§10.3's two columns; titled for what it holds rather than "Tracks"), its other videos in Settings › Video (played over the title, tracking none), Settings › Playback › Audio language / Subtitles; tests `test/tracks.test.js` (a generated MKV + a multi-file torrent through the fake engine), scenario `player-tracks.js` (17 checks). Not done: audio files next to a library file (the scanner keeps only subtitle sidecars), measuring with a real engine and a real torrent. **Step 2** (release names): `lib/media/names.js` (`parse`, `describe`, `release`, `matchKind`, `matches`, `compare`, `rank`; `lib/present.js` gone, `lib/episodes.js` keeps only the EZTV + TheRARBG search), host utilities `playpex.names.*`, `html.select` (`node-html-parser`), `torrent.info` (`lib/plugins/utilities.js`), corpus `test/fixtures/releases.tsv` + the library's 306 names (`test/names.test.js`), sandbox test `plugins.utilities.test.js`; Velvet still carries its own parser (moving it onto `names.*` is the first use). **Step 1** (the Play chooser): `POST /play/sources` answers `groups` (server / stream / torrent, each with its best, count, readiness) and each source's `group` / `readiness` / `file` (a plugin's file hint); profile setting `player.autoplayKind`; the TV's `<play-chooser>` (`PlayChooserService`) for Play and Download (torrents only), with its empty state; Settings › When you press Play; scenario `play-chooser.js` (21 checks), server tests. Left for later steps, on purpose: the server-side file choice in a torrent (step 3, with `/tracks`: the player still picks, using nothing of the hint yet), folding the Resume question into the chooser (it stays a dialog before it), a plugin's play effect with several sources (still the old picker: its sources carry no groups). Decisions §11 taken with the recommended defaults (A–K) until the user says otherwise. Next: step 4 (port the providers to plugins in their own repository, decision A to confirm first) beside step 8 (HLS and live). Asked by the user: "like Stremio: we provide the torrent engine but all the torrent providers are third-party plugins"; Play shows options (direct play, torrent, a file from downloads or storage), never a torrent list; the files inside a multi-file torrent (video, audio, subtitles) are switchable in the player; metadata providers are installable too (TMDB by default, Trakt in the main repository); M3U and HLS so plugins can be IPTV services. This plan **revises two decisions of earlier plans**: `docs/plugins-plan.md` §1 lists "live TV with a programme guide" as a non-goal (lifted here, §8), and keeps `hls` sources for P7 "not before a real plugin asks" (this plan is that ask). It builds on the plugin system (`docs/plugins-plan.md`, P0–P5 done), the play pipeline (`docs/media-server-plan.md` §6) and decision G of `docs/server-separation-plan.md` (catalog behind the server). Read those, the root `CLAUDE.md`, `apps/server/CLAUDE.md` and `apps/tv/src/app/CLAUDE.md` first.

Legal note: Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. This plan makes that line sharper: the core ships an engine and no source of content.

---

## 1. Goals

1. **The core is an engine, not a catalogue of sites.** The server keeps the torrent client, media refs, the library, transcoding, the play pipeline and TMDB metadata. No torrent site, release index or stream site is named in `apps/server`, `apps/tv` or `packages/protocol` (checked like `check:plugins` checks 18+ code).
2. **Every source of content is a plugin**: torrent providers (`magnet`), web streams and debrid services (`http`), IPTV and live streams (`hls`, `live`). The built-in official repository carries none of the torrent providers (§4, decision A).
3. **Play offers ways to play, not releases.** The Play button opens a chooser of three kinds: *On this server* (library files, downloads), *Stream* (a plugin's direct stream), *Torrent*. Each kind shows its best option first; the full list is one step further. With no source plugins, only *On this server* exists, and an empty title says how to get more.
4. **Everything in the file is reachable in the player**: every audio track and subtitle inside the video file, the separate audio and subtitle files of a multi-file torrent (or next to a library file), and the other video files of the torrent. The player switches them without leaving.
5. **Metadata comes from the server, through providers**: TMDB built in (the server's key, cached, the TV stops calling TMDB), plugins adding ratings, lists and details (Trakt first, in the official repository).
6. **Live TV is a first-class kind**: HLS playlists and raw MPEG-TS streams play through the server, channels have a guide, a plugin can be an IPTV service (an M3U playlist + an XMLTV guide), with a first-party "M3U playlist" plugin for the admin's own playlist.

Non-goals: recording live TV (a DVR), transcoding video for weak clients (the player stays direct play + audio conversion), plugin code in the TV (templates only, as today), a Stremio add-on protocol bridge (decision H: maybe later, as a plugin).

## 2. Where things are today (2026-10-24)

| Area | Today | File |
|---|---|---|
| Torrent providers | YTS, EZTV, TheRARBG, The Pirate Bay in the core | `apps/server/lib/providers/*.js` |
| Episode search + ranking | `findEpisodeTorrents` (EZTV + TheRARBG), `describe` / `compare` / `normalizeTitle` also used by the play pipeline for any name | `lib/episodes.js` |
| Find releases | `PROVIDERS` table (piratebay, therarbg, yts / eztv) + plugins' `releases.providers` | `lib/releases.js`, `lib/media/names.js` (was `lib/present.js`) |
| Play pipeline | handlers `library` (10), `downloads` (20), `yts` (30), `episodes` (30), `plugins` (40); ranked; `check` / `rank` / `before` / `resolve` hooks | `lib/play/index.js`, `handlers.js`, `plugins.js` |
| Client routes tied to providers | `GET /movies`, `/movies/{imdbId}` (YTS passthrough), `/shows/{imdbId}/torrents`, `/releases/*` | `lib/api.js:333-437` |
| TV reading YTS | rating, runtime, `mpa_rating`, trailer code and the torrent list of a movie; Play waits for it (`canPlay`); Download picks among YTS torrents | `movies.service.ts:122`, `movie-options.component.ts:243`, `movies-page.component.ts:218` |
| TV reading TMDB | every catalog call, with a key written in the code | `movies.service.ts:58`, `categories.ts`, `catalog-filters.ts` |
| Source picker | `<torrent-picker>` (a `px-dialog`, one flat list: quality, tags, seeds, release name) | `torrent-picker/` |
| Player tracks | one file chosen once on the client (`pickVideoFile` / `pickEpisodeFile`); subtitles only from providers; audio only "convert the default track" | `player-page.component.ts:488-524, 1187` |
| Server tracks | probe lists every audio and subtitle stream; `/transcode?audio=<n>` maps one; sidecar subtitles only for library files | `lib/transcode.js:28-121`, `lib/media/index.js:189` |
| Plugin sources | `magnet` (its `fileIndex` ignored) and `http` (proxied as `r_` refs, fixed size, ranges) | `lib/play/plugins.js`, `lib/plugins/remote.js` |
| Live / HLS / M3U | nothing; a non-goal | `docs/plugins-plan.md:18, 203` |
| Provider health | a hard-coded list of hosts | `lib/health.js:14-25` |

## 3. How it fits together

```
                     ┌──────────────────── Playpex Media Server ─────────────────────┐
 TV / clients ──────►│ /catalog/*  (TMDB built in; plugins' metadata.* add to it)    │
                     │ /play/sources ─► collect: library · downloads · plugins       │
                     │                  rank ─► group by kind: server | stream | torrent
                     │ /media/{ref}    bytes · /tracks · /subtitles · /audio · /hls  │
                     │ engine: torrent client · ffmpeg · HLS proxy · library · DLNA  │
                     └───────────────▲───────────────────────────────────────────────┘
                                     │ hooks (QuickJS sandbox, docs/plugins-plan.md)
         ┌─────────────┬─────────────┼──────────────┬─────────────────┐
     torrent sites   debrid / web   IPTV (M3U,     metadata          subtitles
     (magnet)        streams (http) XMLTV, hls)    (Trakt, …)        (providers)
```

What Stremio calls *resources* maps onto hooks we have or add:

| Stremio | Here |
|---|---|
| `stream` (url, infoHash + fileIdx, behaviorHints) | `play.collect` sources: `magnet` (+ `fileIndex`, now honoured), `http`, new `hls`, `live` |
| `catalog` | the `catalog` template + `core.movies.rows` / `core.shows.rows` slots (have), new `guide` template for channels |
| `meta` | `metadata.title` (have) + new `metadata.details` (§7) |
| `subtitles` | `subtitles.providers` (have) |
| add-on catalogue / installs | repositories, Browse, signed indexes (have) |

## 4. Torrent providers leave the core

### 4.1 What moves where
- **To plugins**: `providers/yts.js`, `eztv.js`, `therarbg.js`, `piratebay.js`, `findEpisodeTorrents`, the `yts` and `episodes` play handlers, `releases.js`'s `PROVIDERS` table. Each site becomes one plugin with `play.collect` (title → magnets) and `releases.providers` (Find releases), using the host utilities of §4.2 so its matching and ranking stay as good as today. `plugins/velvet` already proves the shape (apibay + TheRARBG queries, matching, ranking, releases).
- **Stays in the core, renamed for what it is**: release-name knowledge — `describe` (quality, codec, audio, playable), `compare` (ranking for streaming), `normalizeTitle`, `matchKind` (is this name that episode / that season), `present.release` — moves to `lib/media/names.js`, used by the play pipeline, the downloads handler, the library and plugins. `lib/trackers.js` stays (the engine announces to them; plugins' magnets get them, as today).
- **Removed client routes**: `GET /movies`, `/movies/{imdbId}`, `/shows/{imdbId}/torrents`. `/releases/providers` and `/releases/browse` stay, answering plugin providers only (`plugin:<id>`). Decision C (API version).
- **What the TV took from YTS** comes from metadata instead: runtime and age rating from TMDB (`runtime`, `release_dates` certification), the trailer from TMDB `videos`, the rating from IMDb (`/imdb/{id}`, already used for shows). Play no longer waits for anything but the title's ids.
- **Provider health** (`lib/health.js`): the hard-coded torrent hosts go; the Overview's providers card lists TMDB, IMDb, subtitle providers, and each plugin's hosts from its activity (requests, failures per host: `stats.host`, already counted).

### 4.2 Host utilities for source plugins (SERVER_PLUGIN_API 1, additive)
Today a source plugin re-implements what the core knows (Velvet carries its own parser). New calls, no permission needed, pure and in-process:

| Call | Answers |
|---|---|
| `playpex.names.parse(name)` | `{ title, year, season, episode, episodeEnd, pack, resolution, source, codec, audio, hdr }` (`lib/media/names.js` + `lib/library/parse.js`) |
| `playpex.names.describe(name)` | `{ quality, codec, audio, playable }` — what the TV's Chromium plays |
| `playpex.names.matches(name, titleRef)` | `'episode' \| 'pack' \| null` — the strict matcher EZTV needed ("Breaking Brad") |
| `playpex.names.rank(sources)` | the core's streaming order (playable → audio → healthy seeds → single before pack → resolution → seeds) |
| `playpex.html.select(html, selectors)` | text / attributes of CSS selectors, parsed on the host (`node-html-parser`): HTML parsing in QuickJS costs the 2 s CPU budget; cap 4 MB input, 500 matches |
| `playpex.torrent.info(bytes)` | a `.torrent` file's info hash, name and files (`parse-torrent`), for sites that only offer `.torrent` downloads |

### 4.3 Where the ported plugins live (decision A)
The four ports (`yts`, `eztv`, `therarbg`, `piratebay`) are written by us as the parity reference, but **not published in the official repository** and never installed by default: they go in a repository of their own (like Velvet's), which an admin adds deliberately. The official repository carries Trakt, subtitles, the M3U playlist plugin and the TMDB lists plugin of §7 — no site of content. A test plugin (`fake-torrents`, in `test/fixtures`) covers the pipeline in CI without any site.

### 4.4 Upgrading an install
An install that played torrents yesterday plays none after the upgrade unless the admin adds a source. Like decision E of the plugins plan: the dashboard shows a notice once ("Torrents now come from plugins: add a source repository"), with the repository URL field; the TV's chooser shows the empty state of §5.3. Downloads, resume points and library files are untouched (they're the core's).

## 5. Play: a chooser of ways to play

### 5.1 Server: sources grouped by kind
`POST /play/sources` keeps its pipeline and adds **groups**:

```jsonc
{
  "request": "…", "sources": [ … ],          // as today, ranked; each source gets "group"
  "groups": [
    { "group": "server",  "best": "f_812", "count": 2, "readiness": "instant" },
    { "group": "stream",  "best": "r_9c…", "count": 3, "readiness": "instant" },
    { "group": "torrent", "best": "torrent:ab12…", "count": 41, "readiness": "seconds" }
  ],
  "policy": { "autoplay": "f_812" | null }, "hidden": [ … ], "errors": [ … ]
}
```

- `group`: `server` = type `file` or `download` (a finished or running download) · `stream` = type `plugin` (an `http` / `hls` source) or a torrent a resolver has `cached` (debrid: it plays at once, so it's a stream to the user) · `torrent` = the rest. `live` sources (§8) are their own screen, never in a title's chooser.
- `readiness`: what the user waits for: `instant` (on disk, a stream), `seconds` (a healthy swarm: ≥ 10 seeds), `slow` (few seeds), `unknown`. Shown in words (§10.2).
- Groups with nothing are left out; order is fixed (server, stream, torrent) so the remote's muscle memory holds. The ranking inside a group is today's.
- `policy.autoplay` as today (prefer local + one playable file on disk), plus a profile setting `player.autoplayKind` (`ask` default, or `server` / `stream`: play that group's best without asking when it exists).
- **Torrent file choice moves to the server**: a `magnet` source's `fileIndex` / `fileName` (from the plugin) or the core's choice (the episode's file in a pack, else the largest playable video) becomes `source.file` (`{ path, size }`), carried by `/play/start` into the player request. The player stops guessing with regexes.

### 5.2 TV: the Play chooser
Replaces `<torrent-picker>` for Play and Download (and plugins' play effects with several sources). Design in §10.2. Flow:
1. Play → `/play/sources` (the button shows "Looking for ways to play…" while busy; the server answers when its handlers finish, ≤ 10 s).
2. Autoplay policy hits → plays at once (as today).
3. Otherwise the **chooser** opens: one lane per group, each with its best option; Enter plays it. "All 41 torrents" (one step in place, Back returns) lists the group, with the full detail of today's picker.
4. Download (movie / episode pages) opens the same chooser restricted to `torrent` (and `stream` sources a plugin marks downloadable, later).

### 5.3 With no source plugins
- A title on this server: the chooser has one lane (or autoplays).
- Nothing on this server: Play still opens the chooser, which says so, in the interface's voice: **"Nothing to play this from yet"** / "Files on this server play here. Streams and torrents come from sources the server's admin adds on its dashboard, under Plugins." No setup on the TV (goal 7 of the plugins plan).
- Find releases is hidden when no plugin answers `releases.providers` (the client view says which hooks exist: `GET /plugins` gains `capabilities: { releases, sources, live }`).

## 6. Tracks: everything in the file, switchable in the player

### 6.1 Server: a title's tracks
New `GET /media/{ref}/tracks` (any media ref: library file, torrent file, plugin stream):

```jsonc
{
  "video": [ { "id": "v:0", "ref": "t_…_1a", "name": "Movie.2160p.mkv", "size": …, "current": true },
             { "id": "v:1", "ref": "t_…_9f", "name": "Extras/Making of.mkv", "kind": "extra" } ],
  "audio": [ { "id": "a:0", "source": "embedded", "index": 0, "language": "en", "codec": "eac3", "channels": 6,
               "title": "Atmos", "default": true, "play": "convert" },
             { "id": "a:1", "source": "embedded", "index": 1, "language": "fr", "codec": "aac", "channels": 2, "play": "direct" },
             { "id": "a:f1", "source": "file", "ref": "t_…_c3", "name": "Audio/Commentary.mka", "language": "en", "play": "convert" } ],
  "subtitles": [ { "id": "s:0", "source": "embedded", "index": 0, "language": "en", "codec": "subrip", "forced": false, "play": "text" },
                 { "id": "s:1", "source": "embedded", "index": 1, "language": "en", "codec": "hdmv_pgs_subtitle", "play": "image" },
                 { "id": "s:f2", "source": "file", "ref": "t_…_77", "name": "Subs/English.srt", "language": "en", "play": "text" } ]
}
```

- **Embedded tracks** from the probe (already read: `lib/transcode.js:50-69`). **Separate files** from the torrent's file list (audio: `.mka .ac3 .eac3 .dts .aac .flac .opus .m4a`; subtitles: `.srt .ass .ssa .vtt .sub/.idx`) matched to the video by name and folder (the library's sidecar rules, `lib/library/walk.js`, reused for torrents), or the library's sidecars for a disk file. **Other videos**: the torrent's other video files (`kind`: `episode` in a pack, `extra` in `Extras/` / `Featurettes/` / `Sample/`, else `video`).
- `play`: `direct` (the browser decodes it), `convert` (ffmpeg → AAC, needs ffmpeg), `text` (served as WebVTT), `image` (PGS / VobSub: listed, not shown in v1; decision F), `none` (no ffmpeg).
- **A torrent's small files are fetched on demand**: asking for a separate subtitle or audio file selects it in the torrent (`torrents.select` adds it; priority after the playing range). Subtitle files are tiny; an audio file streams like the video.

### 6.2 Server: playing a track
- **Embedded audio, direct**: the player switches `audioTracks` in Chromium (§6.3) with no server work.
- **Embedded audio that needs converting**: `/media/{ref}/transcode?t=&audio=<index>` (exists).
- **Separate audio file**: `/media/{ref}/transcode?t=&audioRef=<ref>` — ffmpeg with two inputs (`-i video -i audio -map 0:v:0 -map 1:a:0`, video copied, audio → AAC; each input read through its media ref, so a torrent's audio file streams while it downloads). Offset: none (separate tracks in releases are made to the video's timeline).
- **Embedded text subtitles**: `/media/{ref}/subtitles/embedded/{index}` → WebVTT (ffmpeg `-map 0:s:<n> -f webvtt`). For a disk file or a finished download: at once. **For a torrent still downloading** it needs the whole file read (subtitle packets are spread through it): the track is listed with `available: false` and a note "Ready when the download finishes", and becomes available on `download.updated` → completed. (Decision G: extracting while transcoding instead.)
- **Separate subtitle files**: `/media/{ref}/subtitles/file/{trackId}` → WebVTT (exists for library sidecars: `lib/media#subtitle`; extended to torrent files).

### 6.3 TV: native audio tracks
Chromium's `HTMLMediaElement.audioTracks` is behind a Blink feature. The TV shell enables it (`app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks')` in `apps/tv/electron/main.js`), so switching between AAC / Opus / MP3 tracks of an MKV or MP4 needs no transcode. Measured first (§12 step 3: MKV with two AAC tracks, MP4 with two); if it misbehaves in Electron 44, every switch goes through `?audio=`.

### 6.4 Remembering choices
Profile settings (settings plan registry): `player.audioLanguage` (`original` default, or a language), `player.subtitleLanguage` (`off` default), `player.subtitleForcedOnly`. The player picks the first track matching them; a choice made in the player for one title is kept with its resume point (`progress` gets `audioTrack`, `subtitleTrack`), so Resume comes back with the same tracks.

## 7. Metadata: from the server, through providers

### 7.1 TMDB behind the server (decision G of the separation plan, now built)
- New client routes `GET /catalog/*`, the TMDB subset the TV uses (`movies.service.ts`, `categories.ts`, `catalog-filters.ts`): lists (popular, top rated, now playing, upcoming, trending, discover with filters, genres), details (movie, show with external ids and videos, season, episode, person and credits, similar), search (multi, movie, show, person). Answers are **ours** (`CatalogTitle`, `CatalogPage`, `CatalogDetails` in `openapi.yaml`), not TMDB's JSON, so a provider can be swapped without changing clients; images as TMDB paths + the server's image base (clients keep `tmdbImageBase()` sizes).
- The server's key, its cache (6 h; lists 1 h), `include_adult` always false (adults plugins have their own catalogs).
- **A default key** (decision B): the server ships TMDB's app key as the TV app does today, used when the admin set none; Settings › Metadata can replace it. Without it a fresh server shows an empty catalog, which is no first impression.
- The TV's `MoviesService` calls `/catalog/*`; the key in `movies.service.ts` and the `<<api_key>>` URLs go.

### 7.2 Metadata providers
- **TMDB is the identity**: titles stay `(mediaType, tmdbId)`; every provider maps onto it (as `library.match` does for files). A second identity (TVDB, AniDB, IMDb-only) is a non-goal for this plan.
- **What a plugin adds**, new hook `metadata.details` (5 s): input a title (`titleRef` + the core's details), output **additions** — `ratings: [{ source, value, max, votes? }]` (Trakt, Letterboxd…), `tags`, `links: [{ label, url }]` (shown, never opened on the TV), `rows` (lists: "Related on Trakt"), and **overrides** only for text fields the admin allowed (`overview`, `title` in another language: decision I). The core merges them into `/catalog/details` in the admin's provider order.
- `metadata.title` (exists: lines on the title page) folds into `metadata.details` (`lines`), kept as an alias for one API version.
- **Catalog rows from plugins**: the existing slots `core.movies.rows` / `core.shows.rows` (Trakt's watchlist, trending on Trakt).
- **Dashboard › Settings › Metadata**: TMDB (built in; key; language; region), then installed metadata plugins in order (drag to reorder: whose rating shows first), each switchable.

### 7.3 Trakt in the official repository
P6 of the plugins plan unchanged (link, scrobble, sync, rows, rating), plus `metadata.details` instead of `metadata.title`. It is the first plugin of the official repository when that repository is published (plugins plan §10: where it lives, who holds the key — needed before this step ships).

## 8. Live TV: HLS, M3U, channels

### 8.1 Contract
- **Source kinds** `hls` (an `.m3u8` URL: VOD or live) and `live` (a continuous stream: raw MPEG-TS over HTTPS, or an HLS live playlist), with the `http` source's fields (`url`, `headers`, `label`, `quality`, `codec`, `audio`) + `live: true`. Permissions: `sources: ['hls']`, `['live']`, hosts in `network` (the playlist's and its segments' hosts: `*.cdn.example` allowed).
- **A channel** is a new `titleRef` kind: `{ kind: 'channel', plugin, id, number?, name }`. Tracking `none` (no resume, no history; a channel isn't watched to the end).
- **New hooks**: `live.channels` (→ `[{ id, number, name, logo, group, country?, languages? }]`, ≤ 5000, cached by the server per plugin, refreshed by the plugin's schedule), `live.guide` (`{ channels: [id], from, to }` → programmes `[{ channel, start, end, title, subtitle?, description?, image?, category? }]`), `live.stream` (a channel → its `hls` / `live` source, resolved at play time: tokens in IPTV URLs expire).
- **Host utilities** (parsing big files outside the 2 s / 64 MB sandbox): `playpex.iptv.m3u(url | text)` → channels (`#EXTINF` attributes `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, catchup attributes ignored in v1), `playpex.iptv.xmltv(url, { channels, from, to })` → programmes, streamed and parsed on the host (`sax`), gzip allowed, ≤ 200 MB download, cached per URL for 6 h on disk (`<cache>/iptv/`). Both fetch as the plugin (its hosts, the SSRF rules).

### 8.2 Server: playing HLS and live streams
- **HLS proxy** `GET /media/h_<id>/index.m3u8`: the server fetches the playlist as the plugin (headers, hosts, SSRF rules on every hop), **rewrites every URI** (variant playlists, segments, `#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` URIs, relative or absolute) to `/media/h_<id>/r/<token>` (an HMAC of the target URL, like `r_` refs), and serves segments by streaming them through (`lib/plugins/http.js#stream`). Live playlists are refetched on each request (no size, no range logic: `remote.js`'s fixed-size assumptions don't apply, so it's a separate module `lib/media/hls.js`). Content types `application/vnd.apple.mpegurl` / `video/mp2t` / `video/mp4`.
- **Raw MPEG-TS** (`live` without a playlist, common in IPTV): played through ffmpeg (`-i <proxied url> -c copy -f matroska`, audio → AAC when needed), like today's transcode output: no seeking, one ffmpeg per viewer, counts against `streaming.maxTranscodes`.
- Not through DLNA in v1 (renderers handle HLS poorly; maybe later).
- **Limits**: `streaming.maxLive` (default 2) concurrent live streams, separate from torrents.

### 8.3 TV: playing them
- **hls.js** (MIT, ~70 KB gzip; `npm install hls.js -w apps/tv`, pinned) in the player for `h_` refs: Chromium plays no HLS natively. MP4 / MKV / transcode stay on `<video src>`.
- **Live in the player**: no timeline but a "Live" mark and the programme's progress (amber, it's progress); ←/→ do nothing (or move within the DVR window when the playlist has one: later); ↑/↓ = previous / next channel with a channel banner (number, logo, now / next); Enter = the mini guide; media keys `next` / `previous` = channel up / down; tracks panel as for files (HLS audio renditions and subtitles from hls.js).
- **The guide** (template `guide`, §10.4): a plugin's section shows its channels and their programmes; core.search finds channels by name (`core.search.filters` chip per live plugin).

### 8.4 A first-party M3U plugin
`plugins/m3u` (official repository): the admin pastes an M3U URL (and optionally an XMLTV URL) in its settings on the dashboard — **their own** IPTV subscription or free public lists; the plugin carries no list of its own. It uses `iptv.m3u` / `iptv.xmltv`, answers `live.channels` / `live.guide` / `live.stream`, and contributes a "Live TV" section. The playlist's host can't be known when the plugin is packed, and a wildcard host is refused by `checkManifest` (the SSRF policy stays per host), so it needs **hosts from settings** (decision J): a setting of type `url` with `grantsHost: true` adds its host to the plugin's network permission when the admin saves it, shown as "Talks to <host>" in Permissions.

## 9. The dashboard

- **Plugins › Browse** gets category filters that match what admins look for: Sources, Streams, Live TV, Metadata, Subtitles, Tracking, Tools (manifest `listing.categories`, already in the schema: add `streams`, `live`).
- **Overview**: a "Ways to play" card — how many source plugins are on and working (last hour's failures per plugin), with "Add sources" when none.
- **Settings › Metadata** (§7.2) replaces the TMDB key line under Providers.
- **First-run setup** (`pages/setup.tsx`): the TMDB key field leaves (a default key exists); a last step "Where content comes from" explains that the server plays files from its folders, and that streams, torrents and live TV come from plugins — with the official repository's Browse and "Add a repository" side by side. No source is installed for the admin.
- **A plugin's page**: for live plugins, a Channels tab (count, last refresh, guide coverage, a "Refresh now").

## 10. Interfaces

The TV keeps its visual language (`apps/tv/src/styles/_tokens.scss`): focus is white (fill, ring or zoom), amber means progress or "on", wine is the accent of a plugin screen that asks for it, Futura bold for display, Netflix Sans for text, lengths in `dp()`, the type scale `--px-text-*`. New screens add **no new colour roles but one**: `--px-color-live` exists already (the "Live" mark). Every overlay is a `px-panel` or `px-dialog` (UI system step 2), movement through `pxStack` / `pxRow` / `pxGrid`.

### 10.1 Design plan
- **Palette** (existing tokens): page `--px-surface-bg`; the chooser on `--px-surface-pane-solid` (a docked panel); the focused option white (`--px-color-focus`) with `--px-color-on-focus` text; readiness and programme progress amber (`--px-color-progress`); the Live mark `--px-color-live`; warnings `--px-color-caution`.
- **Type**: lane names `--px-text-label` in `--px-font-bold`, sentence case (no caps labels); option lines `--px-text-lead`; detail `--px-text-small` in `--px-color-text-muted`; channel numbers `--px-font-display` at `--px-text-headline` (the one place type is big: numbers are how people flip channels).
- **Layout**: content left-aligned on the page gutter; panels dock at the end edge (the player's settings panel set the pattern); lists are vertical (↑/↓), lanes are rows of the same list, not cards.
- **The one bold thing**: *readiness*. Every way to play says how soon it starts, in words ("Plays now", "Starts in seconds", "Few people sharing: may be slow"), on the line's right edge, aligned like a departure board. It answers the only question someone holding a remote has. Everything else is quiet.
- **Review against the brief**: the first draft had three big cards side by side ("Server / Stream / Torrent", icons, counts): the generic tile kit, and three columns break ↑/↓ on a remote. Changed to one vertical list grouped in lanes, each lane's best line first. A draft label "Direct play" was renamed **Stream** (Plex uses "direct play" for "no transcoding": admins would read it that way); the user's term stays in this plan's §1.

### 10.2 The Play chooser (TV)
A `px-panel edge="end"` (about `dp(620)`) over the title page, so the title stays visible on the left.

```
┌──────────────────────────────────────── title page ─┬─ Play Heat (1995) ─────────────────────┐
│                                                      │                                         │
│  HEAT                                                │  On this server                         │
│  1995 · 2 h 50 · R                                   │ ▐ 2160p  HDR · Atmos converted   Plays now │  ← focused (white)
│                                                      │   1080p                          Plays now │
│                                                      │                                         │
│                                                      │  Stream                                 │
│                                                      │   1080p  from Real-Debrid       Plays now │
│                                                      │   All 3 streams                         │
│                                                      │                                         │
│                                                      │  Torrent                                │
│                                                      │   1080p  x264 · AAC · 1.9 GB  Starts in seconds │
│                                                      │   All 41 torrents                       │
└──────────────────────────────────────────────────────┴─────────────────────────────────────────┘
```

- One `pxStack`; lane names aren't focusable. Each lane shows its best option, a second one only when it differs in quality (2160p / 1080p), and "All N …" when there are more.
- "All 41 torrents" replaces the panel's content in place (an in-page step: Back returns to the lanes, focus on the same line): today's detail per row (quality, tags, size, seeds and peers, release name, notes), filter chips for quality and "Plays here" (playable only).
- A line that may not play says why at the end in `--px-color-caution` ("No sound without conversion", "HEVC: may not play"), instead of readiness.
- Resume: when a resume point exists, the chooser opens with "Resume from 1:12:40" above the lanes (today's `PlayChoiceService` question folded in), resuming on the same source when it's still there.
- Empty (§5.3): the panel holds the message and nothing focusable but Close.
- Copy: the button says **Play** (busy: "Looking for ways to play…"); the panel title "Play <title>"; lanes "On this server", "Stream", "Torrent"; actions keep their names through the flow (Download → toast "Download added").

### 10.3 Tracks in the player (TV)
Two ways in: a **Tracks** button on the controls bar (replacing "Subtitles") for the quick switch, and the Settings panel's tabs for everything else.

```
                                              ┌─ Tracks ───────────────────────────────┐
                                              │  Audio                 Subtitles        │
                                              │ ▐ English · 5.1 Atmos  ▐ Off            │
                                              │   converted             English         │
                                              │   French · Stereo        English (SDH)  │
                                              │   Commentary · file      Français · file│
                                              │                          English · Ready when │
                                              │                          the download finishes│
                                              │                          Find subtitles… │
                                              └─────────────────────────────────────────┘
```

- Two `pxStack` columns in one `pxRow` (←/→ between them, ↑/↓ inside): the only two-column layout of the plan, because audio and subtitles are switched together and both lists are short.
- The current track has the amber "on" mark; switching takes effect at once (a converted track restarts the stream at the current position, with the loading line).
- "file" names a separate file of the torrent; image subtitles show "Can't be shown yet" (decision F) and aren't focusable.
- "Find subtitles…" opens today's provider search (Settings › Subtitles tab).
- **Video** tab in Settings (and in Tracks when the torrent has other videos): the other video files ("Making of", "Episode 4" of a pack), Enter plays it in place.

### 10.4 Live TV (TV)

**The guide** (template `guide`, a plugin's section, `px-section-layout`):

```
┌─ Live TV ───────────────────────────────────────────────────────────────────────────────┐
│  News                    now 21:14                                                        │
│  ┌───────────────────── preview of the focused channel (muted, 16:9) ──────────────────┐  │
│  │  France 24 · Le journal · 21:00–21:30  ━━━━━━━━━━━━━━━━━━━──────────                │  │
│  └─────────────────────────────────────────────────────────────────────────────────────┘  │
│        21:00            21:30            22:00            22:30                          │
│  101 ▐ Le journal   ▐ Le débat           ▐ Reportage                      ←focused row     │
│  102   BBC News at Nine        │ The Context            │ Newsnight                         │
│  103   DW News │ Business      │ Focus on Europe        │ DW News                           │
│  All channels · News · Sport · Kids · Films       (group chips, the plugin's groups)      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- Rows are channels (`pxStack`), each a `pxRow` of programmes sized by duration; the now line is a 1 dp amber rule; programmes already over aren't shown before the now line (the guide starts at the current half hour).
- Enter on a channel plays it full screen; on a future programme it shows its detail (title, time, description) — no reminders in v1.
- Without a guide (`live.guide` absent): rows are just channels (number, logo, name), a simple list.
- Channel numbers in `--px-font-display`: the guide is read by number.

**In the player**: ↑/↓ shows the channel banner (bottom-start, inside the safe area) for 4 s: `102  BBC News  ·  The Context  21:00–22:00` with the programme's amber progress; the "Live" mark top-end in `--px-color-live`; Enter opens a mini guide (a `px-panel edge="end"` with the channel list and now / next).

### 10.5 Dashboard (React + shadcn/ui, its own design: `apps/dashboard/CLAUDE.md`)
- **Settings › Metadata**: a table of providers (TMDB first, plugins below) with a drag handle, an on/off switch and what each adds ("Ratings, lists"); TMDB's row expands to key (default shown as "Built-in key"), language, region.
- **Overview › Ways to play**: one line per source plugin (name, kind chips Sources / Streams / Live TV, last hour "ok" or the failure count linking to its Activity); empty: "No sources yet. Files in your library still play." + Browse.
- **Setup's last step**: two panes, "Official repository" (Browse) and "Another repository" (URL field), with one sentence on what each holds.
- **A live plugin's Channels tab**: counts, guide coverage (channels with programmes in the next 24 h), last refresh and its error, Refresh now.

## 11. Decisions (to take before building)

- **A. Where the ported torrent plugins live**: a separate repository we publish (like Velvet's), never in the official one, never auto-installed / in the official repository / not written by us at all (only a test plugin; third parties write site plugins). *Recommended: our own separate repository*: parity is only provable by porting, and admins upgrading need a path; the official repository stays free of content sites.
- **B. TMDB key**: ship a default key in the server / require the admin's key at setup / none (empty catalog until set). *Recommended: default key*, replaceable: the TV ships one today, TMDB allows app keys, an empty first screen is the worst onboarding.
- **C. API version for removed routes**: remove `/movies*` and `/shows/{imdbId}/torrents` in API 1 (the TV is the only client and ships with the server) / bump `API_VERSION` to 2 and keep v1 answering for a release. *Recommended: bump to 2* with `MIN_API_VERSION` 2 once the TV moves: a published contract (`docs/api/`) promised these routes, and third-party clients may exist.
- **D. Debrid-cached torrents**: in the Stream lane / in the Torrent lane with a "cached" mark. *Recommended: Stream*: the user sees "plays now", not a torrent.
- **E. Autoplay without asking**: never (always the chooser unless today's local rule) / profile setting `player.autoplayKind`. *Recommended: the setting, default ask.*
- **F. Image subtitles (PGS, VobSub)**: listed but not shown / burned in by ffmpeg (video re-encode: heavy, against "no video transcoding") / OCR. *Recommended: listed, "Can't be shown yet"*; revisit with a video-transcode plan.
- **G. Embedded subtitles of a torrent still downloading**: available when the download finishes / extracted live by a second ffmpeg reading the stream / extracted by the transcode ffmpeg into a side VTT. *Recommended: when it finishes* for v1 (simple, correct); live extraction later if wanted.
- **H. A Stremio add-on bridge** (a plugin that speaks Stremio's add-on HTTP protocol, so existing add-ons work): later, as a plugin, if the host API allows it (it needs any host: against the per-host rule) / never. *Recommended: not in this plan.*
- **I. Metadata overrides**: plugins add only / may override text fields with the admin's per-provider permission. *Recommended: add only in v1*; overrides when a real plugin needs them.
- **J. Hosts from settings** (M3U URLs, self-hosted services): a `url` setting with `grantsHost` adds its host to the network permission when the admin saves it / plugins must declare every host / `*` for live plugins. *Recommended: `grantsHost`*: the admin typed the URL, the permission stays per host and visible.
- **K. hls.js vs server remux for HLS**: hls.js in the TV (HLS proxied, segments passed through) / the server remuxes HLS to one Matroska stream with ffmpeg. *Recommended: hls.js*: no ffmpeg per viewer, adaptive bitrates, audio renditions; ffmpeg only for raw TS.

## 12. Steps

| Step | What | Verify |
|---|---|---|
| 0 | **Contract**: `openapi.yaml` (`groups`, `PlaySource.group/readiness/file`, `/media/{ref}/tracks`, embedded / file subtitle routes, `audioRef`, `/catalog/*`, `h_` refs), plugin contract (`hls` / `live` kinds, `channel` titleRef, `live.*` and `metadata.details` hooks, `guide` template, `names.*` / `html.select` / `torrent.info` / `iptv.*` host calls, `grantsHost`, categories), API 2 (decision C); author guides | contract tests, schema tests |
| 1 | **Play chooser**: groups + readiness + server-side file choice in `lib/play`; the TV's chooser replacing `<torrent-picker>` for Play, Download and play effects; resume folded in; empty state; `player.autoplayKind` | `test/play*.test.js` (groups, readiness, file in a pack); a TV scenario: lanes, All N, Back, empty server; screenshots |
| 2 | **Release names in the core** (`lib/media/names.js`) + host utilities `names.*`, `html.select`, `torrent.info` | unit tests on the filename corpus; sandbox tests |
| 3 | **Tracks**: `/tracks` (embedded + torrent / library files + other videos), on-demand selection of small files, `audioRef` two-input transcode, embedded text subtitles → WebVTT, the shell's `AudioVideoTracks` switch (measured first), the player's Tracks button and Video tab, `player.audioLanguage` / `subtitleLanguage`, tracks kept with resume points | a generated MKV (two audio tracks, one converted, SRT + PGS embedded) and a small generated multi-file torrent (video + `.mka` + `.srt` + an extra) through the fake engine and a real one (≤ 100 MB, `limited-disk-space`); a TV scenario switching every track |
| 4 | **Port the providers** to `yts`, `eztv`, `therarbg`, `piratebay` plugins in their own repository (decision A) + `fake-torrents` test plugin | parity: the same titles give the same top sources as the core (recorded answers); `npm run pack:repository` |
| 5 | **Remove them from the core**: handlers, routes, `PROVIDERS`, health hosts; TV metadata from TMDB / IMDb instead of YTS; `check:plugins` (or a new `check:sources`) refuses site names in core code; upgrade notice on the dashboard | contract tests on API 2; a fresh server with no plugins plays a library file and shows the empty chooser; with the repository added, plays a torrent |
| 6 | **Catalog behind the server**: `/catalog/*`, default key (decision B), the TV's `MoviesService` on it (no key in the TV), Settings › Metadata, setup without the key field | every TV screen's screenshots unchanged (`npm run screens`); contract tests; the TV app's bundle has no TMDB key |
| 7 | **Metadata providers**: `metadata.details`, merge in provider order, `metadata.title` alias; **Trakt** (plugins plan P6) on it, published in the official repository (needs its URL and key decided) | P6's verification + ratings order on a title page |
| 8 | **HLS and live**: `hls` / `live` sources, `lib/media/hls.js` (rewrite, keys, live reload), raw TS through ffmpeg, `maxLive`, hls.js in the player, live player UI | a local HLS VOD (ffmpeg-made) and live (ffmpeg `-hls_list_size`) over the test HTTPS server, AES-128 key, relative / absolute URIs, a redirect to a private address refused; Electron scenario plays both |
| 9 | **Live TV**: `live.channels` / `guide` / `stream`, `iptv.m3u` / `iptv.xmltv` (streamed parse, disk cache), the `guide` template, channel banner and mini guide, channel search chip, dashboard Channels tab; **`plugins/m3u`** with `grantsHost` | a generated M3U (300 channels) + XMLTV (50 MB) parsed within limits; guide scenario (rows, now line, Enter plays, ↑/↓ flips); the plugin installed from the official repository |
| 10 | **Docs**: `docs/api/` (playback: groups, tracks, live; catalog), `docs/plugins/` (sources, live, metadata, utilities), the CLAUDE.md guides, `docs/plugins-plan.md` non-goal revised | a reviewer writes a toy source plugin and an M3U plugin from the docs alone |

Order: 0 → 1 and 2 (parallel) → 3 (needs 1's file choice) and 4 (needs 2) → 5 (needs 1, 4) → 6 → 7; 8 → 9 can start after 0 and run beside 3–7. Steps 1, 3 and 6 improve the app even if the providers never leave; step 5 is the point of no return.

## 13. Open questions

- **The official repository's home and key** (plugins plan §10) block steps 7 and 9's publishing; decide before step 6 ends.
- Should a source plugin be able to say "downloadable" for an `http` source (a debrid file saved to the server's downloads), so Download offers streams too? Likely yes, with `write: downloads`.
- Catch-up TV (M3U `catchup` attributes) and time-shift within a live playlist's DVR window: v2.
- Channels in the Library section or the home rows ("Continue watching" can't hold live; a "Live now" row from favourite channels?) — needs favourites per profile (`write` scope `favourites`?).
- Kids profiles and live TV: a plugin's channels have no age rating; an `audience` per channel group, or live plugins hidden from kids profiles unless the admin shows them (today's per-profile "shown / hidden" covers the whole plugin).
- DLNA for live channels and plugin streams (renderers with HLS support vary): after v1.
