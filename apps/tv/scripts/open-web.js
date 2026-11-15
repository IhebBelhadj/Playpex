'use strict';

// Opens the last web build of Playpex TV (`npm run build:tv-web` →
// apps/server/public-tv) in the default browser, like `npm run electron:last`
// does for the desktop app (docs/web-client-plan.md §5.1). The server serves
// that folder as it is on disk, so nothing is rebuilt or restarted.
//
//   npm run tv-web:last            the server on this machine (its configured port), /tv/
//   npm run tv-web:last -- --url http://192.168.1.20:28470
//
// No server answering: the repo's headless server is started (stopped with
// Ctrl+C), as `npm run server` would.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const local = require('@playpex/protocol/local');

const ROOT = path.join(__dirname, '..', '..', '..');
const BUILD = path.join(ROOT, 'apps', 'server', 'public-tv', 'index.html');

const urlArg = process.argv.indexOf('--url');
const base = (urlArg > 0 && process.argv[urlArg + 1]) || `http://localhost:${process.env.PLAYPEX_PORT || local.configuredPort()}`;
const page = base.replace(/\/+$/, '') + '/tv/';

if (!fs.existsSync(BUILD)) {
  console.error('No web build in apps/server/public-tv: run npm run build:tv-web (or npm run tv-web) first');
  process.exit(1);
}

function answers() {
  return fetch(base + '/api/v1/server', { signal: AbortSignal.timeout(2000) }).then(res => res.ok, () => false);
}

function open() {
  const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', page]]
    : process.platform === 'darwin' ? ['open', [page]] : ['xdg-open', [page]];
  spawn(command[0], command[1], { stdio: 'ignore', detached: true }).on('error', () => { }).unref();
  console.log('Playpex TV for the web: ' + page);
}

answers().then(async up => {
  if (up) return open();
  if (urlArg > 0) {
    console.error('No Playpex server answers at ' + base);
    process.exit(1);
  }
  console.log('No server on ' + base + ': starting this repo\'s server (Ctrl+C stops it)…');
  const server = spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'bin', 'playpex-server.js')], { stdio: 'inherit', cwd: ROOT });
  server.on('exit', code => process.exit(code || 0));
  process.on('SIGINT', () => server.kill('SIGINT'));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await answers()) return open();
  }
  console.error('The server did not answer within 30 s');
});
