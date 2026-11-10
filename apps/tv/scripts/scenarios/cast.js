'use strict';

// Casting (docs/cast-plan.md §4.2): this scenario plays a phone's part (a
// sender, device `phone-scenario` on loopback) against a real Playpex TV:
//   1. the TV is a cast screen (GET /cast/screens);
//   2. a library file cast to it opens the player at the asked position, as the
//      asked profile, saying who cast it; the sender's events socket
//      follows it (cast.updated: its session, playing, its position);
//   3. the sender pauses, seeks and resumes it (POST /cast/{id}/commands);
//   4. a second cast replaces the player (one player in the history), the
//      first cast ends;
//   5. stop closes the player, the cast ends;
//   6. Settings › Casting off: the TV is no screen any more (back on after);
//   8. the TV as a sender: another screen (a fake one, `screen-scenario`)
//      shows in the player's "Play on another screen"; OK hands the playback
//      over (that screen gets cast.play with the file, the position and the
//      profile) and the TV's player closes;
//   7. with PLAYPEX_TEST_YOUTUBE=1 (needs the internet): a YouTube video cast
//      plays in the embed player and reports its own state; pause reaches it.
// Needs a throwaway server with a library file that plays here (H.264 / AAC):
//   PLAYPEX_TEST_REF=f_… npx electron scripts/scenario.js cast --server http://127.0.0.1:28480

const WebSocket = require('ws');

const video = "document.querySelector('.moviePlayer')";
const PHONE = 'phone-scenario';

function serverUrl() {
  const i = process.argv.indexOf('--server');
  return process.argv[i + 1].replace(/\/+$/, '');
}

function phone(method, path, body) {
  return fetch(serverUrl() + '/api/v1' + path, {
    method,
    headers: Object.assign({ 'X-Playpex-Device': PHONE, 'X-Playpex-Client': 'playpex-mobile/0.0.0; api=1' },
      body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: /json/.test(r.headers.get('content-type') || '') ? await r.json() : null }));
}

