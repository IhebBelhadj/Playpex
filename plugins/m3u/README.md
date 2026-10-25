# Live TV (M3U)

A first-party live plugin (`docs/providers-plan.md` §8.4, step 9): the channels of an M3U playlist the admin pastes in its settings, their programmes from an XMLTV guide (its address, else the one the playlist names: `url-tvg`), a **Live TV** section drawn by the core's `guide` template.

- Carries no list of its own: the admin gives their own IPTV subscription or a public list.
- Its settings `playlist` and `guide` are `url` settings with `grantsHost` (decision J): the host the admin types joins its network permission (http or https, its port), shown as "Talks to …" on its Permissions. `playlist` also has `streamHosts`: the hosts of the streams, logos and guide the playlist lists may be streamed from (the admin's document named them). Addresses must be public: a LAN IPTV server can't be reached (yet).
- `live.channels`: `playpex.iptv.m3u(playlist)` (fetched and parsed by the host, cached 6 h) → channels (id: the tvg-id when unique, else a hash of name and group); "Only these groups" filters them.
- `live.guide`: `playpex.iptv.xmltv(url, { channels, from, to })`: matched by tvg-id, else by name.
- `live.stream`: the channel's URL as a `live` source: `.m3u8` → HLS (hls.js in the player), else MPEG-TS (ffmpeg on the server remuxes it). `#EXTVLCOPT:http-user-agent` / `http-referrer` are sent as headers.

Published in the official repository (`~/projects/playpex-plugins/official`). Tested by `apps/server/test/live.test.js`.
