# Profiles and the library

A server holds up to **8 profiles** (Netflix-style "Who's watching?"), shared by every device paired with it. Each profile has its own watch list, playback progress and history. Profiles live on the server, so a user who stops on the TV can resume on their phone.

## Who's watching?

```http
GET /api/v1/profiles
```

```json
{ "profiles": [ { "id": "…", "name": "Sam", "avatar": "avatar-03", "isKid": false, "hasPin": true,
                  "preferences": { "adult": { "layout": "posters", "metadataProvider": null } }, "createdAt": "…", "lastUsedAt": "…" } ],
  "lastUsedId": "…", "maxProfiles": 8 }
```

- Show them; focus `lastUsedId` first.
- Picking one: `POST /api/v1/profiles/{id}/unlock` with `{ "pin": "1234" }` for a locked profile (`hasPin`), `{}` otherwise. Answer: the profile (and the server records it as last used). Wrong PIN `403 FORBIDDEN`; after 5 failures `429 TOO_MANY_ATTEMPTS` for 30 s.
- Keep the chosen profile **in memory** for the session: the TV app asks again at every start.
- `avatar` is an id, `avatar-01` … `avatar-12` (the server accepts any string up to 200 characters; stick to those ids so every client can draw it). The TV app's images are `apps/tv/src/assets/avatars/avatar-NN.svg`; a client may ship its own set under the same ids.

**PINs and kids profiles are enforced by the client.** The server checks the PIN on `unlock`, but once paired, a device can read any profile's data and call every route (plan §14.2). Respect `hasPin` and `isKid` in your UI: hide the 18+ section for kids profiles, don't open a locked profile without its PIN.

Managing profiles: `POST /profiles` `{name, avatar?, isKid?, pin?}` (409 on a duplicate name or past 8), `PUT /profiles/{id}` `{name?, avatar?, isKid?, preferences?}` (`preferences` is **deprecated**: only `preferences.adult` is read, and written to the profile's settings; a profile's settings are in [Settings](settings.md)), `PUT /profiles/{id}/pin` `{pin}` or `{pin: null}` (4–6 digits), `DELETE /profiles/{id}` (deletes all its data).

## The library

Titles are identified by **TMDB**: `(mediaType, tmdbId)` with `mediaType` = `movie` or `tv`. Episodes add `season` and `episode`. Writes carry artwork (`title`, `posterPath`, `backdropPath`, `genreIds`: TMDB values) so lists render without calling TMDB.

| Request | What |
|---|---|
| `GET /profiles/{pid}/library` | everything a "My Playpex" page needs at once: `continueWatching`, `watchlist`, `watched` |
| `GET /profiles/{pid}/watchlist` | the watch list |
| `GET \| PUT \| DELETE /profiles/{pid}/watchlist/{mediaType}/{tmdbId}` | `{inWatchlist}` · add (idempotent) · `{removed}` |
| `PUT /profiles/{pid}/watched/{mediaType}/{tmdbId}` · `DELETE …` | mark watched (logged in history) · forget its progress |
| `GET /profiles/{pid}/history` | finished views, newest first |

## Playback progress and resume

```http
PUT /api/v1/profiles/{pid}/progress/tv/1396
Content-Type: application/json

{ "positionS": 1201, "durationS": 2732, "season": 2, "episode": 5,
  "infoHash": "…", "filePath": "Season 2/Breaking.Bad.S02E05.mkv",
  "title": "Breaking Bad", "posterPath": "/…jpg", "backdropPath": "/…jpg" }
```

- Save every ~15 s while playing, on pause and when the player closes. Don't save before playback has really started (or before your resume seek): you would overwrite the saved point with 0.
- Answer `{ progress, finished, justFinished }`: at **90 %** a title counts as finished (the first time, it goes to the history).
- What played: a torrent's file (`infoHash` + `filePath`), or a file of the server's library (`fileId`: the id of its `f_` media ref; then send no `infoHash`).
- **Resume**: `GET /profiles/{pid}/progress/{mediaType}/{tmdbId}?season=&episode=` → `{ resume: {positionS, durationS, infoHash, filePath, fileId} | null, finished }`. `resume` is null under 5 % or when finished. Offer "Resume from 20:01" / "Play from the beginning"; to resume, play the **same release** so the position matches: `fileId` → the source `f_<fileId>` of `POST /play/sources` (if it is still there), `infoHash` as a bare hash is a valid `link`.
- A show's episodes at once: `GET /profiles/{pid}/progress/tv/{tmdbId}/episodes` → `[{season, episode, ratio, finished}]` (badges, progress bars).
- `continueWatching` items have `kind: 'resume'` (stopped in the middle) or `'next'` (finished an episode: the client finds the following one in TMDB).
