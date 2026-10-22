# Settings in the server database: plan

Status (2026-10-22): **done** (steps 1–5: protocol, server, TV `SettingsService`, the Settings page, docs). Decisions A–F (§9): the recommended defaults. Notes under §8 ("Steps 1–2 notes", "Steps 3–5 notes"). Not done by design: the dashboard's view of a profile's / device's settings (§7, "later"). Asked by the user: "the settings should go in the db itself, use the current data access layer, create migrations with drizzle, update the schema and create the services for accessing the settings". Read the root `CLAUDE.md`, `apps/server/CLAUDE.md` (data layers) and `docs/ui-system-plan.md` §13 (the TV features that add settings: screen edges, toasts) first.

## 1. Goal

Every user-facing setting a client stores lives in the server's `playpex.db`, behind the same layers as the watch list: **routes → services (`lib/services`) → repositories (`lib/data`, contract in `contracts.js`) → Drizzle (`lib/db/schema.js`, migrations by `npm run db:generate`)**. A client keeps at most a cache of what it needs before it reaches a server.

Non-goals: the server's own settings (`<config dir>/settings.json`, `lib/settings.js`: port, LAN sharing, keys, download dir; edited by the admin in the dashboard; they stay a file, the server needs them before the DB opens), settings contributed by plugins (UI plan §12, but the key rules of §4 leave room for them), sync between servers.

## 2. What exists today

| Setting | Stored in | Scope it really has |
|---|---|---|
| UI size `uiScale` | `client.json` (shell, `display:get/set`), `localStorage['playpex.uiScale']` in a browser | this screen |
| Subtitle size | `localStorage['playpex.subtitleSize']` (`player-page.component.ts`) | this screen (viewing distance) |
| Volume | `localStorage['playpex.volumePercent']` (player) | this device |
| Subtitle provider | `localStorage['playpex.subtitleProvider']` (`subtitles.service.ts`) | the person: should be the profile |
| 18+ layout, metadata provider | `profiles.preferences.adult` (JSON column, merged by `PUT /profiles/:id`) | the profile |
| Timing, speed, zoom, brightness, picture mode | not stored (this playback only) | stays that way |

Problems: `localStorage` is tied to the `file://` origin and to one client (the root guide says so); the `preferences` blob has no keys, no validation, no defaults, and every client must know its shape.

