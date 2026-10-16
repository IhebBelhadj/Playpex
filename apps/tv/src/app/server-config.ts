// Base URL of the local streaming server (apps/server).
// It listens on 28470 (its settings can change that); Electron passes the
// port actually in use as ?streamer=<port> (see apps/tv/electron/main.js).
const params = new URLSearchParams(window.location.search);
const port = params.get('streamer') || '28470';

// Drop the parameter before Angular boots (this module loads first): the router
// only strips a trailing index.html from file:// URLs and would match nothing
if (params.has('streamer')) {
  history.replaceState(null, '', window.location.pathname);
}

export const STREAMING_SERVER = `http://localhost:${port}`;
