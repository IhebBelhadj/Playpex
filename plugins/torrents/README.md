# Torrent site plugins

The torrent sites Playpex Media Server read itself, ported as plugins (`docs/providers-plan.md` §4, step 4):

| Plugin | Play (`play.collect`) | Find releases (`releases.providers`) |
|---|---|---|
| `yts` | movies, by IMDb id | movies: the most downloaded, or a search |
| `eztv` | episodes and their season's packs, by the show's IMDb id | shows: one show's torrents, or the latest uploads |
| `therarbg` | episodes (`SxxEyy` + `Sxx`), movies (title + year), matched to the title | the categories Movies and TV, most seeded first |
| `piratebay` | movies and episodes, matched to the title | the top 100 of the movie / TV subcategories, or a search |

Each is one site: its own hosts in `permissions.network`, nothing else (no storage, no settings). Matching and ranking are the core's (`playpex.names.matches` / `rank`): the server ranks every plugin's torrents together, so YTS + EZTV + TheRARBG installed give what the core gave on its own (`apps/server/test/providers.parity.test.js`, on recorded answers of the sites).

**Never in the official repository** (decision A of the providers plan): these go in a repository of their own, which an admin adds deliberately. Build it with:

```
npm run pack:repository -- plugins/torrents/yts plugins/torrents/eztv plugins/torrents/therarbg plugins/torrents/piratebay \
  --out <folder> --key <key file> --id torrents --name "Torrent sites" --base-url https://…/
```

To try one without a repository: set `plugins.developerMode` to `true` in the server's `settings.json`, copy its folder into `<config>/plugins-dev/` and restart the server (`docs/plugins/README.md`).

When a site changes its answers: `node apps/server/scripts/record-providers.js` records them again (from the real sites), then run the parity test.

Educational project: streaming copyrighted content via torrents may be illegal where you live.
