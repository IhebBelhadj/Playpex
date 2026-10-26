# The Crew

A port of the Kodi add-on The Crew (`plugin.video.thecrew` 3.2.2 and `script.module.thecrew` 3.2.26, GPL-3.0) to a Playpex plugin. Like its source it is GPL-3.0 (`LICENSE`).

The Crew is a whole Kodi front end: menus, a TMDB catalog, Trakt, lists, its scrapers and its debrid services. Playpex already has the catalog, Trakt (`plugins/trakt`) and the lists, so the port keeps what Playpex lacks: the sources that still work and the debrid services (checked 2026-10-26).

| Part | The Crew | What it does here | Where it shows |
|---|---|---|---|
| Torrentio (`torrentio.strem.fun`) | `scrapers/torrentio.py` | a title's torrents from many sites, by IMDb id; an episode's own file, also inside season packs (`fileIdx`, `filename`: the player and the debrid services play that file) | Play |
| Knaben (`api.knaben.org`) | `scrapers/knaben.py` | a JSON search across torrent sites, live seed counts; kept in Play when the core's matcher says it's the title | Play, Find releases (50 a page; without keywords the category's most seeded), Search › Torrents |
| Real-Debrid | `apis/realdebrid_api.py`, `modules/debrid.py` | `addMagnet` → `selectFiles` (the file) → `downloaded` at once when Real-Debrid has it → `unrestrict/link` | a picked torrent plays as a direct stream |
| AllDebrid | `apis/alldebrid_api.py` | `magnet/upload` (`ready`) → `magnet/files` → `link/unlock` | the same |
| Premiumize | `apis/premiumize_api.py`, `modules/debridcheck.py` | `cache/check` (what it has: "Cached on Premiumize") → `transfer/directdl` | Play's Stream group, at once |
| TorBox | `apis/torbox_api.py` | `torrents/checkcached` ("Cached on TorBox") → `createtorrent` → `mylist` → `requestdl` | the same |

**Debrid accounts**: dashboard › Plugins › The Crew › Settings › Debrid accounts (a token or key per service; "Check the accounts" asks each one). Real-Debrid switched its cache check off (`instantAvailability`, error 37) and AllDebrid removed `magnet/instant` (404): they can't say what they have, so they answer `tries` in `play.resolve`'s check (a core addition for them): their torrents stay in the Torrent group with "Real-Debrid tries it first", and when you pick one the plugin asks the service; one it doesn't have is removed from the account again at once and the torrent plays ("Not on Real-Debrid: playing the torrent"). Premiumize and TorBox mark the torrents they have, which then play at once from the Stream group. The services are asked in the order TorBox, Premiumize, Real-Debrid, AllDebrid (those whose check said cached first); a resolve gives up after 7 s and plays the torrent.

A link must live on one of the hosts in the manifest's `network` (`*.real-debrid.com`, `*.alldebrid.com`, `*.debrid.it`, `*.premiumize.me`, `*.energycdn.com`, `*.torbox.app`, `*.tb-cdn.st`): a service that moves its downloads elsewhere logs "gave a link on <host>, a host this plugin may not reach" and the torrent plays. **Not tested with real accounts yet**: written from The Crew's code and the services' API docs; a fake service's answers are checked in `apps/server/test/plugins.thecrew.test.js`.

**Left out**, and why:

- **Direct-stream services**: WebStreamr and NuvioStreams (`*.hayd.uk`, `scrapers/webstreamer.py`, `nuvio.py`) now answer a "deprecated" page.
- **File-host scrapers** (2ddl, 300mbfilms, rlsbb, scenerls, rapidmoviez, myvideolinks, maxrls, onlineseries, allmoviesforyou, anymovies, watchepisodes, dbgo, databasegdriveplayer…): links to file-host pages that need ResolveURL (another Kodi add-on), mostly debrid-only.
- **Behind Cloudflare challenges**: 1337x, YourBittorrent, TorrentQuest. **Gone, parked or no results**: TorrentGalaxy (`tgx.rs`), MagnetDL, Glodls, Kickass, isoHunt, BitLord, TorrentDownloads, Bitsearch (no magnets in its pages).
- **Other plugins'**: The Pirate Bay, EZTV, YTS (`plugins/torrents/`), LimeTorrents and TorrentDownload (`plugins/openscrapers`).
- **Accounts of their own**: Easynews, Ororo. **Orion**, **Simkl**, **TVDB**, **fanart.tv**: indexers and artwork Playpex doesn't use.
- **Its catalog, lists, Trakt, "TV evening", Up next**: Playpex's own (TMDB behind the server, `plugins/trakt`, the TV's Up next).
- **Its adult sites** (`adult_sites/`): never in a plugin for everyone (the 18+ section is `plugins/velvet`, its own repository).

**Its own repository, never the official one** (decision A of `docs/providers-plan.md`, like `plugins/torrents` and `plugins/openscrapers`): "The Crew" (id `thecrew`), built into `~/projects/playpex-plugins/thecrew` (its own git repository, `IhebBelhadj/playpex-thecrew` on GitHub Pages: `https://ihebbelhadj.github.io/playpex-thecrew/`) and signed with `~/projects/playpex-keys/thecrew.json` (fingerprint `e371 0e2c 23b9 8ef3 b5f0 af83 7f72 05c7`, public key `ed25519:chBAohkJROLT7ApepFY09WUFh5QbHpAuheHPukXB/XE=`; keep using it, servers pin it). After changing the plugin, raise its `version` and build again:

```
npm run pack:repository -- plugins/thecrew \
  --out ../playpex-plugins/thecrew --key ../playpex-keys/thecrew.json --id thecrew --name "The Crew" \
  --base-url https://ihebbelhadj.github.io/playpex-thecrew/ --sign-packages
```

To try it without the repository: `plugins.developerMode` on, copy this folder into `<config>/plugins-dev/`, restart; or `npm run pack:plugin -- plugins/thecrew` and upload the `.ppx` on the dashboard's Plugins page.

Educational project: streaming copyrighted content may be illegal where you live.
