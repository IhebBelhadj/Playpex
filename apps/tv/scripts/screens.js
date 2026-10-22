'use strict';

// UI screenshots (docs/ui-system-plan.md step 0, §9): runs Playpex TV on a
// development build in a hidden window of a fixed size, opens a fixed list of
// screens through window.playpexDev (src/app/dev-hook.service.ts; never a URL
// query, see the root CLAUDE.md) and saves one PNG per screen.
//
//   npm run screens -w apps/tv                          builds, then shoots into .screens/latest
//   npx electron scripts/screens.js [--out .screens/baseline] [--size 1920x1080]   (default 1440x810, the design)
//                                   [--only movies,movie] [--settle 4000] [--scale 0.8]
//
// --scale: the UI scale of the shots (client.json uiScale, ui/display.ts;
// default 0.8, the app's default), whatever Playpex TV itself uses.
//
// Overlay shots (torrent picker, play choice, error, connection lost) open
// over the screen before them: `--only movie,torrent-picker`.
//
// Needs a Playpex Media Server on this machine (`npm run server`): loopback,
// no pairing. Enters the first profile without a PIN that isn't a kids one.
// Live screens show today's TMDB data: compare them side by side by eye; the
// gallery (core.dev.gallery) is the deterministic one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

const SHOTS = [
  { name: 'profiles', run: "reset({ screen: 'core.profiles' })" },
  { name: 'movies', before: 'profile()', run: "reset({ screen: 'core.movies' })", settle: 6000 },
  { name: 'movie', run: "open({ screen: 'core.movie', params: { id: 949 } })" },
  // the shell's overlays with fixture data (DevHook.overlay), over the movie page; `after` closes them
  { name: 'torrent-picker', run: "overlay('torrents')", settle: 1200, after: "input('back')" },
  { name: 'play-choice', run: "overlay('playChoice')", settle: 1200, after: "input('back')" },
  { name: 'error', run: "overlay('error')", settle: 1200, after: "input('back')" },
  { name: 'connection-lost', run: "overlay('connectionLost')", settle: 1200, after: "input('back')" },
  { name: 'shows', run: "reset({ screen: 'core.shows' })", settle: 6000 },
  { name: 'show', run: "open({ screen: 'core.show', params: { id: 1396 } })" },
  { name: 'episode', run: "open({ screen: 'core.episode', params: { id: 1396, season: 1, episode: 1 } })" },
  { name: 'watchlist', run: "reset({ screen: 'core.watchlist' })" },
  { name: 'search', run: "open({ screen: 'core.search' })" },
  { name: 'releases', run: "releases('movie', 'Heat 1995', 'Heat', 'tt0113277')", settle: 6000 },
  { name: 'adult-browse', run: "reset({ screen: 'core.adult.browse' })", settle: 6000 },
  { name: 'adult-releases', run: "reset({ screen: 'core.adult.releases' })", settle: 6000 },
  { name: 'settings', run: "reset({ screen: 'core.settings' })", settle: 1500 },
  { name: 'power', run: "open({ screen: 'core.power' })", settle: 1500 },
  { name: 'display', run: "reset({ screen: 'core.display' })", settle: 1500 },
  { name: 'gallery', run: "reset({ screen: 'core.dev.gallery' })", settle: 1500, optional: true },
  { name: 'connect', run: "reset({ screen: 'core.connect' })" },
];

function option(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const size = option('size', '1440x810');
const out = path.resolve(ROOT, option('out', '.screens/latest'));
const only = option('only', '').split(',').filter(Boolean);
const settle = +option('settle', 3500);
const scale = +option('scale', 0.8);

process.env.PLAYPEX_TV_INDEX = path.join(ROOT, 'dist', 'screens', 'index.html');
process.env.PLAYPEX_TV_SHOTS = size;
if (!fs.existsSync(process.env.PLAYPEX_TV_INDEX)) {
  console.error('No development build: run `npm run screens` (or ng build --configuration development --output-path dist/screens --base-href ./)');
  process.exit(1);
}
// Its own profile: doesn't collide with a running Playpex TV (single instance
// lock). Uses that app's device record (client.json: device id, the server and
// its token), so the server knows this client and nothing needs pairing.
const userData = path.join(os.tmpdir(), 'playpex-tv-screens');
const clientJson = path.join(app.getPath('appData'), 'Playpex TV', 'client.json');
fs.mkdirSync(userData, { recursive: true });
let record = {};
try {
  record = JSON.parse(fs.readFileSync(clientJson, 'utf8'));
} catch (e) { }
// a fixed size, and no first-start size screen in front of every shot
record.uiScale = scale;
fs.writeFileSync(path.join(userData, 'client.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
app.setPath('userData', userData);
// sizes in real pixels: on a scaled display (125 %) the window would be
// measured in larger units and clamped to the screen
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Calls window.playpexDev.<call>; its promises are Zone.js ones, which
// executeJavaScript can't clone: awaited in a native async function
function dev(wc, call) {
  return wc.executeJavaScript('(async () => String(await window.playpexDev.' + call + '))()');
}

async function until(wc, expression, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await wc.executeJavaScript(expression).catch(() => false)) return;
    await wait(250);
  }
  throw new Error('Timed out waiting for ' + label);
}

// every image on the page loaded (or failed), within a few seconds
const IMAGES_DONE = 'Array.from(document.images).every(img => img.complete)';

async function shoot(win) {
  const wc = win.webContents;
  const [w, h] = size.split('x').map(Number);
  // the window manager may have clamped it to the screen
  win.setContentSize(w, h);
  await until(wc, '!!window.playpexDev', 60000, 'the app (window.playpexDev)');
  // the intro video: the picker ignores keys until it's gone
  await until(wc, "getComputedStyle(document.querySelector('.splashContainer') || document.body).display == 'none' || !document.querySelector('.splashAnimation')", 30000, 'the splash').catch(() => {});
  fs.mkdirSync(out, { recursive: true });
  const [width] = size.split('x').map(Number);
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.name)) {
      if (shot.before) await dev(wc, shot.before).catch(() => {});
      continue;
    }
    try {
      if (shot.before) console.log('  ' + shot.before + ' → ' + await dev(wc, shot.before));
      await dev(wc, shot.run);
      await wait(shot.settle || settle);
      await until(wc, IMAGES_DONE, 5000, 'images').catch(() => {});
      await wait(400);
      const screen = await dev(wc, 'screen()');
      let image = await wc.capturePage();
      if (process.env.PLAYPEX_SCREENS_DEBUG) {
        console.log('  capture ' + JSON.stringify(image.getSize()) + ' viewport ' + await wc.executeJavaScript("JSON.stringify([innerWidth, innerHeight, devicePixelRatio, getComputedStyle(document.documentElement).fontSize])"));
      }
      if (image.getSize().width != width) image = image.resize({ width });
      fs.writeFileSync(path.join(out, shot.name + '.png'), image.toPNG());
      console.log(shot.name + '.png  (' + screen + ')');
      if (shot.after) {
        await dev(wc, shot.after);
        await wait(300);
      }
    } catch (err) {
      console.log((shot.optional ? 'skipped ' : 'FAILED ') + shot.name + ': ' + (err.message || err));
    }
  }
}

app.once('browser-window-created', (event, win) => {
  shoot(win)
    .catch(err => {
      console.error(err.message || err);
      process.exitCode = 1;
    })
    .then(() => app.exit(process.exitCode || 0));
});

console.log('Screens ' + size + ' → ' + path.relative(process.cwd(), out));
require('../electron/main.js');
