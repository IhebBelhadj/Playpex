# Security rules

A plugin is code the server's owner didn't write. The rules below hold **by construction** (the plugin has no other way to act) and are what the sandbox's tests (plan step P2) attack. Why: docs/plugins-plan.md §2.

| Rule | Because |
|---|---|
| Plugin code runs only in a QuickJS / WASM sandbox on the server, with nothing but `playpex` | the server runs as the user: files, processes, secrets |
| No plugin code in the TV; screens are core templates fed with data | the TV's renderer holds the device token (added by the shell) and `window.playpex` (power, connection) |
| Every capability is a permission in the manifest, shown to the admin in words, granted at install, and asked again when it grows | install is consent; an update can't sneak in more |
| Network: HTTPS, declared host names only (no IPs, no local names); resolved addresses must be public, on every redirect | the server sits on the LAN: routers, NAS, cameras (SSRF) |
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
| Assets served with fixed types, `nosniff`, SVG with a script-blocking CSP | an asset is never a page |
