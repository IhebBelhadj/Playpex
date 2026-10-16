# Real-time events

One **WebSocket** carries what changes on the server, so clients don't have to poll. It's optional: everything is also available with plain requests.

```
ws://<host>:<port>/api/v1/events?topics=session,torrent.stats
Authorization: Bearer <token>          (or ?access_token=<token>)
```

- Same auth as other routes (no lease is involved: local clients needn't name their device here); the server also checks `Host` and refuses browser pages from foreign origins (`403 ORIGIN_NOT_ALLOWED` before the upgrade).
- `topics` (optional): comma-separated **prefixes**; `session` keeps `session.started`, `session.updated`, `session.ended`. Without it you get every topic your role may see.
- Every message is a text frame of JSON `{ "topic", "time", "data" }` (`time` = ISO 8601). Messages you send are ignored.
- The server pings every 30 s. Reconnect with back-off (1 s, 2 s, 5 s… 30 s) when the socket closes: the server restarted, changed port (rediscover it by `id`), or revoked the device (the upgrade then answers `401`).

## Topics for every client

| Topic | When | `data` |
|---|---|---|
| `server.status` | on connect, then every 30 s | `{ uptimeS, torrents, sessions, eventClients }` |
| `torrent.stats` | every 2 s while torrents with a lease run | `[{ infoHash, peers, downloadSpeed, uploadSpeed, downloaded }]` (bytes, bytes/s) |
| `session.started` | a device takes a lease on a torrent | a `Session` (see below) |
| `session.updated` | a keepalive with a playback state arrives | a `Session` |
| `session.ended` | the lease is released, reaped, or stopped by the admin | `{ id, deviceId, infoHash }` |

Payload schemas: `ServerStatusEvent`, `TorrentStatsEvent`, `Session`, `SessionEndedEvent` in the spec. Note that `torrent.stats` is a short form: `/stats` answers a richer `TorrentStats` (`peers: {total, unchocked}`, `speed: {down, up}`…).

`Session` (schema in the spec): `{ id, deviceId, deviceName, paired, client, address, infoHash, torrentName, file, method ('direct' | 'audio-transcode'), streaming, since, lastActivity, playback (your last keepalive body), torrent: {peers, downloadSpeed, uploadSpeed, downloaded, length} }`.

**Every client currently receives every device's sessions** (names, addresses, titles), not only its own; this may be narrowed to a device's own sessions later, so don't build features on other devices' sessions. To find yours, compare `deviceId` with your own id **as the server knows it**: for a paired device, the `id` of `GET /devices/me` (not the `deviceId` you sent in `PUT /devices/me`, which is stored as `clientDeviceId`); for a local client, the value of your `X-Playpex-Device` header.

A player can use `torrent.stats` for its buffering screen instead of polling `/stats`, and `session.ended` with its own device id to notice that the admin stopped it.

## Admin-only topics

Sent only to the dashboard's admin session: `log` (log lines), `device.paired`, `device.revoked`, `pairing.requested`, `pairing.approved`, `pairing.denied`, `host.updated`. Listed so you know they exist; device tokens never receive them.
