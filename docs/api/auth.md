# Pairing and auth

A client on another machine **pairs once** with a server, the way you link a TV app to an account: the client shows a code, the server's admin approves it. The flow is the standard **OAuth 2.0 device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628))**, so any OAuth device-flow library works. The result is a **device token**, sent on every request afterwards.

`GET /api/v1/server` says `"auth": "pairing"`. (`"none"` is reserved for a server that needs no pairing; no Playpex server answers it today. Treat it as "no token needed".)

## The device flow

```
client                                   server                              admin
  │ POST /auth/device/code {client_id}     │                                    │
  │──────────────────────────────────────►│  pairing request (10 min)          │
  │ ◄── device_code, user_code, uri, …     │── tray notification / dashboard ──►│
  │ show "ZETW-HGRK" + uri + QR code       │                                    │
  │ POST /auth/device/token (every 5 s)    │                                    │
  │──────────────────────────────────────►│ 400 authorization_pending          │
  │                                        │ ◄─────────── approve ZETW-HGRK ────│
  │ POST /auth/device/token                │                                    │
  │──────────────────────────────────────►│ 200 {access_token, …}              │
  │ PUT /devices/me {name, platform, …}    │                                    │
```

### 1. Ask for a code

```http
POST /api/v1/auth/device/code
Content-Type: application/json
X-Playpex-Client: my-client/1.2.0; api=1

{ "client_id": "my-client" }
```

- `client_id` names your app: lowercase letters, digits, `.`, `_`, `-`, 2 to 64 characters, starting with a letter or digit (`playpex-tv`, `playpex-android`). It isn't registered anywhere; it shows in the admin's list. `scope` is accepted and ignored. Form-encoded bodies work too (as RFC 8628 says).
- Send `X-Playpex-Client` here too: the admin sees it next to the request with your address.

Answer `200`:

```json
{
  "device_code": "…secret, only for polling…",
  "user_code": "ZETWHGRK",
  "verification_uri": "http://192.168.1.20:28470/link",
  "verification_uri_complete": "http://192.168.1.20:28470/link?user_code=ZETWHGRK",
  "expires_in": 600,
  "interval": 5
}
```

At most 10 requests a minute per address. Past that, and when polling far too fast, the server answers `429` with an `X-Retry-After` header (seconds) and a body that isn't the usual `{error, code}`: wait that long.

### 2. Show the code

- Show `user_code` large, split in two halves (`ZETW-HGRK`); it has no ambiguous characters (no `0/O`, `1/I`). The admin may type it in any case, with or without the dash.
- Show where to approve it: `verification_uri` (the server dashboard's `/link` page), and a **QR code of `verification_uri_complete`** so the admin can approve from a phone without typing. Also mention the other ways: the server's tray icon (desktop server) shows the request with Approve / Deny.
- Show the time left (`expires_in`, 10 min by default). When it runs out, offer "Get a new code".

### 3. Poll for the token

```http
POST /api/v1/auth/device/token
Content-Type: application/json

{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "<device_code>",
  "client_id": "my-client" }
```

Poll every `interval` seconds. Errors are RFC 8628 errors, `400` with `{ "error", "error_description" }`:

| `error` | Meaning | Do |
|---|---|---|
| `authorization_pending` | not approved yet | keep polling |
| `slow_down` | you polled faster than `interval` | add 5 s to your interval |
| `expired_token` | the request expired | start again at step 1 |
| `access_denied` | the admin refused | stop; say so |
| `invalid_grant` | unknown or already used `device_code` | start again |
| `invalid_client` | `client_id` doesn't match the code's | fix your client |

Approved, `200` (given **once**; the code is used up):

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 31536000 }
```

### 4. Describe the device

```http
PUT /api/v1/devices/me
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "Living room TV", "platform": "android-tv", "deviceId": "5d0c…",
  "capabilities": { "containers": ["mp4", "mkv"], "video": ["h264", "hevc"], "audio": ["aac", "ac3", "eac3"], "maxHeight": 2160 } }
