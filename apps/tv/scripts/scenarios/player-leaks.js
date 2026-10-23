'use strict';

// The player lets go of its video on every way out: leaving while it is still
// opening (the file's probe or the torrent answers after the player closed),
// and leaving while it plays. Every <video> that ever played is tracked (a
// detached one keeps playing its sound with nothing on screen), and nothing
// may navigate after the player is gone.
// Needs a server with a library file: PLAYPEX_TEST_REF=f_<media_files.id> --server <url>

module.exports = async function (t) {
  const ref = process.env.PLAYPEX_TEST_REF;
  if (!ref) throw new Error('set PLAYPEX_TEST_REF to a media ref of a file on the server (f_…)');
  await t.dev('profile()');
  // every <video> play() was called on; /probe answers 1.5 s late (as a torrent's file does)
  await t.js(`(() => {
    window.__videos = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (!window.__videos.includes(this)) window.__videos.push(this); return play.call(this); };
    const fetch0 = window.fetch;
    window.fetch = (url, ...rest) => /\\/probe/.test(String(url)) ? new Promise(r => setTimeout(r, 1500)).then(() => fetch0(url, ...rest)) : fetch0(url, ...rest);
    return true;
  })()`);
  const playing = "window.__videos.filter(v => !v.paused || v.getAttribute('src')).length";
  const home = await t.dev('screen()');

  // 1. out while it opens
  await t.dev(`player(${JSON.stringify(ref)})`);
  await t.until("window.playpexDev.screen() == 'core.player'", 4000);
  await t.wait(300);
  await t.dev("input('back')");
  await t.until("window.playpexDev.screen() != 'core.player'", 4000);
  await t.wait(3000);
  t.check('left while opening: no video plays or holds a stream', await t.js(playing) === 0,
    { videos: await t.js('window.__videos.length'), playing: await t.js(playing) });
  t.check('… and nothing navigated afterwards', (await t.dev('screen()')) === home, { screen: await t.dev('screen()') });

  // 2. out while it plays
  await t.dev(`player(${JSON.stringify(ref)})`);
  t.check('plays', await t.until("document.querySelector('.moviePlayer')?.currentTime > 0.5", 15000));
  const before = await t.js('window.__videos.length');
  await t.dev("input('back')");
  await t.until("window.playpexDev.screen() != 'core.player'", 4000);
  await t.wait(1500);
  t.check('left while playing: stopped, its stream let go', await t.js(playing) === 0,
    { videos: before, playing: await t.js(playing) });
  t.check('… and nothing navigated afterwards', (await t.dev('screen()')) === home, { screen: await t.dev('screen()') });
};
