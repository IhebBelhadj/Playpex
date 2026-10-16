// Which Playpex server this client talks to, resolved once before Angular
// boots (this module loads first). Use ServerService, not these constants.
//   ?streamer=<port>  Electron: the port of the server it started or found
//                     (see apps/tv/electron/main.js)
//   ?server=<url>     browser dev (`ng serve`): any server, remembered
//   localStorage['playpex.server'], else http://localhost:28470
// Switching servers = store the new one and reload, so every catalog and
// subscription starts clean (docs/server-separation-plan.md §10.2).
const DEFAULT_SERVER = 'http://localhost:28470';
const STORAGE_KEY = 'playpex.server';

const params = new URLSearchParams(window.location.search);

function stored():string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

function resolve():string {
  if (params.get('streamer')) {
    return `http://localhost:${params.get('streamer')}`;
  }
  const server = params.get('server');
  if (server) {
    try {
      localStorage.setItem(STORAGE_KEY, server);
    } catch (e) { /* not remembered */ }
    return server;
  }
  return stored() || DEFAULT_SERVER;
}

// Drop the parameters before Angular boots: the router only strips a trailing
// index.html from file:// URLs and would match nothing
if (params.has('streamer') || params.has('server')) {
  history.replaceState(null, '', window.location.pathname);
}

/** Origin of the server, e.g. http://localhost:28470 (no trailing slash) */
export const SERVER_URL = resolve().replace(/\/+$/, '');

/** Every API route lives under it (@playpex/protocol API_PREFIX) */
export const API_PREFIX = '/api/v1';
