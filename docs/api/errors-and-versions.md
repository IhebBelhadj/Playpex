# Errors, versions, limits

## Error answers

Every error from the Playpex API is JSON with a human message and a stable code:

```json
{ "error": "This server already streams 4 torrents; stop one first", "code": "BUSY" }
```

Branch on `code`, show `error`. Some list routes add an empty list next to it (`"torrents": []`, `"subtitles": []`) so list screens can render as is.

| Code | Status | Meaning, what to do |
|---|---|---|
| `INVALID` | 400 | bad parameters or body (malformed JSON too). Some routes add `errors[]` |
| `PAIRING_REQUIRED` | 401 | no valid device token: pair, or pair again if it was revoked ([auth](auth.md)) |
| `ADMIN_REQUIRED` | 401 | an admin-only route; not for clients |
| `FORBIDDEN` | 403 | e.g. a wrong profile PIN |
| `HOST_NOT_ALLOWED` | 403 | the `Host` header isn't this server (DNS-rebinding defence). Use the server's IP, `localhost`, its `.local` name, or a name the admin allowed (Settings › Network › Extra host names) |
| `ORIGIN_NOT_ALLOWED` | 403 | a browser page from another origin tried to change something. Web clients must be served from an allowed origin (Settings › Network › Extra web origins) |
| `NOT_FOUND` | 404 | unknown route, torrent, profile, file… |
| `CONFLICT` | 409 | e.g. a duplicate profile name |
| `CLIENT_TOO_OLD` / `SERVER_TOO_OLD` | 426 | API versions don't overlap ([below](#versions)) |
| `TOO_MANY_ATTEMPTS` | 429 | PIN attempts; wait 30 s |
| `INTERNAL` | 500 | a server bug: the admin finds it in the dashboard's Logs |
| `NOT_SUPPORTED` | 501 | this kind of server can't do it (desktop-only routes) |
| `UPSTREAM` | 502 | a provider (YTS, EZTV, IMDb, a subtitle site…) failed or timed out: try again later or another provider |
| `PROBE_FAILED` | 502 | ffprobe couldn't read the file: play it directly |
| `BUSY` | 503 | a server limit (torrents, transcodes), or the server is in recovery mode |
| `PROVIDER_NOT_CONFIGURED` | 503 | the provider needs an API key the server doesn't have (admin: Settings › Providers) |
| `TRANSCODER_UNAVAILABLE` | 503 | no ffmpeg on the server: play directly |

The list is `ERROR_CODES` in `@playpex/protocol`; new codes may appear (treat an unknown one by its HTTP status). `BUSY` also answers every client route while the server is in **recovery mode** (its port was taken at start; only its machine can reach the dashboard then): `GET /server` still answers, so "busy for minutes" is worth a "check the server" message.

Two families of routes follow their own standards instead:
- the device flow (`/auth/device/*`): RFC 8628 / RFC 6749 errors `{ "error": "authorization_pending", "error_description": "…" }` ([auth](auth.md#3-poll-for-the-token));
- the admin's sign-in (`/auth/sign-in/username`…): `{ "message", "code" }` (Better Auth). Clients don't use them.

Rate limits answer `429`: profile PINs with `{error, code: 'TOO_MANY_ATTEMPTS'}`; the device flow and the admin's sign-in with Better Auth's own body and an `X-Retry-After` header (seconds).

## Versions

- The API version is an integer: **1** today, at `/api/v1`. `GET /server` gives the server's `apiVersion` (newest it speaks) and `minApiVersion` (oldest it still serves). Your client works with the server when its API version is in `[minApiVersion, apiVersion]`.
- **Send your version** on every request. The header is optional (a request without it is served), but it is what the admin sees for your device, and it gets you a clear `426` instead of a confusing failure when versions stop overlapping:
  ```http
  X-Playpex-Client: playpex-android/1.4.0; api=1
  ```
  Outside the range: `426` with `CLIENT_TOO_OLD` ("update the app") or `SERVER_TOO_OLD` ("update Playpex Media Server"). Show which one to update.
- **What doesn't bump the version** (handle it): new routes, new optional request fields, new fields in answers, new event topics, new error codes, new enum values in informational fields. **Ignore fields you don't know.** The spec lists closed `enum`s for some strings (`Error.code`, `Session.method`, `ServerInfo.auth`, OAuth errors): configure your code generator to accept unknown values (e.g. a fallback enum case) rather than fail to decode.
- **What bumps it**: removing or renaming a route or field, changing a field's type or meaning, a new required request field. The server then keeps serving the previous version for a while (`minApiVersion` stays lower) so clients have time to update.
- The server's software version (`version`, e.g. `0.9.0`) is for people; don't compare it to decide what the API can do. Use `apiVersion` and `features`.

## Limits worth knowing

| Limit | Default | Answer past it |
|---|---|---|
| torrents running at once | 4 | `503 BUSY` on `POST /torrents` |
| transcodes at once | 2 | `503 BUSY` on `/transcode` (a new one from the same device and file replaces the previous) |
| idle lease | 10 min without a request or keepalive | the lease is dropped |
| grace after the last lease | 30 s | the torrent stops; its data is deleted unless the server keeps downloads |
| pairing request | 10 min | `expired_token` |
| profiles | 8 | `409 CONFLICT` |

The admin can change the first three (Settings › Streaming).

## Security notes

- **Traffic on the LAN is plain HTTP today.** Tokens, PINs and the admin's password cross the network unencrypted; anyone able to capture the network's traffic can reuse a device token. Run the server on a network you trust (WPA2/WPA3, not a guest network). HTTPS with a self-signed certificate that clients pin at pairing is proposed (plan §12 K): clients written now should keep the scheme (`http`/`https`) as part of a stored server URL rather than assume `http`.
- Store tokens in the platform's secret storage; send them in the `Authorization` header rather than in URLs where the player allows it.
- Access from outside the home network isn't supported (no TLS, no relay). Users who want it can join the server's network with a VPN such as Tailscale or WireGuard.
- Browsers: the server only allows its own origin, `file://` pages and origins the admin listed, and checks `Host` against DNS rebinding. A web client must be served from an allowed origin.

## The spec

- `packages/protocol/openapi.yaml` (OpenAPI 3.1), served by every server at `GET /api/v1/openapi.yaml` and rendered at `/docs/reference`.
- TypeScript types: `@playpex/protocol/types/api` (generated with openapi-typescript; `import type { Schema } from '@playpex/protocol'`, e.g. `Schema<'Torrent'>`).
- Other languages: generate a client from the spec (openapi-generator, Kotlin / Swift…). Expect to hand-write the byte-range and WebSocket parts; generators cover the JSON routes.
- The server's contract test (`npm test -w apps/server`) checks real answers against the spec, so the spec is what the server does.
