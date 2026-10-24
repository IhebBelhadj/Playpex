# Network storage: library folders on a NAS, a share or a cloud drive

Status (2026-10-24): **proposed, nothing built.** Asked by the user: "the option to connect network storage (Playpex should be your only needed media server)". The dashboard's side (the Storage page's places, the "Network share" dialog) is in [`dashboard-plan.md`](dashboard-plan.md) §6. Read the root `CLAUDE.md`, `apps/server/CLAUDE.md` (library, media refs, DLNA) and `docs/media-server-plan.md` §5 first.

---

## 1. Goals

1. A library folder can live **on another machine**: an SMB / CIFS share (Windows, Synology, QNAP, TrueNAS, macOS sharing), an NFS export, a WebDAV server (Nextcloud, many NAS), an SFTP host.
2. Everything that works on a local folder works on a network one: scanning and matching, playback by media ref (ranges, ffprobe, the audio conversion), sidecar subtitles, DLNA, the Storage browser, delete.
3. **A share that goes offline never loses the library**: its files aren't marked missing (and purged after 7 days) because the NAS slept; the folder shows "Offline" and comes back by itself.
4. Credentials are kept like the server's other secrets and never shown again.
5. Optionally, the download folder on a share (a NAS as the only disk).

Non-goals: cloud object stores (S3, Google Drive) in v1 (a plugin could later be a source: §8); writing to shares beyond delete (organising files is a later step); serving Playpex's own folders as a share (Playpex is a media server, not a file server).

## 2. Two ways to reach a share