function events() {
  const ws = new WebSocket(serverUrl().replace(/^http/, 'ws') + '/api/v1/events?topics=cast&device=' + PHONE);
  ws.got = [];
  ws.on('message', data => ws.got.push(JSON.parse(String(data))));
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

module.exports = async function (t) {
  const ref = process.env.PLAYPEX_TEST_REF;
  if (!ref) throw new Error('set PLAYPEX_TEST_REF (a library file of the --server)');
  const name = await t.dev('profile()');
  const device = await t.js('window.playpexDev.deviceId');
  const all = (await phone('GET', '/profiles')).body.profiles;
  const profileId = (all.find(p => p.name == name) || all.find(p => !p.isKid) || all[0]).id;
  const ws = events();
  await ws.ready;
  const screen = () => phone('GET', '/cast/screens').then(r => r.body.find(s => s.deviceId == device));

  // ── 1. a screen ─────────────────────────────────────────────────────────
  const listed = await until(screen, 6000);
  t.check('the TV is a cast screen', !!listed, (await phone('GET', '/cast/screens')).body);
  t.check('it plays files, torrents and embeds', listed && listed.accepts.media && listed.accepts.magnet && listed.accepts.embed, listed);
  t.check('it is a tv', listed && listed.kind == 'tv', listed);

  // ── 2. a file ───────────────────────────────────────────────────────────
  let r = await phone('POST', '/cast/screens/' + device + '/play',
    { title: 'Cast test', subtitle: 'A library file', source: { ref }, positionS: 12, profileId });
  t.check('the cast is delivered', r.status == 202 && r.body.delivered >= 1, r);
  const castId = r.body && r.body.castId;
  t.check('the player opens', await t.until(`window.playpexDev.screen() == 'core.player' && ${video}?.readyState >= 2`, 15000),
    await t.js('window.playpexDev.stack()'));
  t.check('the player says who cast it, as whom', await t.until("document.querySelector('.castFrom')?.textContent.includes('Cast from Playpex Mobile · ' + " + JSON.stringify(name) + ")", 3000),
    await t.js("document.querySelector('.castFrom')?.textContent"));
  t.check('at the asked position', await t.until(`Math.abs(${video}.currentTime - 12) < 3`, 6000), await t.js(`${video}.currentTime`));
  await t.shot('cast-playing');
  const playing = await until(() => ws.got.find(m => m.topic == 'cast.updated' && m.data.castId == castId && m.data.sessionId && m.data.state == 'playing'), 5000);
  t.check('the sender follows it: its session, playing', !!playing, ws.got.map(m => m.topic + ' ' + m.data.state));

  // ── 3. driven by the sender ─────────────────────────────────────────────
  // (a player takes commands once it's ready)
  await t.until("document.querySelector('.player')?.classList.contains('ready')", 6000);
  r = await phone('POST', '/cast/' + castId + '/commands', { action: 'pause' });
  t.check('pause delivered', r.status == 202, r);
  t.check('the player paused', await t.until(`${video}.paused`, 3000));
  t.check('the sender sees it paused', !!await until(() => ws.got.find(m => m.topic == 'cast.updated' && m.data.castId == castId && m.data.state == 'paused'), 3000));
  r = await phone('POST', '/cast/' + castId + '/commands', { action: 'seek', positionS: 30 });
  t.check('the player is at 30 s', await t.until(`Math.abs(${video}.currentTime - 30) < 1.5`, 4000), await t.js(`${video}.currentTime`));
  r = await phone('POST', '/cast/' + castId + '/commands', { action: 'resume' });
  t.check('it plays again', await t.until(`!${video}.paused`, 3000));
  r = await phone('POST', '/cast/' + castId + '/commands', { action: 'pause' }).then(() =>
    fetch(serverUrl() + '/api/v1/cast/' + castId + '/commands', { method: 'POST', headers: { 'X-Playpex-Device': 'stranger', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }) }));
  t.check('another device may not drive it', r.status == 403, r.status);

  // ── 4. a new cast replaces it ───────────────────────────────────────────
  r = await phone('POST', '/cast/screens/' + device + '/play', { title: 'Second cast', source: { ref }, positionS: 0, profileId });
  const second = r.body && r.body.castId;
  t.check('the second cast is delivered', r.status == 202, r);
  t.check('the first one ended', !!await until(() => ws.got.find(m => m.topic == 'cast.ended' && m.data.castId == castId), 3000));
  t.check('its title shows', await t.until("document.querySelector('app-player-page')?.textContent.includes('Second cast')", 6000));
  t.check('one player in the history', (await t.js('window.playpexDev.stack()')).filter(s => s == 'core.player').length == 1,
    await t.js('window.playpexDev.stack()'));
  await t.until(`${video}?.readyState >= 2`, 10000);

  // ── 5. stop ─────────────────────────────────────────────────────────────
  await until(() => ws.got.find(m => m.topic == 'cast.updated' && m.data.castId == second && m.data.sessionId), 5000);
  r = await phone('POST', '/cast/' + second + '/commands', { action: 'stop' });
  t.check('stop delivered', r.status == 202, r);
  t.check('the player closed', await t.until("window.playpexDev.screen() != 'core.player'", 5000), await t.js('window.playpexDev.stack()'));
  t.check('the cast ended', !!await until(() => ws.got.find(m => m.topic == 'cast.ended' && m.data.castId == second), 3000));

  // ── 6. Settings › Casting ───────────────────────────────────────────────
  const api = await t.js('window.playpexDev.api');
  const setCast = on => t.js(`fetch(${JSON.stringify(api)} + '/settings/device?device=' + window.playpexDev.deviceId, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'cast.allowed': ${on} }) }).then(r => r.status)`);
  t.check('casting turned off', (await setCast(false)) < 300);
  t.check('no screen any more', !!await until(async () => !(await screen()), 6000));
  r = await phone('POST', '/cast/screens/' + device + '/play', { title: 'Refused', source: { ref } });
  t.check('a cast is refused: offline', r.status == 409, r);
  await setCast(true);
  t.check('a screen again', !!await until(screen, 6000));

  // ── 8. the TV as a sender ───────────────────────────────────────────────
  const other = new WebSocket(serverUrl().replace(/^http/, 'ws') +
    '/api/v1/events?control=playback,cast&accepts=media,magnet&device=screen-scenario');
  other.got = [];
  other.on('message', data => other.got.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { other.on('open', resolve); other.on('error', reject); });
  r = await phone('POST', '/cast/screens/' + device + '/play', { title: 'Hand over', source: { ref }, positionS: 40, profileId });
  t.check('playing again to hand over', await t.until(`window.playpexDev.screen() == 'core.player' && ${video}?.readyState >= 2 && !${video}.paused`, 15000));
  t.check('the cast button shows', await t.until("!!document.querySelector('[data-px-key=\"cast\"]')", 6000),
    await t.js("[...document.querySelectorAll('.buttons [data-px-key]')].map(e => e.dataset.pxKey)"));
  await t.until("document.querySelector('.player')?.classList.contains('ready')", 6000);
  // the controls up (a key while they're hidden only brings them), then the button
  if (!await t.js("document.querySelector('.player').classList.contains('controlsShown')")) await t.key('Down');
  t.check('the controls show', await t.until("document.querySelector('.player').classList.contains('controlsShown')", 3000));
  await t.click('[data-px-key="cast"]');
  t.check('its panel lists the other screen', await t.until("!!document.querySelector('[data-px-key=\"screen:screen-scenario\"]')", 4000),
    await t.js("document.querySelector('#playerCast')?.textContent"));
  t.check('and not the TV itself', await t.js(`!document.querySelector('[data-px-key="screen:${device}"]')`));
  await t.shot('cast-play-on');
  t.check('the screen is focused', (await t.focused()).key == 'screen:screen-scenario', await t.focused());
  await t.key('Return');
  const handed = await until(() => other.got.find(m => m.topic == 'cast.play'), 5000);
  t.check('the other screen gets the cast', !!handed, other.got.map(m => m.topic));
  const req = handed && handed.data.request;
  t.check('the same file', req && req.source && req.source.ref == ref, req);
  t.check('from where it was', req && req.positionS >= 40 && req.positionS < 60, req && req.positionS);
  t.check('as the same profile', handed && handed.data.profileId == profileId, handed && handed.data.profileId);
  t.check('from the TV', handed && /TV|Playpex/.test(handed.data.from.name), handed && handed.data.from);
  t.check('the TV’s player closed', await t.until("window.playpexDev.screen() != 'core.player'", 5000), await t.js('window.playpexDev.stack()'));
  other.close();

  // ── 7. YouTube ──────────────────────────────────────────────────────────
  if (process.env.PLAYPEX_TEST_YOUTUBE == '1') {
    r = await phone('POST', '/cast/screens/' + device + '/play', { title: 'A YouTube video', source: { embed: { provider: 'youtube', id: 'aqz-KE-bpKQ' } }, profileId });
    const yt = r.body && r.body.castId;
    t.check('the YouTube cast is delivered', r.status == 202, r);
    t.check('the embed player shows', await t.until("!!document.querySelector('.embedPlayer')", 6000));
    t.check('it reports playing', !!await until(() => ws.got.find(m => m.topic == 'cast.updated' && m.data.castId == yt && m.data.state == 'playing'), 20000),
      ws.got.filter(m => m.data.castId == yt));
    await t.shot('cast-youtube');
    r = await phone('POST', '/cast/' + yt + '/commands', { action: 'pause' });
    t.check('pause reaches the embed', !!await until(() => ws.got.find(m => m.topic == 'cast.updated' && m.data.castId == yt && m.data.state == 'paused'), 5000));
    await phone('POST', '/cast/' + yt + '/commands', { action: 'stop' });
    t.check('stop closes it', await t.until("window.playpexDev.screen() != 'core.player'", 5000));
  }
  ws.close();
};
