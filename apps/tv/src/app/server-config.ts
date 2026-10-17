// Which Playpex server this client talks to, resolved once before Angular
// boots (main.ts awaits `resolveServer()`). Use ServerService, not this module.
//   Electron: the shell resolves it (apps/tv/electron/connection.js: the last
//             server used, found again by id, or one on this machine) and
//             hands it over through window.playpex
//   browser dev (`ng serve`): ?server=<url> (remembered), else
//             localStorage['playpex.server'], else http://localhost:28470
// Switching servers = the shell stores the new one and reloads the app, so
// every catalog and subscription starts clean (docs/server-separation-plan.md §10.2).
import { ConnectionState, desktop } from './desktop';

const DEFAULT_SERVER = 'http://localhost:28470';
const STORAGE_KEY = 'playpex.server';
const DEVICE_KEY = 'playpex.deviceId';

/** Every API route lives under it (@playpex/protocol API_PREFIX) */
export const API_PREFIX = '/api/v1';

/** What the app was started with; `server` null → the /connect page */
export let connection:ConnectionState = null;

function stored(key:string):string | null {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function freshDeviceId():string {
  return 'tv-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

// ng serve: no shell, no pairing (loopback); the device id lives in localStorage
function browserConnection():ConnectionState {
  const params = new URLSearchParams(window.location.search);
  let url = params.get('server');
  if (url) {
    try {
      localStorage.setItem(STORAGE_KEY, url);
    } catch (e) { /* not remembered */ }
    // the router would match nothing with a query left on the URL
    history.replaceState(null, '', window.location.pathname);
  }
  url = (url || stored(STORAGE_KEY) || DEFAULT_SERVER).replace(/\/+$/, '');
  let deviceId = stored(DEVICE_KEY);
  if (!deviceId) {
    deviceId = freshDeviceId();
    try {
      localStorage.setItem(DEVICE_KEY, deviceId);
    } catch (e) { /* a new device per start */ }
  }
  let host = url;
  try {
    host = new URL(url).host;
  } catch (e) { /* shown as typed */ }
  return {
    server: { id: url, name: host, url, local: true },
    reason: null, detail: null, candidate: null,
    deviceId, deviceIdIsNew: false, tokenStorage: 'encrypted', version: '', platform: 'web'
  };
}

export function resolveServer():Promise<void> {
  const bridge = desktop();
  if (!bridge) {
    connection = browserConnection();
    return Promise.resolve();
  }
  return bridge.connection.current().then((state):Promise<void> => {
    connection = state;
    // First run since step 9: keep the id the app had in localStorage, so the
    // server's leases and device names stay the same
    if (!state.deviceIdIsNew) {
      return Promise.resolve();
    }
    return bridge.connection.adoptDeviceId(stored(DEVICE_KEY)).then(id => {
      connection = Object.assign({}, state, { deviceId: id, deviceIdIsNew: false });
    });
  });
}

/** Saves a server for the next start in the browser (ng serve) and reloads */
export function useBrowserServer(url:string) {
  try {
    localStorage.setItem(STORAGE_KEY, url.replace(/\/+$/, ''));
  } catch (e) { /* not remembered */ }
  window.location.reload();
}
