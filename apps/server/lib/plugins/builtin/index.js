'use strict';

// Plugin code the server ships (docs/plugin-layer-plan.md §8): adapters that
// managed plugins run (./../managed: a Stremio add-on's plugin runs
// builtin/stremio/server.js). A plugin is **trusted** when it was made by a
// managed provider and its server.js is, byte for byte, one of these files:
// checked by SHA-256 at every load, so a copy changed on disk is refused.
// Trusted code may use core-only host calls (./corecalls.js); it stays
// sandboxed, with its own permissions and limits. It is trusted to report
// truthfully where things came from, never to reach more.
//
//   code(name) → { name, file, text, hash, options } | null
//   trusted(text) → the name of the shipped code it is, or null
//   options(name) → what the core lets that code do beyond core calls (<name>/builtin.json):
//     openStreams: its streams' further addresses (redirects, an HLS playlist's parts) may be any
//     public host (the Stremio bridge: a debrid link redirects to a host no answer named)
//   register(name, file, options) for tests (an adapter of their own)

var crypto = require('crypto'),
  fs = require('fs'),
  path = require('path');

var shipped = {};   // name → { name, file, text, hash }

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function register(name, file, options) {
  var text = fs.readFileSync(file, 'utf8');
  if (options === undefined) {
    try {
      options = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'builtin.json'), 'utf8'));
    } catch (e) {
      options = {};
    }
  }
  shipped[name] = { name: name, file: file, text: text, hash: sha256(text), options: { openStreams: !!(options && options.openStreams) } };
  return shipped[name];
}

// every <name>/server.js next to this file
fs.readdirSync(__dirname, { withFileTypes: true }).forEach(function (e) {
  var file = path.join(__dirname, e.name, 'server.js');
  if (e.isDirectory() && fs.existsSync(file)) {
    register(e.name, file);
  }
});

function code(name) {
  return shipped[name] || null;
}

function trusted(text) {
  var h = sha256(text);
  var found = Object.keys(shipped).filter(function (n) { return shipped[n].hash === h; })[0];
  return found || null;
}

function options(name) {
  return (shipped[name] && shipped[name].options) || { openStreams: false };
}

module.exports = {
  code: code,
  options: options,
  trusted: trusted,
  register: register,
  sha256: sha256
};
