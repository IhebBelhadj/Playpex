---
title: "Publishing"
description: "Pack and sign your plugin, and publish it in a repository admins add once."
group: Build plugins
order: 8
---

## Pack

From the Playpex source code:

```sh
npm run pack:plugin -- path/to/my-plugin                 # → my-plugin-1.0.0.ppx, manifest checked first
npm run pack:plugin -- --keygen ~/my-publisher-key.json  # once: a key pair; keep the file private
npm run pack:plugin -- path/to/my-plugin --key ~/my-publisher-key.json   # signed
```

A package keeps only `playpex-plugin.json`, `server.js`, `assets/`, `i18n/*.json`, `CHANGELOG.md`, `README.md` and a `LICENSE`.

## How a server installs it

On the dashboard, **Plugins › Install plugin** takes:

- the `.ppx` file, uploaded;
- a link to the `.ppx`;
- a link to your **GitHub repository or release**: the server takes the release's `.ppx` asset. Attach it to every release.

A package signed by a key the admin trusts installs anytime; an unsigned one only in developer mode. Put your public key in your README.

## A repository

A repository is any HTTPS host serving a signed index and your packages:

```
https://plugins.example.org/index.json         the index
https://plugins.example.org/index.json.sig     its ed25519 signature
https://plugins.example.org/my-plugin-1.0.0.ppx
```

Build or update one with:

```sh
npm run pack:repository -- path/to/my-plugin --out ./repo --key ~/my-publisher-key.json \
  --id example --name "Example plugins" --base-url https://plugins.example.org/
```

It packs each plugin, adds the version to `index.json`, checks it and signs it. Serve the folder; admins add `https://plugins.example.org/index.json` in **Plugins › Repositories**. Keep using the same key: servers pinned it.

- Keep older versions listed, so admins can roll back.
- Mark a version `deprecated` (with `replacedBy`) or `broken` (with a `reason`): broken versions are switched off until a fixed one appears.
- Updates install automatically only when they ask for no new permissions; the others wait for the admin's consent.

## The official repository

Every server has the official Playpex repository built in: `https://ihebbelhadj.github.io/playpex-official/index.json`. It holds Trakt and Live TV (M3U).
