'use strict';

// What a client and a server on the same machine both know: where the server
// keeps its state (the per-OS config dir) and the record the desktop server
// leaves there so a client can start it (docs/server-separation-plan.md §11,
// step 9: "the TV app finds an installed but stopped server and starts it").
//
//   const local = require('@playpex/protocol/local')
//   local.configDir()           ~/.config/Playpex, ~/Library/Application Support/Playpex, %APPDATA%\Playpex
//   local.readDesktopApp()      → { executable, appImage, version, platform, updatedAt } | null
//   local.writeDesktopApp(rec)  (the desktop server, on every start)
//   local.configuredPort()      general.port from settings.json, else DEFAULT_PORT
//
// Node only (fs, os, path): not exported by index.js, which browsers load too.

var fs = require('fs'),
  os = require('os'),
  path = require('path'),
  DEFAULT_PORT = require('./index').DEFAULT_PORT;

var APP_NAME = 'Playpex';
var DESKTOP_APP_FILE = 'desktop-app.json';

// Same rules as the server's lib/paths.js, which uses this
function configDir() {
  if (process.env.PLAYPEX_CONFIG_DIR) {
    return process.env.PLAYPEX_CONFIG_DIR;
  }
  var home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readDesktopApp() {
  var record = readJson(path.join(configDir(), DESKTOP_APP_FILE));
  return record && typeof record.executable === 'string' ? record : null;
}

function writeDesktopApp(record) {
  var dir = configDir(),
    file = path.join(dir, DESKTOP_APP_FILE),
    tmp = file + '.tmp';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, record, { updatedAt: new Date().toISOString() }), null, 2));
  fs.renameSync(tmp, file);
}

// The port the local server listens on, as far as its settings file says
// (environment overrides of the server's own process can't be seen from here)
function configuredPort() {
  var settings = readJson(path.join(configDir(), 'settings.json')),
    port = settings && settings.general && Number(settings.general.port);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

module.exports = {
  DESKTOP_APP_FILE: DESKTOP_APP_FILE,
  configDir: configDir,
  readDesktopApp: readDesktopApp,
  writeDesktopApp: writeDesktopApp,
  configuredPort: configuredPort
};
