# OpenScrapers

A port of the Kodi add-on [OpenScrapers](https://github.com/a4k-openproject/script.module.openscrapers) (`script.module.openscrapers` 0.0.2.012, GPL-3.0) to a Playpex plugin. Like its source it is GPL-3.0 (`LICENSE`).

OpenScrapers is ~130 Python scrapers for Kodi. A Playpex plugin is JavaScript in the server's sandbox, so each scraper is rewritten, and only the ones that still work and give something Playpex plays made it (checked 2026-10-25):

| Source | OpenScrapers | What it gives | Where it shows |
|---|---|---|---|
| BnW Movies (`bnwmovies.com`) | `en/bnwmovies.py` | direct MP4 files (public-domain black-and-white films, hosted on archive.org) | Play (a movie: title + year), Search › Streams & files |
| netzkino (`netzkino.de`) | `de/netzkino.py` | direct MP4 files (free German films). **Off by default**: its CDN (CloudFront) answers 403 outside Germany, Austria, Switzerland and a few neighbours; the search API (`api.netzkino.de.simplecache.net`) answers everywhere. The stream URL (`pmd.netzkino-seite.netzkino.de/<Streaming>.mp4`) couldn't be checked from outside those countries | Play, Search |
| LimeTorrents (`limetorrents.fun`, `.info`) | `en_Torrent/limetorrents.py` | movie and TV torrents (the hash is in each row's `.torrent` link) | Play (matched by the core), Find releases / Search › Torrents; without keywords its Movies / TV-shows category by seeds |
| TorrentDownload (`torrentdownload.info`) | `en_Torrent/torrentdownload.py` | torrents of every kind (the hash is each result's link; names with `_` for spaces are fixed) | Play, Find releases |
| Nyaa (`nyaa.si`) | `en_Torrent/nyaa.py` | anime torrents (magnets in the list; shows: category 1_2, English-translated) | Play, Find releases |

Each one is a switch in the plugin's settings (dashboard › Plugins › OpenScrapers › Settings). Every site request waits 5 s at most (`timeoutMs`): LimeTorrents now and then doesn't answer, and one silent site mustn't sink the others' results.

**Left out**, and why:

- **File-host scrapers** (most of `en/`, `de/`, `fr/`, `pl/`…: 5movies, primewire, watchseries, filmxy…): they return links to file-host pages (openload, streamtape…). Kodi turns those into videos with another add-on, ResolveURL, which isn't part of OpenScrapers; a resolver per host is large, breaks often, and is mostly for piracy lockers.
- **Accounts**: Furk, Easynews, Ororo, FilePursuit (RapidAPI key), and `en_DebridOnly/` (a debrid service).
- **Gone or parked**: cartoonhd, hdm.to, animetoon, hdfilme, 4udrama, dramacool, ExtraTorrent, magnet4you, torrentapi (RARBG's API), isoHunt, 7torrents, BitLord (a script-only site), and the DNS-dead torrent sites (TorrentGalaxy, MagnetDL, Glodls, ettv, Zooqle…).
- **Behind Cloudflare challenges** a server can't pass: TorLock, YourBittorrent, TorrentFunk, 1337x.
- **Other plugins'**: The Pirate Bay, EZTV, YTS (the "Torrent sites" repository: `plugins/torrents/`); foxx.to relied on Google Drive player links Google shut down.

**Its own repository, never the official one** (decision A of `docs/providers-plan.md`, like `plugins/torrents`): "OpenScrapers" (id `openscrapers`), built into `~/projects/playpex-plugins/openscrapers` (its own git repository, `IhebBelhadj/playpex-openscrapers` on GitHub Pages: `https://ihebbelhadj.github.io/playpex-openscrapers/`) and signed with `~/projects/playpex-keys/openscrapers.json` (fingerprint `31c9 c96c da0d 0557 52ff 9e5e 6cca a8d1`, public key `ed25519:H32tbULm2xtiwke9LH852pXC99vKppMPScXlNYUfs60=`; keep using it, servers pin it). After changing the plugin, raise its `version` and build again:

```
npm run pack:repository -- plugins/openscrapers \
  --out ../playpex-plugins/openscrapers --key ../playpex-keys/openscrapers.json --id openscrapers --name "OpenScrapers" \
  --base-url https://ihebbelhadj.github.io/playpex-openscrapers/ --sign-packages
```

To try it without the repository: `plugins.developerMode` on, copy this folder into `<config>/plugins-dev/`, restart.

Educational project: streaming copyrighted content may be illegal where you live.
