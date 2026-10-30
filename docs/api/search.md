# Search, links and direct downloads

Beyond the catalog ([catalog](catalog.md)) and a title's sources ([playback](playback.md)), a server can find **streams and files by keywords** in its plugins, **read a link** someone pastes, and **download files over HTTP** as well as torrents. The dashboard's Search page uses all three; a client can too. Shapes: `SearchProvider`, `SearchSource`, `LinkInspection`, `LinkItem`, `DirectDownload` in the OpenAPI spec.

## Streams and files by keywords

Plugins with the hook `sources.search` (a streaming service's catalogue, the Internet Archive's films) answer keywords with their streams and files:

```
GET /api/v1/search/providers
→ [{ "id": "plugin:archive", "name": "Internet Archive", "kinds": ["http"] }]

GET /api/v1/search/sources?provider=plugin:archive&q=night+of+the+living+dead&kind=movie&page=1
→ { "provider": "plugin:archive", "page": 1, "hasMore": true,
    "items": [{ "provider": "archive", "kind": "file", "label": "Night.mp4", "title": "Night of the Living Dead", "year": 1968,
                "poster": "https://…", "ref": "r_9e46…", "size": 596808390, "quality": "SD", "codec": "h264", "audio": null,
                "seeds": null, "peers": null, "matches": true }, …] }
```

- Ask every provider at once (one request each): a slow one never holds the others back. `kind`: `movie`, `show` or `any` (default).
- `kind` of an item: `file` (an HTTP file: `ref` is an `r_…` media ref), `hls` (a stream: an `h_…` ref, played with an HLS player from `<api>/media/{ref}/index.m3u8`), `torrent` (`magnet`, `infoHash`: add it with `POST /downloads` or play it as any torrent). Play a ref exactly like a file's ([playback](playback.md)); refs live an hour after their last use.
- You never see a provider's URL or token: the server fetches as the plugin.
- `404 NOT_FOUND`: no such provider; `502 UPSTREAM`: it failed (its message says why). Plugins marked `audience: adults` never answer here.

### Matching

Keywords reach every source as plain words: `Breaking.Bad` and `breaking_bad` are sent as `Breaking Bad`. Sites answer loosely, so every item (and every release of `GET /releases/browse`) carries **`matches`**: whether its name holds every keyword, however it's spelt. Punctuation doesn't count, and joined or split words meet (`spiderman` finds `Spider-Man`, `s01` finds `S01E05`, `breaking bad` doesn't find `Breaking Brad`). Show the matching ones first and the others on demand. Release lists of shows also get the show's IMDb id when a show has exactly that title in the catalog, so sources that list a show by its id (EZTV) answer keyword searches too.

## Reading a link

```
POST /api/v1/links/inspect   { "url": "https://example.org/films/", "profileId": "…" }
→ { "url": "https://example.org/films/", "kind": "page", "title": "Old films", "truncated": false,
    "items": [{ "kind": "video", "label": "Film One (1931)", "url": "https://…/Film.One.mp4", "ref": "r_…", "size": null },
              { "kind": "hls", "label": "index.m3u8", "url": "https://…/index.m3u8", "ref": "h_…" },
              { "kind": "torrent", "label": "film.torrent", "url": "https://…/film.torrent" },
              { "kind": "magnet", "label": "Film.Two.1932", "url": "magnet:?xt=…", "infoHash": "…" }] }
```

- `kind` says what the URL itself is: `magnet` (not fetched), `torrent`, `video`, `hls`, or `page`. A page's items are what it links to: magnets anywhere in it, links to `.torrent` files and video files (also in directory listings), `<video>` / `<source>`, `og:video`, and `.m3u8` playlists anywhere (scripts too). Each one is listed once. 2 MB of a page are read (`truncated`).
- Video files and playlists get refs: play them, or download them (below). Magnets and `.torrent` URLs go to `POST /downloads {link}`.
- The server only reads **public addresses**: a link on its own network (a router, a NAS) answers `400 INVALID` ("only reads links on the internet"). Every redirect is checked again.
- Paired devices may ask (`POST /links/inspect`, since 2026-10-30; the dashboard uses `POST /admin/links/inspect`, the same answer). Send the profile searching: a kids profile is refused (`403 FORBIDDEN`), since what a page links to isn't checked. Playpex Mobile's Search uses it: a pasted link's videos and streams play by their refs, its magnets and `.torrent` URLs through `POST /torrents {link}`.

## Direct downloads (the admin's)

Files fetched over HTTP, not torrents, from a media ref the server made (Search, a link, Play):

| Method & path | Behaviour |
|---|---|
| `GET /downloads/direct` | every one, newest first |
| `POST /downloads/direct {ref, name?, paused?}` | `ref`: an `r_…` (a file: HTTP with ranges, resumed after a pause or a restart) or an `h_…` (an HLS stream, saved by ffmpeg into a Matroska file; a live stream: `400`). Saved in the download folder as `<name>`, `<name>.part` until complete; a name taken gets ` (2)`. Two run at a time, the rest wait. `404`: the ref expired: search or read the link again |
| `POST /downloads/direct/{id}/start` · `…/pause` | start (or queue) a paused or failed one · pause it (a file resumes where it stopped; a stream starts again) |
| `DELETE /downloads/direct/{id}?files=1` | stop and forget it; `files=1` also deletes its file (a `.part` always goes) |

A `DirectDownload`: `{ id, name, kind: file | hls, state: queued | downloading | paused | completed | error, size (null: unknown), received, speed, path, ref, error, addedAt, completedAt, source: { by: 'links' | <plugin id>, host } }`. Once complete and scanned by the library (the download folder is a library folder), `ref` is the file's `f_…` ref: play it. Events (admin sessions): `direct.updated` (a `DirectDownload`, at most once a second while it runs) and `direct.removed {id}`; `library.changed` when the library has scanned a finished one.
