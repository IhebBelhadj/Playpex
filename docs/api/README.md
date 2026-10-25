# Writing a Playpex client

This guide is for people writing a **client** for Playpex Media Server: an Android TV app, a phone app, a web player, a script. It covers everything a client needs that isn't a single request: finding the server, pairing, making requests, playing a torrent, real-time events, errors and versions. The exact shape of every request and answer lives in the **OpenAPI spec** (`packages/protocol/openapi.yaml`, also served by every server at `GET /api/v1/openapi.yaml`). This guide explains how to use those requests together.

A running server serves this guide at **`http://<server>:28470/docs`** (no sign-in), with an interactive API reference at `/docs/reference`.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.

## Chapters

| Chapter | What it covers |
|---|---|
| [Finding a server](discovery.md) | mDNS, the UDP fallback, manual entry, recognising a server by its `id` |
| [Pairing and auth](auth.md) | the RFC 8628 device flow, tokens, clients on the server machine, re-pairing |
| [The catalog](catalog.md) | movies, shows, seasons, people and search from the server (`/catalog/*`: TMDB behind the server, no key in the client), images |
| [Playing a torrent](playback.md) | catalog sources, what's on this server (the media library), adding a torrent, choosing a file, streaming, audio transcoding, subtitles, keepalive and leases, downloads the server keeps |
| [Profiles and the library](profiles.md) | "Who's watching?", PINs, watch list, resume points |
| [Settings](settings.md) | per-device and per-profile settings, the key registry, effective values, your own keys |
| [Plugins](plugins.md) | rendering what the server's plugins contribute, asking their handlers, performing their effects |
| [Real-time events](events.md) | the WebSocket, topics and payloads |
| [Errors, versions, limits](errors-and-versions.md) | error shapes, codes, API versions, rate limits, security notes |

## What a server is

- **One machine, one server.** Playpex Media Server runs on an always-on computer of the home (desktop app with a tray icon, or headless). It downloads torrents with BitTorrent and serves the files over HTTP byte ranges, so a client plays them like any web video.
- **Everything is HTTP + JSON** under `http://<host>:<port>/api/v1`, plus one WebSocket for events. No client library, no Electron or Chromium feature is needed: anything with an HTTP client, a media player that sends `Range` requests and (optionally) UDP / mDNS can be a client.
- **Default port 28470/TCP**; discovery answers on **28471/UDP**. The port can be changed on the server: never hard-code it, take it from discovery or from what the user typed.
- **Constants** (ports, header names, discovery strings, error codes) are in `@playpex/protocol` (`packages/protocol/index.js`): JS clients can import it, others copy the values.

## The shortest path to playing something

1. **Find** a server: browse mDNS `_playpex._tcp.local` and/or broadcast `PLAYPEX_DISCOVER 1` to UDP 28471 ([discovery](discovery.md)). Confirm with `GET /api/v1/server` and keep its `id`.
2. **Pair** once: `POST /api/v1/auth/device/code {client_id}` → show `user_code` → poll `POST /api/v1/auth/device/token` until the server's admin approves → store `access_token` for that server `id` ([auth](auth.md)).
3. **Describe** the device: `PUT /api/v1/devices/me {name, platform, deviceId, capabilities}`.
4. **Pick a profile**: `GET /api/v1/profiles`, then `POST /api/v1/profiles/{id}/unlock` ([profiles](profiles.md)).
5. **Find a title**: `GET /api/v1/catalog/search/multi?q=…`, then its page `GET /api/v1/catalog/titles/{mediaType}/{tmdbId}` for its `imdbId` ([catalog](catalog.md)).
6. **Find what plays it**: `POST /api/v1/play/sources {kind, tmdbId, imdbId, title, year}` → files on the server, downloads, the source plugins' streams and torrents, ranked; a torrent: `POST /api/v1/torrents {link: <magnet>}` → `{infoHash}`, then poll `GET /api/v1/torrents/{infoHash}` until it lists `files` ([playback](playback.md)).
7. **Play** a file: give your player `http://<host>:<port>` + the file's `link`, with the token (`Authorization` header, or `?access_token=` when the player can't set headers).
8. While the player is open, **`POST /api/v1/torrents/{infoHash}/keepalive`** every 60 s; when it closes, **`DELETE /api/v1/torrents/{infoHash}`**.

Every request after step 2 carries `Authorization: Bearer <token>`.

## Examples

Shell, against a server found at `192.168.1.20:28470` (`jq` for reading JSON):

