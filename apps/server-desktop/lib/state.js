'use strict';

// The desktop app's own settings, next to the server's: <config>/desktop.json
// (Linux ~/.config/Playpex/desktop.json, see @playpex/server/lib/paths.js).
//   openAtLogin       null until the first packaged launch turns it on (plan §8.1)
//   checkForUpdates   look for updates at start and every 6 hours
//   setupShown        the dashboard's first-run setup was opened once

const fs = require('fs');
const path = require('path');
const paths = require('@playpex/server/lib/paths');

const FILE = path.join(paths.config, 'desktop.json');
const DEFAULTS = { openAtLogin: null, checkForUpdates: true, setupShown: false };

let data = null;

function load() {
  data = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    Object.keys(DEFAULTS).forEach(key => {
      if (typeof saved[key] === 'boolean') {
        data[key] = saved[key];
      }
    });
  } catch (e) {
    // first launch, or a broken file: the defaults
  }
  return data;
}

function get(key) {
  return (data || load())[key];
}

function set(patch) {
  data = Object.assign({}, data || load(), patch);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(FILE + '.tmp', FILE);
  return data;
}

module.exports = { FILE, load, get, set };