```

All fields are optional; `null` clears one. `name` (≤ 64 chars) is what the admin sees in Devices and Activity; `platform` (≤ 32: `windows`, `linux`, `macos`, `android-tv`, `ios`, `web`…); `deviceId` your own id for this install (use letters, digits and `._:-`, up to 64, so the same value also works as `?device=`; the server stores it as `clientDeviceId`, its own id for you is the record's `id`); `capabilities` (≤ 4 KB) what the device can decode, in **ffprobe's names** (the ones `/probe` answers): `containers` as file extensions (`mp4`, `mkv`, `webm`, `avi`), `video` (`h264`, `hevc`, `vp9`, `av1`, `mpeg4`), `audio` (`aac`, `mp3`, `opus`, `ac3`, `eac3`, `dts`, `truehd`, `flac`), `maxHeight` in pixels. The server stores capabilities today and will use them to choose direct play or transcoding per device (plan §6.5); send them now. Send `PUT /devices/me` again when something changes. `GET /devices/me` returns the record.

## Making requests

```http
Authorization: Bearer <access_token>
```

on **every** request except the public ones: `GET /server`, `GET /openapi.yaml`, `GET /docs`, the two device-flow routes and `/admin/setup` (the dashboard's first run). Without a valid token: **`401 {"code": "PAIRING_REQUIRED"}`** with `WWW-Authenticate: Bearer`.

- **Media elements that can't set headers** (an HTML `<video>`, some TV players, `<track>`): add `?access_token=<token>` to the URL instead. Prefer the header wherever you can: URLs end up in player logs and history. (The server itself never logs query strings.)
- **The WebSocket** (`/api/v1/events`) takes the header, or `?access_token=` for clients that can't set headers on a WebSocket (browsers).

### How long a token lives

A device token is valid **a year from its last use**: the server renews it (at most once a day) when it's used. A device that connects at least once a year never has to pair again. A token ends when the admin **revokes** the device (dashboard › Devices, or `playpex-server devices revoke`): from then on every request gets `401 PAIRING_REQUIRED`, and its streams are cut at once.

On `401 PAIRING_REQUIRED` from a server you had paired with: drop the stored token and go back to step 1 (say "This device was removed from <server name>; pair it again").

### Storing tokens

Store `{serverId → {name, lastUrl, token}}` in the platform's secret storage (Android Keystore / EncryptedSharedPreferences, Apple Keychain, Electron `safeStorage`, Windows DPAPI). A token gives full client access to that server: adding torrents, every profile's data.

## Clients on the server machine

Requests from **loopback** (`127.0.0.1`, `::1`) are trusted as a "local" client and need **no token**, unless the admin turned on *Settings › Security › Pair clients on this machine too* (`security.requirePairingOnLoopback`). A local client still names itself, so its torrent leases are its own:

```http
X-Playpex-Device: <your deviceId>
```

or `?device=<deviceId>` on media URLs. Without either, the server uses the client's address, and every local client then shares the same leases. `PUT /devices/me` answers 404 for local clients (they aren't paired).

Probe loopback first when your client may run on the server machine, and use the loopback URL for it.

## The admin (dashboard) is not a client role

The dashboard signs in as the server's single admin (`POST /api/v1/auth/sign-in/username` → an HttpOnly cookie). Admin routes (`/api/v1/admin/*`, `GET /api/v1/sessions`) answer `401 ADMIN_REQUIRED` to device tokens: **a device token never grants admin**. Clients have no reason to call them; they are in the spec for the dashboard.

## What a paired device can do

Everything under `/api/v1` except the admin routes: torrents and streams, catalog proxies, subtitles, profiles and the library of every profile. Profile PINs are checked by the profile `unlock` route, but the server doesn't yet restrict what a request may read once it has a token (plan §14.2): a client must still respect kids profiles and PINs in its UI.

## Reference

- Constants: `AUTH` (`DEVICE_CODE_PATH`, `DEVICE_TOKEN_PATH`, `DEVICE_GRANT_TYPE`, `TOKEN_PARAM`), `DEVICE_HEADER`, `DEVICE_PARAM` in `@playpex/protocol`.
- Spec: `requestDeviceCode`, `requestDeviceToken`, `getMyDevice`, `describeMyDevice`; schemas `DeviceAuthorization`, `DeviceToken`, `DeviceDescription`, `Device`.
- Server side: `apps/server/lib/auth/` (Better Auth with its device-authorization plugin; plan §6.3).
