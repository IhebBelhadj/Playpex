'use strict';

// Start at login (plan §8.1), hidden: no dashboard opens, only the tray icon.
//   Windows, macOS  app.setLoginItemSettings (HKCU\…\Run on Windows: no admin rights)
//   Linux           ~/.config/autostart/playpex-media-server.desktop (XDG autostart)
// Windows and Linux pass --hidden; macOS can't pass arguments to login items,
// so main.js also checks getLoginItemSettings().wasOpenedAtLogin.

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HIDDEN = '--hidden';

function linuxFile() {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'playpex-media-server.desktop');
}

// What to run: the AppImage itself (its mount path changes on every run), the
// installed binary, or Electron + this app in development
function command() {
  if (process.env.APPIMAGE) {
    return [process.env.APPIMAGE];
  }
  return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
}

function quote(arg) {
  return /[\s"'\\$`]/.test(arg) ? '"' + arg.replace(/(["\\$`])/g, '\\$1') + '"' : arg;
}

function get() {
  if (process.platform === 'linux') {
    return fs.existsSync(linuxFile());
  }
  return app.getLoginItemSettings({ args: app.isPackaged ? [HIDDEN] : [app.getAppPath(), HIDDEN], path: process.execPath, name: 'Playpex Media Server' }).openAtLogin;
}

function set(on) {
  if (process.platform === 'linux') {
    const file = linuxFile();
    if (!on) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Playpex Media Server',
      'Comment=Runs the Playpex media server in the background',
      'Exec=' + command().concat(HIDDEN).map(quote).join(' '),
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n'));
    return;
  }
  // name: the HKCU\…\Run value on Windows (build/installer.nsh removes it)
  const settings = { openAtLogin: on, args: [HIDDEN], name: 'Playpex Media Server' };
  if (!app.isPackaged) {
    settings.path = process.execPath;
    settings.args = [app.getAppPath(), HIDDEN];
  }
  app.setLoginItemSettings(settings);
}

// Started by the login item: stay in the tray
function startedHidden() {
  return process.argv.includes(HIDDEN) ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}

module.exports = { get, set, startedHidden, HIDDEN };
