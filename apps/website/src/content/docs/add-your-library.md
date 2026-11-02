---
title: "Add your library"
description: "Point the server at your folders; every file is matched to its title, poster and story."
group: Get started
order: 3
---

The library is what's on your server: the films and series in the folders you give it, plus your downloads.

## Add a folder

On the dashboard, open **Library** and press **Add folder**. Choose the folder and what it holds:

| Kind | Use it for |
|---|---|
| Movies | One film per file or folder. |
| Shows | Series, as `Show/Season 01/Show S01E01.mkv` or similar. |
| Mixed | A folder with both. |
| Other | Videos that should never be matched to a title. |

The server scans the folder at once and again when files change. Your folders stay as they are: nothing is moved, renamed or deleted.

## How files are matched

Each file's name is read for its title, year, season and episode, then matched to The Movie Database (TMDB) for its poster, story, cast and ratings. Names like these match well:

```
Sintel (2010).mkv
The General (1926)/The General.mp4
Breaking Bad/Season 01/Breaking Bad S01E01.mkv
```

## Fixing a match

Files the server couldn't match, or matched to the wrong title, are in **Library › To fix**. Pick the right title and the server remembers it; your own match always wins over the automatic one.

## Folders on other computers

A folder on a NAS or another computer works when your system has mounted it as a folder. Offline shares are never purged from the library: their titles come back when the share does.

## Where the library shows

- Playpex TV and Playpex Mobile have a **Library** section, newest first, and mark titles that are "On this server".
- When you press Play on a title that's in your library, its file plays first.
- The dashboard's **Library** shows every title as posters, A to Z or newest first, and each folder as a file browser.
