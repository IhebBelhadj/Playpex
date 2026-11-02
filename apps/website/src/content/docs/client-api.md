---
title: "Client API"
description: "Build your own Playpex client: discovery, pairing, the catalog, playback and events."
group: Build clients
order: 1
---

Every Playpex app is a client of the server's versioned HTTP API, at `/api/v1`. You can write your own the same way.

## What a client does

1. **Finds the server** on the network, by mDNS (`_playpex._tcp`) or a UDP broadcast on port 28471, or by a typed address.
2. **Pairs** with the device flow: it asks for a code, shows it, and polls until the admin approves it on the dashboard. Then it sends `Authorization: Bearer <token>` with every request. A client on the server's own computer needs no pairing.
3. **Browses** the catalog (`/catalog/*`) and the library (`/library/*`), always as a profile.
4. **Plays**: `POST /play/sources` ranks every way to play a title; a file streams from `/media/{ref}` with HTTP range requests.
5. **Listens** to events on the WebSocket `/api/v1/events`.

## The full guide

Every server serves the client guide at `/docs` and the API reference at `/docs/reference`, rendered from the OpenAPI description (`packages/protocol/openapi.yaml` in the source code). The same guide is in the source code's `docs/api` folder:

- discovery and pairing;
- requests, errors and versions;
- profiles, the catalog and search;
- playback, tracks and subtitles;
- events, remote control and live TV;
- plugins, for clients that draw plugin screens.
