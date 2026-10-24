'use strict';

// The Play chooser (docs/providers-plan.md §5.2, §10.2): the ways to play in
// lanes (On this server / Stream / Torrent), each lane's best first and how
// soon it plays, "All N torrents" in place (Back returns to its line), Back
// closes, Enter plays the focused one; Download offers torrents only; with
// nothing to play, the panel says where sources come from.
// Needs a server in plugin developer mode with a plugin like this one in
// <config>/plugins-dev/chooser-test/ (play.collect, sources magnet + http,
// network: stream.playpex-test.dev):
//   three magnets (1080p 312 seeds, 720p 4 seeds, 2160p x265 HDR 80 seeds)
//   and one http source (1080p) — no network is used until something plays —
//   and nothing for a title named "Nothing".
//   npx electron scripts/scenario.js play-chooser --server http://127.0.0.1:28480

module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.settings' })");
  await t.wait(800);
  const heat = JSON.stringify({ kind: 'movie', tmdbId: 949, title: 'Heat', year: 1995 });
  const panel = "document.querySelector('#playChooser')";
  const lanes = `[...${panel}.querySelectorAll('.laneName')].map(e => e.textContent.trim())`;

  // 1. the lanes: Stream then Torrent, best first, a second torrent of another quality, the rest behind "All 3"
  await t.dev(`sources(${heat})`);
  t.check('the chooser opens', await t.until(panel, 8000));
  await t.wait(500);
  t.check('lanes Stream, Torrent', JSON.stringify(await t.js(lanes)) === '["Stream","Torrent"]', await t.js(lanes));
  const text = await t.js(`${panel}.innerText`);
  t.check('the title says what plays', /Play Heat/.test(text), { text });
  t.check('the stream plays now', /1080p[\s\S]*Plays now/.test(text), { text });
  t.check('torrents say how soon', /Starts in seconds/.test(text) && /Few people sharing: may be slow/.test(text), { text });
  t.check('"All 3 torrents" is offered', /All 3 torrents/.test(text), { text });
  t.check('the 2160p HEVC isn\'t a lane line', !/2160p/.test(text), { text });
  t.check('the first line is focused', (await t.focused()).key?.startsWith('r_'), await t.focused());
  await t.shot('chooser-lanes');

  // 2. All 3 torrents in place, Back returns onto it
  await t.key('Down', 3);
  t.check('down to "All 3 torrents"', (await t.focused()).key === 'more:torrent', await t.focused());
  await t.key('Return');
  t.check('the full list replaces the lanes', await t.until(`${panel}.querySelector('.px-panel-title').textContent.includes('All 3 torrents')`, 2000));
  const all = await t.js(`${panel}.innerText`);
  t.check('… with the HEVC one and why it may not play', /2160p[\s\S]*May not play/.test(all), { all });
  t.check('… and release names', /Heat 2160p WEB x265 HDR/.test(all), { all });
  await t.shot('chooser-all');
  await t.key('Escape');
  t.check('Back returns to the lanes', await t.until(`!!${panel}.querySelector('.laneName')`, 2000));
  t.check('… on "All 3 torrents"', await t.until("document.activeElement?.dataset.pxKey == 'more:torrent'", 2000), await t.focused());
  await t.key('Escape');
  t.check('Back again closes it', await t.until(`!${panel}`, 2000));

  // 3. Enter plays the focused line (through /play/start)
  await t.dev(`sources(${heat})`);
  await t.until(panel, 8000);
  await t.wait(400);
  await t.key('Down');
  await t.key('Return');
  t.check('Enter picks the best torrent', await t.until("window.playpexDev.chosen()?.id == 'torrent:' + '1'.repeat(40)", 4000),
    { chosen: await t.dev('chosen()') });
  t.check('… and the chooser is gone', await t.until(`!${panel}`, 2000));

  // 4. nothing to play: the panel says where sources come from, Close is the only choice
  await t.dev(`sources(${JSON.stringify({ kind: 'movie', tmdbId: 1, title: 'Nothing' })})`);
  t.check('nothing found: the chooser still opens', await t.until(panel, 8000));
  await t.wait(400);
  const empty = await t.js(`${panel}.innerText`);
  t.check('… and says where sources come from', /Nothing to play this from yet/.test(empty) && /dashboard/.test(empty), { empty });
  t.check('… Close focused', (await t.focused()).key === 'close', await t.focused());
  await t.shot('chooser-empty');
  await t.key('Return');
  t.check('Close closes it', await t.until(`!${panel}`, 2000));
};
