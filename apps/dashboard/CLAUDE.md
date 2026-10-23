# Dashboard (`apps/dashboard`) — Agent Guide

The Playpex Media Server's admin web UI (plan §7, step 5): desktop web and phones, **not** the 10-foot TV UI. Started from Vite's `react-ts` template, with shadcn/ui on top.

**Stack**: React 19, TypeScript 6, Vite 8, Tailwind CSS 4, **shadcn/ui** (style `radix-nova`, `radix-ui` primitives, Lucide icons, Geist font), TanStack Query 5 (server state), React Router 8 (library mode, `createBrowserRouter`), **openapi-fetch** typed from `@playpex/protocol/types/api` (generated from `packages/protocol/openapi.yaml`), sonner (toasts); for `/docs` only: react-markdown + remark-gfm, Scalar (`@scalar/api-reference-react`, pinned). Lint: oxlint (`npm run lint`).

## Run / build
| Goal | Command (repo root) |
|---|---|
| Develop | `npm run server` in one terminal, `npm run dashboard` in another → Vite on :5173 with hot reload. `vite.config.ts` proxies `/api` (and the events WebSocket) to `PLAYPEX_SERVER` (default `http://localhost:28470`) and rewrites `Origin` to the server's, so cookies, the CORS/Origin checks and Better Auth's CSRF check behave as in production (same origin). Proxied requests come from loopback, so the setup wizard works |
| Build | `npm run build:dashboard` (= `tsc -b && vite build`) → **`apps/server/public`** (git-ignored, emptied first). The server serves it at `/` (`lib/api.js`: `/assets` immutable 1 year, other files 1 h, every GET path without a dot outside `/api` → `index.html`, `no-cache`). Without a build, `/` answers a 404 hint |
| Typecheck / lint | `npx tsc -b`, `npm run lint -w apps/dashboard` |

## Layout
```
src/main.tsx            QueryClient (a 401 anywhere → session cleared → /login), TooltipProvider, Toaster
src/router.tsx          routes: /setup, /login, /docs (public, lazy: DocsLayout → /docs = guide index, /docs/:page = a chapter,
                        /docs/reference = the API reference), then RequireAdmin + AppLayout: / (Overview), /activity, /devices,
                        /link (pairing's verification_uri; ?user_code= from the client's QR code), /library (?file= opens a
                        library file's sheet), /downloads (?hash= opens a download's sheet), /storage, /logs,
                        /settings[/:tab] (tabs = settings groups + desktop app (desktop host only) + account), /profiles, /about
src/lib/api.ts          `api` (openapi-fetch client, baseUrl /api/v1, cookies), `unwrap()` → data or ApiError
                        ({error,code} / Better Auth {message,code} / RFC {error_description}), schema type aliases
src/lib/auth.ts         useSetupState (GET /admin/setup {needed, local}), useSession (Better Auth get-session),
                        useSignIn / useSignOut
src/lib/events.tsx      EventsProvider: one WebSocket to /api/v1/events (reconnects with back-off); invalidates
                        queries on session.* / device.* / pairing.* / host.*; useEvent(prefix, fn) for pages (Logs: `log`)
src/lib/restart.ts      POST /admin/restart, then waits for the server (or reports its new port)
src/lib/format.ts       bytes, speed, clock, duration, ago (Intl.RelativeTimeFormat)
src/components/layout.tsx  RequireAdmin (→ /setup or /login?next=), AppLayout (sidebar / mobile Sheet, recovery
                        banner, pairing toasts), useOverview, usePairingRequests
src/components/desktop.tsx useHost (GET /admin/host), DesktopCard (Settings › Desktop app, shown only when the
                        server runs in the desktop app), UpdateNotice (Overview: a downloaded update, install)
src/components/dlna.tsx   DlnaPanel (Settings › DLNA, under its two settings: GET /admin/dlna every 10 s: status, the folders'
                        switches (PATCH /admin/library/folders/{id} {dlna}; adults-only ones disabled), "Seen by")
src/components/common.tsx  PageHeader, Stat, Empty, QueryError, Loading, Spinner, Dot, Confirm (AlertDialog), Mono
src/components/ui/      shadcn components (generated: `npx shadcn@latest add <name>` from apps/dashboard)
src/pages/*.tsx         one file per page
src/pages/docs.tsx      the client author guide: `docs/api/*.md` (repo root) bundled with `import.meta.glob(…?raw)`, rendered
                        with react-markdown (GitHub-style heading ids, `chapter.md#x` links → `/docs/chapter#x`); chapter order
                        in `ORDER`; styles `.doc-prose` in index.css. A new chapter = a new .md file there (+ `ORDER`)
src/pages/docs-reference.tsx  Scalar on `/api/v1/openapi.yaml`, its own lazy chunk (~1.9 MB). Kept offline: telemetry off,
                        `showDeveloperTools: 'never'` (its Share / Deploy upload the spec to scalar.com), agent / MCP off,
                        no web fonts, no proxy
```

## Conventions
- **All data through `api` + `unwrap` in React Query** (`queryKey` = the resource: `overview`, `sessions`, `devices`, `pairing`, `settings`, `storage`, `logs`, `profiles`, `torrents`, `downloads`, `download` (+ hash), `library`, `library-files` (+ filters), `library-file` (+ id), `library-search`, `fs` (+ path), `host`, `dlna`). Frequent events patch the cache instead of invalidating it: `download.updated` → `setQueryData(['downloads'])` in `pages/downloads.tsx`; `library.scan` progress → `setQueryData(['library'])` in `pages/library.tsx` (its end invalidates the library keys). The events socket invalidates by those keys; add yours to `INVALIDATES` in `events.tsx` when a new event topic exists.
- **API first**: a new page needs its route in `openapi.yaml` (+ `npm run generate -w packages/protocol`, server, contract test) before the UI; the types then flow here. Don't hand-write response types.
- Theme tokens only (`bg-card`, `text-muted-foreground`, `text-success`, `text-warning`, `bg-destructive`…, defined in `src/index.css`); the accent (`--primary`) is the gold of the Playpex logo. Dark unless the OS prefers light (`index.html` script toggles `.dark`).
- Destructive actions go through `Confirm` (AlertDialog). Mutations toast their result (`sonner`).
- `@/` = `src/` (tsconfig `paths`, Vite alias). **After `npx shadcn add`, check the new files' imports**: on init the CLI wrote `import { cn } from "cn"` (an unrelated npm package) instead of `@/lib/utils`; that was fixed by hand.
- Fast-refresh warnings from oxlint (`only-export-components`) are accepted for files exporting hooks next to components.

## Auth model (server side: `apps/server/lib/auth`)
- First run: `GET /admin/setup` → `needed`; the account can only be created from the server machine (`local`), then the wizard signs in and saves a few settings (restarting the server when one needs it).
- Admin session = Better Auth's HttpOnly cookie `playpex.session_token` (per host:port: after the server moves to another port, sign in again there).
- Recovery mode (port taken at start): the server listens on a random loopback port, serves only `/server`, `/admin/*`, `/auth/*` and this UI; `Overview.server.recovery` drives the banner and Settings › General's port field (Check → `POST /admin/settings/check-port`, then Save + Restart).
