# Dashboard: a torrent client's detail, a player, a file browser

Status (2026-10-25): **steps 1–8 built**, then the rest of the torrent client, rqbit's detail and the player's "Watch as" the same day (§12.1; what differs from the text below and what's left: §12). Asked by the user: "enhance the design of the Playpex dashboard: for torrents being downloaded we need more info (take the interface of µTorrent Web), add a player to the dashboard so you can play torrents from there as well; storage is more like the library, where you see the folder structure of the media dirs, with the option to connect network storage (Playpex should be your only needed media server)." Network storage has its own plan, [`network-storage-plan.md`](network-storage-plan.md), because most of it is the server's. Read the root `CLAUDE.md`, `apps/dashboard/CLAUDE.md`, `apps/server/CLAUDE.md` and `docs/media-server-plan.md` (§4 downloads, §5 library) first.

Legal note: Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.

---

## 1. Goals

1. **Downloads reads like a real torrent client.** A dense list (µTorrent Web's list, sortable, multi-select, configurable columns), a filter rail, and a detail pane with the tabs every torrent client has: General, Files, Peers, Trackers, Pieces, Speed. Global speed limits and the swarm's health in a status bar. Nothing a qBittorrent or µTorrent user looks for should be missing.
2. **Play anything from the dashboard**: a download's file (while it downloads), a library file, from the Downloads, Library and Storage pages, in a player that stays docked while the admin moves between pages.
3. **Storage is the server's files**: a folder browser of every place Playpex keeps media (the download folder, library folders, network shares), with sizes, what each file is (matched title, download, unmatched), and the actions that make sense on files (play, scan, fix the match, delete).
4. **One look across the dashboard**, refined rather than replaced: the shadcn base stays, with a stronger identity for data (numbers, states, swarm) so the pages read as one product with Playpex TV.

Non-goals: a web version of Playpex TV (browsing the catalog to watch is the TV's and a future web client's: server-separation plan §13); RSS auto-downloaders and schedulers (later, §11); editing media files (rename / move) beyond delete (§11).

## 2. Today (2026-10-24)

| Page | Today | File |
|---|---|---|
| Downloads | a table (name, state badge, progress bar, speeds, ETA), filter tabs (All / Active / Queued / Paused / Completed), a detail Sheet (files with checkboxes, remove when watched), add by magnet / URL / file | `apps/dashboard/src/pages/downloads.tsx` (559 lines) |
| Storage | the download folder's top-level entries (one per torrent) with sizes, delete, clear; disk free | `pages/storage.tsx` (147 lines), `apps/server/lib/storage.js` |
| Library | folders (add, kind, audience, DLNA), scans, files with filters, fixing matches | `pages/library.tsx` (1174 lines) |
| Theme | shadcn `radix-nova`, Geist, neutral oklch greys, gold `--primary` (the logo's), `--success` / `--warning`; dark unless the OS prefers light | `src/index.css` |

What the server can tell today, through the engine port (`lib/torrents/port.js`, version 1): per torrent `state, doneBytes, sizeBytes, downBps, upBps, peers` (a count), `peersUnchoked, seeds` (connected), `downloadedBytes, uploadedBytes, checking, pieces` (a bitfield). **Not**: the peer list, trackers and their status, per-file priority (only selected / not), per-torrent speed limits, availability, a speed history. An admin session already passes `requireClient` (`lib/auth/http.js`), so the dashboard can read `/media/{ref}` with its cookie.

## 3. The dashboard's look

### 3.1 Subject, audience, job
A **home server's control desk**: the person who runs Playpex at home (often also its only technical user), on a laptop or a phone, checking what downloads, what plays, what's on the disks, and fixing what's wrong. The job of every page: *see the state at a glance, act in one step.* The vernacular is the torrent client and the NAS admin panel (dense tables, speeds, ratios, piece maps), not the marketing site.

### 3.2 Tokens (refining `src/index.css`, dark first)

| Name | Value (dark) | Role |
|---|---|---|
| Ground | `#141416` | the page; a hint of blue in the black, so gold reads warm against it |
| Panel | `#1C1D21` | tables, the detail pane, the docked player |
| Line | `#2A2C31` | row separators, the pane's top edge (structure, never decoration) |
| Gold | `#E6C163` (existing `--primary`) | the Playpex accent: the selected row's edge, primary buttons, the active filter |
| Down | `#E0A93B` | download speed and progress: **the TV's amber means progress**, kept across products |
| Up | `#5FB3A6` | upload speed, seeding, ratio reached: a cool counterpart that never competes with gold |
| Fault | existing `--destructive` | errors, a tracker that fails, a share offline |

Light mode keeps the same roles (Down `#9A6A0E`, Up `#007F69`: the first draft's `#B07A12` / `#2E8577` measured 3.7 and 4.4 : 1 on white, under the 4.5 : 1 text floor), defined next to the existing `.dark` block. The ground and panel stay the dashboard's existing neutrals (the admin liked them); only Down, Up and the strip's track are new. The speed chart's lines take `--chart-down` / `--chart-up` (dark: `#C18620` / `#36A894`), checked with the dataviz validator (lightness band, chroma, colour-blind separation). Every value is a CSS custom property in `index.css`, exposed to Tailwind through `@theme inline` like today's (`text-down`, `bg-up/15`).

- **Type**: Geist stays (one family). Numbers that change (speeds, sizes, ETA, ratio, seeds) use `font-variant-numeric: tabular-nums` so columns don't jitter as they update; no monospace face (a mono for data labels is the generic choice; tabular Geist keeps the page one voice). Scale: 13 px table text (dense lists), 14 px body, 16 px pane titles, 22 px page titles, 600 weight for names and headings, 400 for values; sentence case everywhere, no capitalised labels.
- **Layout**: the existing sidebar shell; content left-aligned, tables full-bleed inside the page gutter; numbers right-aligned in their columns, names left; a page is one primary surface (the list) and, when something is selected, its detail beneath (desktop) or over it (phone).

### 3.3 The one bold thing: the swarm strip
Every download's progress is drawn **from its pieces**, not as a plain bar: a thin strip (6 px, the row's width of the Done column) where each pixel column is the share of verified pieces in that slice of the torrent (Down amber, more opaque = more complete), with the range a player is streaming outlined in Gold. At a glance it says what no percentage can: a stream that has its start and end (MKV index), a torrent stuck at 99 % on a few pieces, a season pack whose one episode is done. The Pieces tab is the same strip at full size with piece-level detail. Everything else on the page stays quiet.

### 3.4 Review against the brief
- First draft: summary cards on top of Downloads (total down / up / active / ratio as big numbers with small labels): the dashboard default, and it pushes the list below the fold. **Changed**: those numbers go into a one-line status bar under the list (as torrent clients do), the list starts at the top.
- First draft: a mono face for hashes, sizes and speeds. **Changed**: tabular Geist (the hash alone stays in the existing `Mono` component: it is copied, not read).
- First draft: per-state coloured badges (blue downloading, green seeding, grey paused…). **Changed**: state is a word plus the strip's colour (Down / Up); badges only for exceptions (Error, Checking, Queued #3) — fewer colours, each meaning one thing.

## 4. Downloads, as a torrent client

The reference is µTorrent Web's list and the classic µTorrent / qBittorrent Web UI detail pane (what users of those clients expect), re-drawn with the tokens above.

### 4.1 Layout (desktop ≥ 1024 px)

```
┌ sidebar ┬───────────────────────────────────────────────────────────────────────────────────────────┐
│         │ Downloads                                   [+ Add torrent ▾] [▶ Start] [⏸ Pause] [🗑 Remove] │
│         │ ┌─ filters ──────┐ ┌──────────────────────────────────────────────────────────────────────┐ │
│         │ │ All         12 │ │ ☐ Name                     Size    Done        Status      ↓      ↑  … │ │
│         │ │ Downloading  3 │ │ ☐ Heat (1995) 1080p        1.9 GB ▓▓▓▓▓░▒▓▓▓ 61 %  Downloading 4.2 MB/s 120 KB/s│
│         │ │ Seeding      2 │ │ ☑ Breaking Bad S01        14 GB  ▓▓▓▓▓▓▓▓▓▓ 100 % Seeding      —  1.1 MB/s│ ← selected (gold edge)
│         │ │ Completed    5 │ │ ☐ The Office S02E01       350 MB ░░░░░░░░░░ 0 %   Queued #2     —      — │
│         │ │ Paused       1 │ │   …                                                                    │ │
│         │ │ Errors       1 │ ├──────────────────────────────────────────────────────────────────────┤ │
│         │ │ ─────────────  │ │ General  Files  Peers  Trackers  Pieces  Speed                      ✕  │ │
│         │ │ Movies       4 │ │ (the selected torrent's tab: §4.3)                                   │ │
│         │ │ Shows        6 │ │                                                                       │ │
│         │ │ Other        2 │ └──────────────────────────────────────────────────────────────────────┘ │
│         │ └────────────────┘  ↓ 4.3 MB/s (limit 8)  ↑ 1.2 MB/s (limit 2)  DHT 312 nodes  Port open  412 GB free │
└─────────┴───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Filter rail**: states (with counts), then what the download is (Movies / Shows / Other, from its `title`), then labels (§4.5). One click filters; the URL keeps it (`?filter=`).
- **The list** (TanStack Table; virtualised past 200 rows): sortable columns, a column menu to show / hide / reorder (kept in `localStorage`: a per-viewer convenience), multi-select (checkboxes, Shift-click ranges, Ctrl/Cmd-click), the toolbar acting on the selection. Columns available:

| Column | Shown by default | From |
|---|---|---|
| Name (+ the matched title under it, muted) | yes | `name`, `title` |
| Size (selected files) | yes | `sizeBytes` |
| Done (swarm strip + %) | yes | `pieces`, `progress` |
| Status (word; "Queued #2", "Checking 43 %", "Error: …") | yes | `state`, queue position, `checking`, `error` |
| Down speed / Up speed | yes | `downloadSpeed`, `uploadSpeed` |
| ETA | yes | `eta` |
| Seeds (connected / in swarm) | yes | `seeds` + tracker scrape (§4.4) |
| Peers (connected / in swarm) | yes | `peers` + scrape |
| Ratio | yes | `ratio` |
| Availability (distributed copies) | no | pieces of connected peers (§4.4) |
| Downloaded / Uploaded (bytes) | no | `doneBytes`, `uploadedBytes` |
| Added / Completed / Last active | no | dates |
| Save path | no | the download folder + name |
| Label | no | §4.5 |
| Added by (a device, a plugin, the admin) | no | `addedBy` |
| Engine | no | the running engine (torrent-stream / rqbit / torrentd) |

- **Row actions** (a ⋯ menu and the right-click menu): Start, Pause, Force start (ignore the queue), Force recheck, Move up / down in the queue, Set label, Limit speed…, Seeding goal… (ratio / minutes, this torrent), Copy magnet link, Export .torrent, Open in Storage (its folder, §6), Play (§5), Remove (Confirm: "keep files" / "delete files", today's two). Keyboard: ↑/↓ move the selection, Space start / pause, Delete removes (Confirm), Enter opens the pane, `P` plays.
- **Status bar**: totals, global limits (click → a popover with both limits and "Alternative speeds" on / off), DHT nodes, whether the peer port is reachable, free space of the download folder's disk. `downloads.paused` ("Pause all") as a switch there.
- **Add torrent ▾**: magnet / URL / `.torrent` file (today's dialog) + **before adding, the file list** (µTorrent's "Add torrent" dialog): files with checkboxes and sizes once metadata arrives (magnet: "Getting the file list…"), save into (the download folder or a library folder: §6), label, start now / add paused, "Remove when watched". Drag a `.torrent` onto the page adds it.

### 4.2 Phone (< 768 px)
The rail becomes a select; the list shows Name, the strip with %, and one line of Status · ↓ speed · ETA; tapping a row opens the detail as a full-height sheet with the same tabs (horizontally scrolling tab list); the toolbar becomes a bottom action bar for the selection.

### 4.3 The detail pane
A resizable pane under the list (drag its top edge; height kept), closed by ✕ or Escape; on phones a sheet. Tabs:

- **General**: the swarm strip at full width; Time elapsed, Remaining, Downloaded / Uploaded (session and total), Ratio and the seeding goal, Speeds (now and average) with this torrent's limits, Connections (peers, seeds; in swarm from the scrape), Availability, Pieces (count × size, have), Save path (→ Storage), Added / Completed, Info hash (copy), Magnet (copy), Comment and Created by (from the metainfo), the title it's for (→ Library / TMDB), who added it, the engine's last error.
- **Files**: a tree (folders collapsible) with Name, Size, Done (a small strip per file), Priority (Skip / Low / Normal / High), Play (video files: §5). Multi-select + "Set priority". Skip = today's deselect; Low / High need the engine (§4.4). A file a player streams now is marked "Playing on <device>".
- **Peers**: Address (IP:port; a reverse-DNS name when known), Client (from the peer id: "qBittorrent 4.6", "µTorrent 3.6"…), Flags (µTorrent's letters with a legend: D/d downloading from / interested, U/u uploading to / interested, O optimistic unchoke, S snubbed, I incoming, E encrypted, P µTP, L local peer, X peer exchange, H DHT), Progress (their %), ↓ / ↑ speed, Downloaded / Uploaded from them. Sorted by ↓ speed. Optional country (an offline GeoLite database is a licence question: §10).
- **Trackers**: URL, Status ("Working", "Not contacted yet", "Updating…", the error), Seeds / Peers / Downloaded (scrape), Last / Next announce, Message; DHT, PeX, LSD as rows like qBittorrent shows. Actions: Add trackers (a textarea, one per line), Remove, Force reannounce, Copy. The server's own tracker list (`lib/trackers.js`) is marked.
- **Pieces**: the full piece map (one cell per piece, wrapping; Have Down amber, Downloading now outlined, Missing dark, **Being streamed** in Gold), legend, piece size, the range each player reads ("Breaking Bad S01E02 on Living room TV: pieces 1 204–1 380").
- **Speed**: the last 10 minutes of ↓ / ↑ for this torrent (a line chart, Down / Up colours, 2 s samples from the server; longer ranges later), plus peers over time. One chart, no decoration (axes, a unit, the current value).

### 4.4 What the server and engines must add
New engine-port methods (port version 2), each behind a **capability** so engines that can't stay valid (the client and the dashboard hide what's missing; `test/engines.test.js` gains cases per capability):

| Method / capability | Answers | torrent-stream | rqbit | torrentd (anacrolix) |
|---|---|---|---|---|
| `peers(hash)` · `peerList` | `[{ address, port, client, flags, progress, downBps, upBps, downloaded, uploaded }]` | yes (`swarm.wires`: address, peer id, choke / interest, speeds; progress from their bitfield) | its peer stats API (to verify) | yes (`PeerConns`) |
| `trackers(hash)` · `trackerStatus` | `[{ url, status, seeds, peers, downloaded, lastAnnounce, nextAnnounce, message }]` | announce list only, no status (shown as "Not reported by this engine") | to verify | to verify (anacrolix's tracker announcer state) |
| `scrape(hash)` · `scrape` | swarm seeds / peers | a UDP / HTTP scrape we do ourselves (`bittorrent-tracker` client, in the client, any engine) | — | — |
| `priority(hash, [{ path, priority }])` · `filePriority` | | skip / normal only (select) | yes | yes |
| `torrentLimits(hash, { downBps, upBps })` · `torrentLimits` | | no | to verify | yes |
| `recheck(hash)` · `recheck` | | yes (re-add) | yes | yes (`VerifyData`) |
| `trackers.add / remove`, `reannounce` · `trackerEdit` | | add only (on re-add) | to verify | yes |
| `availability` | distributed copies | from wires' bitfields | to verify | yes |

Server: `GET /downloads/{hash}/peers`, `/trackers`, `/pieces` (bitfield as base64 + piece size + the ranges being streamed, from `lib/sessions.js`), `/speed` (a 10-min ring of 2 s samples per running torrent, kept in `lib/torrents/client.js`), `PUT /downloads/{hash}/priorities`, `PATCH /downloads/{hash}` (`label`, `limits`, `seedRatio`, `seedMinutes`, `queuePosition`, `force`), `POST …/recheck`, `POST …/reannounce`, `PUT …/trackers`, `GET …/torrent` (the `.torrent` file), `POST /downloads/preview` (a magnet / URL / file → its file list, without adding: the Add dialog). All admin-only except what clients use today. The pane polls its tab's route every 2 s while open (no new event topic: only the admin needs it, only while looking).

### 4.5 Labels
A free-text label per download (`downloads.label`, migration), with a few automatic ones the rail shows without a label set (Movies / Shows / Other from `title`, "Added by plugins"). Labels filter, colour nothing.

## 5. A player in the dashboard

### 5.1 Behaviour
- **Play** buttons: a download's row and its files (Files tab), a library file (Library), a file in Storage (§6). Plays by media ref (`/media/{ref}`: a torrent's file streams while it downloads, with the lease of the dashboard's device).
- **Docked player**: plays in a dock at the bottom right (~480 px wide, 16:9) that **stays while the admin moves between pages** (it lives in `AppLayout`, outside the routed page), with Expand → a theatre view (the content dims, the video takes the page width), Picture-in-Picture (the browser's), and close. One video at a time; a new Play replaces it.
- **Controls**: play / pause, seek bar showing the downloaded ranges (from `/pieces`, the same Down amber), time, volume, speed, audio track and subtitles (the tracks of `docs/providers-plan.md` §6: `/media/{ref}/tracks`; until that step, sidecar subtitles of library files and the audio conversion), full screen, PiP. Keyboard: Space, ←/→ 10 s, ↑/↓ volume, F full screen, M mute, C subtitles.
- **Who watches**: the admin isn't a profile, so by default nothing is saved (no progress, no history, `tracking: 'none'`); a "Watch as <profile>" select in the player saves progress for that profile (decision B).
- **Mobile**: the dock is a bar above the page; Expand is full screen.

### 5.2 What browsers can play (the hard part)
The TV is Chromium in Electron with known codecs; a dashboard viewer can be Chrome, Firefox or Safari:

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| MP4 (H.264 + AAC) | yes | yes | yes |
| MKV container | yes (Chromium plays Matroska) | **no** | **no** |
| HEVC | hardware-dependent | no | yes |
| AC-3 / E-AC-3 / DTS audio | no | no | AC-3 / E-AC-3 yes |

So the dashboard player needs **a browser-safe stream** besides direct play: `GET /media/{ref}/hls/index.m3u8` — ffmpeg remuxing to HLS (fMP4 segments, video copied, audio → AAC when needed, segments on demand in `<cache>/hls/<ref>/`, cleaned when the lease ends), played with **hls.js** (Chrome, Firefox) or natively (Safari). Video that the browser can't decode (HEVC in Firefox) would need a video transcode: out of scope (the player says "This video's format doesn't play in this browser; it plays on Playpex TV and in Chrome / Edge").
The player asks the server which way to play: `GET /media/{ref}/playback?client=<browser capabilities>` → `{ method: 'direct' | 'hls', url, notes }` (the browser's `MediaSource.isTypeSupported` / `canPlayType` answers sent as capabilities). This is the "capabilities + `…/playback`" item 3b of `docs/server-separation-plan.md` §6.5, finally built: Playpex TV and future clients use the same route.

### 5.3 Server
- `/media/{ref}` already works for the admin's cookie; the dashboard sends `?device=dashboard-<session id hash>` so its lease is its own (Activity shows "Dashboard (Chrome on Linux)").
- New: `/media/{ref}/hls/*` (decision C: hls output, shared with the providers plan's HLS work only in the player library, not on the server side: that plan proxies remote HLS, this one makes HLS from a file), `/media/{ref}/playback`, counting against `streaming.maxTranscodes`.

## 6. Storage: the server's files

### 6.1 What it becomes
Today's Storage lists the download folder's top-level entries. It becomes a **file browser of every place Playpex keeps media** — the download folder, each library folder, network shares (`network-storage-plan.md`) — the way the Library page shows titles, but by folder:

```
┌ sidebar ┬──────────────────────────────────────────────────────────────────────────────────────────┐
│         │ Storage                                                        [+ Add folder] [+ Network share] │
│         │ ┌─ places ─────────────────────┐ ┌──────────────────────────────────────────────────────────┐ │
│         │ │ This server                  │ │ Movies › Heat (1995)                         2 items · 9.4 GB │ │
│         │ │  Downloads      312 GB  ▓▓▓░ │ │ Name                          Size     What it is      Added │ │
│         │ │  Movies         1.2 TB  ▓▓▓▓ │ │ 🎞 Heat.1995.2160p.mkv        8.1 GB   Heat (1995) ✓   3 d    │ │
│         │ │  Shows          2.4 TB  ▓▓▓▓ │ │ 🎞 Heat.1995.1080p.mkv        1.3 GB   Heat (1995) ✓   3 d    │ │
│         │ │ Network                      │ │ 📄 Heat.1995.en.srt           80 KB    subtitles             │ │
│         │ │  nas.local › media  online   │ │                                                          │ │
│         │ │  backup (WebDAV)    offline  │ │ ── disk: /dev/sdb1 · 1.8 TB used of 4 TB ▓▓▓▓▓▓▓░░░░░░  │ │
│         │ └──────────────────────────────┘ └──────────────────────────────────────────────────────────┘ │
└─────────┴──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Places**: grouped "This server" (the download folder and library folders, each with its size and its disk's fill as a thin bar) and "Network" (shares, with online / offline). Selecting a place opens its root.
- **Listing**: breadcrumbs, folders first (with their size and item count), files with size, **What it is** (the matched title with a ✓, "Unmatched", "Ignored", "Subtitles", "Download in progress 43 %", "Not a video"), added date; sort by name / size / date; a search within the place. Row actions: Play (videos), Open in Library (its matched title / the file's sheet), Fix match, Scan this folder, Show the download (a torrent's folder → Downloads), Delete (Confirm; refused while a running torrent writes there, as today: `lib/storage.js` rules), Copy path.
- **Disk usage**: a per-disk line at the foot of the listing (used / total, what Playpex holds there), and "Largest folders" in the place's root (the 10 biggest, one click away). No treemap: a sorted list answers "what takes the space" faster and reads on a phone.
- **Clean up** (today's Clear): stays, under the Downloads place: "Delete files no download uses" with what it would free.

### 6.2 Server
- `GET /admin/storage/places` (download folder, library folders, shares: id, name, kind, root, size, disk `{ used, total, device }`, status), `GET /admin/storage/browse?place=&path=&sort=&q=` (one level: folders with size / count, files with size, mtime, the library's file row when there is one (state, match, ref), the download owning it), `DELETE /admin/storage/entries` `{ place, path }` (the `lib/storage.js` checks: inside the place's realpath, no running torrent; a library file's row goes too), `GET /admin/storage/largest?place=`.
- **Sizes without walking the disk on every request** (today's 14.2c item in the separation plan): folder sizes come from an index kept by the library scanner (it already walks every library folder: it records each directory's total) and, for the download folder, from the torrent client (sizes on disk per download); refreshed on scans and `download.*` events. A place never scanned is walked once in the background ("Measuring…").

### 6.3 Library and Storage, not two copies
The Library page keeps titles: what's matched to what, scans, folder settings (kind, audience, DLNA, information provider). Storage is files and space. Adding a folder or a share is possible from both (the same dialog); a folder's settings stay in Library (Storage links there).

## 7. Other pages (light touch, same tokens)
- **Overview**: the status bar's numbers (↓ / ↑, active downloads), "Playing now" with posters (Activity's sessions), disks with fill, problems first (a share offline, an engine error, no TMDB key) — the page answers "is everything fine?".
- **Activity**: each session's swarm strip for torrents (what the viewer's player reads, the Pieces tab's Gold range), so a stall is visible.
- Tables everywhere get tabular numbers and the same right-aligned numeric columns.

## 8. Decisions

- **A. Detail pane under the list vs a side sheet** (today): under the list, resizable (µTorrent / qBittorrent: the list stays visible and comparable while one is inspected) / a sheet. *Recommended: under the list on desktop, a sheet on phones.*
- **B. Who the dashboard player watches as**: nobody (nothing saved) by default, a profile when chosen / always a profile. *Recommended: nobody by default.*
- **C. Browser-safe playback**: HLS made by ffmpeg (copy video, AAC audio) / fragmented MP4 progressive (simpler, but seeking restarts ffmpeg and the server's notes say fMP4 drifted after `-ss`) / direct play only (Chrome works, Firefox and Safari fail on MKV). *Recommended: HLS*, through `…/playback` so clients ask rather than guess.
- **D. Engine detail where an engine can't tell** (torrent-stream's tracker status): hide the column / show "Not reported by this engine". *Recommended: say so*, with the engine's name: the admin chose it and can switch.
- **E. Peer countries**: none / an offline GeoLite2 database (licence: free with an account, redistribution needs MaxMind's terms) / an online lookup (privacy). *Recommended: none in v1.*
- **F. Charts library**: Recharts (shadcn's charts) / a small hand-written SVG line. *Recommended: shadcn charts* (Recharts), already the kit's.

## 9. Steps

| Step | What | Verify |
|---|---|---|
| 1 | **Tokens and table base**: the palette of §3.2 in `index.css` (dark + light, contrast checked), tabular numbers, a shared `DataTable` (TanStack Table: sorting, column menu, selection, virtualisation) and `SwarmStrip` (canvas, from a base64 bitfield) components | screenshots light / dark at 1360 px and 390 px; contrast of every pair ≥ 4.5 : 1 (text) |
| 2 | **Downloads list**: rail, columns, multi-select, toolbar, row menu, keyboard, status bar, labels (migration), Add dialog with the file list (`POST /downloads/preview`) | a throwaway server with the fake engine (several states) + one real small torrent (≤ 100 MB: `limited-disk-space`); screenshots; keyboard-only walk |
| 3 | **Engine port v2** (`peers`, `trackers`, `priority`, `torrentLimits`, `recheck`, `trackerEdit`, `availability`, capabilities), the client's scrape and speed history, the routes of §4.4; adapters: torrent-stream and torrentd first, rqbit after measuring | `test/engines.test.js` per capability (offline seeder); contract tests |
| 4 | **Detail pane**: General, Files (tree, priorities, Play), Peers, Trackers, Pieces (streamed range), Speed | a real small torrent while a TV plays it: the Gold range follows the playhead; screenshots per tab |
| 5 | **Player**: dock + theatre + PiP, controls, keyboard, "Watch as", `?device=dashboard-…`; `/media/{ref}/playback` + `/hls/*` (ffmpeg HLS, cache, cleanup, transcode limit), hls.js | Chrome, Firefox (MKV via HLS), Safari if available; a torrent file streaming while it downloads; the lease in Activity; leaving the page doesn't stop it, closing the dock releases it |
| 6 | **Storage browser**: places, browse, What it is, actions, disk lines, largest folders, sizes from the scanner's index | temp folders with a few thousand files: browse answers < 100 ms; delete rules (a running torrent's folder refused) |
| 7 | **Overview and Activity** touches (§7) | screenshots |
| 8 | **Docs**: `apps/dashboard/CLAUDE.md`, `apps/server/CLAUDE.md`, `docs/api/` for the client-facing `…/playback` | — |

Network shares in the Storage page come with `network-storage-plan.md`'s steps; steps 1–2 and 6 don't wait for them.

## 10. Open questions
- RSS feeds and automatic downloads (µTorrent's RSS, qBittorrent's rules): wanted? They would belong to a plugin (sources are plugins: `docs/providers-plan.md`), with a dashboard page from its manifest.
- Moving a download's data to another folder (µTorrent's "Set download location"): needs the engine stopped, files moved (maybe across disks), paths updated; worth a step of its own.
- A bandwidth scheduler (alternative speeds by time of day).
- Should the dashboard player be offered to non-admin users (a household member on a laptop)? That's a web client, not the dashboard (server-separation plan §13).

## 12. Built (2026-10-25)

| Step | Built | Where |
|---|---|---|
| 1 | Down / Up / strip tokens (light and dark, contrast checked), tabular numbers in every table, no monospace for numbers; `DataTable` (TanStack Table: sorting, a column menu to show / hide / reorder kept in `localStorage`, file-manager selection, ⋯ and right-click menus with the same actions, keyboard ↑ ↓ Shift Home End Enter Space Delete P Ctrl/Cmd+A Esc, columns shown by the list's own width through container queries); `SwarmStrip` (a CSS gradient of the `pieceMap`, waiting stripes, gold marks) | `apps/dashboard/src/index.css`, `components/data-table.tsx`, `components/swarm-strip.tsx` |
| 2 | Downloads: the rail (states, what it is, labels; `?filter=`), the list, the toolbar acting on the selection, the status bar (totals, the speed limits popover, the disk, the engine, Pause all), labels (migration `0016_download_labels`), the Add dialog with the preview and the file list, drop a `.torrent` on the page; phones: a select, a list, a sheet. Server: `Download.label` / `queuePosition` / `pieceMap` / `savePath`, `POST /downloads/preview`, `POST /downloads` `label` / `paused` (multipart `files` as JSON), `PATCH` `label`, settings `downloads.downLimitKBps` / `upLimitKBps` (engines with `rateLimits`), Overview `downloads.capabilities` | `pages/downloads.tsx`, `lib/downloads.ts`, `components/add-download.tsx`, `apps/server/lib/torrents/client.js` |
| 3 | Engine port **v2**: capabilities `peerList`, `trackerList`, `trackerEdit`, `recheck` with `peers` / `trackers` / `addTrackers` / `recheck` in torrent-stream (its wires; the peer id kept from the handshake), torrentd 0.2 (`GET /torrents/{h}/peers`, `/trackers`, `POST …/trackers`, `…/recheck`; an older build answers `NOT_SUPPORTED`), the fake engine (which now streams bytes as they arrive, like a real engine); rqbit declares them false (not measured). The client: peer names from peer ids (`lib/torrents/peerid.js`), a 10-minute speed history, where players read (a counter on each stream). Routes `GET /downloads/{h}/peers|trackers|pieces|speed`, `POST …/trackers`, `…/recheck` (admin) | `lib/torrents/port.js`, `engines/*`, `engines/torrentd/main.go`, `lib/api.js` |
| 4 | The detail pane under the list (resizable, its height kept; a sheet on phones): General (+ Check the data again), Files (Play per video), Peers (flags legend), Trackers (add, copy; "doesn't report" said once with the engine's name), Pieces (a canvas map: verified, missing, files left out, the read-ahead in gold, the piece read now in ink; hover), Speed (an SVG chart, crosshair + tooltip, one axis) | `components/download-pane.tsx`, `components/download-tabs.tsx` |
| 5 | `GET /media/{ref}/playback` (direct / hls / none from the client's flags and a probe; notes in words) and `/media/{ref}/hls/{session}/{file}` (ffmpeg: video copied, AAC, fMP4 event playlist from a keyframe; one per device and file, in `maxTranscodes`, ended by `DELETE /media/{ref}` or 90 s idle; parts carry `?device=`); the dashboard's player (`PlayerProvider` in `RequireAdmin`: docked, Expand to a theatre, PiP, full screen, seek (in the stream, else asked again with `t`), volume, speed, sound tracks, subtitles shifted by the stream's start, keyboard, keepalive for Activity, released on close); device `dashboard-<id>`, named "Dashboard (Chrome on Linux)"; Play in Downloads (row, P, Files tab), Library (rows, the file's sheet), Storage | `lib/media/playback.js`, `lib/routes/media.js`, `components/player.tsx` |
| 6 | Storage as a file browser: places (the library's folders and the download folder, sizes, disks, offline ones), browse one level / search a place, what each file is, Play / Open in the Library / Show the download / Copy path / Delete (refused while a running torrent writes there; library rows and a whole download's entry go too), the disk line, the largest title folders, Clean up downloads. Sizes from a background measure per place (10 min, again after scans and downloads), never in a request | `apps/server/lib/storageBrowser.js`, `GET /admin/storage/places|browse|largest`, `DELETE /admin/storage/entries`, `pages/storage.tsx` |
| 7 | Overview: problems first (engine, ffmpeg, low disks, offline folders, failing providers, paused downloads) with where to fix them, then Traffic and Playing now instead of four stat cards. Activity: each torrent session's strip with its player's read range in gold, the method in words | `pages/overview.tsx`, `pages/activity.tsx` |
| 8 | Docs: this section, `apps/dashboard/CLAUDE.md`, `apps/server/CLAUDE.md`, `docs/api/playback.md` (`/playback`, labels, preview, the piece map) | |

Verified: server tests (`downloads.detail.test.js`, `storage.test.js`, the new cases of `downloads.test.js`, `engines.test.js` (port v2 on torrent-stream, fake and torrentd 0.2), `media.test.js` (playback: direct, HLS end to end with ffprobe, replaced, released)); screenshots (Downloads in light and dark at 1360 px and on a 390 px phone; the pane's tabs, the player, Storage and Overview in dark at 1360 px) against `test/helpers/downloads-server.js` (a throwaway server with downloads in every state, real videos made by ffmpeg, a library folder: `node apps/server/test/helpers/downloads-server.js`, admin / playpex-demo).

**Differs from the plan**
- The list's strip comes from `pieceMap` (≤ 100 slices, sent with every `download.updated`), not the whole bitfield; the Pieces tab reads the bitfield (`/pieces`).
- No list virtualisation yet (fine for hundreds of downloads).
- Tracker status: neither torrent-stream nor anacrolix exposes it, so every engine says "doesn't report"; the scrape (§4.4) isn't built.
- Peer flags: torrent-stream gives D d U u; torrentd D U I X H P (anacrolix keeps choke state private).
- Added trackers are kept in memory until the server restarts (not in the table).
- Player: no "Watch as <profile>" yet (nothing is saved, decision B's default); the timeline doesn't draw the downloaded ranges (the strip in the pane does).

### 12.1 The rest of the torrent client, rqbit, "Watch as" (2026-10-25)

| What | Built | Where |
|---|---|---|
| Queue moves | `PATCH /downloads/{h}` `{queuePosition}` (a queued one; past the end = last): the queue's order is then the admin's (`queue_order`, migration `0017_download_controls`), the others after it oldest first; queued again after a stop = at the back, after waiting for a slot = its place kept. Row menu: Move to the front / up / down / to the back | `lib/torrents/client.js` (`queueCompare`, `moveInQueue`), `pages/downloads.tsx` |
| Force start | `{force: true}`: intent `download`, runs past `downloads.maxActive` (not past `streaming.maxTorrents` nor Pause all: "Forced, waiting" then), ended by a pause, completion or error; `forced` in Download; "Downloading (forced)" | `client.js#setForce`, `pump` |
| Seeding goals, speed limits per download | `{seedRatio, seedMinutes}` (null = the server's; 0 = stop once done), `{downLimitKBps, upLimitKBps}` (engines with `torrentLimits`, else 501); the "Seeding goal and speed limits" dialog (row menu, General) | `client.js#setSeedGoal` / `setTorrentLimits`, `components/download-rules.tsx` |
| `.torrent` export | `GET /downloads/{h}/torrent` (admin): the metainfo with the trackers it announces to; row menu, General | `client.js#torrentFile`, `lib/api.js` |
| Trackers kept, removed, announced again | `POST …/trackers {add?, remove?}` kept in the row (`trackers: {added, removed}`): the torrent's own + the server's + the added, less the removed (a removed one is left out of the `.torrent` and magnet engines get); `POST …/reannounce` (409 while a player reads it: the engines restart the torrent's traffic for it) | `client.js#editTrackers` / `reannounce`, `download-tabs.tsx` (✕ per tracker, Announce again) |
| The scrape | `lib/torrents/scrape.js` (HTTP BEP 48, UDP BEP 15, many hashes per request, our own bdecoder: binary keys), every download's trackers every 30 min (the first a minute after the start; the Trackers tab asks again past 5 min), 8 trackers at once; `Download.swarm` (the most any tracker counted), each tracker's `swarm` (seeds, leechers, downloads, error); the list's Seeds / Peers "3 (120)" | `client.js#scrapeSome` |
| Engine port **v3** | capabilities `trackerRemove` (`removeTrackers`), `reannounce`, `torrentLimits` (`torrentLimits(hash, {downBps, upBps})`); torrent-stream: removal from its next start; torrentd 0.3: removal (`ModifyTrackers` + next start), reannounce (the torrent leaves the client and comes back: fast resume), limits (a token bucket per torrent and direction turning its traffic off and on, `limitTick` every 100 ms: anacrolix limits only the client); fake: all three (`latest().inspect(hash)` for tests) | `lib/torrents/port.js`, `engines/*`, `engines/torrentd/main.go` |
| rqbit, measured (9.0.1) | `peerList` (its `peer_stats`: address, client name, byte counters, tcp / µTP, incoming; speeds from two polls; no progress), `trackerList` (the ones it was given), `reannounce` (pause + start announces again, checked against a local tracker); no API for tracker edits on a running torrent, recheck or per-torrent limits | `engines/rqbit/index.js` |
| "Watch as" | the player's menu: Nobody (default, decision B) or a profile (kept per browser); `GET /media/{ref}/playback` now says what the file is (`title`, `download`, `fileId`, `lib/media#describe`); the position is saved for that profile every 15 s, on pause, on close (`PUT /profiles/{id}/progress/…`), the keepalive names the profile; "Resume at 12:34 for Sam" on opening | `components/player.tsx`, `lib/routes/media.js` |
| Downloaded ranges on the timeline | a torrent's file: `GET /downloads/{h}/pieces` every 4 s until the file is all there, its runs drawn in Down amber under what the browser holds | `player.tsx#downloadedRuns` |

Found on the way: anacrolix 1.61's `Piece.VerifyDataContext` returns on a closed torrent with the client's lock held, so a torrent dropped during a recheck (a pause, a remove, now a reannounce) hung every torrent; torrentd's recheck now has a context that `pause` cancels and waits for (`stopVerify`). The conformance suite's peers case selects every file while it waits for a peer (rqbit doesn't connect again to a seeder once its files are done).

Verified: `test/engines.test.js` (port v3 on torrent-stream, rqbit 9.0.1, torrentd, fake; 3 runs in a row), `test/downloads.controls.test.js` (queue, force, goals, limits, trackers kept and exported, reannounce, `describe`, scrapes over HTTP and UDP against bittorrent-tracker's server), the whole server suite; in the browser against `test/helpers/downloads-server.js`: the row menu, force start, the dialog, General, Trackers, a library file saved for a profile and resumed, a downloading torrent's ranges on the timeline. Not checked: per-torrent limits slowing real traffic on torrentd (the fake engine only records them), scrapes of public trackers.

**Left**: network shares in Storage (`network-storage-plan.md`); the TV app using `/playback` (it decides from the probe today); tracker status from the engines (anacrolix and torrent-stream keep it private; the scrape stands in for counts); torrentd 0.3 isn't published (`release.json` still names 0.1.0: `npm run build:torrentd`, or a `torrentd-v0.3.0` tag); no list virtualisation yet.
