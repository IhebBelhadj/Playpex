---
title: "Troubleshooting"
description: "Fixes for the problems people meet most: finding the server, sound, ports and playback."
group: Using Playpex
order: 11
---

## A screen can't find the server

- Check that the screen and the server are on the same network, and not on a guest Wi-Fi.
- Make sure the server shares on the network: dashboard **Settings › Network**.
- Discovery uses mDNS and UDP port 28471. If your router blocks them, type the address instead: `playpex.local:28470`, or the server's IP address with `:28470`.
- A firewall on the server's computer must let port 28470 in.

## "Lost connection" on the TV

The TV tried three times and couldn't reach the server. Press **Retry**, or **Choose server** if the server moved. If its pairing was revoked on the dashboard, the TV goes back to the server list: pair it again.

## A film plays without sound

The film's sound is Dolby, DTS or TrueHD, which Playpex TV and browsers can't play. The server converts it to AAC when it has ffmpeg: the desktop server's installers include it. On a headless server, install ffmpeg or set its path in **Settings**.

## The server won't start: port 28470 is taken

Another program uses the port. The server starts in recovery mode, with only the dashboard on a free port printed in its log. Change the port there, or from a terminal with `playpex-server set-port <port>`, then restart.

## A file doesn't play

- `.avi` files with XviD video don't play on Playpex TV. Playpex Mobile plays them.
- A torrent with no peers can't start. The source picker shows each torrent's seeds.

## A title has the wrong poster

The file was matched to another title. Fix it in **Library › To fix**, or from the title in the library. See [Add your library](add-your-library).

## Where the logs are

The dashboard's **Logs** page shows them live. On disk, Linux keeps them in `~/.local/state/Playpex/logs`.
