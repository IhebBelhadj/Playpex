# Live TV (M3U)

A first-party live plugin (`docs/providers-plan.md` §8.4, step 9): the channels of up to 5 M3U playlists the admin pastes in its settings (shown together), each one's programmes from its XMLTV guide (its address, else the one the playlist names: `url-tvg`), a **Live TV** section drawn by the core's `guide` template.

- Carries no list of its own: the admin gives their own IPTV subscription or a public list.
- Its settings `playlist` / `guide` (the first playlist) and `playlist2`…`playlist5` / `guide2`…`guide5` (groups "Playlist 2"…"Playlist 5") are `url` settings with `grantsHost` (decision J): the host the admin types joins its network permission (http or https, its port), shown as "Talks to …" on its Permissions. `playlist` also has `streamHosts`: the hosts of the streams, logos and guide the playlist lists may be streamed from (the admin's document named them). Addresses must be public: a LAN IPTV server can't be reached (yet).
- `live.channels`: `playpex.iptv.m3u(url)` for every playlist set, side by side (fetched and parsed by the host, cached 6 h; one that fails is logged and left out) → channels (id: the tvg-id when unique, else a hash of name and group; the second to fifth playlists' prefixed `<n>:`, so the first one's stay what they were with one playlist; a channel number an earlier playlist took is dropped, the server numbers it after the highest); "Only these groups" filters them all.
- `live.guide`: `playpex.iptv.xmltv(url, { channels, from, to })` per playlist with its own channels (in parallel): matched by tvg-id, else by name.
- `live.stream`: the channel's URL as a `live` source: `.m3u8` → HLS (hls.js in the player), else MPEG-TS (ffmpeg on the server remuxes it). `#EXTVLCOPT:http-user-agent` / `http-referrer` are sent as headers.

Published in the official repository (`~/projects/playpex-plugins/official`). Tested by `apps/server/test/live.test.js`.
