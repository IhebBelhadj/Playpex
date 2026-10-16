'use strict';

// Playpex Media Server, desktop edition (docs/server-separation-plan.md §8.1).
// Electron is only the supervisor here: no window. It runs the server core
// (@playpex/server's headless entry) in a utilityProcess, shows a tray icon,
// starts at login, restarts the server when it crashes, and updates itself.
// Everything else (settings, devices, logs…) is the server's web dashboard,
// opened in the user's browser.
//
//   npm start -w apps/server-desktop    development run (Electron + this folder)
//   --hidden                            started at login: tray only, no dashboard

const { app, shell, Notification, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ServerProcess = require('./lib/server-process');
const { createTray } = require('./lib/tray');
const autostart = require('./lib/autostart');
const updater = require('./lib/updater');
const state = require('./lib/state');

const APP_ID = 'app.playpex.mediaserver';

let server = null;
let tray = null;
let quitting = false;
let installing = false;
let notifiedUpdate = null;

// Bundled ffmpeg/ffprobe: resources/ffmpeg when installed, vendor/ffmpeg/<platform>-<arch>
// (build/fetch-ffmpeg.js) in development
function ffmpegDir() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') :
    path.join(__dirname, 'vendor', 'ffmpeg', process.platform + '-' + process.arch);
  return fs.existsSync(dir) ? dir : null;
}

function desktopState() {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    openAtLogin: autostart.get(),
    checkForUpdates: state.get('checkForUpdates'),
    update: updater.state()
  };
}

function refresh() {
  if (tray) {
    tray.update({ server, updater: updater.state(), openAtLogin: autostart.get(), appVersion: app.getVersion() });
  }
}

function pushDesktopState() {
  if (server) {
    server.send({ type: 'desktop', state: desktopState() });
  }
}

// ── actions ────────────────────────────────────────────────────────────────

function notify(title, body, onClick) {
  if (!Notification.isSupported()) {
    return;
  }
  const n = new Notification({ title, body, silent: false });
  if (onClick) {
    n.on('click', onClick);
  }
  n.show();
}

// The dashboard in the default browser. Recovery mode: its Network settings
// (the port to change); another Playpex server on our port: that one.
function openDashboard(page) {
  const s = server.status;
  if (server.state === 'error' && server.error.port) {
    return shell.openExternal('http://localhost:' + server.error.port + '/');
  }
  if (!s || !s.dashboardUrl) {
    notify('Playpex Media Server', 'The server is not running: ' + (server.error ? server.error.message : server.state));
    return Promise.resolve();
  }
  const where = server.state === 'recovery' ? 'settings/network' : page || '';
  return shell.openExternal(s.dashboardUrl + where);
}

function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function serverAction(action, args, success) {
  return server.request(action, args).then(result => {
    if (success) {
      notify('Playpex Media Server', success);
    }
    return result;
  }, err => {
    notify('Playpex Media Server', err.message);
  });
}

function setOpenAtLogin(on) {
  try {
    autostart.set(on);
    state.set({ openAtLogin: on });
  } catch (e) {
    notify('Playpex Media Server', 'Could not change "Start at login": ' + e.message);
  }
  refresh();
  pushDesktopState();
}

function setCheckForUpdates(on) {
  state.set({ checkForUpdates: on });
  updater.schedule(on);
  pushDesktopState();
}

// Stops the server cleanly, then quits into the installer. Asks first when
// someone is watching (`force` skips it: the dashboard asked already).
function installUpdate(force) {
  const streams = server.status ? server.status.streams : 0;
  const go = force || !streams ? Promise.resolve(0) : dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart now', 'Later'],
    defaultId: 1,
    cancelId: 1,
    title: 'Playpex Media Server',
    message: 'Install update ' + updater.state().version + '?',
    detail: (streams === 1 ? '1 stream is' : streams + ' streams are') + ' playing; installing restarts the server and stops ' + (streams === 1 ? 'it' : 'them') + '.'
  }).then(r => r.response);
  return go.then(response => {
    if (response !== 0) {
      return;
    }
    installing = true;
    quitting = true;
    return server.stop().then(() => {
      if (!updater.install()) {
        installing = false;
        quitting = false;
        server.start();
      }
    });
  });
}

// Windows: one elevated netsh rule for this executable (UAC prompt only
// now, only because the user asked), plan §8.2. Utility processes run the
// same executable, so the rule covers the server's sockets.
function allowFirewall() {
  const exe = process.execPath.replace(/'/g, "''");
  const rule = 'advfirewall firewall add rule name="Playpex Media Server" dir=in action=allow program="' + exe +
    '" enable=yes profile=private,domain';
  const command = "Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '" + rule.replace(/'/g, "''") + "'";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, err => {
    notify('Playpex Media Server', err ? 'The firewall rule was not added (' + err.message.split('\n')[0] + ')' :
      'Playpex Media Server is allowed through the firewall on private networks.');
  });
}

