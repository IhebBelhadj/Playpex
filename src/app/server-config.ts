// Base URL of the local streaming server (src/server/streamingServer).
// It listens on 9000, or the next free port when 9000 is taken; Electron
// passes the port it actually got as ?streamer=<port> (see src/electron.js).
const params = new URLSearchParams(window.location.search);
const port = params.get('streamer') || '9000';

// Drop the parameter before Angular boots (this module loads first): the router
// only strips a trailing index.html from file:// URLs and would match nothing
if (params.has('streamer')) {
  history.replaceState(null, '', window.location.pathname);
}

export const STREAMING_SERVER = `http://localhost:${port}`;
