---
title: "Connect a screen"
description: "Find your server from Playpex TV, Playpex Mobile, Server Manager or a browser, and pair it once."
group: Get started
order: 4
---

Every screen finds your server on the Wi-Fi by itself. A screen on the server's own computer connects at once; any other screen is **paired** once, with a code you approve on the dashboard.

## Playpex TV

1. Open Playpex TV. On its first start it asks how big Playpex should look on your screen.
2. It lists the servers on your network. Pick yours, or choose **Enter address** and type `playpex.local:28470` or the server's address.
3. The TV shows a code. On the dashboard, open **Devices** (or the `/link` page) and approve it. The tray app shows the request too.

The TV remembers the server and finds it again if its address changes. To switch servers later, open **Server** in the TV's menu.

## Playpex Mobile

Open the app and choose your server under **On this network**, or type its address. Approve the code on the dashboard the same way. To switch later, open **Profiles** and press **Change server**.

## Server Manager

Server Manager lists the servers on your Wi-Fi; nobody types an address. Pick one and sign in as its admin: the whole dashboard opens on your phone, with the remote for every screen.

## A browser

Any browser on your network opens the dashboard at `http://playpex.local:28470`. Signing in as the admin gives you the library, the player, downloads and settings.

## When a screen can't find the server

- Both must be on the same network. Guest Wi-Fi networks often keep devices apart.
- The server must share on the network: dashboard **Settings › Network**.
- Type the address by hand: `playpex.local:28470`, or the computer's IP address with `:28470`.
- See [Troubleshooting](troubleshooting) for more.

A screen whose pairing you revoke on the **Devices** page is sent back to the server list.
