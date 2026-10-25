# Publishing: repositories

How plugins reach a server (docs/plugins-plan.md §6.1–6.4, borrowed from Kodi's repositories, with signatures Kodi doesn't have). Schema: `packages/protocol/repository.schema.json`; signatures: `packages/protocol/signing.js`.

## A repository

Any HTTPS host serving two files and your packages:

```
https://plugins.example.org/index.json        the index (below)
https://plugins.example.org/index.json.sig    base64 ed25519 signature of index.json's exact bytes
https://plugins.example.org/trakt-1.2.0.ppx   the packages the index lists
```

```jsonc
{
  "format": 1,
  "repository": { "id": "example", "name": "Example plugins", "key": "ed25519:…", "homepage": "https://…" },
  "generatedAt": "2026-10-23T10:00:00Z",
  "plugins": [{
    "id": "trakt", "name": "Trakt", "publisher": { "name": "Example" },
    "icon": "https://plugins.example.org/trakt.svg",
    "listing": { "summary": "…", "categories": ["tracking"], "screenshots": ["https://…/shot.jpg"] },
    "versions": [{                                          // newest first
      "version": "1.2.0", "url": "https://plugins.example.org/trakt-1.2.0.ppx",
      "sha256": "<hex of the .ppx>", "size": 48213, "releasedAt": "2026-10-20",
      "api": { "server": "^1" }, "audience": "everyone",
      "permissions": { … }, "requires": [ … ],              // copied from the manifest: shown before downloading
      "lifecycle": "stable", "changelog": "…"
    }]
  }]
}
```

- **Building one**: `npm run pack:repository -- <plugin folder>… --out <folder> --key <key file> --id <id> --name "<name>" --base-url https://<host>/<path>/` packs each plugin (`<id>-<version>.ppx`, its icon beside it), adds or replaces that version in the folder's `index.json` (the versions already there stay listed), checks it against the schema and signs it (`index.json.sig`). The key file comes from `npm run pack:plugin -- --keygen <file>`; keep using the same one, servers pinned it. `--sign-packages` also signs each package with that key, so its `.ppx` installs by upload on a server that trusts the key (Plugins › trusted publisher keys) without the repository. Then serve the folder at the base URL; admins add `<base URL>index.json`.
- **Signing** (what the tool does): `signing.generate()` once (keep the private key offline), then `signing.sign(bytes, privateKey)` on every new `index.json` → `index.json.sig`. The public key goes in `repository.key`.
- **Adults plugins** (`audience: adults`) go in a repository of their own: the official Playpex repository never carries one (servers leave such an entry out of its index and refuse its package). The 18+ section is such a plugin (`plugins/velvet`).
- The index is the signature of everything it lists: the server checks the index's signature with the key it pinned, then each package's `sha256`. Packages don't need their own `signature`.
- **Lifecycle** per version: `stable` (default), `deprecated` (+ `replacedBy`: the dashboard offers to switch, copying settings to a plugin that lists it in `migratesFrom`), `broken` (+ `reason`: installed copies are disabled until a fixed version appears).
- Keep older versions listed: the admin can roll back to them.

## On the server (the dashboard, admin only)

- **Plugins › Repositories › Add**: paste the index URL; the dashboard shows the repository's name and **key fingerprint** (`signing.fingerprint`), and the admin trusts it. The key is pinned: an index signed by another key is refused until the admin accepts the new one, with a warning. Or ship a **repository package** (`"type": "repository"` manifest, [manifest.md](manifest.md)): installing it adds the repository.
- The **official Playpex repository** is built in: `https://ihebbelhadj.github.io/playpex-official/index.json`, key fingerprint `1440 8b9d b5d7 cf14 eac7 2c7b c4ea 0738` (`apps/server/lib/plugins/official.js`); its first plugin is Trakt. Admins can turn it off, never edit or remove it. It **never carries an `audience: adults` plugin**: such an entry is left out of its index, and a package from it whose manifest says adults is refused at install. An adults plugin is published in a repository of its own, which admins add deliberately.
- Indexes are refreshed every 24 h, on "Check now", and 5 min after start (with `If-None-Match`: serve an `ETag`); a repository that fails keeps its last good index (shown stale). Redirects to other hosts are fine (a GitHub release asset), always HTTPS to public addresses; indexes up to 4 MB, packages up to 20 MB.
- **Browse** lists the plugins of every enabled repository; installing shows the listing, the permissions in words and the dependencies (`requires`: from the same repository first, then the others; optional ones offered), all accepted at once.
- **Origin pinning**: a plugin updates only from the repository it was installed from; the same id elsewhere is ignored unless the admin moves it (the preview says so and installing asks for consent).
- **Updates**: policy `auto` (default) · `notify` · `never`, server-wide (`plugins.updates`) and per plugin. `auto` installs only updates whose package asks for **no new permissions**; the others wait in Updates as "needs consent".
- **Lifecycle**: a version marked `broken` switches the installed plugin off (and plugins requiring it) until a fixed version installs; `deprecated` + `replacedBy` shows the replacement, and a plugin listing the old one in `migratesFrom` takes its settings on its first install.
- **Any listed version** can be installed (Versions on the plugin's page, or Browse), its permissions shown first.
