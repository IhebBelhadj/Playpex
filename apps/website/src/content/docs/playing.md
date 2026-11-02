---
title: "Playing"
description: "How Play chooses a source, resume, audio and subtitles, and what the server converts."
group: Using Playpex
order: 4
---

## Pressing Play

When you press Play, the server gathers every way it can play the title and ranks them:

1. **On this server**: a file in your library or a finished download. It plays at once when it's the only choice.
2. **Streams**: files that plugins offer, such as the Internet Archive's public-domain films.
3. **Torrents**: from the source plugins you installed.

With several choices you get the source picker: the best match first, with each source's quality, size and how soon it plays. The core finds no torrent itself: torrents and streams come only from the plugins you install.

## Resume

Every profile keeps the minute it stopped at, on any screen. A title you started shows **Resume** and **From the start**. In the last 40 seconds of an episode, the next one is ready.

## Audio and subtitles

The player's **Audio & subtitles** lists every audio track and subtitle in the file, the separate subtitle files beside it, and subtitles found online. A profile's settings choose the language played first.

Online subtitle providers: OpenSubtitles, YIFY Subtitles, and OpenSubtitles.com or Wyzie Subs when the server has their key. Subtitles have a size and a timing offset in the player.

## What the server converts

Playpex TV and the dashboard's player play AAC, Opus and MP3 sound. For films with Dolby (AC-3, E-AC-3), DTS or TrueHD sound, the server copies the video and converts the sound to AAC on the fly, so no film plays silent. This needs ffmpeg, which the desktop server's installers include.

Playpex Mobile decodes every format on the phone and needs no conversion.

## Torrents while they download

A torrent starts playing as soon as the beginning of the file is there, and only that file downloads. Leaving the player pauses it; the download is kept, never deleted unless you remove it, and pressing Play again resumes it.
