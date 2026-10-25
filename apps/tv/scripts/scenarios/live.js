'use strict';

// Plugins' HLS and live streams in the player (docs/providers-plan.md step
// 8): an HLS VOD (an AES-128 TS variant and an fMP4 one) plays through
// hls.js with its timeline and seeks; a live HLS playlist and a continuous
// MPEG-TS (remuxed by the server's ffmpeg) play with the Live mark instead of
// a timeline, the arrows only bringing the controls; Back leaves each.
// Needs the throwaway server of apps/server/test/helpers/hls-server.js (its
// plugin `streamer` hands out the streams as play effects):
//   node apps/server/test/helpers/hls-server.js --port 28490
//   npx electron scripts/scenario.js live --server http://127.0.0.1:28490

const video = "document.querySelector('.moviePlayer')";
const player = "ng.getComponent(document.querySelector('app-player-page'))";

// A play effect's source from the test plugin: { ref, format }
async function stream(t, name) {
  return t.js(`fetch(window.playpexDev.api + '/plugins/streamer/data/${name}', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Playpex-Device': window.playpexDev.deviceId }, body: JSON.stringify({ args: {} }) })
    .then(r => r.json()).then(r => r.effects[0].request.sources[0])`);
}

async function leave(t) {
  await t.key('Escape');
  await t.key('Escape');
  await t.key('Escape');
  return t.until("!document.querySelector('app-player-page')", 5000);
}

module.exports = async function (t) {
  await t.dev('profile()');

  // ── an HLS VOD ───────────────────────────────────────────────────────────
  const vod = await stream(t, 'vod');
  t.check('the plugin\'s VOD is an h_ ref, format hls', /^h_/.test(vod.ref) && vod.format == 'hls', vod);
  await t.dev(`player(${JSON.stringify(vod.ref)})`);
  t.check('plays through hls.js', await t.until(`${video}?.currentTime > 2`, 20000), await t.js(`${video}?.currentTime`));
  await t.until(`${player}.playerReady`, 5000);
  t.check('… from a blob (Media Source), not a src URL', await t.js(`${video}.src.startsWith('blob:')`), await t.js(`${video}.src`));
  t.check('… its length from the playlist (12 s)', await t.js(`Math.abs(${video}.duration - 12) < 1.5`), await t.js(`${video}.duration`));
  t.check('no Live mark, a timeline', await t.js("!document.querySelector('.liveMark') && !!document.querySelector('.scrubber')"));
  await t.js(`${player}.seekTo(8)`);
  t.check('seeks (to 8 s)', await t.until(`${video}.currentTime >= 8`, 8000), await t.js(`${video}.currentTime`));
  await t.key('Down');
  await t.until("document.querySelector('.player.controlsShown')", 3000);
  await t.shot('live-vod');
  t.check('Back leaves', await leave(t));

  // ── a live HLS playlist ──────────────────────────────────────────────────
  const news = await stream(t, 'liveHls');
  t.check('a live playlist is an h_ ref too', /^h_/.test(news.ref) && news.format == 'hls', news);
  await t.dev(`player(${JSON.stringify(news.ref)})`);
  t.check('plays', await t.until(`${video}?.currentTime > 1`, 20000), await t.js(`${video}?.currentTime`));
  t.check('the player knows it\'s live (from the playlist)', await t.until(`${player}.live`, 5000));
  await t.until(`${player}.playerReady`, 5000);
  await t.key('Left');
  t.check('an arrow brings the controls, doesn\'t scrub', await t.until("document.querySelector('.player.controlsShown')", 3000) &&
    await t.js(`!${player}.scrub`));
  t.check('the Live mark, no timeline, no 10 s buttons', await t.js(
    "!!document.querySelector('.liveMark') && !document.querySelector('.scrubber') && !document.querySelector('[data-px-key=\"back10\"]')"));
  t.check('the focus on Play', (await t.focused()).key == 'play', await t.focused());
  const was = await t.js(`${video}.currentTime`);
  await t.wait(3000);
  t.check('keeps playing as the window moves', await t.js(`${video}.currentTime > ${was + 1.5}`), await t.js(`${video}.currentTime`));
  await t.shot('live-hls');
  t.check('Back leaves', await leave(t));

  // ── a continuous MPEG-TS ─────────────────────────────────────────────────
  const tv = await stream(t, 'live');
  t.check('a continuous stream is an l_ ref, format live', /^l_/.test(tv.ref) && tv.format == 'live', tv);
  await t.dev(`player(${JSON.stringify(tv.ref)})`);
  t.check('plays (Matroska from the server\'s ffmpeg)', await t.until(`${video}?.currentTime > 2`, 25000), await t.js(`${video}?.currentTime`));
  t.check('… on <video src>', await t.js(`${video}.src.includes('/media/${tv.ref}')`), await t.js(`${video}.src`));
  t.check('… with sound (its MP2 audio as AAC)', await t.js(`${video}.webkitAudioDecodedByteCount > 0`));
  await t.key('Down');
  t.check('the Live mark', await t.until("!!document.querySelector('.player.controlsShown .liveMark')", 3000));
  await t.shot('live-ts');
  t.check('Back leaves', await leave(t));
};
