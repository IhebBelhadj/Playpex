# Security rules

A plugin is code the server's owner didn't write. The rules below hold **by construction** (the plugin has no other way to act) and are what the sandbox's tests (plan step P2) attack. Why: docs/plugins-plan.md §2.

| Rule | Because |
|---|---|
| Plugin code runs only in a QuickJS / WASM sandbox on the server, with nothing but `playpex` | the server runs as the user: files, processes, secrets |
| No plugin code in the TV; screens are core templates fed with data | the TV's renderer holds the device token (added by the shell) and `window.playpex` (power, connection) |
| Every capability is a permission in the manifest, shown to the admin in words, granted at install, and asked again when it grows | install is consent; an update can't sneak in more |
| Network: HTTPS, declared host names only (no IPs, no local names); resolved addresses must be public, on every redirect | the server sits on the LAN: routers, NAS, cameras (SSRF) |
| An address the admin typed (a `url` setting with `grantsHost`) adds only its own host and port (plain http allowed there); `streamHosts` adds the hosts that document lists, for streaming only; still public addresses only | the admin chose them, the plugin didn't; data can't leave through the plugin's own requests to hosts a document named |
| Requests rate limited per host (2/s, burst 10, 4 in flight; stricter only) | a plugin hammering a site gets the user's address banned |
| `http` sources are proxied; the client never sees the URL or headers | tokens of debrid services stay on the server |
| Context carries profile id + kids flag, device id + name; never tokens or other profiles | user data stays the user's |
| `adults` plugins never see kids profiles, never write but downloads, never track plays | children; the household's history |
| Personal permissions (`events.playback`, `write.watchlist / watched / ratings`) are granted per profile by the admin, off until switched on | what someone watches isn't the admin's to send to a third party |
| Answers are validated against `plugin-api.schema.json`; a bad answer = a failed handler, skipped | the core never acts on malformed data |
| Hooks only add, reorder, or hide with a reason the user sees | a plugin can't silently take over Play |
| Limits per plugin: 64 MB, 2 s CPU per call, 4 concurrent calls, 100 queued events, 5 min per job run | a broken plugin can't take the server down |
| Packages come from a repository whose signed index lists their sha256 (the key pinned when the admin added it; a new key refused until accepted), or are uploads signed by a trusted publisher; unsigned ones only in developer mode | knowing who wrote what you install |
| A plugin updates only from the repository it came from (origin pinning) | another repository can't take over an id |
| Updates with more permissions wait for the admin's consent, whatever the update policy | an update can't grow its power silently |
| Plugins call each other only through declared `exports`, in the callee's sandbox with the callee's permissions | nobody borrows another plugin's permissions |
| Setup, grants and linking only on the dashboard (admin) | a client, or anyone holding one, can't change what plugins may do |
| Secrets and linked accounts' tokens are encrypted in the database (AES-256-GCM, the key in `<config>/secrets.key`, 0600); unlinking revokes tokens at the service when the link has a `revokeUrl` | a copy of `playpex.db` (a backup, a file sent for help) holds no usable key or account |
| An `embed` source is a video id, never a URL; the client frames the server's static page, and Playpex TV's shell sends its token only from the app's own top frame | YouTube's code in the frame can't call the server as the device |
| Assets served with fixed types, `nosniff`, SVG with a script-blocking CSP | an asset is never a page |
| Pictures a plugin names (cards, backdrops, releases, programmes, logos) are fetched by the server as the plugin, from its `network` / `images` hosts, granted hosts, image.tmdb.org or picture hosts learned from what the server fetched; checked by their bytes (JPEG, PNG, WebP, GIF, AVIF; never SVG), ≤ 5 MB; clients get `images/<token>` paths (API 1.5) | a client never contacts a plugin's hosts (its address, its profile's browsing), and the per-host rule still holds for pictures |
| Hosts are learned only from what the server fetched itself (a playlist from an address the admin gave, a core-only call's answer), for one scope: streams (never `http.request`) or pictures; ≤ 5000 each, forgotten when the address changes | a plugin can't make the server trust a host by naming it |
| A bridged Stremio add-on ([stremio.md](stremio.md)) is read by the core, never by plugin code: its address is a secret the adapter can't read, its answers are size-capped and cleaned (`@playpex/protocol/stremio`), learned hosts are https only; shipped code flagged `openStreams` (the bridge's) may follow a stream's redirects and an HLS playlist's parts to any **public** host | a debrid link's CDN plays, while the LAN and this machine stay out of reach |
| Trusted code is a managed plugin whose `server.js` is, byte for byte, code the server ships (SHA-256 checked at every load); only it gets core-only calls; it keeps the sandbox, its permissions and limits | the core's own adapters can vouch for provenance; nothing a package can copy or edit |
| The admin can treat any installed plugin as an adults plugin (its page, Profiles: "Treat as adults"): all of the adults rules then apply; stricter only (a plugin declaring adults stays one, and the switch never gives it what adults plugins get more) | the admin decides what reaches children, whatever a plugin's author declared |
| Managed plugins are built by the core's providers from what the admin gives, installed through the same preview and consent as packages; their input (an add-on URL can hold a key) is a sealed secret the plugin's code can't read | a service's configuration stays the server's |
