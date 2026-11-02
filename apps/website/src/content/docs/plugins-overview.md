---
title: "Plugins for developers"
description: "What a Playpex plugin is, what it can add, and how to run your first one."
group: Build plugins
order: 1
---

A plugin adds to a Playpex server: sources for Play, live TV channels, ratings on title pages, subtitles, its own screens on the TV, and more. It's a small package the admin installs on the dashboard.

## What a plugin is

A package, `<id>-<version>.ppx`: a zip holding

```
playpex-plugin.json      the manifest: who you are, what you add, what you need
server.js                your code, one bundled file, run in a sandbox on the server
assets/                  icons, images and screenshots
i18n/<locale>.json       optional translations
CHANGELOG.md             optional: shown on install and update
```

- **The manifest** declares everything: your permissions, the screens and settings you add, the stages you hook into. See [The manifest](manifest).
- **`server.js`** runs on the server, in a sandbox, with one global: `playpex`. See [Server code](server-code).
- **No plugin code runs in the apps.** Your screens are the apps' own templates filled with your data. See [Screens and slots](screens).

## What a plugin can do

| To | Use |
|---|---|
| Offer torrents or streams when someone presses Play | the `play.collect` hook |
| Reorder or hide sources, ask before playing | `play.rank`, `play.before` |
| Add ratings, tags and links to title pages | `metadata.details` |
| Offer subtitles | `subtitles.providers` |
| Mark intros and credits in the player | `player.markers` |
| Provide live TV channels and their guide | `live.channels`, `live.guide`, `live.stream` |
| Answer the dashboard's Search | `sources.search` |
| Add a section, screens and rows to the TV and phone | `contributes.sections`, `screens`, `slots` |
| React to what people watch, sync a service, run jobs | events, schedules, writes |

## Run your first plugin

1. Turn on developer mode: on the dashboard, **Plugins › Developer**, or set `plugins.developerMode` to `true` in the server's `settings.json`.
2. Copy the example plugin **Hello** (`plugins/hello` in the source code) into the server's `plugins-dev/hello/` folder. On Linux that's `~/.config/Playpex/plugins-dev/`.
3. Restart the server. Its log says whether the plugin loaded, and why not.

Hello uses every screen template, slot, effect and kind of setting, with made-up titles: its section shows in Playpex TV's menu and its settings on the dashboard. Start your own plugin from a copy of it.

## A minimal plugin

`playpex-plugin.json`:

```json
{
  "id": "example",
  "name": "Example",
  "description": "Adds a rating from example.com to every film page.",
  "version": "1.0.0",
  "publisher": { "name": "Your name" },
  "api": { "server": "^1" },
  "permissions": {
    "network": ["api.example.com"],
    "hooks": ["metadata.details"]
  }
}
```

`server.js`:

```js
playpex.hooks.on('metadata.details', async function (input, ctx) {
  var r = await playpex.http.request({
    url: 'https://api.example.com/rating?imdb=' + input.title.imdbId,
    responseType: 'json',
  });
  if (r.status !== 200) return {};
  return { ratings: [{ source: 'Example', value: r.body.score, max: 10 }] };
});
```

## Where to go next

- [The manifest](manifest): identity, permissions, settings and what you contribute.
- [Server code](server-code): the sandbox and the host API.
- [Hooks](hooks): the stages of Play, metadata, subtitles and live TV.
- [Events, jobs and accounts](events-and-jobs).
- [Screens and slots](screens): what the TV and phone draw for you.
- [Security](security) and [Publishing](publishing).

Playpex is an educational project; streaming copyrighted content through torrents may be illegal where you live. Plugins inherit that framing.
