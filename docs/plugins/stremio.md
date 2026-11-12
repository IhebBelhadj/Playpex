# Stremio add-ons in Playpex

Playpex Media Server installs **Stremio add-ons** by their address. Each add-on becomes a plugin of its own: it has its own row on the dashboard's Plugins page, its permissions, its settings, its Profiles, Activity and updates. Every Playpex client shows what it adds; nothing changes in the clients. Plan and decisions: [`docs/stremio-bridge-plan.md`](../stremio-bridge-plan.md).

Playpex is an educational project; streaming copyrighted content you don't have the rights to may be illegal where you live. Playpex names no add-on and lists none: you choose which to add.

## For admins

### Adding one
1. Open **Plugins › Install a plugin › Stremio add-on**, or **Add a Stremio add-on** on the Overview's "Add sources to play from" notice.
2. Paste the add-on's manifest address: `https://…/manifest.json`, or `stremio://…`.
3. Playpex reads the add-on's manifest and shows what it adds:
   - Play sources for movies and episodes
   - subtitles
   - catalogs, each with where it will show
   - what Playpex can't use (another type of content, a catalog that needs something Playpex can't give, resources such as `addon_catalog` without lists)
   - the host it talks to
4. Install. The add-on is on for every profile, like any plugin. Hide it from a profile on its **Profiles** tab, or switch on **Treat as adults** there. An add-on that says it is for adults is `audience: adults`: it never reaches kids profiles.

**Configured add-ons.** Many add-ons (Torrentio and its copies, debrid services) have a configuration page that gives you an address holding your settings, sometimes a key. When the preview offers **Configure on <host>**, set the add-on up there, then paste the address it gives you. Playpex keeps that address as the plugin's secret, encrypted like other secrets. After install it is never shown again, never logged, and never sent to a client. Another configuration of the same add-on, such as a second debrid account, installs as another plugin.

**Importing your Stremio add-ons.** In the Stremio add-on tab, **Or import the add-ons of my Stremio account** signs in to your Stremio account once:
- Playpex reads which add-ons you installed there, then signs out before showing them. It keeps neither your password nor the session.
- Tick the ones you want. Stremio's own add-ons start unticked: Cinemeta repeats TMDB, and OpenSubtitles v3 is already built in. Add-ons that run on your computer, and those offering nothing Playpex uses, can't be ticked.
- Configured add-ons come with their configuration, kept as each plugin's secret.
- Stremio's account API isn't a documented public one. If it changes, importing stops working; adding add-ons by address doesn't.

**Add-ons an add-on lists.** Some add-ons recommend others (Stremio's `addon_catalog`: Cinemeta lists the community's). Their plugin page then shows **Add-ons it lists**, with nothing ticked. A listed add-on whose address holds a configuration is someone else's set-up, possibly with their key. It can't be ticked: add that add-on by its own address and configure it yourself.

**Changing the configuration.** On the plugin's **Versions** tab, use **Change configuration** and paste the new address from the same add-on. The plugin keeps its settings and data.

### Where its things show
| The add-on offers | In Playpex |
|---|---|
| `stream` for IMDb ids (`tt…`) | Play's chooser for movies and episodes. Torrents go in *Torrent*, ranked with every other source's by seeders (as the add-on says). Direct links (debrid, web files) and HLS go in *Stream*. Switch **Use for Play** off in its Settings to stop asking it. |
| `subtitles` | the player's subtitle providers: it is asked with the file's name, size and OpenSubtitles hash when the server has the file. **Use for subtitles** switches it off. |
| `catalog` | rows. **Settings › Catalogs** chooses each catalog's place: *Movies* or *TV shows* (rows after the section's own), *Its own section* (a menu entry with the add-on's name, with its search and genre filter), *Search only*, or *Hidden*. By default, movie and series catalogs go in Movies / TV shows, others (anime, channels) in its own section, and catalogs that only answer searches on the search page (a chip with the add-on's name). |
| `meta` for its own ids (`kitsu:…`, channels) | a title page: its description, its episodes or videos by season. A video plays with the streams of **every** bridged add-on that answers for that id, so a Kitsu episode plays from Torrentio. |

