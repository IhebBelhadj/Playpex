# Search plan: one search for everything, links pasted in, direct downloads

Status: proposed and built 2026-10-25. Steps: 1 ✓ 2 ✓ 3 ✓ 4 ✓ 5 ✓ 6 ✓ 7 ✓; 2026-10-30: the same Search on the phone (Playpex Mobile) and on the TV (its search page: videos, torrents with a sort and filter panel, links through `POST /links/inspect` for paired devices). Left: links on the LAN, refused by decision A

The dashboard's Find torrents page (built 2026-10-25, `apps/dashboard/src/pages/search.tsx`) searched one kind of thing: torrents
from the release providers. This plan makes it **Search**: one field for everything the server can reach, and a URL pasted into it is
read, whatever it is.

## 1. What one search covers

| Group | Where from | What a result does |
|---|---|---|
| On this server | `GET /library/home` (titles), `GET /downloads` (kept torrents and direct downloads) | opens the title's sheet / the download |
| Movies & shows | `GET /catalog/search/multi` (TMDB behind the server) | opens the title: its sources from the play pipeline (`POST /play/sources`: files on the server, downloads, plugins' torrents and streams), each playable or downloadable |
| Streams | **new** hook `sources.search` (§3): plugins that offer direct links (HTTPS files, HLS) and have a search of their own | Play (its media ref), Download (§5) |
| Torrents | `GET /releases/browse` (release providers, `matches`) | Add, Add and start |
| Live channels | `GET /live/{plugin}/channels?q=` (live plugins) | Play |
| A URL | **new** `POST /admin/links/inspect` (§4) | by what it is: a magnet or a .torrent → Add; a video file → Play, Download; an HLS playlist → Play, Download (saved by ffmpeg); a web page → what it links to, each with its own actions |

Adults plugins never answer here (the dashboard has no profile: `NO_ADULTS`, as release lists).

## 2. Decisions

- **A. The URL is the server's to read, the admin's to give.** `POST /admin/links/inspect` is admin-only. *Revised 2026-10-30:* clients' Search (Playpex Mobile) may paste links too: `POST /links/inspect` for paired devices, the same reading rules, refused for a kids profile. The server fetches it as a
  core principal (`anyHost`, plain http and any port allowed, like an address the admin granted a plugin) through
  `lib/plugins/http.js`: public addresses only, every hop checked (the server sits on the LAN: a pasted link mustn't reach the
  router's admin page). A LAN address is refused with that reason. Pages: 2 MB of HTML read at most.
- **B. Found media get refs, never URLs to the client.** A video file → an `r_` ref (`lib/plugins/remote.js`, its principal the core's
  `links` one), an HLS playlist → an `h_` ref (`lib/media/hls.js`); the dashboard's player plays them like any ref.
- **C. Direct downloads are a second kind of download, not torrents.** Their own table (`direct_downloads`), service and engine
  (`lib/downloads/direct.js`: HTTP with `Range` resume, two at a time, into the download folder, `.part` until done), their own
  routes (`/downloads/direct*`) and event (`direct.updated`); the Downloads page lists them beside torrents. HLS is saved by ffmpeg
  reading the server's own `h_` playlist on loopback (`-c copy` into .mp4/.ts), so the SSRF rules still apply to every segment.
  A plugin's source keeps its plugin: its download fetches as the plugin (its hosts, its headers).
- **D. `sources.search` is a hook, not `releases.providers` stretched.** Releases are torrents (seeds, info hash required);
  `sources.search` answers sources of the kinds the plugin declared (`http`, `hls`, `magnet`), each with what it is (title, year,
  season / episode), for keywords. Same checks as `play.collect` (`effects.sourceAllowed`).
- **E. Matching is the core's** (`names.searchMatches`): every group's results say whether their name holds every keyword.

## 3. Hook `sources.search` (plugin API)

Input `{ query, kind: 'movie' | 'show' | 'any', page }`; output `{ results: [{ source, title?, year?, season?, episode?, poster? }], last }`
(`source`: `$defs/source`, its kind one of the plugin's `permissions.sources`; `poster`: an https URL). Manifest: needs
`permissions.sources`. Server: `GET /search/providers` (plugins with the hook), `GET /search/sources?provider=&q=&kind=&page=` →
`{ provider, page, hasMore, items: SearchSource[] }` (refs minted, magnets with the server's trackers, `matches`).

Reference plugin: `plugins/archive` (the Internet Archive's public-domain films: its advanced search, direct MP4s).

## 4. `POST /admin/links/inspect {url}`

→ `{ url, kind, title, items: LinkItem[] }`. `kind`: `magnet` (not fetched: `/downloads/preview` reads it), `torrent`, `video`, `hls`,
`page`. A page's items: magnets in it, links to .torrent files, video files (`<video>`, `<source>`, `<a>` by extension, `og:video`),
HLS playlists (`.m3u8` anywhere in it), each once, with its label (the link's text, else the file name). Every video / HLS item has
a `ref`; every item says what can be done (`actions`: `add`, `play`, `download`).

## 5. Steps

| # | What | Verify |
|---|---|---|
| 1 | Contract: `sources.search` in `plugins.js` / `plugin-api.schema.json` / manifest check; OpenAPI: `/search/*`, `/admin/links/inspect`, `/downloads/direct*`, `SearchSource`, `LinkItem`, `DirectDownload` | `npm run generate`, contract test |
| 2 | Server: `lib/search/sources.js` + routes | a fake plugin in `plugins.sources.test.js` |
| 3 | Server: `lib/links/inspect.js` (core principal, classification, page scraping) + route | a local fixture server through `configure({ allowAddresses })` |
| 4 | Server: direct downloads (migration, repository, service, engine with resume, HLS through ffmpeg, routes, events) | resume after a pause on a fixture server; small files only (limited disk) |
| 5 | Dashboard: Search (groups, the URL view, title sheet with its sources, Play / Download / Add everywhere); Downloads lists direct downloads | the throwaway server, screenshots |
| 6 | `plugins/archive` (developer mode) | a real search |
| 7 | Docs: client guide, plugin author guide (`docs/plugins/server.md`), CLAUDE.md files | — |
