# Writing a Playpex plugin

**Status: the contract (steps P0, P0b of [`docs/plugins-plan.md`](../plugins-plan.md)), the sandbox (P2), the TV templates (P1), the hooks (P3), events / schedules / writes / linking / notifications (P3b) and installing (P4).** The manifest, permissions, hooks, events, sources, effects, template data and repository indexes described here are fixed in `packages/protocol` and checked by tests. The server runs plugins in their sandbox with the whole host API but `plugins.call` (calls between plugins come with repositories). Playpex TV draws your screens and contributions (tv.md); the dashboard installs packages, edits your settings, grants your personal permissions per profile, links accounts and shows what your plugin does (its page's Activity: requests per host, calls, CPU time, jobs, its log lines). An update asking for more permissions than the installed version installs only once the admin accepts them; the version an update replaced can be put back. Still to come: repositories (P4b). **The example plugin [`plugins/hello`](../../plugins/hello)** uses every template, slot, effect and kind of setting.

**Trying a plugin today**: set `plugins.developerMode` to `true` in the server's `settings.json`, put your plugin folder (manifest, `server.js`, `assets/`, `i18n/`) in `<config dir>/plugins-dev/<id>/` (Linux `~/.config/Playpex/plugins-dev/`), restart the server; the log says whether it loaded and why not. Your section shows in Playpex TV's menu, your settings on the dashboard's Plugins page; call a data handler by hand with `POST /api/v1/plugins/<id>/data/<name>` ([client guide](../api/plugins.md)). Copying `plugins/hello` there is the quickest start. For the parts not built yet, this guide is what a plugin will be written against, and what those steps must keep.

Playpex is an educational project; streaming copyrighted content via torrents may be illegal where you live. Plugins inherit that framing.

## What a plugin is

A **package** `<id>-<version>.ppx`: a zip with

```
playpex-plugin.json      the manifest: who you are, what you add, what you need (manifest.md)
server.js                your code, one bundled file, run in a sandbox on the server (server.md)
assets/                  icons, images, screenshots, served at /api/v1/plugins/<id>/assets/*
i18n/<locale>.json       optional: translations ("@key" strings; en required when any is used)
CHANGELOG.md             optional: shown by the dashboard on install and update
signature                optional: { "key": "ed25519:…", "signature": "<base64>" } over the files' hashes (below)
```

## Packing, signing, publishing

```sh
npm run pack:plugin -- path/to/my-plugin                    # → my-plugin-1.0.0.ppx (manifest checked first)
npm run pack:plugin -- --keygen ~/my-publisher-key.json     # once: a key pair; keep the file private, publish the public key
npm run pack:plugin -- path/to/my-plugin --key ~/my-publisher-key.json   # signed
```

The package keeps only `playpex-plugin.json`, `server.js`, `assets/`, `i18n/*.json`, `CHANGELOG.md`, `README.md` and a `LICENSE`. A `signature` signs the text made of one line per other file, sorted by path, `<sha256 hex>  <path>\n` (`packageDigest` / `signPackage` in `@playpex/protocol/signing`).

How a server gets it (Plugins › Install plugin on its dashboard; the admin sees your name, version, changelog and what the plugin may do, in words, before it installs):

- **Upload** the `.ppx` (or a `.zip` of the same files).
- **A link**: to the `.ppx` itself, or to your **GitHub repository or release page** (`https://github.com/you/repo`, `…/releases/latest`, `…/releases/tag/v1.0.0`): the server takes the release's `.ppx` (else `.zip`) asset, else its source zip, and finds `playpex-plugin.json` at the root or in one sub folder. Attach the `.ppx` to each release: a source zip only works when `server.js` is committed bundled.
- **Trust**: a package signed by a key the admin trusts (Plugins › Trust › Trusted publisher keys) installs anytime; an unsigned one only while the server is in developer mode. Put your public key in your README.
- An update is installed the same way (the dashboard says "Update"); the version it replaces is kept, and comes back by itself if the new one doesn't start.

Later (plugins plan step P4b) you can also publish in a **repository** (a signed index on any HTTPS host, [repositories.md](repositories.md)) that the admin adds once, with updates offered automatically.

**Setup is the dashboard's, content is the clients'.** Everything about your plugin's life (install, updates, permissions, settings, which profiles use it, linked accounts, its activity) happens on the server's dashboard, rendered from your manifest. Clients have no plugin settings or prompts: they only show what you contribute to the current profile.

There is **no TV code** in a plugin. Your screens and contributions are data (the manifest names them, your `server.js` fills them in), and Playpex TV draws them with its own templates and primitives (tv.md). So every client gets your plugin, it looks and moves like the rest of the app, and it can't reach the device's token or the TV's shell.

## What a plugin can do

| | How | Guide |
|---|---|---|
| A section in the menu, its own screens | `contributes.sections` / `screens` on the templates `catalog`, `title`, `releases`, `list` | [tv.md](tv.md) |
| Rows, action tiles, meta, search filters on core screens | `contributes.slots` | [tv.md](tv.md) |
| More sources for Play (torrents, HTTPS streams), reorder or hide them, confirm before playing | hooks `play.collect`, `play.rank`, `play.before` | [server.md](server.md#hooks) |
| Release lists, subtitles, more information on titles, intro / credits markers in the player | hooks `releases.providers`, `subtitles.providers`, `metadata.title`, `player.markers` | [server.md](server.md#hooks) |
| React to what happens (scrobble, notify) | events `playback`, `downloads`, `library`, `watchlist` | [server.md](server.md#events) |
| Work in the background | `schedule.every` | [server.md](server.md#schedules) |
| Change the user's watch list, watched marks, ratings, add downloads | write scopes | [server.md](server.md#writes) |
| Play torrents through a debrid service ("Cached on Real-Debrid") | hook `play.resolve` | [server.md](server.md#hooks) |
| Recognise library files the core can't (anime numbering, a site's naming) | hook `library.match`, chosen per folder by the admin | [server.md](server.md#hooks) |
| Tell people something ("Downloaded: …") | `notify.send` | [server.md](server.md#notifications) |
| Work with other plugins | `requires`, `exports` | [manifest.md](manifest.md#dependencies) |
| Link an account (Trakt, a debrid service) | `link`: a device code, or your own `custom` flow; the admin links from the dashboard | [server.md](server.md#account-linking) |
| Options (rendered by the dashboard) | `contributes.settings` | [manifest.md](manifest.md#settings) |
| Be found and updated | a repository | [repositories.md](repositories.md) |

What it can't: read files, start processes, reach this machine or the LAN, see tokens or other plugins' data, run code in the TV, change the core's own sources (only add, reorder, hide with a reason), show anything to kids profiles when it's an `adults` plugin. [security.md](security.md) lists the rules and why.

## Where the contract lives

| What | File |
|---|---|
| Manifest schema | `packages/protocol/plugin.schema.json` (point `$schema` at it for editor completion) |
| Run-time shapes: hook input / output, `Source`, `Marker`, effects, events, template and slot data, notifications, link answers | `packages/protocol/plugin-api.schema.json` |
| Repository index | `packages/protocol/repository.schema.json`; signatures `packages/protocol/signing.js` |
| Constants (`SERVER_PLUGIN_API`, hooks, events, limits), `checkManifest`, `describePermissions`, `hostAllowed`, `satisfiesVersion` | `packages/protocol/plugins.js` (types `plugins.d.ts`) |
| Tests | `apps/server/test/plugins.contract.test.js` |
| Reference manifests | `plugins/adult/playpex-plugin.json` (18+), `plugins/trakt/playpex-plugin.json` (Trakt) |

A manifest is valid when it passes the schema **and** `checkManifest` (the rules between fields: a hook needs its permission, an `http` source a declared host, a link its secrets…). The server runs both at install.

## Versions

`api.server` is a range of `SERVER_PLUGIN_API` (1): the host API, hooks, events. `api.nav` / `api.ui` are ranges of the TV's `NAV_API_VERSION` / `UI_API_VERSION`: the templates and effects. A breaking change bumps a version; adding a hook, an event, an optional field or a template field doesn't. Ranges: `1`, `^1`, `1.x`, `>=1`, `>=1 <3`, `*`.

## The core's own extension API

`docs/tv-plugins.md` describes `defineScreen` / `defineContribution`, the compiled-in Angular API the core's features and the templates use. It is **not** this API: packaged plugins never ship Angular code.