```sh
S=http://192.168.1.20:28470/api/v1
curl -s $S/server                                      # who it is (no auth)

# pair
curl -s -X POST $S/auth/device/code -H 'Content-Type: application/json' \
     -d '{"client_id":"my-client"}'                    # → device_code, user_code, interval …
# … show user_code, the admin approves it on the dashboard's /link page, then:
curl -s -X POST $S/auth/device/token -H 'Content-Type: application/json' \
     -d '{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"my-client"}'
TOKEN=<access_token>
H="Authorization: Bearer $TOKEN"

curl -s -X PUT $S/devices/me -H "$H" -H 'Content-Type: application/json' \
     -d '{"name":"Test laptop","platform":"linux","deviceId":"5d0c…"}'

# play a public-domain torrent (Big Buck Bunny)
HASH=$(curl -s -X POST $S/torrents -H "$H" -H 'Content-Type: application/json' \
       -d '{"link":"magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"}' | jq -r .infoHash)
curl -s $S/torrents/$HASH -H "$H" | jq '.files[] | {path, link, length}'   # repeat until files appear
LINK=$(curl -s $S/torrents/$HASH -H "$H" | jq -r '.files[] | select(.path | endswith(".mp4")) | .link')
mpv --http-header-fields="$H" "http://192.168.1.20:28470$LINK"      # the server's origin + the file's link
curl -s -X DELETE $S/torrents/$HASH -H "$H"
```

The Playpex TV app (`apps/tv`, Angular + Electron) is the reference client; its `ServerService`, `TorrentService` and player page (`apps/tv/src/app/player-page`) do all of the above.

## Status of the protocol

API version **2**. What exists today and what is planned (`docs/server-separation-plan.md`, `docs/media-server-plan.md`):

| Part | Status |
|---|---|
| Discovery, pairing, tokens, events, leases, streaming, audio transcoding, subtitles, profiles, library | **Done**, described here |
| Downloads (`/downloads`: the server keeps torrents, pauses them when players leave, downloads without a player) | **Done** (`docs/media-server-plan.md` step 1); per-device permission to add downloads is planned (decision D: today every client may) |
| Per-device playback decision (`GET …/files/{path}/playback`, from the `capabilities` a device declares) | **Planned** (plan §6.5, "3b"). Until then the client decides from `/probe` ([playback](playback.md#choosing-direct-play-or-the-transcoded-stream)) |
| Catalog through the server (`/api/v1/catalog/*`, TMDB key on the server) | **Done** (`docs/providers-plan.md` step 6): [catalog](catalog.md) |
| HTTPS with a pinned certificate on the LAN | **Proposed** (plan §12 K). Today the LAN traffic is plain HTTP ([security notes](errors-and-versions.md#security-notes)) |
| Plugins for clients (`/plugins`: what to render, data handlers, effects) | **Done** (`docs/plugins-plan.md`: the server's host, installs and repositories, Playpex TV's renderer) |
| A JS/TS client SDK (`packages/client-sdk`) | **Planned** (plan §6.6). Meanwhile use the generated types `@playpex/protocol/types/api` with any OpenAPI client (e.g. `openapi-fetch`, as the dashboard does) |

## A worked example: Playpex TV

The TV app in this repository (`apps/tv`, an Electron shell around an Angular UI) is the first client built on this guide. Where each step lives, to read alongside the chapters:

| Step | Playpex TV | Chapter |
|---|---|---|
| Find servers: mDNS + UDP broadcast + a probe of this machine, merged by `id`, confirmed with `GET /server`; manual entry probes one address | `apps/tv/electron/discovery.js` | [discovery](discovery.md) |
| Pick the server at start: the last one used at its saved URL, else found again by `id` (new port or address), else one on this machine; nothing usable → the server picker | `apps/tv/electron/connection.js` | [discovery](discovery.md), [auth](auth.md#clients-on-the-server-machine) |
| Pair: `POST /auth/device/code` (`client_id: playpex-tv`), show the code split in two, the `verification_uri` and a QR code of `verification_uri_complete`, poll `/auth/device/token` (`slow_down`, `expired_token`, `access_denied` handled), then `PUT /devices/me` with its name and codecs | `apps/tv/electron/pairing.js`, the `/connect` page (`apps/tv/src/app/connect-page/`) | [auth](auth.md) |
| Store tokens: `client.json` in the app's own data folder, tokens encrypted with Electron `safeStorage`; without a keyring (Linux) stored as plain text and the picker says so | `apps/tv/electron/clientConfig.js` | [auth](auth.md#storing-tokens) |
| Send the token: the UI never sees it. The shell's network layer adds `Authorization`, `X-Playpex-Client: playpex-tv/<version>; api=2` and `X-Playpex-Device` to every request to the current server, `<video>` and `<track>` included, so media URLs carry no `access_token` | `apps/tv/electron/auth.js` | [auth](auth.md#making-requests) |
| Errors: `401 PAIRING_REQUIRED` → forget the token, back to the picker ("This device was removed from …"); `426` → "Update Playpex TV" / "Update the server" screens; 3 network failures in a row → "Lost connection" with Retry (rediscovers by `id`) / Choose server | `apps/tv/src/app/server-errors.interceptor.ts`, `connection.service.ts` | [errors and versions](errors-and-versions.md) |
| Leases: `?device=<deviceId>` on media URLs, keepalive every 60 s while the player is open (with the TMDB `media`), `DELETE …?device=` on leaving | `apps/tv/src/app/player-page/`, `torrent.service.ts` | [playback](playback.md) |

On the server machine it connects over loopback without pairing, and starts an installed but stopped Playpex Media Server (whose install location the desktop app records in `<config dir>/desktop-app.json`, `@playpex/protocol/local`).
