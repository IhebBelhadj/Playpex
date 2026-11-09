'use strict';

// A stream with several qualities (a plugin's HLS master playlist): the
// player's Settings › Video shows Quality (Auto + each height, highest first),
// a choice switches the picture and is kept as the device setting
// player.streamQuality, the next stream starts at it, Auto chooses again.
// Needs a server with a plugin stream of several heights, as an h_ ref:
//   PLAYPEX_TEST_HLS=h_… npx electron scripts/scenario.js stream-quality --server http://127.0.0.1:28491

const player = "ng.getComponent(document.querySelector('app-player-page'))";
const video = "document.querySelector('.moviePlayer')";

function serverUrl() {
  const i = process.argv.indexOf('--server');
  return process.argv[i + 1].replace(/\/+$/, '');
}

async function deviceSetting(key) {
  const r = await fetch(serverUrl() + '/api/v1/settings', { headers: { 'X-Playpex-Device': 'tv-scenario' } });
  return (await r.json()).device[key];
}

async function chip(t, key) {
  await t.js(`window.SpatialNavigation.focus(document.querySelector('[data-px-key="${key}"]'))`);
  await t.key('Return');
}

module.exports = async function (t) {
  const ref = process.env.PLAYPEX_TEST_HLS;
  if (!ref) throw new Error('set PLAYPEX_TEST_HLS');
  await t.dev('profile()');
  // start from Auto
  await fetch(serverUrl() + '/api/v1/settings/device', { method: 'PATCH', headers: { 'Content-Type': 'application/json',
    'X-Playpex-Device': 'tv-scenario' }, body: JSON.stringify({ 'player.streamQuality': null }) });
  await t.wait(500);

  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('the stream plays', await t.until(`${video}?.currentTime > 2 && !${video}.paused`, 30000));
  const qualities = await t.js(`${player}.qualities.map(q => q.label)`);
  t.check('its qualities, highest first', qualities.length >= 2 && parseInt(qualities[0]) > parseInt(qualities[qualities.length - 1]), qualities);

  await t.js(`${player}.openSettings('video')`);
  t.check('Settings › Video shows Quality', await t.until("document.querySelector('[data-px-key=\"quality:auto\"]')", 3000));
  t.check('Auto is chosen and says what plays', await t.until("/^Auto · \\d+p|^Auto · 4K/.test(document.querySelector('[data-px-key=\"quality:auto\"]')?.textContent.trim())", 8000),
    await t.js("document.querySelector('[data-px-key=\"quality:auto\"]')?.textContent.trim()"));
  t.check('a chip per quality', (await t.js("document.querySelectorAll('[data-px-key^=\"quality:\"]').length")) == qualities.length + 1);
  await t.shot('stream-quality');

  // the lowest one: the picture changes to it
  const low = await t.js(`${player}.qualities[${player}.qualities.length - 1]`);
  await chip(t, 'quality:' + low.key);
  t.check('the chip is chosen', await t.until(`${player}.quality == ${JSON.stringify(low.key)}`, 2000));
  t.check('the picture switches to ' + low.label, await t.until(`${video}.videoHeight == ${parseInt(low.key)}`, 20000),
    await t.js(`${video}.videoHeight`));
  t.check('still playing', await t.until(`!${video}.paused && ${video}.currentTime > 0`, 3000));
  t.check('kept as the device setting', await deviceSetting('player.streamQuality') == low.key, await deviceSetting('player.streamQuality'));

  // the next stream starts at it
  await t.key('Escape');
  await t.wait(300);
  await t.key('Escape');
  await t.until("!document.querySelector('.moviePlayer')", 5000);
  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('the next stream plays', await t.until(`${video}?.currentTime > 1 && !${video}.paused`, 30000));
  t.check('and starts at the kept quality', await t.until(`${player}.quality == ${JSON.stringify(low.key)} && ${video}.videoHeight == ${parseInt(low.key)}`, 15000),
    await t.js(`[${player}.quality, ${video}.videoHeight]`));

  // Auto again: the player chooses (here the highest, on loopback)
  await t.js(`${player}.openSettings('video')`);
  await t.until("document.querySelector('[data-px-key=\"quality:auto\"]')", 3000);
  await chip(t, 'quality:auto');
  t.check('Auto chosen', await t.until(`${player}.quality == 'auto'`, 2000));
  t.check('kept as auto', await deviceSetting('player.streamQuality') == 'auto');
  t.check('the picture goes up again', await t.until(`${video}.videoHeight > ${parseInt(low.key)}`, 30000), await t.js(`${video}.videoHeight`));
};
