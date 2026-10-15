'use strict';

// Where the server keeps its files. Never inside the app itself: a packaged app
// is read-only (app.asar, /Applications, Program Files).
//
//   config  small state (torrents.json, optional config.json)
//     Linux   $XDG_CONFIG_HOME/Playpex  (~/.config/Playpex)
//     macOS   ~/Library/Application Support/Playpex
//     Windows %APPDATA%\Playpex
//   cache   downloads (multi-GB, deleted when the player is left) in
//           torrent_data/, and torrent-stream's metadata cache (torrent-stream/)
//     Linux   $XDG_CACHE_HOME/Playpex   (~/.cache/Playpex; not /tmp, which is often RAM)
//     macOS   ~/Library/Caches/Playpex
//     Windows %LOCALAPPDATA%\Playpex\Cache
//
// Overrides: PLAYPEX_CONFIG_DIR, PLAYPEX_CACHE_DIR.

var os = require('os');
var path = require('path');

var APP_NAME = 'Playpex';
var home = os.homedir();

function configDir() {
  if (process.env.PLAYPEX_CONFIG_DIR) {
    return process.env.PLAYPEX_CONFIG_DIR;
  }
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  }
}

function cacheDir() {
  if (process.env.PLAYPEX_CACHE_DIR) {
    return process.env.PLAYPEX_CACHE_DIR;
  }
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME, 'Cache');
    case 'darwin':
      return path.join(home, 'Library', 'Caches', APP_NAME);
    default:
      return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), APP_NAME);
  }
}

var config = configDir();
var cache = cacheDir();

module.exports = {
  config: config,
  cache: cache,
  downloads: path.join(cache, 'torrent_data')
};
