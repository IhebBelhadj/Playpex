---
title: "Install the server"
description: "Install Playpex Media Server, run its first-time setup and open its dashboard."
group: Get started
order: 2
---

Playpex Media Server runs on the computer that keeps your films. It can run with a small window-less app in the system tray, or headless on a machine without a screen.

## Download and install

Get the installer for your system from the [download page](/#download) or the releases on GitHub:

| System | File | How |
|---|---|---|
| Windows | `.exe` | Installs for your user only. Windows may ask you to confirm the first time. |
| macOS | `.dmg` | Drag Playpex Media Server to Applications. |
| Linux | `.AppImage` or `.deb` | Make the AppImage executable and open it, or install the `.deb`. |

Once installed, the server starts with a Playpex icon in the tray. From there you can open the dashboard, approve new screens, pause downloads, restart it and choose to start it when you log in.

## First-time setup

Open the dashboard at `http://localhost:28470` on the server's computer. The first visit runs the setup:

1. **The admin account**: the user name and password you sign in with. Only the admin runs the dashboard.
2. **The server's name**: what screens show when they find it, such as "Living room".
3. **The download folder**: where downloads are kept.
4. **Sharing on your network**: on by default, so other screens on your Wi-Fi can reach the server. They must be paired first.

## The dashboard

The dashboard is the server's control room, in any browser on your network at `http://playpex.local:28470` (or the computer's address). It has:

- **Overview**: what's running, problems first.
- **Library**, **Search** and **Downloads**.
- **Activity**: what every screen is playing, with Pause and Stop.
- **Devices**, **Remote control** and **Profiles**.
- **Plugins**, **Settings**, **Logs** and **About**.

## Running it headless

On a machine without a desktop, run the server from a terminal. It listens on port 28470 on every network interface, and the dashboard works the same way.

```sh
playpex-server                      # start it
playpex-server admin set <name>     # create or reset the admin
playpex-server set-port <port>      # when another program holds 28470
```

If another program already uses port 28470, the server starts in **recovery mode**: only the dashboard, on a free port printed in the log, so you can change its port.
