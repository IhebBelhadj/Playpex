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

API (all JSON, `Authorization: Bearer <token>`): `GET /health`, `POST /torrents`, `GET /torrents?pieces=1`, `GET /torrents/{hash}/metadata`, `POST /torrents/{hash}/start|pause|stop|remove`, `PUT /torrents/{hash}/files`, `GET /torrents/{hash}/stream?path=` (HTTP ranges), `PUT /limits`, `GET /debug/status`. See the comments in `main.go`.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.
