# Torrent site plugins

The torrent sites Playpex Media Server used to read itself, as plugins (`docs/providers-plan.md` §4, steps 4–5). Since step 5 the server reads **no** torrent site: without a source plugin, Play finds only files on the server and its downloads, and the TV hides Find releases.

| Plugin | Play (`play.collect`) | Find releases (`releases.providers`) |
|---|---|---|
| `yts` | movies, by IMDb id | movies: the most downloaded, or a search |
| `eztv` | episodes and their season's packs, by the show's IMDb id | shows: one show's torrents, or the latest uploads |
| `therarbg` | episodes (`SxxEyy` + `Sxx`), movies (title + year), matched to the title | the categories Movies and TV, most seeded first |
| `piratebay` | movies and episodes, matched to the title | the top 100 of the movie / TV subcategories, or a search |

Each is one site: its own hosts in `permissions.network`, nothing else (no storage, no settings); `contributes.releases.kinds` says which Find releases lists it is a source of (YTS movies, EZTV shows). Matching and ranking are the core's (`playpex.names.matches` / `rank`): the server ranks every plugin's torrents together, so YTS + EZTV + TheRARBG installed give what the core gave on its own (`apps/server/test/providers.parity.test.js`, on recorded answers of the sites, against what the core's providers answered on them: `expected.json`).

**Never in the official repository** (decision A of the providers plan): they are the default source plugins, in a repository of their own ("Torrent sites", id `torrents`) that an admin adds deliberately; other publishers' source plugins come in their own repositories. It is built into `~/projects/playpex-plugins/torrents` (its own git repository, `IhebBelhadj/playpex-torrents` on GitHub Pages; `https://ihebbelhadj.github.io/playpex-torrents/`) and signed with `~/projects/playpex-keys/torrents.json` (fingerprint `a991 6fcc 01cc 2e17 44c0 544a dc1d 8be2`; keep using it, servers pin it). After changing a plugin, raise its `version` and build again:

```
npm run pack:repository -- plugins/torrents/yts plugins/torrents/eztv plugins/torrents/therarbg plugins/torrents/piratebay \
  --out ../playpex-plugins/torrents --key ../playpex-keys/torrents.json --id torrents --name "Torrent sites" \
  --base-url https://ihebbelhadj.github.io/playpex-torrents/ --sign-packages
```

Another host: the same command with its `--base-url` (same key). `--sign-packages` signs each `.ppx` too: until the repository is online, trust the key on the dashboard (Plugins › trusted publisher keys: `ed25519:mAtCvzXymXpJ3Hku7fmWWjkurGAYO5equ+2/ErAMKkY=`) and upload the packages.

To try one without a repository: set `plugins.developerMode` to `true` in the server's `settings.json`, copy its folder into `<config>/plugins-dev/` and restart the server (`docs/plugins/README.md`).

When a site changes its answers: `node apps/server/scripts/record-providers.js` records them again (the plugins on the real sites), then `PLAYPEX_UPDATE_EXPECTED=1 node --test apps/server/test/providers.parity.test.js` writes what the plugins answer now into `expected.json`: read that diff (it was the core's ranking) before keeping it.

## The sites

- **YTS** (`movies-api.accel.li`, then `yts.lt`, `yts.ag`; yts.mx stopped answering in 2026): small x264 / x265 encodes with AAC audio. Its seed counts are capped at 100 and **`sort_by=seeds|peers` is broken** (it answers the newest uploads, 0 seeders): lists sort by `download_count`. A release name is built as `Title (Year) [1080p] [BluRay] [x264] [AAC 5.1] [YTS]` so `names.describe` classifies it; no 3D.
- **EZTV** (`eztvx.to`, `eztv.wf`, `eztv.tf`): the official API (`/api/get-torrents?imdb_id=`), every page of a show read once and kept 30 min; episode `0` = a season pack. Without an IMDb id, Find releases lists the latest uploads (EZTV has no keyword search: keywords only filter a page). Its IMDb lookup can answer another show (tt0903747 Breaking Bad → only "Breaking Brad", checked Oct 2026): the core's matcher drops those.
- **TheRARBG** (RARBG's successor; `therarbg.to`, `therarbg.com`): the JSON search `/get-posts/?keywords=…&format=json` (`n` name, `h` hash, `s` size, `se` **seeders**: the site's own dropdown mislabels it, `c` category). Episodes: two queries, `"<title> SxxEyy"` and `"<title> Sxx"` (packs). Don't put the resolution in the keywords: it then ranks by name, not seeders. Seed counts can be months stale.
- **The Pirate Bay** (`apibay.org`, its JSON API): Find releases reads the top-100 lists by quality (movies 201 / 207 HD / 211 UHD, TV 205 / 208 / 212; "any" merges the three) or searches `q.php` in category 200 keeping those subcategories (not 202 DVDR, 209 3D); one page only.

Educational project: streaming copyrighted content via torrents may be illegal where you live.