Titles with an IMDb id that TMDB knows open Playpex's own movie and show pages. The rest open the add-on's title page.

- **Up next.** The next episode plays from the same add-on and release style as the one you watched (Stremio's `bingeGroup`) when that add-on has it. A file on this server still comes first.
- **The dashboard's Search.** An add-on with a movie search catalog (Cinemeta) finds films by your keywords, and every bridged add-on's streams for the first three show in Search's stream results.

### What Playpex doesn't use
- `externalUrl` streams (they open a web page).
- Usenet streams (`nzbUrl`), and archives that can't be seeked (`7zipUrls`, `tgzUrls`). Videos in `rarUrls`, `zipUrls` and `tarUrls` play when they're stored (uncompressed), as scene releases are: the server reads the archive and streams the file. A compressed one fails when you play it.
- YouTube streams in Play. They do play from an add-on's own title pages.
- Types Playpex has no place for (`music`…).
- Streams over plain `http`.

Activity counts what was dropped.

### What it can and can't do
| | |
|---|---|
| It sees | this server's address and the titles asked for, nothing about profiles or devices |
| It reaches | nothing: Playpex asks it, never the other way. Its answers are checked and cut to size (2 MB an answer, 500 streams, 200 catalog items, 5000 videos) |
| Its streams | come from the hosts its answers name (learned for its streams only), and their redirects (a debrid link's CDN) go on to any **public** host. Every hop is checked: an address on your network or this machine is refused |
| Its pictures | go through the server's image proxy (`/plugins/{id}/images/{token}`); clients never contact its hosts |
| Its code | doesn't exist: an add-on is a web service. The code that reads it is Playpex's own (`apps/server/lib/plugins/builtin/stremio/server.js`), sandboxed like every plugin |

### Updates
Once a day Playpex reads the add-on's manifest again. **Versions › Check for updates** reads it now. A new version, or changed catalogs, builds a new plugin version. When it asks for more (a new hook, for adults), it waits for you like any plugin update. Answers are cached for as long as the add-on says (`cacheMaxAge`: an hour for Torrentio), and an earlier answer is used for a day when the add-on fails.

## For add-on authors: your add-on in Playpex

Nothing to do: Playpex speaks the [Stremio add-on protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). What helps Playpex use more of it:

- **Name the release.** Put `behaviorHints.filename` on every stream. Playpex reads quality, codec and audio from it, and whether its clients play the file as it is.
- **`fileIdx` on torrents**, so the server downloads only that file of a pack.
- **Seeders and size** in the text, as `👤 123` and `💾 1.5 GB`, or `behaviorHints.videoSize`. Playpex ranks torrents by them.
- **HTTPS** for every URL you answer: streams, subtitles, pictures. Plain `http` is dropped.
- **`cacheMaxAge`** on answers. Playpex keeps an answer that long (at most 6 hours for streams, a day for catalogs) and asks again with `staleRevalidate`.
- **`imdb_id` on metas** (also on videos: `imdb_id`, `imdbSeason`, `imdbEpisode`) when your ids aren't IMDb's. Playpex then opens its own pages for titles TMDB knows.
- **`bingeGroup`** on streams of one release style, so Up next keeps to it.
- **Archives stored, not compressed** (`rar -m0`, `zip -0`), with the parts in order and `fileIdx` or `fileMustInclude` when an archive holds several videos. Use https for every part.
- **Configuration in the path** as `key=value` pairs or one encoded segment. Playpex recognises those as a configuration and keeps the address secret. A plain path, such as `/my-addon/manifest.json`, is only where your add-on lives.
- **Catalogs with `extra`**: `skip` (paged rows; Playpex learns your page size from the first page), `genre` with its `options` (a filter), `search` (the search page). A required `extra` other than these makes the catalog unusable.
