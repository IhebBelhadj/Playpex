'use strict';

// The web clients this server serves (docs/web-unified-plan.md): Playpex TV
// at /tv/, Playpex Mobile at /m/, and what /app/ opens on each kind of device
// (settings `clients.*`). Read by GET /api/v1/clients (no auth), the /app/
// page and the web clients' own routes in lib/api.js.

var fs = require('fs'),
  path = require('path'),
  settings = require('../settings');

var SERVER = path.join(__dirname, '..', '..');

var WEB = [
  { id: 'tv', name: 'Playpex TV', path: '/tv/', setting: 'clients.tvWeb',
    dir: function () { return process.env.PLAYPEX_TV_WEB_DIR || path.join(SERVER, 'public-tv'); },
    build: 'npm run build:tv-web' },
  { id: 'mobile', name: 'Playpex Mobile', path: '/m/', setting: 'clients.mobileWeb',
    dir: function () { return process.env.PLAYPEX_MOBILE_WEB_DIR || path.join(SERVER, 'public-m'); },
    build: 'npm run build:mobile-web' }
];

function byId(id) {
  return WEB.filter(function (c) { return c.id === id; })[0] || null;
}

function built(client) {
  return fs.existsSync(path.join(client.dir(), 'index.html'));
}

function enabled(client) {
  return settings.get(client.setting) !== false;
}

// GET /clients
function view() {
  return {
    web: WEB.map(function (c) {
      return { id: c.id, name: c.name, path: c.path, enabled: enabled(c), built: built(c) };
    }),
    open: { computers: settings.get('clients.computers'), tablets: settings.get('clients.tablets') }
  };
}

module.exports = { WEB: WEB, byId: byId, built: built, enabled: enabled, view: view };
