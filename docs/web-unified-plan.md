# Playpex on the web, one address: plan

Status: **steps 1–3 built 2026-11-16, uncommitted** (tried in Chromium: a phone and a desktop window on a copy of the
server; `test/web-entry.test.js`). Step 4 later. Playpex TV (`/tv/`, `docs/web-client-plan.md`) and Playpex Mobile
(`/m/`, `docs/mobile-web-plan.md`) both run in a browser. This plan makes them one product on the web: one address
that opens the right one for the device, the dashboard's Clients page that hands each out, and a switch between them
that keeps the profile and the title.

## 1. Decisions (2026-11-16, the user)

- The two clients stay two code bases (Angular, React Native): they already share the whole API. The unification is at
  the edges: the address, the device, the profile, the switch.
- **`/app/`** opens the client for the device. **Dashboard › Clients** lists every client, each opening its own
  address (`/tv/`, `/m/`), with its link and QR code, and holds the choices `/app/` follows.
- Computers open Playpex TV by default, tablets Playpex Mobile: the admin's settings, not constants.

## 2. Settings (`lib/settings.js`, group `clients`)

| Key | Default | Meaning |
| --- | --- | --- |
| `clients.tvWeb` | `true` | Playpex TV on the web is served at `/tv/` (off: a page saying so, with a link to `/app/`) |
| `clients.mobileWeb` | `true` | Playpex Mobile on the web at `/m/` (the same) |
| `clients.computers` | `tv` | What `/app/` opens on a computer (a mouse): `tv` or `mobile` |
| `clients.tablets` | `mobile` | What `/app/` opens on a tablet (touch, a large screen): `tv` or `mobile` |

## 3. `GET /api/v1/clients` (no auth)

What a browser can open here: `{ web: [{ id: 'tv' | 'mobile', name, path, enabled, built }], open: { computers,
tablets } }`. Read by `/app/` and by the clients' "Switch view"; no secret in it (like `GET /server`).

## 4. `/app/` (`lib/webEntry.js`)

A page of its own, no framework (the server writes it; nothing from the request goes into it). Its script decides, in
order:

1. `?view=tv|mobile` (remembered: `localStorage['playpex.web.view']`), else the remembered view;
2. a TV's browser (its user agent: Tizen, webOS, Android TV / Google TV, Fire TV, BRAVIA, VIDAA, HbbTV, consoles…) →
   Playpex TV;
3. a touch screen without a mouse (`(pointer: coarse)` and `(hover: none)`): a phone → Playpex Mobile, a tablet (its
   shorter side ≥ 600 CSS px) → `clients.tablets`;
4. else (a computer) → `clients.computers`.

A view that is off or not built gives way to the other; neither → the page says so. `?at=` names a place both clients
know (§5) and opens it there. A server-side redirect can't do this: only the browser knows whether it has a mouse.

## 5. Switch view (both clients)

Playpex TV: the power menu's **Phone view** (in a browser, beside Switch profile and Full screen: the place it opened
over, `web/switch-view.ts` `placeOf`) and Settings › Display › Phone view (`at=settings`). Playpex Mobile: Settings ›
This browser › **Switch to the TV view** (`at=settings`; `state/views.ts` `useTvView`, `native/viewSwitch(.web).ts`).
Each shows only while the other client is served (`GET /clients`). They open `/app/?view=<other>&at=<place>`: `/app/`
remembers the choice and translates the place (`lib/web/entry.js` `PLACES`), so the route map lives in one file:

| `at` | Playpex TV | Playpex Mobile |
| --- | --- | --- |
| `home` | `/home/list` | `/` |
| `movies`, `shows` | `/movies/list`, `/shows/list` | `/movies`, `/shows` |
| `search` | `/search` | `/search` |
| `mylist`, `settings` | `/watchlist`, `/settings` | `/mylist`, `/settings` |
| `person/<id>` | `/people/<id>` | `/person/<id>` |
| `title/movie/<id>` | `/movies/movie/<id>` | `/title/movie/<id>` |
| `title/tv/<id>` | `/shows/show/<id>` | `/title/tv/<id>` |

Anything else: Home. During a video: the title (its resume point is the server's, "Resume from …").

**The profile follows**: both clients keep the profile of the tab in `sessionStorage['playpex.web.profile']`
(`{ server, profile }`): Playpex Mobile's `native/profileMemory.web.ts`, Playpex TV's `session-restore.ts` (written with
its own history; at start, a shared profile its history doesn't hold → that profile only, at the address opened,
`resumeShared`). Opened with `POST /profiles/{id}/resume` (a PIN only if this browser unlocked it lately). The tab is the
same across the switch, so is its sessionStorage.

## 6. Steps

1. **Built**: settings `clients.*`, `GET /clients` (`lib/routes/clients.js`, `lib/web/clients.js`), `/app/`
   (`lib/web/entry.js`: its own CSP with the script's hash), `/tv` / `/m` turned off (403 page); the spec
   (`WebClients`, `Settings.clients`), `test/web-entry.test.js` (the page's script run in a vm per device).
2. **Built** (reworked 2026-11-17 from a design canvas: a shelf of small screens, Web first and chosen at first):
   Dashboard › Clients (`pages/clients.tsx`, in the nav right under Overview): Web shows one row, Playpex on the web (`/app/` at an IP
   address, never the `.local` name, which not every device resolves; what it opens on each screen; Open, Copy, a QR code (`qrcode`, a local
   type declaration: `@types/qrcode` would pull `@types/node` into the TV's build); a Served switch per client behind it,
   the build command when one isn't built); the TV, a computer, a tablet or a phone shows only its apps to install (the
   downloads from GitHub's releases API, the server's version else the newest published, so every link is a real file);
   every screen shows all of it and DLNA; the computer's and the tablet's choices under their screens (not on phones).
3. **Built**: Switch view and the shared profile in both clients (above).
4. Later: the view in Activity / Devices ("Chrome on Android · phone view"), the downloadable apps on the Clients page
   once they are published, a shared web player package (`docs/mobile-web-plan.md` §7).
