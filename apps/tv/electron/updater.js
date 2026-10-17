'use strict';

// Updates of Playpex TV with electron-updater (step 9). Provisional release
// scheme, from the §12 J proposal (not decided yet): electron-updater's
// `generic` provider on a fixed "channel" release of this product (`tv-channel`,
// see build.publish in package.json) that only holds latest*.yml pointing at
// the installers of the versioned release (`tv-v0.9.0`). Its GitHub provider
// can't be used: it reads the repo-wide latest release, which may be the server's.
//
// Found updates download in the background and install when the app quits,
// or at once from the "update Playpex TV" screen (a server answered 426 CLIENT_TOO_OLD).
//
//   updater.init(onChange)   onChange(state) on every change
//   updater.state()   { state, version, percent, error }
//     state: unsupported | idle | checking | none | available | downloading | downloaded | error
//   updater.check() / updater.install()

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;

let current = { state: 'unsupported', version: null, percent: null, error: null };
let autoUpdater = null;
let onChange = () => {};

// A development run has no app-update.yml; on Linux only the AppImage and the
// .deb (resources/package-type) can update themselves
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

function init(listener) {
  onChange = listener || onChange;
  if (!supported()) {
    return;
  }
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  current = Object.assign({}, current, { state: 'idle' });
  autoUpdater.on('checking-for-update', () => update({ state: 'checking', error: null }));
  autoUpdater.on('update-available', info => update({ state: 'available', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => update({ state: 'none', version: null, percent: null }));
  autoUpdater.on('download-progress', p => update({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => update({ state: 'downloaded', version: info.version, percent: 100 }));
  autoUpdater.on('error', err => update({
    state: current.state === 'downloaded' ? 'downloaded' : 'error',
    error: (err && err.message || String(err)).split('\n')[0]
  }));
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, EVERY_MS);
}

function check() {
  if (autoUpdater && ['checking', 'downloading', 'downloaded'].indexOf(current.state) === -1) {
    autoUpdater.checkForUpdates().catch(() => {});   // the outcome arrives through the events
  }
  return current;
}

// Quits and runs the installer, then starts the app again
function install() {
  if (!autoUpdater || current.state !== 'downloaded') {
    return false;
  }
  autoUpdater.quitAndInstall(true, true);
  return true;
}

module.exports = { init, check, install, state: () => current };
