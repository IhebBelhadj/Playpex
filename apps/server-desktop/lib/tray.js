'use strict';

// The tray icon and its menu (plan §8.1). Rebuilt from scratch on every
// change: Linux AppIndicators only take whole menus.
//
//   const tray = createTray(actions)   actions: see menuTemplate()
//   tray.update(model)                 model: { server, updater, openAtLogin, appVersion }

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const ICONS = path.join(__dirname, '..', 'assets', 'tray');

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// 'running' | 'warning' | 'error' | 'stopped' for the icon, and the status line
function describe(server) {
  const s = server.status;
  switch (server.state) {
    case 'running':
      return { icon: 'running', line: 'Running · ' + plural(s.streams, 'stream') + ' · ' + plural(s.devicesOnline, 'device') };
    case 'recovery':
      return { icon: 'warning', line: 'Port ' + s.recovery.port + ' is in use' };
    case 'starting':
      return { icon: 'stopped', line: 'Starting…' };
    case 'stopping':
      return { icon: 'stopped', line: 'Stopping…' };
    case 'crashed':
      return { icon: 'warning', line: 'Stopped unexpectedly, restarting in ' + Math.round(server.error.retryInMs / 1000) + ' s' };
    case 'error':
      return { icon: 'error', line: 'Error: ' + server.error.message };
    default:
      return { icon: 'stopped', line: 'Stopped' };
  }
}

function icon(name) {
  if (process.platform === 'darwin') {
    // template images follow the menu bar's light / dark look; states other
    // than running keep their colour so they stand out
    const image = nativeImage.createFromPath(path.join(ICONS, name === 'running' ? 'macTemplate.png' : 'mac-' + name + '.png'));
    image.setTemplateImage(name === 'running');
    return image;
  }
  return nativeImage.createFromPath(path.join(ICONS, name + (process.platform === 'win32' ? '.ico' : '.png')));
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function updateItem(updater, actions) {
  const u = updater;
  switch (u.state) {
    case 'unsupported':
      return { label: 'Updates: not available in this build', enabled: false };
    case 'checking':
      return { label: 'Checking for updates…', enabled: false };
    case 'available':
    case 'downloading':
      return { label: 'Downloading update ' + (u.version || '') + (u.percent ? ' (' + u.percent + ' %)' : '…'), enabled: false };
    case 'downloaded':
      return { label: 'Restart to install ' + u.version, click: actions.installUpdate };
    case 'none':
      return { label: 'Check for updates (up to date)', click: actions.checkForUpdates };
    case 'error':
      return { label: 'Check for updates (last check failed)', click: actions.checkForUpdates };
    default:
      return { label: 'Check for updates', click: actions.checkForUpdates };
  }
}

function who(request) {
  return request.client ? request.client.split(';')[0] : request.clientId || request.address || 'A device';
}

function menuTemplate(model, actions) {
  const server = model.server, s = server.status, live = server.state === 'running' || server.state === 'recovery';
  const items = [
    { label: 'Playpex Media Server ' + model.appVersion, enabled: false },
    { label: truncate(describe(server).line, 70), enabled: false },
    { type: 'separator' },
    { label: server.state === 'recovery' ? 'Open dashboard to change the port' : 'Open dashboard', click: actions.openDashboard, enabled: live || server.state === 'error' && !!server.error.port }
  ];
  if (s && s.setupNeeded && server.state === 'running') {
    items.push({ label: 'Finish the setup…', click: actions.openDashboard });
  }
  if (s && s.pairing && s.pairing.length) {
    items.push({ type: 'separator' }, { label: 'Pairing requests', enabled: false });
    s.pairing.slice(0, 5).forEach(request => {
      items.push({
        label: truncate(who(request), 40) + ' wants to connect · code ' + request.userCode,
        submenu: [
          { label: 'Approve', click: () => actions.approve(request.userCode) },
          { label: 'Deny', click: () => actions.deny(request.userCode) }
        ]
      });
    });
  }
  // the server's downloads.paused (kept across restarts); streams still play
  const paused = !!s && !!s.downloadsPaused;
  items.push(
    { type: 'separator' },
    { label: 'Open downloads folder', click: actions.openDownloads },
    { label: 'Open logs folder', click: actions.openLogs },
    paused ?
      { label: 'Resume downloads', click: actions.resumeAll, enabled: live } :
      { label: 'Pause all downloads', click: actions.pauseAll, enabled: live && !!s },
    { label: 'Restart server', click: actions.restart, enabled: server.state !== 'stopping' },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: !!model.openAtLogin, click: item => actions.setOpenAtLogin(item.checked) },
    updateItem(model.updater, actions)
  );
  if (process.platform === 'win32') {
    items.push({ label: 'Allow through firewall…', click: actions.allowFirewall });
  }
  items.push({ type: 'separator' }, { label: 'Quit Playpex Media Server', click: actions.quit });
  return items;
}

function createTray(actions) {
  let current = null, lastLine = null;
  const tray = new Tray(icon('stopped'));
  tray.setToolTip('Playpex Media Server');
  // Windows: a left click opens the dashboard (the menu is on the right button)
  if (process.platform === 'win32') {
    tray.on('click', actions.openDashboard);
  }
  return {
    update(model) {
      const d = describe(model.server);
      if (d.icon !== current) {
        current = d.icon;
        tray.setImage(icon(d.icon));
      }
      tray.setToolTip(truncate('Playpex Media Server · ' + d.line, 120));
      const pairing = model.server.status && model.server.status.pairing || [];
      const line = d.icon + ': ' + d.line + (pairing.length ? ' · pairing ' + pairing.map(p => p.userCode).join(', ') : '');
      if (!app.isPackaged && line !== lastLine) {
        lastLine = line;
        process.stdout.write('[tray] ' + line + '\n');   // development runs only
      }
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(model, actions)));
    },
    destroy() {
      tray.destroy();
    }
  };
}

module.exports = { createTray, describe, menuTemplate };