Facts the design depends on:
- **Device identity.** Loopback clients (the TV app on the server machine) have **no `devices` row** (they're trusted without pairing). Every client already sends its own install id: `X-Playpex-Device` / `?device=` (`deviceId` in `client.json`; `DEVICE_ID` regex in `lib/sessions.js`). A paired device's row stores it as `devices.client_device_id`. So device settings are keyed by **that client device id**, not `devices.id`.
- `uiScale` is needed **before** the app knows its server (`/display` runs before `/connect`), so it can't live only on the server.
- Per-profile rows cascade from `profiles` (schema conventions), timestamps are epoch ms, ids text.

## 3. Data model

Two tables (`lib/db/schema.js`), one per owner, so the profile one can cascade:

```js
// Per-profile settings: one row per key. Deleted with the profile.
var profileSettings = sqliteTable('profile_settings', {
  profileId: profileId(),
  key: text('key').notNull(),                       // 'subtitles.provider', 'adult.layout', …
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (t) { return [primaryKey({ columns: [t.profileId, t.key] })]; });

// Per-device settings, keyed by the id the client sends (X-Playpex-Device):
// loopback clients have no `devices` row, so no foreign key.
var deviceSettings = sqliteTable('device_settings', {
  deviceId: text('device_id').notNull(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: timestamp('updated_at').notNull()
}, function (t) { return [primaryKey({ columns: [t.deviceId, t.key] })]; });
```

One row per key (not one JSON blob per owner): writes from two clients to different keys can't overwrite each other, `updatedAt` is per key, and a key is easy to reset (delete its row = back to the default).

## 4. The key registry

`packages/protocol/settings.js` (shared by the server, which validates, and clients, which read defaults and build the Settings UI; like `index.js`'s constants), described in `openapi.yaml` too:

```js
SETTINGS = {
  'display.uiScale':       { scope: 'device',  type: 'number', enum: [0.7, 0.8, 0.9, 1, 1.15], default: 0.8 },
  'display.safeArea':      { scope: 'device',  type: 'number', min: 0, max: 0.06, step: 0.005, default: 0 },   // UI plan §13.1
  'player.volume':         { scope: 'device',  type: 'number', min: 0, max: 100, step: 5, default: 100 },
  'subtitles.size':        { scope: 'device',  type: 'string', enum: ['small', 'medium', 'large', 'largest'], default: 'medium' },
  'subtitles.provider':    { scope: 'profile', type: 'string', nullable: true, default: null },
  'player.autoplayNext':   { scope: 'profile', type: 'boolean', default: true },
  'adult.layout':          { scope: 'profile', type: 'string', enum: ['posters', 'compact'], default: 'posters', adult: true },
  'adult.metadataProvider':{ scope: 'profile', type: 'string', nullable: true, default: null, adult: true },
}
```

Rules:
- A key is `<area>.<name>`, lowercase camel after the dot. Unknown keys are refused (`400 INVALID`), except the namespace **`client.<clientId>.<name>`** (free JSON ≤ 4 KB, device or profile scope by route): a client's private state without a protocol change. Plugins get `plugin.<pluginId>.<name>` the same way when they exist.
- `adult: true` keys are refused for kids profiles (`403`), like the 18+ section.
- Reads always return **every registered key with its effective value** (stored, else default), so clients never hard-code defaults.
- Adding a key is a protocol change (spec first, `npm run generate -w packages/protocol`, contract test), not an API version bump: old clients ignore keys they don't know.

## 5. Server layers

- **Repositories** (`lib/data/drizzle/settings.js`, contract added to `contracts.js`): `SettingsRepository { list(owner) → {key, value, updatedAt}[], get(owner, key), set(owner, key, value, at) (upsert), remove(owner, key), removeAll(owner) }`, where `owner = { kind: 'profile', id } | { kind: 'device', id }` and the implementation picks the table. Registered in `lib/data/index.js`.
- **Service** (`lib/services/settings.js`, in `createServices`): `get({ profileId?, deviceId })` → `{ device: {key: value}, profile: {key: value} | null }` (effective values); `update(owner, patch)` (validates each key against the registry and its scope, `null` = reset to default, all or nothing); kids rule through `profiles.requireProfile`; emits `settings.changed { scope, ownerId, keys }` (`lib/events.js`). Validation helpers in `validate.js`.
- **Routes** (`lib/routes/settings.js`, mounted under `/api/v1`):
  - `GET /settings?profile=<id>` → `{ device, profile, definitions? }` (`?definitions=1` adds the registry, for clients that don't bundle the protocol package)
  - `PATCH /settings/device` body `{ key: value | null }` → the device's effective settings
  - `PATCH /profiles/:id/settings` body `{ key: value | null }` → the profile's
  - `DELETE /settings/device` (reset), dashboard-only later: `GET/DELETE /admin/devices/:id/settings`
- **Which device**: a paired client is the device its token names (`req.auth` → `devices.client_device_id`; a different `X-Playpex-Device` header is ignored, so one device can't write another's settings); a loopback client is its `X-Playpex-Device` (validated with `DEVICE_ID`); no id → `400 DEVICE_REQUIRED` (new error code in `ERROR_CODES`).
- **Revoking a device** (`lib/auth`, Devices page) deletes its `device_settings`.

## 6. Migrations

1. `npm run db:generate` after the schema change → `0003_settings.sql` (the two tables).
2. `npx drizzle-kit generate --custom --name settings_data` (from `apps/server`) → `0004_settings_data.sql`, hand-written: copy `profiles.preferences.adult.layout` / `.metadataProvider` into `profile_settings` with `json_extract`, for profiles that have them.
3. The `preferences` column stays one release (decision B): the API stops documenting it for writes (`deprecated: true` in the spec), the server keeps answering it from the settings (`{ adult: { layout, metadataProvider } }`), then a later migration drops it.

Tests: a migration spec that opens a DB at `0002` with a profile holding `preferences.adult`, migrates, and finds the rows; the contract test gains the new routes.

## 7. Clients

**Playpex TV** (`apps/tv/src/app/settings.service.ts`, root):
- Loads `GET /settings?profile=` when the server is known and again when the profile changes (`ProfilesService.current`); `value(key)`, `changes(key): Observable`, `set(key, value)` (optimistic; reverts and shows a toast on failure, UI plan §13.3); sliders write **on release / after 500 ms idle**, not per step; reacts to `settings.changed` from the events socket (another client, the dashboard).
- Replaces: `SubtitlesService`'s provider key, the player's volume and subtitle size, `AdultService.preferences` / `setPreferences` (reads `adult.*`).
- **Moving the local values** (once per device): if `localStorage` holds `playpex.subtitleSize` / `volumePercent` / `subtitleProvider` and the server has no row for that key, push them, then delete the local keys.
- **`uiScale`** (decision A): `client.json` stays the boot cache (the UI must have a size before any server is reached; `/display` on the first start writes it there). Once connected, the DB is the source: a stored `display.uiScale` that differs replaces the cache and is applied; none stored → the cached one is pushed. Settings › Size writes both.
- Settings page: Display (Size, Screen edges §13.1), Playback (Subtitle size, provider, Autoplay next episode, Volume), 18+ (layout, metadata provider; not shown for kids). Each item says "on this device" or "for <profile>". Built on the current page now, on `px-rail-layout` when UI step 5 lands.

**Dashboard**: later, the Profiles page shows a profile's settings and Devices a device's (read + reset); not in this plan's steps.

**Client author guide** (`docs/api/`): a `settings.md` page (scopes, registry, effective values, namespaces, events), linked from its README.

## 8. Steps

Each step leaves the app working; the user commits.

1. **Protocol**: `settings.js` registry, spec paths + schemas + `DEVICE_REQUIRED`, `generate`, `settings.changed` in `docs/api/events.md`.
2. **Server**: schema, `0003` + `0004` migrations, repository + contract, service + validation, routes, events, device revoke cleanup, `preferences` compatibility; specs (service rules: scope, kids, unknown keys, namespaces, reset, device identity for paired vs loopback) and the contract test.
3. **TV**: `SettingsService`, the local-to-server move, the four call sites, `uiScale` sync.
4. **TV Settings page**: the groups of §7 (Screen edges comes with UI §13.1).
5. **Docs**: `docs/api/settings.md`, `apps/server/CLAUDE.md` (layers table, routes), `apps/tv/src/app/CLAUDE.md` (services table, Settings page), root `CLAUDE.md` (persisted state: settings in `playpex.db`; `localStorage` keys removed).

Verify: `npm run test:server`; TV specs for `SettingsService` (load, optimistic set + revert, debounce, profile switch, event); by hand: change volume in the player, restart the app → kept; a second client on the LAN with another profile doesn't see it; a kids profile has no 18+ group and the API refuses `adult.*`.

### Steps 1–2 notes (2026-10-22)

Built as in §3–§6, with these details:
- **Protocol**: `packages/protocol/settings.js` (`SETTINGS`, `SCOPES`, `CLIENT_VALUE_MAX` 4096, `isClientKey`, `definition`, `keys(scope)`, `defaults(scope)`, `validate(key, value, scope)` → message or null; no `Buffer`, browsers can load it) + `settings.d.ts` (`SettingKey`, `SettingValues`, …); `index.js` re-exports `SETTINGS`; `DEVICE_REQUIRED` (400) in `ERROR_CODES` and the spec. `client.<clientId>.<name>`: clientId `[a-z0-9][a-z0-9-]{0,31}`, name camelCase ≤ 64. Strings ≤ 200 characters.
- **Spec**: operations `getUserSettings` (`GET /settings`), `updateDeviceSettings`, `resetDeviceSettings`, `updateProfileSettings`; schemas `UserSettings`, `UserSettingValues`, `UserSettingsPatch`, `SettingDefinition` (`Settings` / `SettingsPatch` were taken by the admin's server settings); `X-Playpex-Device` documented as a header parameter (`DeviceHeader`). `Profile.preferences` / `ProfileUpdate.preferences` marked `deprecated`; `PUT /profiles/{id}` documents 403.
- **Server**: migrations `0003_settings`, `0004_settings_data` (custom; only valid `layout` values and text `metadataProvider`s are copied). Repository `lib/data/drizzle/settings.js` (`setMany` = one `db.batch`, a `null` value deletes the row). Service `lib/services/settings.js` (`createServices(…, {publish})`, `userData.js` passes `events.publish`). Kids profiles: `adult.*` writes → 403, and reads leave the `adult.*` keys out (not just "refused"). Routes `lib/routes/settings.js` (mounted before `/profiles`). The paired device is keyed by its `clientDeviceId`, else its `devices.id` (so a paired client never gets `DEVICE_REQUIRED`); the admin needs the header. `revokeDevice` deletes the device's rows in the same batch as its session. CORS (`lib/middleware.js`) now allows `PATCH`; **the TV shell answers CORS itself** (`apps/tv/electron/auth.js`, `Access-Control-Allow-Methods` without `PATCH`): add it with step 3.
- **`preferences` compatibility** (decision B): the profiles service answers `preferences` as `{ adult: { layout, metadataProvider } }` built from the settings (`{}` for kids profiles) and writes `preferences.adult` from `POST /profiles` / `PUT /profiles/:id` to the settings (validated; 403 for kids). The column is no longer written.
- `settings.changed` goes to every client (no admin flag): `ownerId` is a device id or a profile id.
- Tests: `test/contract.test.js` "settings: …" (defaults, `definitions`, set / reset / DELETE, all or nothing, ranges / steps / enums, scope, `client.*` size, other device, kids, deprecated `preferences`, cascade on profile delete) and paired-device identity + cleanup on revoke inside the auth test; `test/migrations.test.js` (0002 → latest). `npm run test:server`: 23 pass, 1 skipped (network).

### Steps 3–5 notes (2026-10-22)

TV (`apps/tv`):
- **`SettingsService`** (`src/app/settings.service.ts`, root, injected by `AppComponent` so it loads at start): the registry is imported from `@playpex/protocol/settings` (CommonJS: `allowedCommonJsDependencies` in `angular.json`); every key starts at its default, then `GET /settings?profile=&device=` (again when `ProfilesService.current` changes id). `value(key)`, `changes(key)` (Observable), `set(key, value, { debounceMs? })`: applied at once, written to its scope's route (`PATCH /settings/device` or `/profiles/:id/settings`), a refused write puts the previous value back and shows an error toast (`Toasts`, UI plan §13.3); sliders use `debounceMs: 500`. Values that fail the registry's `validate` aren't sent. Reads again on `settings.changed` for this device / the current profile unless the changed key is being written from here.
- **Events**: new `ServerEvents` (`src/app/server-events.service.ts`): the `<api>/events` WebSocket, opened on the first subscriber, reconnects (2 s … 30 s); the shell adds the token to the upgrade like any request.
- **The four call sites**: the player's subtitle size (`subtitles.size`) and volume (`player.volume`, debounced), the subtitle source (`subtitles.provider`: the player's provider chips write it; `SubtitlesService.preferredProvider` is gone), `AdultService.preferences` / `setPreferences` (read `adult.*` once the settings answered, `profile.preferences` before; writes go to the settings and return at once). New use: the player's end-of-episode autoplay follows `player.autoplayNext`.
- **Moving local values** (`adoptLocal`, once per device): `playpex.subtitleSize`, `playpex.volumePercent`, `playpex.subtitleProvider` (profile keys wait for a profile) and the first start's `playpex.safeArea` are pushed when the server still answers the default, then removed from `localStorage`. ("No row" isn't visible in an effective-value answer: the default stands for it.)
- **`uiScale`** (decision A): `client.json` stays the boot cache. After a read: a non-default server value different from the cache replaces it (`saveUiScale`); the server at its default while this device chose another size → the device's size is pushed. `<display-size>` writes both.
- **CORS**: `apps/tv/electron/auth.js` allows `PATCH`.
- **Settings page** (`core.settings`, `settings-page/`) on `px-rail-layout` (UI plan step 5, pulled forward): groups as a vertical `px-tabs` rail (moving onto one shows it), the settings in a scrolling `pxStack`, each with "On this device" / "For <profile>": **Display** (Size = `<display-size>`; Screen edges → the calibration panel, UI plan §13.1), **Playback** (Volume slider, Subtitle size chips, Subtitle source chips "Automatic" + the enabled providers, "Play the next episode when one ends" switch), **18+** (not for kids: Layout Posters / List, Catalog source "Server default" + the enabled metadata providers). Back: a setting → its group → the menu → out.
- Specs: `settings.service.spec.ts` (9: defaults then server values, profile switch, scope routing, revert + toast, debounce with the first previous value, registry refusal, events for this device / profile only, the local move, the UI size push). Scenario `apps/tv/scripts/scenarios/settings.js` (20 checks against a throwaway server: rail, volume written once the slider stops, a chip and a switch stored, Back ladder, screen edges preview / Back restores / OK stores).
- Not done: "a second client on the LAN" by hand (one machine here); the dashboard's views (§7, later).

Docs: `docs/api/settings.md` (step 2), `apps/tv/src/app/CLAUDE.md` (services, Settings page, player), root `CLAUDE.md` (persisted state, configuration).

## 9. Decisions (taken 2026-10-22: the recommended defaults, in bold)

- **A. `uiScale`**: **DB is the source, `client.json` the boot cache** / `client.json` only (it's about the screen, not the server: a TV used with two servers keeps one size).
- **B. `preferences` column**: **migrate, keep it answered (read-only) for one release, then drop** / drop now (only our clients use it) / keep it as the free-form namespace.
- **C. Subtitle size scope**: **device** (depends on the screen and the distance) / profile / profile-on-device (a third table; more than needed now).
- **D. Table shape**: **two tables, one row per key** / one `settings` table with `scope` + `owner_id` (no cascade, owner checked in code) / a JSON column per owner.
- **E. Registry location**: **`packages/protocol/settings.js` + the spec** / the spec only (clients fetch `?definitions=1`).
- **F. Who may change a profile's settings**: **any client that may use the profile (as `PUT /profiles/:id` today)** / only after the PIN unlock of that session.

## Legal note
Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.
