'use strict';

// A Playpex Media Server installed on this machine but not running: the TV app
// starts it instead of asking the user to (step 9 decision: "the TV app finds
// an installed but stopped server and starts it"; docs/server-separation-plan.md §11).
//
//   localServer.status()  → { installed, kind: 'desktop' | 'development' | null, port }
//   localServer.start()   → Promise<info>   resolves with GET /server once it answers (30 s at most)
//   localServer.stop()    stops a development server this app started (an installed one keeps running)
//
// Where it is: the record the desktop server writes on every start
// (<config dir>/desktop-app.json, @playpex/protocol/local), else the usual
// install places. A development run (`npm run electron`) can also start the
// repo's headless server (apps/server/bin/playpex-server.js) with Electron's
// own Node, as a child that ends with this app.

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const local = require('@playpex/protocol/local');
const { serverInfo } = require('./discovery');

const START_TIMEOUT_MS = 30000;
const EXE = 'playpex-media-server';   // apps/server-desktop build.executableName
const PRODUCT = 'Playpex Media Server';
const REPO_SERVER = path.join(__dirname, '..', '..', 'server', 'bin', 'playpex-server.js');

let devChild = null;
let starting = null;

function exists(file) {
  try {
    return !!file && fs.statSync(file).isFile();
  } catch (e) {
    return false;
  }
}

// The usual install places, for a server installed before it ever ran
function knownInstalls() {
  switch (process.platform) {
    case 'win32': {
      const programs = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
      let dirs = [];
      try {
        dirs = fs.readdirSync(programs);
      } catch (e) { /* none */ }
      return dirs.map(d => path.join(programs, d, EXE + '.exe'));
    }
    case 'darwin':
      return ['/Applications', path.join(os.homedir(), 'Applications')]
        .map(d => path.join(d, PRODUCT + '.app', 'Contents', 'MacOS', PRODUCT));
    default:
      return [path.join('/opt', PRODUCT, EXE), path.join('/usr/bin', EXE)];
  }
}

// { command, args, kind } to start a server, or null
function launcher() {
  const record = local.readDesktopApp();
  if (record) {
    if (exists(record.appImage)) {
      return { command: record.appImage, args: [], kind: 'desktop' };
    }
    if (exists(record.executable)) {
      return { command: record.executable, args: [], kind: 'desktop' };
    }
  }
  const installed = knownInstalls().find(exists);
  if (installed) {
    return { command: installed, args: [], kind: 'desktop' };
  }
  if (!app.isPackaged && exists(REPO_SERVER)) {
    return { command: process.execPath, args: [REPO_SERVER], kind: 'development' };
  }
  return null;
}

function status() {
  const found = launcher();
  return { installed: !!found, kind: found ? found.kind : null, port: local.configuredPort() };
}

function waitForServer(port) {
  const url = 'http://127.0.0.1:' + port;
  const until = Date.now() + START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      serverInfo(url, 1500).then(info => resolve(Object.assign(info, { url })), () => {
        if (Date.now() > until) {
          return reject(new Error(PRODUCT + ' did not start in time'));
        }
        setTimeout(attempt, 700);
      });
    };
    attempt();
  });
}

function start() {
  if (starting) {
    return starting;
  }
  const found = launcher();
  if (!found) {
    return Promise.reject(new Error(PRODUCT + ' is not installed on this computer'));
  }
  const port = local.configuredPort();
  // already up (started by hand meanwhile)?
  starting = serverInfo('http://127.0.0.1:' + port, 1500).then(info => Object.assign(info, { url: 'http://127.0.0.1:' + port }), () => {
    if (found.kind === 'development') {
      devChild = spawn(found.command, found.args, {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        stdio: 'inherit'
      });
      devChild.on('exit', () => { devChild = null; });
    } else {
      // --hidden: started for us, so the desktop app shows its tray icon but
      // doesn't open the dashboard in a browser
      const child = spawn(found.command, found.args.concat(['--hidden']), { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
    return waitForServer(port);
  });
  const clear = () => { starting = null; };
  starting.then(clear, clear);
  return starting;
}

function stop() {
  if (devChild) {
    devChild.kill('SIGTERM');
    devChild = null;
  }
}

module.exports = { status, start, stop };