| | **Mounted by the system** (the OS mounts the share; Playpex sees a path) | **Opened by Playpex** (a protocol client inside the server) |
|---|---|---|
| How | Linux `/etc/fstab` / `autofs` / `gio mount` (user, gvfs), macOS `/Volumes/…` (Finder, `mount_smbfs` as the user), Windows UNC paths `\\nas\media` (no mount needed: Node's `fs` reads them) or mapped drives | `lib/storage/sources/<protocol>.js`: list, stat, read a range |
| Protocols | everything the OS speaks (SMB 1–3, NFS 3/4, WebDAV via davfs2 / Finder, SFTP via sshfs) | WebDAV (`webdav` npm, mature), SFTP (`ssh2`, mature), SMB 2/3 (`@marsaud/smb2` is old and SMB2-only; to evaluate, §5), NFS (no mature pure-JS client: not in v1) |
| Speed | the kernel's: fine for 4K remuxes | a userspace client: fine for streaming (a range at a time), slower for scans |
| Setup | outside Playpex (or the OS's own dialog); Playpex can't do it for the user without root | inside the dashboard: host, share, user, password, Test |
| Downloads onto it | yes (engines write to a path) | no (engines need a file system) |
| Offline detection | the path disappears or hangs (stat timeouts: a hard-mounted NFS can block a process: `soft` mounts recommended) | the client's errors, with timeouts we control |

**Recommended (decision A): both.** System mounts are first-class (no new protocol code, every protocol, downloads allowed): Playpex recognises a library folder on a network mount, shows it as a share, and handles it going offline. Playpex's own clients cover what a home user can't easily mount (a NAS on Linux without root, a Nextcloud WebDAV, an SFTP box), set up from the dashboard.

## 3. Mounted by the system

- **Recognising a network folder**: on Linux `/proc/self/mountinfo` (types `cifs`, `smb3`, `nfs`, `nfs4`, `fuse.sshfs`, `davfs`, `fuse.gvfsd-fuse`), on macOS `mount` (`smbfs`, `nfs`, `webdav`), on Windows a UNC path or a drive whose type is network (`wmic logicaldisk` / PowerShell `Get-PSDrive`). `lib/storage/mounts.js#describe(path)` → `{ network: bool, protocol, server, share }`, checked when a folder is added and on each scan.
- **The folder browser** (Library › Add folder, `GET /admin/fs`) lists mounted shares under a "Network" place (`/mnt/*`, `/media/*`, `/Volumes/*`, `/run/user/<uid>/gvfs/*`, mapped drives) so the admin finds them.
- **Help where the OS needs it**: the Add share dialog's "Mounted by this computer" tab explains per OS how to mount (fstab line with `soft,timeo=` for NFS, `gio mount smb://nas/media` on Linux desktops, Finder ⌘K on macOS, `\\nas\media` on Windows, with "the server runs as <user>: mount it for that user").
- Windows service note: a server running as a service (separation plan §13) doesn't see a user's mapped drives; UNC paths with stored credentials work.

## 4. Opened by Playpex: storage sources

### 4.1 The source abstraction
```
lib/storage/sources/
  index.js     registry: create(row) → source; capabilities; health
  local.js     the file system (today's behaviour, also system-mounted shares)
  webdav.js    `webdav` (PROPFIND / GET with Range), Basic / Digest auth, HTTPS (self-signed: pinned certificate on first use)
  sftp.js      `ssh2` SFTP: readdir, stat, createReadStream({ start, end }); host key pinned on first use
  smb.js       SMB 2/3 (after the spike, §5)
```
A source answers `list(dir)` → entries `{ name, type, size, mtime }`, `stat(path)`, `open(path, { start, end })` → Readable, `remove(path)` (when allowed), `health()` → `{ ok, error, latencyMs }`, with timeouts on every call (10 s; reads 30 s idle) and a small connection pool (2–4 per share).

### 4.2 Where it plugs in
- **Library folders** gain a `source_id` (null = local) and keep `path` as the path inside the source; `storage_sources` table: `id, kind (webdav | sftp | smb), name, host, port, share, root, user, secret (encrypted with the server's key, like `plugin_secrets`), options (TLS fingerprint, host key, domain), status, last_ok_at, error`.
- **The scanner** (`lib/library/walk.js`) walks through `source.list` instead of `fs.readdir` (one implementation: `local.js` wraps `fs`), with lower concurrency for network sources (2) and a back-off on errors. Change detection by size + mtime works as today.
- **Media refs** stay `f_<id>`; `lib/media#open` opens through the folder's source; `lib/media#input` (what ffprobe / ffmpeg read) gives the loopback `/media/{ref}?internal=` URL for non-local sources (as for torrents), so probing and the audio conversion work unchanged.
- **Sidecars and nfo** read through the source (small files).
- **DLNA** reads through `lib/media`: nothing to change.
- **Offline**: a source whose `health()` fails marks its folders `offline`; the scanner then **skips** them — no file is marked missing, nothing is purged — and plays answer 503 `UNAVAILABLE` ("nas.local is offline"); health is retried every minute, then every 5, and a recovered share is scanned (quick, by size + mtime). The same rule applies to system mounts whose root path is gone or times out (today they'd become `missing`).

### 4.3 Discovering shares
`GET /admin/storage/discover` → servers on the LAN: mDNS `_smb._tcp`, `_webdav._tcp` / `_webdavs._tcp`, `_sftp-ssh._tcp`, `_nfs._tcp` (with `bonjour-service`, already a dependency) and, for SMB, the share list of a host once credentials are given (SMB's NetShareEnum, if the SMB client supports it; else the admin types the share).

## 5. SMB from Node: a spike first
SMB is what most NAS and Windows machines share, and the weakest in pure JavaScript. Step 1 measures before committing:
- `@marsaud/smb2` (SMB 2.0 only, unmaintained, no SMB 3 encryption), `v9u-smb2` / forks, `smb2-client`: list, stat, ranged reads against Samba 4 (Linux), a Synology DSM 7 if available, Windows 11; throughput of a 4K remux (≥ 15 MB/s sustained needed), seek latency.
- Fallbacks if none is good: `smbclient` (Samba's binary) as a subprocess for listing + a FUSE-free read path (`smbclient -c 'get … -'` per range is too slow for seeking), or **system mounts only for SMB** with the dashboard's mounting help (§3). Decision B is taken from the spike's numbers.

## 6. The download folder on a share
Only on a **system mount** (engines write files). The Settings › Storage folder picker accepts a network path with a warning: torrents write many small random pieces; over SMB / NFS that's slower and wears nothing locally but stresses the network; "Keep the downloads on a local disk and add the share as a library folder" is the advice shown. A share going offline pauses running downloads (state `error: storage offline`), resumed when it's back.

## 7. Security
- Credentials: encrypted at rest with the server's key (`<config>/auth.json`'s secret, as plugin secrets), never returned by the API (the dashboard shows "Set"), never logged; changing one requires the admin.
- WebDAV over plain HTTP refused unless the admin allows it for a LAN address ("credentials would cross the network in clear"); certificates and SSH host keys pinned on first use, a change refused until the admin accepts it (like plugin repository keys).
- Sources only reach the hosts the admin configured; paths are confined to the share's root (no `..`, symlinks on the remote side followed only inside the root, as the local walker does).
- The server never mounts anything itself (no root, no `mount` calls).

## 8. Decisions
- **A. System mounts, Playpex's clients, or both**: *Recommended: both* (§2).
- **B. SMB inside Playpex**: a pure-JS client / Samba's binary / system mounts only. *Taken after the spike (step 1)*; until then SMB is "mount it".
- **C. NFS inside Playpex**: none in v1 (system mounts) / a native binding (libnfs: packaging pain in the Electron server). *Recommended: none in v1.*
- **D. Offline vs missing**: an offline share's files keep their rows indefinitely / are purged after N days offline. *Recommended: kept until the admin removes the folder*, with a dashboard warning after 7 days offline.
- **E. Cloud stores** (S3, Drive, OneDrive): later, as plugins that are storage sources (a plugin API for `list` / `open`, sandboxed HTTP), not core code.

## 9. Steps

| Step | What | Verify |
|---|---|---|
| 1 | **SMB spike** (§5): candidates against Samba (a container), throughput and seeking; write the result into this plan (decision B) | numbers in §5 |
| 2 | **Offline, not missing** for local / mounted folders: health of a folder's root (stat with a timeout), `offline` status, scanner skips, 503 `UNAVAILABLE` on play, recovery scan | `test/library.test.js`: a folder unmounted (renamed) mid-life keeps its files; plays answer 503; back → ok without rematching |
| 3 | **Recognise system mounts** (`mounts.js` per OS), the "Network" place in the folder browser, the dashboard's mounting help | Linux with a CIFS / NFS mount (containers), macOS / Windows by hand |
| 4 | **Source abstraction** (`local.js` first: every test still passes), `storage_sources` (migration), the scanner / `lib/media` / sidecars through sources, loopback input for ffmpeg | the whole server suite unchanged with `local.js` |
| 5 | **WebDAV and SFTP sources** (+ pinned certificates / host keys, secrets), `GET /admin/storage/discover` | test servers in `test/` (a WebDAV server in Node, `ssh2`'s server for SFTP): scan, play with ranges, ffprobe, DLNA, offline → online |
| 6 | **SMB source** if the spike says so | Samba container: the step-5 checks |
| 7 | **Dashboard**: Add network share (protocol, discovered servers, Test connection, the folder's kind / audience / DLNA), places "Network" in Storage, offline badges, credentials "Set" | screenshots; a wrong password says so in words ("nas.local refused the user `media`") |
| 8 | **Download folder on a mount** (§6): warnings, pause on offline | a mounted share as the download dir; unmount → downloads pause; remount → resume |
| 9 | **Docs**: `apps/server/CLAUDE.md`, `docs/media-server-plan.md` (library sources), the dashboard guide | — |

## 10. Open questions
- Watching for changes on shares (inotify doesn't cross SMB / NFS): periodic scans only (today: every 15 min), or a "Scan now" per share and a shorter interval for small shares?
- Transcode caching for slow shares (prefetch ahead of the playhead into `<cache>`)?
- Several Playpex servers reading the same share: fine (read-only), but each matches separately (media-server plan §10).
