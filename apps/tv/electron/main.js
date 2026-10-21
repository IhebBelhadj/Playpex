'use strict';

// Playpex TV, a client of Playpex Media Server (docs/server-separation-plan.md
// §10). It carries no server: it finds one on this machine or the LAN
// (discovery.js), pairs with it (pairing.js), adds this device's headers to
// every request to it (auth.js) and remembers it (clientConfig.js). The
// renderer reaches the main process only through preload.js (window.playpex).
//
//   npm run electron      development run (builds the UI first); finds the server
//                         of `npm run server` / the desktop app, or starts one

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const protocol = require('@playpex/protocol');
const local = require('@playpex/protocol/local');

// scripts/screens.js (UI screenshots) runs this app on a development build
// (PLAYPEX_TV_INDEX) in a hidden window of a fixed size (PLAYPEX_TV_SHOTS=WxH)
const INDEX = process.env.PLAYPEX_TV_INDEX || path.join(__dirname, '..', 'dist', 'playpex', 'index.html');
const SHOT_SIZE = /^(\d+)x(\d+)$/.exec(process.env.PLAYPEX_TV_SHOTS || '');
const CLIENT_HEADER = protocol.clientHeader('playpex-tv', app.getVersion());

let win = null;
let resolving = null;     // Promise of the connection being resolved
let picker = null;        // the /connect page's discovery, while it is open

// Before step 9 the app was "@playpex/tv" (development runs) with its own
// userData: carry its Local Storage over once (subtitle provider, deviceId)
function carryOverStorage() {
  const target = app.getPath('userData');
  if (fs.existsSync(target)) {
    return;
  }
  const old = path.join(app.getPath('appData'), '@playpex', 'tv', 'Local Storage');
  if (fs.existsSync(old)) {
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(old, path.join(target, 'Local Storage'), { recursive: true });
    } catch (e) { /* start clean */ }
  }
}

function load() {
  if (win) {
    win.loadFile(INDEX);
  }
}

function createWindow() {
  const options = {
    fullscreen: true,
    frame: false,
    height: 780,
    width: 1270,
    backgroundColor: '#000',
    icon: path.join(__dirname, '..', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
  if (SHOT_SIZE) {
    Object.assign(options, { fullscreen: false, show: false, useContentSize: true, enableLargerThanScreen: true, width: +SHOT_SIZE[1], height: +SHOT_SIZE[2] });
    options.webPreferences.offscreen = true;
  }
  win = new BrowserWindow(options);
  // our own pages only: no pop-ups, no navigating away from the app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });
  win.on('closed', () => {
    win = null;
    stopPicker();
  });
  load();
}

function send(channel, value) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, value);
  }
}

// Answers only our own window
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents) {
      throw new Error('Not allowed');
    }
    return fn(...args);
  });
}

function stopPicker() {
  if (picker) {
    picker.stop();
    picker = null;
  }
}

function connectIpc() {
  const config = require('./clientConfig');
  const connection = require('./connection');
  const discovery = require('./discovery');
  const pairing = require('./pairing');
  const localServer = require('./localServer');
  const power = require('./power');
  const updater = require('./updater');

  const resolveAgain = () => {
    resolving = connection.resolve();
    return resolving;
  };
  const view = state => Object.assign({}, state, {
    deviceId: config.deviceId(),
    deviceIdIsNew: config.deviceIdIsNew(),
    tokenStorage: config.tokenStorage(),
    version: app.getVersion(),
    platform: process.platform
  });

  handle('connection:current', () => resolving.then(view));
  handle('connection:adoptDeviceId', id => config.adoptDeviceId(id));
  // Another server, or the same one after pairing: the UI starts again clean
  handle('connection:choose', server => {
    pairing.cancel();
    resolving = connection.choose(server);
    return resolving.then(state => {
      load();
      return view(state);
    });
  });
  handle('connection:reconnect', () => resolveAgain().then(state => {
    if (state.server) {
      load();
    }
    return view(state);
  }));
  handle('connection:drop', (reason, detail) => {
    resolving = Promise.resolve(connection.drop(reason, detail));
    return resolving.then(state => {
      load();
      return view(state);
    });
  });
  handle('connection:forget', id => {
    config.forget(id);
    return true;
  });

  handle('discovery:start', () => {
    if (!picker) {
      picker = discovery.createDiscovery({
        localPort: local.configuredPort(),
        onChange: servers => send('discovery:servers', servers.map(connection.annotate))
      });
      picker.start();
    }
    return picker.servers().map(connection.annotate);
  });
  handle('discovery:stop', () => stopPicker());
  handle('discovery:rescan', () => {
    if (picker) {
      picker.rescan();
    }
  });
  handle('discovery:probe', address => discovery.probe(address).then(connection.annotate));

  handle('pairing:start', server => pairing.start(server, CLIENT_HEADER, update => send('pairing:update', update)));
  handle('pairing:cancel', () => pairing.cancel());

  handle('local:status', () => localServer.status());
  handle('local:start', () => localServer.start().then(info => connection.annotate({
    id: info.id, name: info.name, url: info.url, local: true, compatible: true
  })));

  handle('power', action => power.run(action));

  updater.init(state => send('updater:state', state));
  handle('updater:state', () => updater.state());
  handle('updater:check', () => updater.check());
  handle('updater:install', () => updater.install());

  app.on('before-quit', () => {
    pairing.cancel();
    stopPicker();
    localServer.stop();
  });

  return resolveAgain;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  carryOverStorage();
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });
  app.whenReady().then(() => {
    const connection = require('./connection');
    require('./auth').install(session.defaultSession, connection.auth, CLIENT_HEADER);
    const resolve = connectIpc();
    resolve();
    createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (win === null) {
      createWindow();
    }
  });
}
