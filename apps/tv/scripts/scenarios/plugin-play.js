'use strict';

// The server's plugins in Play (docs/plugins-plan.md step P3): the Play
// chooser says what a plugin hid and why, a plugin's question is asked before
// playing, and the player shows "Skip intro" where a plugin marked the intro
// (OK skips to its end).
// Needs a server in plugin developer mode with a plugin like
// apps/server's test "markers-test" (play.collect: three magnets, one HEVC
// and one labelled ASK; play.rank: hides HEVC; play.before: asks for ASK;
// player.markers: intro 3–40 s, credits 15 s before the end; metadata.title: a
// score labelled "Testmeta"), and a clip of exactly a minute (Up next's check)
// a minute or more: PLAYPEX_TEST_CLIP=file:///…/clip.mp4 --server <url>

module.exports = async function (t) {
  const clip = process.env.PLAYPEX_TEST_CLIP;
  if (!clip) throw new Error('set PLAYPEX_TEST_CLIP to a video file URL (a minute or more)');
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.settings' })");
  await t.wait(800);
  const query = JSON.stringify({ kind: 'movie', tmdbId: 949, title: 'Heat', year: 1995 });
  const picker = "document.querySelector('#playChooser')";

  // 1. the chooser: two torrents, the HEVC one hidden with its reason
  await t.dev(`sources(${query})`);
  t.check('the Play chooser opens', await t.until(picker, 8000));
  await t.wait(400);
  const text = await t.js(`${picker}.innerText`);
  t.check('two sources offered', (await t.js(`${picker}.querySelectorAll('button.choice:not(.more)').length`)) === 2, { text });
  t.check('"Hidden by Markers Test: HEVC" is said', /Hidden by Markers Test: HEVC/.test(text), { text });
  await t.shot('picker-hidden');
  await t.key('Return');
  t.check('the first plays without a question', await t.until("window.playpexDev.chosen()?.id == 'torrent:' + '1'.repeat(40)", 4000),
    { chosen: await t.dev('chosen()') });

  // 2. the plugin asks before the ASK one
  await t.dev(`sources(${query})`);
  await t.until(picker, 8000);
  await t.wait(400);
  await t.key('Down');
  await t.key('Return');
  const question = await t.until("[...document.querySelectorAll('px-dialog')].find(d => /Play the 720p one/.test(d.innerText))", 4000);
  t.check('the plugin\'s question is asked', !!question);
  await t.shot('plugin-question');
  await t.key('Return');
  t.check('… and yes plays it', await t.until("window.playpexDev.chosen()?.id == 'torrent:' + '2'.repeat(40)", 4000),
    { chosen: await t.dev('chosen()') });

  // 3. Skip intro in the player, between 3 and 40 s
  await t.dev(`player(${JSON.stringify(clip)})`);
  t.check('plays', await t.until("document.querySelector('.moviePlayer')?.currentTime > 0.5", 15000));
  t.check('"Skip intro" shows in the intro', await t.until("document.querySelector('.skip')?.innerText.includes('Skip intro')", 8000),
    { time: await t.js("document.querySelector('.moviePlayer')?.currentTime") });
  await t.shot('skip-intro');
  await t.key('Return');
  t.check('OK skips to the intro\'s end', await t.until("document.querySelector('.moviePlayer')?.currentTime >= 39", 5000),
    { time: await t.js("document.querySelector('.moviePlayer')?.currentTime") });
  t.check('… and the button is gone', await t.until("!document.querySelector('.skip')", 3000));
  await t.dev("input('back')");
  await t.wait(800);

  // 4. a plugin's score on a title's meta line (metadata.title; needs TMDB for the page)
  await t.dev("open({ screen: 'core.movie', params: { id: 949 } })");
  t.check('the plugin\'s score shows on the title', await t.until("document.body.innerText.includes('Testmeta')", 12000));
  await t.shot('title-meta');

  // 5. Up next from the credits (15 s before the end here), not the last 40 s (needs TMDB for the next episode)
  await t.dev(`player(${JSON.stringify(clip)}, 'episode')`);
  t.check('the episode plays', await t.until("document.querySelector('.moviePlayer')?.currentTime > 0.5", 15000));
  await t.js("document.querySelector('.moviePlayer').currentTime = 22, true");
  await t.wait(2500);
  t.check('no Up next 35 s before the end', !(await t.js("!!document.querySelector('.upNext')")));
  await t.js("document.querySelector('.moviePlayer').currentTime = 47, true");
  t.check('Up next from the credits', await t.until("!!document.querySelector('.upNext')", 8000),
    { time: await t.js("document.querySelector('.moviePlayer')?.currentTime") });
  await t.wait(1000);   // the hidden window's capture lags a frame or two
  await t.shot('up-next-credits');
  await t.dev("input('back')");
};
