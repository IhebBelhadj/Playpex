'use strict';

// Control from the server (docs/remote-control-plan.md): this scenario plays
// the dashboard's part against a real Playpex TV.
//   1. Remote control: the TV is a target of /remote; a controller (the
//      admin's cookie) connects, the badge shows, keys move the focus, the
//      pointer hovers / clicks a chip (a setting changes), text types into
//      the search keyboard, the cursor comes back; Settings' switch turns it off.
//   2. Session commands: the player pauses, resumes, seeks and stops on
//      POST /sessions/{id}/commands; the dashboard's session follows at once.
// Needs a throwaway server with an admin and a library file:
//   PLAYPEX_TEST_REF=f_… PLAYPEX_TEST_COOKIE='playpex.session_token=…' npx electron scripts/scenario.js remote --server http://127.0.0.1:28480

const WebSocket = require('ws');

const video = "document.querySelector('.moviePlayer')";

function serverUrl() {
  const i = process.argv.indexOf('--server');
  return process.argv[i + 1].replace(/\/+$/, '');
}

function admin(method, path, body) {
  return fetch(serverUrl() + '/api/v1' + path, {
    method,
    headers: Object.assign({ Cookie: process.env.PLAYPEX_TEST_COOKIE }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: /json/.test(r.headers.get('content-type') || '') ? await r.json() : null }));
}

