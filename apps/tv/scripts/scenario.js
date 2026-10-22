'use strict';

// Keyboard / mouse scenarios against a development build (docs/ui-system-plan.md
// §9 "Scenarios"): runs Playpex TV in a hidden window like screens.js, then a
// scenario file from scripts/scenarios/ that sends real keys
// (webContents.sendInputEvent, Electron key names: Up Down Left Right Return
// Escape) and checks the page.
//
//   npx electron scripts/scenario.js settings [--size 1440x810] [--shots .screens/scenario]
//                                    [--server http://127.0.0.1:28480]
//
// --server: a Playpex Media Server on this machine to use instead of Playpex
// TV's (e.g. a throwaway one: PLAYPEX_CONFIG_DIR=… PLAYPEX_PORT=28480 npm run
// server); loopback, no token, device id `tv-scenario`.
//
// A scenario exports async function (t), with:
//   t.key(name, times?)          one press (keyDown + keyUp), repeated
//   t.click(selector)            a mouse click at the element's centre
//   t.dev(call)                  window.playpexDev.<call> (open, reset, profile, …)
//   t.js(expression)             evaluates in the page (a native async function)
//   t.until(expression, ms?)     waits until it's truthy
//   t.focused()                  { key, text, classes, section } of document.activeElement
//   t.check(label, ok, detail?)  records a result (a failed one fails the run)
//   t.shot(name)                 a PNG into --shots
//   t.wait(ms)
//   t.cdp(method, params?)       a DevTools protocol command (Performance.getMetrics, HeapProfiler…)
// Needs a Playpex Media Server on this machine, like screens.js (same client.json copy).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

function option(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const name = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+x\d+$/.test(a) && !a.includes('/') && !a.startsWith('.'));
const size = option('size', '1440x810');
const shots = path.resolve(ROOT, option('shots', '.screens/scenario'));
const scale = +option('scale', 0.8);
const serverUrl = option('server', '');
if (!name) {
  console.error('usage: npx electron scripts/scenario.js <name> (scripts/scenarios/<name>.js)');
  process.exit(1);
}
const scenario = require(path.join(__dirname, 'scenarios', name + '.js'));

process.env.PLAYPEX_TV_INDEX = path.join(ROOT, 'dist', 'screens', 'index.html');
process.env.PLAYPEX_TV_SHOTS = size;
if (!fs.existsSync(process.env.PLAYPEX_TV_INDEX)) {
  console.error('No development build: ng build --configuration development --output-path dist/screens --base-href ./');
  process.exit(1);
}
const userData = path.join(os.tmpdir(), 'playpex-tv-scenario');
const clientJson = path.join(app.getPath('appData'), 'Playpex TV', 'client.json');
fs.mkdirSync(userData, { recursive: true });
let record = {};
try {
  record = JSON.parse(fs.readFileSync(clientJson, 'utf8'));
} catch (e) { }
record.uiScale = scale;
app.setPath('userData', userData);
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(win) {
  const wc = win.webContents;
  const results = [];
  const t = {
    keyGap: 180,      // ms between presses (perf journeys shorten it)
    wait,
    js: expression => wc.executeJavaScript('(async () => (' + expression + '))()'),
    dev: call => wc.executeJavaScript('(async () => String(await window.playpexDev.' + call + '))()'),
    async until(expression, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await t.js(expression).catch(() => false)) return true;
        await wait(100);
      }
      return false;
    },
    async key(keyCode, times = 1) {
      for (let i = 0; i < times; i++) {
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
        await wait(t.keyGap);
      }
      await wait(150);
    },
    async click(selector) {
      const box = await t.js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) throw new Error('no element ' + selector);
      const point = { x: Math.round(box.x), y: Math.round(box.y) };
      wc.sendInputEvent({ type: 'mouseMove', ...point });
      await wait(120);
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await wait(300);
    },
    focused: () => t.js(`(() => { const a = document.activeElement; return a && { key: a.dataset.pxKey || null, text: (a.textContent || '').trim().slice(0, 60), classes: a.className, section: a.closest('[data-px-section]')?.getAttribute('data-px-section') || null }; })()`),
    check(label, ok, detail) {
      results.push({ label, ok: !!ok });
      console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail !== undefined && !ok ? '  → ' + JSON.stringify(detail) : ''));
    },
    async cdp(method, params) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      return wc.debugger.sendCommand(method, params || {});
    },
    async shot(file) {
      fs.mkdirSync(shots, { recursive: true });
      const image = await wc.capturePage();
      fs.writeFileSync(path.join(shots, file + '.png'), image.toPNG());
    },
  };
  return { t, results };
}

// the server to use: its id is the key client.json knows it by
async function useServer() {
  if (serverUrl) {
    const info = await fetch(serverUrl.replace(/\/+$/, '') + '/api/v1/server').then(r => r.json());
    record.servers = { [info.id]: { name: info.name, url: serverUrl.replace(/\/+$/, '') } };
    record.lastServerId = info.id;
    record.deviceId = 'tv-scenario';
  }
  fs.writeFileSync(path.join(userData, 'client.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
}

app.once('browser-window-created', (event, win) => {
  const { t, results } = harness(win);
  (async () => {
    const [w, h] = size.split('x').map(Number);
    win.setContentSize(w, h);
    if (!await t.until('!!window.playpexDev', 60000)) throw new Error('the app never came up (window.playpexDev)');
    await t.until("getComputedStyle(document.querySelector('.splashContainer') || document.body).display == 'none' || !document.querySelector('.splashAnimation')", 30000);
    console.log('Scenario ' + name);
    await scenario(t);
  })()
    .catch(err => {
      console.error('  ERROR ' + (err.stack || err.message || err));
      process.exitCode = 1;
    })
    .then(() => {
      const failed = results.filter(r => !r.ok).length;
      console.log(results.length + ' checks, ' + failed + ' failed');
      app.exit(failed || process.exitCode ? 1 : 0);
    });
});

useServer().then(() => require('../electron/main.js'), err => {
  console.error('No server at ' + serverUrl + ': ' + err.message);
  process.exit(1);
});
