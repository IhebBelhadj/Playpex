# Hello, the example plugin

A packaged Playpex plugin that uses every part the TV draws and the dashboard sets up, with made-up titles and no network:

- a menu section (`catalog` template) with search, a Decade filter, a paged row and a fixed one;
- a title page (`title`) whose "Say hello" asks first (`confirm`) and answers with a toast, a "Releases" list (`releases`) and a menu (`list`) opening its screens, a toast and a core movie page;
- contributions to core screens: an action on movie pages, a row in the Movies section, a chip on title meta lines, a chip on the search page;
- events, a job, a write, an account and notifications: when a profile adds a title to its watch list Hello sends it a notification (a toast on the TV); "Hello: my list" on movie pages adds the movie through the core once the admin allows it (Plugins › Hello › Settings › Profiles: "Can change your watch list"); a made-up "Hello account" per profile linked on the dashboard (Accounts: a form) and read by the menu's "Who am I?"; an hourly job;
- settings of every type on the dashboard (Plugins › Hello › Settings): text, switch, number, slider (advanced), a secret, an action, and per profile a choice, a switch and a text with a pattern that shows only while "Shout it" is off.

Try it: set `plugins.developerMode` to `true` in the server's settings, copy this folder to `<config dir>/plugins-dev/hello/` (Linux `~/.config/Playpex/plugins-dev/hello/`) and restart the server; or pack it (`npm run pack:plugin -- plugins/hello`) and install the `.ppx` from the dashboard. Guide: [`docs/plugins/`](../../docs/plugins/README.md), templates and effects in [`docs/plugins/tv.md`](../../docs/plugins/tv.md).

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live.
