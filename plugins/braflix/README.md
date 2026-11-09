# Braflix

Direct play for movies and TV episodes from [Braflix](https://braflix.at): streams that play at once in a title's Play (the Stream group), no torrent.

Braflix itself hosts nothing: its app lists about thirty third-party embed players for a title, each opened by the title's TMDB id (`<server>/movie/<id>`, `<server>/tv/<id>/<season>/<episode>`; the list is in its bundle, `/assets/index-*.js`). This plugin reads the two that are Braflix's own and answer plain JSON (checked 2026-11-09):

| Server (switch) | Braflix's name | What it gives |
|---|---|---|
| `vidsrc.party` (`hls`) | "Brelix", its default | An HLS stream, most titles in 1080p / 720p / 480p (H.264, AAC), an English audio and subtitle (WebVTT) rendition. `GET /api/play/{movie/<id> \| tv/<id>/<s>/<e>}?async=1&wait=1` → `file.playlist` `/v/<token>/stream`; a lookup still `running` is long-polled on `/api/jobs/<jobId>?wait=1`. Every URI in the playlist is `/p/<token>/<base64 of the real URL>` on vidsrc.party itself, so its throwaway CDN hosts never need to be declared |
| `braflix.dev` (`mp4`) | "Vidsrc HD" | MP4 files, usually 480p and 360p (sometimes 1080p): the same API answers one file per call (`token` `d0`, `d1`…; `exclude=d0,…` asks for the next). The file is a signed MP4 on MovieBox's CDN (`*.hakunaymatata.com`) that answers ranges without a Referer: the server reads it directly, not through braflix.dev's `/dash-proxy` |

Both are switches in the plugin's settings (dashboard › Plugins › Braflix › Settings), both on by default.

**Timing.** `play.collect` has 8 s; the plugin asks both servers at once and stops at 7 s. braflix.dev answers in under a second. vidsrc.party answers in about a second for a title it has looked up recently, but 4–9 s for one it hasn't: then the HLS stream can be missing from that Play (the MP4 files are there) and shows the next time.

**Left out**: the other embed players. Most encrypt their stream lists (vsembed / cineby "Braflix": ChaCha20 with a WebAssembly key that changes every 5 minutes; vidlink, videasy), sit behind Cloudflare challenges (2embed, xpass, wplay) or were down. braflix.dev's `quality=` parameter stalls mid-answer and isn't used.

**Playback notes.** vidsrc.party's part URLs have no file extension (and its segments come as `text/html`); the server's HLS proxy names such parts `.ts` / `.m3u8` / `.vtt` (`apps/server/lib/media/hls.js#rewrite`) so ffmpeg (the phone's libmpv, direct downloads) reads them; the TV's hls.js doesn't mind either way.

**Its own repository, never the official one** (like `plugins/torrents`, `plugins/openscrapers`): "Braflix" (id `braflix`), built into `~/projects/playpex-plugins/braflix` (for GitHub Pages as `IhebBelhadj/playpex-braflix`: `https://ihebbelhadj.github.io/playpex-braflix/`) and signed with `~/projects/playpex-keys/braflix.json` (fingerprint `ca20 7bf4 18ab 3015 605b dd02 c04c ffb1`, public key `ed25519:IhUB7Ng0kUR7WCVZF5bVRrJQQYYNPRsUvuUGtcCDgIk=`; keep using it, servers pin it). After changing the plugin, raise its `version` and build again:

```
npm run pack:repository -- plugins/braflix \
  --out ../playpex-plugins/braflix --key ../playpex-keys/braflix.json --id braflix --name "Braflix" \
  --base-url https://ihebbelhadj.github.io/playpex-braflix/ --sign-packages
```

To try it without the repository: `plugins.developerMode` on, copy this folder into `<config>/plugins-dev/`, restart.

Educational project: streaming copyrighted content may be illegal where you live.
