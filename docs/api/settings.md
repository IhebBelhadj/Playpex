# Settings

A client's user settings (the UI size, volume, subtitle size, subtitle provider…) live on the server, in its database, so they survive a reinstall and follow the profile to every client. The registry of keys is **`@playpex/protocol` `settings.js`** (JS clients import it; the others read it from `GET /api/v1/settings?definitions=1`). Request and answer shapes: the OpenAPI spec, tag `settings`.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.

## Two scopes

| Scope | Owner | Keys | Why |
|---|---|---|---|
| `device` | the calling device | `display.uiScale`, `display.safeArea`, `player.volume`, `subtitles.size` | depend on the screen, its distance, its speakers |
| `profile` | a profile | `subtitles.provider`, `player.autoplayNext`, `player.preferLocalFiles`, `player.autoplayKind`, `player.audioLanguage`, `player.subtitleLanguage`, `player.subtitleForcedOnly` | depend on the person |

**Which device**: a paired client is the device its token names, keyed by the `deviceId` it sent with `PUT /devices/me` (send it right after pairing; an `X-Playpex-Device` header is ignored for paired clients, so one device can't write another's settings). A client on the server machine (no token) is its `X-Playpex-Device` header or `?device=` (letters, digits and `._:-`, up to 64). Without one, the settings routes answer `400 DEVICE_REQUIRED`. Revoking a device deletes its settings.

## The registry

| Key | Scope | Type | Values | Default |
|---|---|---|---|---|
| `display.uiScale` | device | number | 0.7, 0.8, 0.9, 1, 1.15 | 0.8 |
| `display.safeArea` | device | number | 0 – 0.06, step 0.005 (of each dimension) | 0 |
| `player.volume` | device | number | 0 – 100, step 5 | 100 |
| `subtitles.size` | device | string | small, medium, large, largest | medium |
| `subtitles.provider` | profile | string or null | a subtitle provider id (`GET /subtitles/providers`) | null (the server's first enabled one) |
| `player.autoplayNext` | profile | boolean | | true |
| `player.preferLocalFiles` | profile | boolean | files on the server first in `POST /play/sources`, a lone one plays at once | true |
| `player.autoplayKind` | profile | `ask` · `server` · `stream` | play the best way of that group (`POST /play/sources` `groups`) without the chooser, when it plays; `ask`: always the chooser (unless the lone-file rule) | `ask` |
| `player.audioLanguage` | profile | `original` or an ISO 639-1 code (`en`) | the audio track a video starts with when it has that language ([tracks](playback.md#tracks-audio-subtitles-other-videos)); `original`: the file's default | `original` |
| `player.subtitleLanguage` | profile | `off` or an ISO 639-1 code | subtitles of that language turn on by themselves when the file (or its torrent) has them | `off` |
| `player.subtitleForcedOnly` | profile | boolean | with a subtitle language: only forced subtitles (the lines in another language) | false |

Adding a key is a protocol change, not a new API version: **ignore keys you don't know.**

## Reading

`GET /api/v1/settings?profile=<id>` → `{ device: {key: value}, profile: {key: value} | null }`, plus `definitions` (the registry) with `?definitions=1`. Every registered key of the scope is there with its **effective value** (the stored one, else the default): never hard-code a default. Read again when the profile changes.

## Writing

- `PATCH /api/v1/settings/device` and `PATCH /api/v1/profiles/{id}/settings`, body `{ key: value | null }` → the owner's effective settings after the change.
- `null` resets a key (its row is deleted; the default applies again). `DELETE /api/v1/settings/device` resets them all.
- **All or nothing**: one unknown key, a key of the other scope or a bad value refuses the whole patch (`400 INVALID`, one message per bad key in `errors`).
- Values that change continuously (a volume slider): write when the user lets go, or after ~500 ms without change, not on every step.
- Any client that may use a profile may change its settings (as `PUT /profiles/{id}`); the PIN only gates the UI.

## Your own keys

`client.<clientId>.<name>` (e.g. `client.playpex-tv.lastTab`): free JSON, at most 4 KB, stored in the scope of the route you send it to, returned with the registered keys. For a client's private state that no other client needs to understand, without a protocol change. Use your pairing `client_id` as `<clientId>`.

## Events

`settings.changed` (every client, on the events WebSocket) after each write or reset: `{ scope: 'device' | 'profile', ownerId, keys: [...] }`. `ownerId` is the device id or the profile id. If it's yours (your device id, or the profile you show) and you didn't make the change, read the settings again.

## Before settings existed

`Profile.preferences` is **deprecated**: answered `{}`, ignored on `PUT /profiles/{id}`. Use the settings routes. (The `adult.*` keys left with the 18+ section, now a plugin: its options are the plugin's, set on the dashboard.)
