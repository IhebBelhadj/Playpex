'use strict';

// A plugin's embed source (provider youtube, plugins/youtube): YouTube's
// IFrame player in the server's /embed/youtube page, under the player's own
// controls. It plays (time moves, the loading view goes), OK pauses and plays
// again, → scrubs and seeks there, the Settings panel has Audio and Video
// only, the frame never takes the focus, Back leaves and the frame goes.
// Needs the internet (YouTube) and a server on this machine:
//   npx electron scripts/scenario.js youtube --server http://127.0.0.1:28493
// PLAYPEX_TEST_YOUTUBE=<video id> to play another (default: Big Buck Bunny, the Blender Foundation's).

const player = "ng.getComponent(document.querySelector('app-player-page'))";
const embed = `${player}?.embed`;

module.exports = async function (t) {
  const id = process.env.PLAYPEX_TEST_YOUTUBE || 'aqz-KE-bpKQ';
  await t.dev('profile()');
  await t.wait(500);
  await t.dev(`open({ screen: 'core.player', params: { session: 'yt' + Date.now().toString(36) }, payload: { title: 'Big Buck Bunny', subtitle: 'Blender', tracking: 'none', embed: { provider: 'youtube', id: ${JSON.stringify(id)} } } })`);
  t.check('the frame is the server\'s embed page', await t.until("document.querySelector('iframe.embedPlayer')?.src.includes('/api/v1/embed/youtube?v=')", 5000),
    await t.js("document.querySelector('iframe.embedPlayer')?.src"));
  t.check('YouTube\'s player is ready and plays', await t.until(`${player}?.playerReady && ${embed}?.currentTime > 1 && !${embed}.paused`, 45000),
    await t.js(`({ ready: ${player}?.playerReady, time: ${embed}?.currentTime, paused: ${embed}?.paused, stages: ${player}?.stages })`));
  t.check('its length is known', await t.js(`${embed}.duration > 60`), await t.js(`${embed}.duration`));
  await t.shot('youtube-playing');

  t.check('the frame never has the focus', await t.js("document.activeElement?.tagName != 'IFRAME'"));
  await t.key('Return');
  t.check('OK pauses', await t.until(`${embed}.paused && ${player}.paused`, 5000));
  await t.shot('youtube-paused');
  await t.key('Return');
  t.check('OK plays again', await t.until(`!${embed}.paused`, 5000));

  // → with the controls hidden: a scrub, then one seek
  await t.js(`${player}.hideControls?.()`);
  await t.wait(300);
  const before = await t.js(`${embed}.currentTime`);
  await t.key('Right', 3);
  await t.wait(1500);
  const after = await t.js(`${embed}.currentTime`);
  t.check('→ ×3 seeks about 30 s ahead', after - before > 20 && after - before < 45, { before, after });

  await t.js(`${player}.openSettings()`);
  await t.wait(400);
  const tabs = await t.js("[...document.querySelectorAll('#playerSettings [data-px-key^=\"tab:\"]')].map(e => e.textContent.trim())");
  t.check('Settings: Audio and Video only', JSON.stringify(tabs) == JSON.stringify(['Audio', 'Video']), tabs);
  await t.key('Escape');
  await t.wait(300);

  await t.key('Escape');
  await t.key('Escape');
  t.check('Back leaves the player', await t.until("!document.querySelector('app-player-page')", 5000));
  t.check('the frame is gone', await t.js("!document.querySelector('iframe.embedPlayer')"));
};
