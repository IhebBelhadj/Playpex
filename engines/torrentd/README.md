# playpex-torrentd

A torrent engine for Playpex Media Server, built on [anacrolix/torrent](https://github.com/anacrolix/torrent) (MPL-2.0) for streaming: a stream is a responsive reader with read-ahead, so a seek fetches the pieces it needs first. The server runs it as a sidecar on loopback and talks to it through `apps/server/lib/torrents/engines/torrentd/` (the engine port, `docs/media-server-plan.md` §4.3 and §4.7).

It is an **optional download**: the installers don't include it; the admin installs it from the dashboard (Settings › Downloads) or with `npm run install:engine -- torrentd` once releases are published.

| | |
|---|---|
| Build for this machine | `npm run build:torrentd` (repo root; Go 1.26+): into `<cache>/engines/torrentd`, where the server finds it |
| Build the releases | `node engines/torrentd/build.js --all` → `dist/` (git-ignored), every platform |
| Publish a release | bump `version` in `apps/server/lib/torrents/engines/torrentd/release.json` (and `main.version` follows), push tag `torrentd-v<version>`: `.github/workflows/torrentd.yml` builds and attaches them to a GitHub release; then `node engines/torrentd/build.js --pin` downloads them, hashes them and writes their URL + SHA-256 into `release.json` (what the server's Install trusts) |
| Run by hand | `PLAYPEX_TORRENTD_TOKEN=x playpex-torrentd --listen 127.0.0.1:0 --data-dir <dir> --state-dir <dir> [--peer-port 6881] [--no-discovery] [--port-forwarding] [--no-upload] [--debug]` (keep stdin open: it stops when stdin closes) |
| Test | the server's conformance suite runs on it when installed: `npm run test:server` |

API (all JSON, `Authorization: Bearer <token>`): `GET /health`, `POST /torrents`, `GET /torrents?pieces=1`, `GET /torrents/{hash}/metadata`, `POST /torrents/{hash}/start|pause|stop|remove`, `PUT /torrents/{hash}/files`, `GET /torrents/{hash}/stream?path=` (HTTP ranges), `PUT /limits`, `GET /debug/status`; since 0.2 (engine port v2, the dashboard's detail pane): `GET /torrents/{hash}/peers` (connections, flags D U I X H P, their progress and speeds), `GET|POST /torrents/{hash}/trackers` (the announce list; `{add: [urls]}`), `POST /torrents/{hash}/recheck`; since 0.3 (engine port v3): `POST /torrents/{hash}/trackers` also takes `{remove: [urls]}`, `POST /torrents/{hash}/reannounce` (the torrent leaves the client and comes back from its info: fast resume), `PUT /torrents/{hash}/limits` (`{downBps, upBps}`, 0 = none: a token bucket per torrent that turns its traffic off and on, since anacrolix limits only the whole client). A recheck is cancelled and waited for before a torrent is dropped (anacrolix 1.61 leaks its client lock when a torrent closes during `VerifyData`). See the comments in `main.go`. The published releases (`release.json`) are still 0.1.0: build it from source (`npm run build:torrentd`) for the new routes, or publish a `torrentd-v0.3.0` tag (and bump `release.json`'s version).

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.