function controller(device) {
  const ws = new WebSocket(serverUrl().replace(/^http/, 'ws') + '/api/v1/remote?role=controller&device=' + device,
    { headers: { Cookie: process.env.PLAYPEX_TEST_COOKIE } });
  ws.got = [];
  ws.on('message', data => ws.got.push(JSON.parse(String(data))));
  ws.json = msg => ws.send(JSON.stringify(msg));
  ws.ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function key(ws, name, wait = 250) {
  ws.json({ type: 'key', phase: 'down', key: name, code: name });
  ws.json({ type: 'key', phase: 'up', key: name, code: name });
  await new Promise(r => setTimeout(r, wait));
}

module.exports = async function (t) {
  const ref = process.env.PLAYPEX_TEST_REF;
  if (!ref || !process.env.PLAYPEX_TEST_COOKIE) throw new Error('set PLAYPEX_TEST_REF and PLAYPEX_TEST_COOKIE');
  await t.dev('profile()');
  const device = await t.js('window.playpexDev.deviceId');

  // ── 1. remote control ────────────────────────────────────────────────────
  const target = await until(async () => (await admin('GET', '/remote/targets')).body.filter(x => x.deviceId == device)[0]);
  t.check('the TV is a remote target', !!target, await admin('GET', '/remote/targets'));
  t.check('with keyboard, pointer and text', target && target.capabilities.keyboard && target.capabilities.pointer && target.capabilities.text, target);
  t.check('and its screen size', target && target.screen && target.screen.width == 1440, target && target.screen);

  await t.dev("open({ screen: 'core.settings' })");
  await t.until("document.querySelector('.settingsPage [data-px-key]')", 5000);
  await t.wait(600);
  t.check('no badge before a controller', !await t.js("!!document.querySelector('remote-overlay .badge')"));

  const ws = controller(device);
  await ws.ready;
  t.check('controller connected', !!await until(() => ws.got.find(m => m.type == 'state' && m.connected)), ws.got);
  t.check('the badge shows who controls', await t.until("document.querySelector('remote-overlay .badge')?.textContent.includes('admin')", 3000));
  await t.shot('remote-badge');

  // keys: the rail's tabs, then into the group's settings
  const before = await t.focused();
  await key(ws, 'ArrowDown');
  const afterDown = await t.focused();
  t.check('ArrowDown from the dashboard moves the focus', afterDown.key != before.key, { before, afterDown });
  await key(ws, 'ArrowUp');
  await key(ws, 'ArrowRight');
  const inSettings = await t.focused();
  t.check('ArrowRight enters the settings', inSettings.section == 'settings', inSettings);

  // pointer: an absolute move over the Playback tab's subtitle size "Large" chip, then a click
  await key(ws, 'ArrowLeft');
  await key(ws, 'ArrowDown');           // the Playback tab shows
  await t.until("document.querySelector('[data-px-key=\"size:large\"]')", 3000);
  const box = await t.js(`(() => { const r = document.querySelector('[data-px-key="size:large"]').getBoundingClientRect();
    return { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight }; })()`);
  const sizeBefore = await t.js("window.playpexDev && document.querySelector('[data-px-key=\"size:large\"]').closest('px-chip').getAttribute('ng-reflect-selected')");
  ws.json({ type: 'pointer', phase: 'move', x: box.x, y: box.y - 0.01 });
  await t.wait(150);
  ws.json({ type: 'pointer', phase: 'move', x: box.x, y: box.y });
  await t.wait(300);
  t.check('the remote pointer is drawn', await t.js("!!document.querySelector('remote-overlay .pointer')"));
  t.check('the system cursor is hidden meanwhile', await t.js("document.body.classList.contains('remote-pointer')"));
  t.check('hovering focuses the chip', (await t.focused()).key == 'size:large', await t.focused());
  ws.json({ type: 'pointer', phase: 'down', button: 'left' });
  ws.json({ type: 'pointer', phase: 'up', button: 'left' });
  await t.wait(600);
  t.check('the click chose it', await t.js("document.querySelector('[data-px-key=\"size:large\"]').closest('px-chip').querySelector('.selected, [aria-pressed=true], [aria-checked=true]') != null || document.querySelector('[data-px-key=\"size:large\"]').matches('.selected, [aria-pressed=true], [aria-checked=true]')"),
    { before: sizeBefore, html: await t.js("document.querySelector('[data-px-key=\"size:large\"]').outerHTML.slice(0, 200)") });
  t.check('the cursor comes back to the controller', !!ws.got.find(m => m.type == 'cursor'), ws.got.map(m => m.type));
  await t.shot('remote-pointer');
  // put the subtitle size back
  await t.js(`(async () => fetch(window.playpexDev.api + '/settings/device', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': window.playpexDev.deviceId }, body: JSON.stringify({ 'subtitles.size': null }) }))()`);

  // text: the search page's keyboard
  await t.dev("open({ screen: 'core.search' })");
  await t.until("document.querySelector('text-keyboard')", 5000);
  await t.wait(500);
  ws.json({ type: 'text', text: 'dune' });
  t.check('typed text arrives in the search keyboard', await t.until("document.querySelector('text-keyboard')?.textContent.toLowerCase().includes('dune')", 3000),
    await t.js("document.querySelector('text-keyboard')?.textContent.slice(0, 120)"));

  // the keyboard is the device's open field: the controller heard it open, and its text changes
  const opened = ws.got.find(m => m.type == 'field' && m.open);
  t.check('the open keyboard reaches the controller as a field', !!opened && opened.kind == 'search' && !!opened.id, ws.got.filter(m => m.type == 'field'));
  t.check('and its text typed on the TV follows', !!await until(() => ws.got.find(m => m.type == 'field' && m.open && /dune/i.test(m.value))),
    ws.got.filter(m => m.type == 'field'));
  // the controller's own keyboard: the whole text replaces the TV's, never echoed back
  const fieldsBefore = ws.got.filter(m => m.type == 'field').length;
  ws.json({ type: 'field', id: opened && opened.id, value: 'blade runner' });
  t.check('the controller\'s text replaces the keyboard\'s', await t.until("document.querySelector('text-keyboard .textDisplay')?.textContent.trim() == 'blade runner'", 3000),
    await t.js("document.querySelector('text-keyboard .textDisplay')?.textContent"));
  t.check('the TV shows a remote is connected', await t.js("!!document.querySelector('text-keyboard .remoteHint')"));
  await t.shot('remote-field');
  await t.wait(400);
  t.check('not echoed back', ws.got.filter(m => m.type == 'field').length == fieldsBefore, ws.got.filter(m => m.type == 'field').slice(fieldsBefore));
  // another field's text is dropped
  ws.json({ type: 'field', id: 'f-old', value: 'wrong' });
  await t.wait(400);
  t.check('a closed field\'s text is dropped', await t.js("document.querySelector('text-keyboard .textDisplay')?.textContent.trim() == 'blade runner'"));
  // Enter on the phone: the keyboard's Done (the search runs), and the controller hears it closed
  ws.json({ type: 'field', id: opened && opened.id, value: 'blade runner', submit: true });
  t.check('submit is the keyboard\'s Done', await t.until("!document.querySelector('text-keyboard')", 3000));
  t.check('the controller hears the field closed', !!await until(() => ws.got.find(m => m.type == 'field' && m.open === false && m.id == (opened && opened.id))));
  t.check('the search ran with it', await t.until("document.querySelector('px-search-field')?.textContent.toLowerCase().includes('blade runner')", 3000),
    await t.js("document.querySelector('px-search-field')?.textContent"));
  await t.wait(400);

  // the controller leaves: the badge goes
  ws.json({ type: 'bye' });
  t.check('the badge goes with the controller', await t.until("!document.querySelector('remote-overlay .badge')", 3000));

  // ── 2. session commands ──────────────────────────────────────────────────
  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('plays', await t.until(`${video}?.currentTime > 2 && !${video}.paused`, 20000));
  const session = await until(async () => (await admin('GET', '/sessions')).body.filter(s => s.deviceId == device && s.playback)[0], 5000);
  t.check('its session, at once (first keepalive)', !!session, (await admin('GET', '/sessions')).body);
  t.check('the session takes commands', session && session.control.playback, session && session.control);
  if (!session) return;

  let r = await admin('POST', '/sessions/' + session.id + '/commands', { action: 'pause' });
  t.check('pause delivered', r.status == 202, r);
  t.check('the player paused', await t.until(`${video}.paused`, 3000));
  t.check('the dashboard sees it paused within a second or two', !!await until(async () =>
    (await admin('GET', '/sessions')).body.find(s => s.id == session.id && s.playback.paused), 2500));

  r = await admin('POST', '/sessions/' + session.id + '/commands', { action: 'seek', positionS: 30 });
  t.check('seek delivered', r.status == 202, r);
  t.check('the player is at 30 s', await t.until(`Math.abs(${video}.currentTime - 30) < 1.5`, 3000), await t.js(`${video}.currentTime`));

  r = await admin('POST', '/sessions/' + session.id + '/commands', { action: 'resume' });
  t.check('the player plays again', await t.until(`!${video}.paused`, 3000));

  r = await admin('POST', '/sessions/' + session.id + '/commands', { action: 'seekBy', deltaS: -10 });
  t.check('seekBy −10 s', await t.until(`${video}.currentTime < 25`, 3000), await t.js(`${video}.currentTime`));

  r = await admin('DELETE', '/sessions/' + session.id);
  t.check('stop accepted', r.status == 200, r);
  t.check('the player closed', await t.until("!document.querySelector('.moviePlayer')", 4000));
  t.check('with a toast', await t.until("document.querySelector('px-toast-host')?.textContent.includes('stopped from the server')", 2000));
  t.check('the session is gone (released by the player, before the 5 s cut)', !!await until(async () =>
    !(await admin('GET', '/sessions')).body.find(s => s.id == session.id), 3000));

  // ── Settings: off ────────────────────────────────────────────────────────
  await t.js(`(async () => fetch(window.playpexDev.api + '/settings/device', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': window.playpexDev.deviceId }, body: JSON.stringify({ 'remote.allowed': false }) }))()`);
  t.check('turned off: no longer a target', !!await until(async () =>
    !(await admin('GET', '/remote/targets')).body.find(x => x.deviceId == device), 4000));
  await t.js(`(async () => fetch(window.playpexDev.api + '/settings/device', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': window.playpexDev.deviceId }, body: JSON.stringify({ 'remote.allowed': null }) }))()`);
  t.check('on again: a target again', !!await until(async () =>
    (await admin('GET', '/remote/targets')).body.find(x => x.deviceId == device), 6000));
};
