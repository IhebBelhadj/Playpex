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

- **Signing**: `signing.generate()` once (keep the private key offline), then `signing.sign(bytes, privateKey)` on every new `index.json` → `index.json.sig`. The public key goes in `repository.key`.
- The index is the signature of everything it lists: the server checks the index's signature with the key it pinned, then each package's `sha256`. Packages don't need their own `signature`.
- **Lifecycle** per version: `stable` (default), `deprecated` (+ `replacedBy`: the dashboard offers to switch, copying settings to a plugin that lists it in `migratesFrom`), `broken` (+ `reason`: installed copies are disabled until a fixed version appears).
- Keep older versions listed: the admin can roll back to them.

## On the server (the dashboard, admin only)

- **Plugins › Repositories › Add**: paste the index URL; the dashboard shows the repository's name and **key fingerprint** (`signing.fingerprint`), and the admin trusts it. The key is pinned: an index signed by another key is refused until the admin accepts the new one, with a warning. Or ship a **repository package** (`"type": "repository"` manifest, [manifest.md](manifest.md)): installing it adds the repository.
- The **official Playpex repository** is built in (its key ships with the server).
- Indexes are refreshed every 24 h, on "Check now", and 5 min after start; a repository that fails keeps its last good index (shown stale).
- **Browse** lists the plugins of every enabled repository; installing shows the listing, the permissions in words and the dependencies, all accepted at once.
- **Origin pinning**: a plugin updates only from the repository it was installed from; the same id elsewhere is ignored unless the admin moves it.
- **Updates**: policy `auto` (default) · `notify` · `never`, server-wide and per plugin. `auto` installs only updates asking for **no new permissions**; the others wait in Updates as "needs consent".
