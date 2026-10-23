'use strict';

// Constants of the Playpex protocol, shared by the server and every client
// (docs/server-separation-plan.md §6). The HTTP API itself is described in
// openapi.yaml; its TypeScript types are generated into types/api.d.ts.
// CommonJS with no dependencies, so the server, Electron and Angular can all load it.

// Bumped only on breaking API changes. Clients may send
// `X-Playpex-Client: <name>/<version>; api=<n>`; the server answers 426 when
// it can't serve that version (CLIENT_TOO_OLD / SERVER_TOO_OLD).
var API_VERSION = 1;
var MIN_API_VERSION = 1;

var API_PREFIX = '/api/v1';
var CLIENT_HEADER = 'X-Playpex-Client';

// Which device a request comes from, for clients that aren't paired (local
// ones on the server machine): a paired device is the one its token names.
// Media elements, which can't set headers, use `?device=<id>`. The server
// falls back to the client's address.
var DEVICE_HEADER = 'X-Playpex-Device';
var DEVICE_PARAM = 'device';

// Pairing and auth (plan §6.3): RFC 8628 device flow under /api/v1/auth, then
// `Authorization: Bearer <token>` on every request (`?access_token=` for media
// elements that can't set headers)
var AUTH = {
  DEVICE_CODE_PATH: '/auth/device/code',
  DEVICE_TOKEN_PATH: '/auth/device/token',
  DEVICE_GRANT_TYPE: 'urn:ietf:params:oauth:grant-type:device_code',
  TOKEN_PARAM: 'access_token'
};

// Fixed ports (plan §5.9); the HTTP one can be changed in the server settings
var DEFAULT_PORT = 28470;
var DISCOVERY_PORT = 28471;

// Finding servers on the LAN (plan §5.7). A server with LAN sharing on answers
// both ways; clients use both and merge what they find by `id`, then confirm
// with GET /api/v1/server on the address found (the server's id is the key,
// never its address: DHCP and port changes don't break a paired client).
//   mDNS / DNS-SD: service type `_playpex._tcp.local`, SRV → the HTTP port in
//     use, TXT `id` (server id), `v` (apiVersion), `ver` (server version),
//     `name` (the full server name; the instance name may be shortened)
//   UDP: send the datagram QUERY to DISCOVERY_PORT (broadcast, or unicast to
//     one address); each server answers the sender with one JSON datagram
//     { id, name, port, apiVersion, minApiVersion, version }
var DISCOVERY = {
  MDNS_TYPE: 'playpex',                  // bonjour-style name of `_playpex._tcp`
  MDNS_SERVICE: '_playpex._tcp.local',
  UDP_PORT: DISCOVERY_PORT,
  QUERY: 'PLAYPEX_DISCOVER 1',
  INTERVAL_MS: 5000                      // how often a client asks again while it looks
};

// Media refs (media-server plan §3): the id the media routes (/media/{ref})
// take, `t_<infoHash>_<16 hex>` for a file of a torrent, `f_<uuid>` for a file
// on disk. Opaque to clients: they get refs from the server, never build them.
var MEDIA_REF_PATTERN = '^(t_[0-9a-f]{40}_[0-9a-f]{16}|f_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';

// Every error answer is { error: <message for people>, code: <one of these> }
var ERROR_CODES = {
  INVALID: 400,                  // bad parameters or body
  DEVICE_REQUIRED: 400,          // the route needs to know the calling device (X-Playpex-Device / ?device=)
  PAIRING_REQUIRED: 401,         // no valid device token: pair (POST /auth/device/code)
  ADMIN_REQUIRED: 401,           // an admin route without the admin's session
  FORBIDDEN: 403,                // e.g. wrong profile PIN
  HOST_NOT_ALLOWED: 403,         // Host header isn't this server (DNS rebinding defence)
  ORIGIN_NOT_ALLOWED: 403,       // state-changing request from a web origin that isn't allowed
  NOT_FOUND: 404,
  CONFLICT: 409,
  CLIENT_TOO_OLD: 426,
  SERVER_TOO_OLD: 426,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
  NOT_SUPPORTED: 501,            // this server's host can't do it (desktop-only routes on a headless server)
  UPSTREAM: 502,                 // a provider (YTS, EZTV, TMDB, a subtitle site…) failed
  PROBE_FAILED: 502,             // ffprobe couldn't read the file
  BUSY: 503,                     // a server limit is reached (torrents, transcodes); try again later
  PROVIDER_NOT_CONFIGURED: 503,  // the provider needs an API key the server doesn't have
  TRANSCODER_UNAVAILABLE: 503    // ffmpeg / ffprobe not found
};

// Parses `<name>/<version>; api=<n>` → { name, version, api } (api null when absent)
function parseClientHeader(value) {
  if (!value) {
    return null;
  }
  var parts = String(value).split(';'),
    product = parts[0].trim().split('/'),
    api = null;
  parts.slice(1).forEach(function (p) {
    var m = /^\s*api\s*=\s*(\d+)\s*$/.exec(p);
    if (m) {
      api = parseInt(m[1], 10);
    }
  });
  return { name: product[0] || '', version: product[1] || '', api: api };
}

function clientHeader(name, version) {
  return name + '/' + version + '; api=' + API_VERSION;
}

// User settings registry (settings.js): keys, scopes, defaults, validation
var settings = require('./settings');

module.exports = {
  SETTINGS: settings.SETTINGS,
  API_VERSION: API_VERSION,
  MIN_API_VERSION: MIN_API_VERSION,
  API_PREFIX: API_PREFIX,
  CLIENT_HEADER: CLIENT_HEADER,
  DEVICE_HEADER: DEVICE_HEADER,
  DEVICE_PARAM: DEVICE_PARAM,
  AUTH: AUTH,
  DEFAULT_PORT: DEFAULT_PORT,
  DISCOVERY_PORT: DISCOVERY_PORT,
  DISCOVERY: DISCOVERY,
  MEDIA_REF_PATTERN: MEDIA_REF_PATTERN,
  ERROR_CODES: ERROR_CODES,
  parseClientHeader: parseClientHeader,
  clientHeader: clientHeader
};
