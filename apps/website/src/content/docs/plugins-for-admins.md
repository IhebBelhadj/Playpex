---
title: "Plugins on your server"
description: "Install, set up and update plugins from the dashboard, and add repositories."
group: Using Playpex
order: 10
---

Plugins add to your server: films to play, live TV, your Trakt history, subtitles and more. Only the admin installs and sets them up, on the dashboard; every screen then shows what they add. Browse them on the [plugins page](/plugins).

## Installing

Open **Plugins**:

- **Browse** lists the plugins of every repository you have. The official Playpex repository is built in.
- **Install plugin** takes a `.ppx` file, a link to one, or a GitHub repository or release.

Before installing, the dashboard shows what the plugin may do, in words: the sites it talks to, what it reads and what it may change. Plugins that need others install them in the same step.

## A plugin's page

Each installed plugin has its own page:

- **Overview** and **Permissions**: what it is and what it may do.
- **Settings**: its options, server-wide or per profile.
- **Profiles**: which profiles it reaches, and which may let it see what they watch or change their lists.
- **Accounts**: link an account, such as your Trakt account, with a code you enter on the service's site.
- **Activity**: its requests, jobs and log lines.
- **Versions**: install an older version, and **Clear data**.

## Repositories

**Plugins › Repositories › Add** takes a repository's address (its `index.json`). The dashboard shows the repository's key; once you trust it, an index signed by another key is refused until you accept it.

Updates follow a policy: install automatically, notify, or never, for the server and per plugin. An update asking for more permissions always waits for your consent.

## Developer mode

**Developer** lets you load plugins from the server's `plugins-dev` folder and install unsigned packages. Use it to write your own: see [Plugins for developers](plugins-overview).