function quit() {
  app.quit();
}

const trayActions = {
  openDashboard: () => openDashboard(),
  approve: code => serverAction('pairing.approve', { code }, 'Device approved: it connects in a few seconds'),
  deny: code => serverAction('pairing.deny', { code }),
  openDownloads: () => openFolder(server.status ? server.status.downloadDir : require('@playpex/server/lib/paths').downloads),
  openLogs: () => openFolder(server.status ? server.status.logsDir : require('@playpex/server/lib/paths').logs),
  pauseAll: () => serverAction('torrents.pauseAll'),
  resumeAll: () => serverAction('torrents.resumeAll'),
  restart: () => server.restart(),
  setOpenAtLogin,
  checkForUpdates: () => updater.check(),
  installUpdate: () => installUpdate(false),
  allowFirewall,
  quit
};

// ── the server's events ────────────────────────────────────────────────────

function onServerEvent(event) {
  if (event.topic === 'pairing.requested') {
    const d = event.data || {};
    const name = d.client ? d.client.split(';')[0] : d.address || 'A device';
    notify(name + ' wants to connect', 'Code ' + d.userCode + '. Approve it from the tray icon or the dashboard.',
      () => openDashboard('devices'));
  }
}

// ── start ──────────────────────────────────────────────────────────────────

function start() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);   // notifications
  }

  // First packaged launch: start at login on by default (plan §8.1). A
  // development run never registers itself.
  state.load();
  if (state.get('openAtLogin') === null && app.isPackaged) {
    setOpenAtLogin(true);
  } else if (process.platform === 'linux' && app.isPackaged && autostart.get()) {
    // The AppImage may have moved (AppImageLauncher integrates it into
    // ~/Applications): point the autostart entry at where we run now
    autostart.set(true);
  }

  const env = Object.assign({}, process.env);
  const ff = ffmpegDir();
  if (ff && !env.PLAYPEX_FFMPEG_DIR) {
    env.PLAYPEX_FFMPEG_DIR = ff;
  }
  server = new ServerProcess({
    entry: require.resolve('@playpex/server/bin/playpex-server.js'),
    env,
    stdio: app.isPackaged ? 'ignore' : 'inherit'
  });
  server.handle('desktop.set', args => {
    if (typeof args.openAtLogin === 'boolean') {
      setOpenAtLogin(args.openAtLogin);
    }
    if (typeof args.checkForUpdates === 'boolean') {
      setCheckForUpdates(args.checkForUpdates);
    }
    return desktopState();
  });
  server.handle('update.check', () => updater.check().then(desktopState));
  server.handle('update.install', args => {
    if (updater.state().state !== 'downloaded') {
      throw Object.assign(new Error('No update is downloaded'), { code: 'CONFLICT' });
    }
    // after the answer has gone out
    setTimeout(() => installUpdate(true), 500);
    return null;
  });
  server.on('change', refresh);
  server.on('event', onServerEvent);
  server.on('started', () => pushDesktopState());

  // Opened by the user (not at login): show the dashboard, which starts with
  // the setup on the first run. At login only for an unfinished first setup.
  const hidden = autostart.startedHidden();
  server.once('started', status => {
    if (!hidden || status.setupNeeded && !state.get('setupShown')) {
      state.set({ setupShown: true });
      openDashboard();
    }
  });
  // Another Playpex server holds the port: that one's dashboard
  const onError = () => {
    if (server.state === 'error' && server.error.port) {
      server.removeListener('change', onError);
      if (!hidden) {
        openDashboard();
      }
    } else if (server.state === 'running' || server.state === 'recovery') {
      server.removeListener('change', onError);
    }
  };
  server.on('change', onError);

  updater.init({
    onChange: () => {
      refresh();
      if (server.child) {
        pushDesktopState();
      }
      const u = updater.state();
      if (u.state === 'downloaded' && !installing && notifiedUpdate !== u.version) {
        notifiedUpdate = u.version;
        notify('Update ' + u.version + ' is ready', 'It installs when you choose "Restart to install" in the tray, or the next time Playpex Media Server quits.');
      }
    }
  });
  updater.schedule(state.get('checkForUpdates'));

  tray = createTray(trayActions);
  server.start();
  refresh();
}

if (!app.requestSingleInstanceLock()) {
  // Already running: the first instance opens the dashboard
  app.quit();
} else {
  app.on('second-instance', () => {
    if (server) {
      openDashboard();
    }
  });
  // No windows: closing nothing must not quit
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (installing || !server || server.state === 'stopped' || server.state === 'error' && !server.child) {
      return;
    }
    // Let the server destroy its torrent engines and close the database first
    event.preventDefault();
    if (!quitting) {
      quitting = true;
      server.stop().then(() => app.quit());
    }
  });
  app.on('will-quit', () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
  app.whenReady().then(start);
}
