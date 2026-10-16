'use strict';

// Updates (plan §8.1) with electron-updater, from GitHub Releases (the
// `publish` config in package.json). Found updates download in the
// background; they install when the user asks (tray, dashboard) or when the
// app quits, never by themselves during a stream.
//
//   updater.init({ onChange })     onChange(state) on every state change
//   updater.state()   { state, version, percent, checkedAt, error }
//     state: unsupported | idle | checking | none | available | downloading | downloaded | error
//   updater.check() / updater.schedule(on) / updater.install()

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;

let current = { state: 'unsupported', version: null, percent: null, checkedAt: null, error: null };
let autoUpdater = null;
let onChange = () => {};
let timers = [];

// A development run has no app-update.yml; on Linux only the AppImage and the
// .deb (resources/package-type, needs pkexec) can update themselves
function supported() {
  if (!app.isPackaged) {
    return false;
  }
  if (process.platform === 'linux') {
    return !!process.env.APPIMAGE || fs.existsSync(path.join(process.resourcesPath, 'package-type'));
  }
  return true;
}

function update(patch) {
  current = Object.assign({}, current, patch);
  onChange(current);
}

function init(options) {
  onChange = options.onChange || onChange;
  if (!supported()) {
    return;
  }
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = options.logger || null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  current = Object.assign({}, current, { state: 'idle' });
  autoUpdater.on('checking-for-update', () => update({ state: 'checking', error: null }));
  autoUpdater.on('update-available', info => update({ state: 'available', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => update({ state: 'none', checkedAt: new Date().toISOString(), version: null, percent: null }));
  autoUpdater.on('download-progress', p => update({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => update({ state: 'downloaded', version: info.version, percent: 100, checkedAt: new Date().toISOString() }));
  autoUpdater.on('error', err => update({
    // a failed check keeps a downloaded update installable
    state: current.state === 'downloaded' ? 'downloaded' : 'error',
    error: (err && err.message || String(err)).split('\n')[0],
    checkedAt: new Date().toISOString()
  }));
}

function check() {
  if (!autoUpdater) {
    return Promise.resolve(current);
  }
  if (current.state === 'checking' || current.state === 'downloading' || current.state === 'downloaded') {
    return Promise.resolve(current);
  }
  // the outcome arrives through the events above
  autoUpdater.checkForUpdates().catch(() => {});
  return Promise.resolve(current);
}

// Checks at start (after 30 s) and every 6 hours while `on`
function schedule(on) {
  timers.forEach(clearTimeout);
  timers = [];
  if (!on || !autoUpdater) {
    return;
  }
  timers.push(setTimeout(check, FIRST_CHECK_MS));
  timers.push(setInterval(check, EVERY_MS));
}

// Quits and runs the installer (Windows: silently, then starts the app again)
function install() {
  if (!autoUpdater || current.state !== 'downloaded') {
    return false;
  }
  autoUpdater.quitAndInstall(true, true);
  return true;
}

module.exports = {
  init,
  check,
  schedule,
  install,
  state: () => current
};
