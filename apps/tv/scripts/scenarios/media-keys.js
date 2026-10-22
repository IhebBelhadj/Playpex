'use strict';

// Media keys (§13.2) on the player with a local test clip: play / pause,
// forward / rewind (a preview, one seek), previous (from the start), stop
// (leaves); and the remote's Play key on a title page opens playback.
// Needs PLAYPEX_TEST_CLIP (a video file; e.g. ffmpeg -f lavfi -i testsrc=d=900 -f lavfi -i sine=d=900 clip.mp4).

module.exports = async function (t) {
  const clip = process.env.PLAYPEX_TEST_CLIP;
  if (!clip) throw new Error('set PLAYPEX_TEST_CLIP to a video file');
  await t.dev('profile()');
  await t.dev(`player(${JSON.stringify('file://' + clip)}, 'movie')`);
  t.check('the player is ready', await t.until("!!document.querySelector('.controls') && document.querySelector('.moviePlayer')?.readyState >= 3", 20000));
  await t.wait(2500);
  const video = "document.querySelector('.moviePlayer')";
  // Electron's sendInputEvent has no FastForward / Rewind key names: a DOM event
  const press = key => t.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`).then(() => t.wait(180));
  await t.js(`${video}.play()`);
  await t.wait(500);
  await t.key('MediaPlayPause');
  t.check('MediaPlayPause pauses', await t.js(`${video}.paused`));
  await t.key('MediaPlayPause');
  t.check('… and plays', await t.until(`!${video}.paused`, 2000));
  const before = await t.js(`${video}.currentTime`);
  for (let i = 0; i < 3; i++) await press('MediaFastForward');
  t.check('forward previews a scrub, no seek yet', await t.js(`Math.abs(${video}.currentTime - ${before}) < 3 && !!document.querySelector('.scrubber')`));
  await t.wait(1200);
  const after = await t.js(`${video}.currentTime`);
  t.check('… then seeks once, ahead', after > before + 20, { before, after });
  await t.key('MediaPreviousTrack');
  await t.wait(500);
  t.check('previous: from the start', await t.js(`${video}.currentTime < 3`));
  await t.key('MediaStop');
  t.check('stop leaves the player', await t.until("window.playpexDev.screen() != 'core.player'", 4000));

  await t.dev("open({ screen: 'core.movie', params: { id: 949 } })");
  await t.until("!!document.querySelector('[data-px-key=\"play\"]')", 10000);
  await t.wait(1500);
  await t.key('MediaPlayPause');
  const opened = await t.until("window.playpexDev.layers().length > 0 || document.querySelector('[data-px-key=\"play\"]')?.classList.contains('busy')", 6000);
  t.check('MediaPlayPause on a title page = Play (picker, choice or finding torrents)', opened);
  await t.dev("input('back')");
};
