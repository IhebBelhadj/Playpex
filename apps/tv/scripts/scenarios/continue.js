'use strict';

// Continue watching (docs/rows-plan.md step 3): on Home, each card says where
// it is on its picture ("S1 E5 · 1 h 12 min left", "Next: S2 E1", "20 min left");
// focused, the info on top has the resume line (with the episode's name) and
// the amber line; Enter on a show's card opens that episode's page (Resume
// there), not the show's; the show's page then plays from there ("Resume S1
// E5" / "Play S2 E1"). Needs a profile with a show and a movie in progress;
// reads only.

module.exports = async function (t) {
  await t.dev(`profile(${JSON.stringify(process.env.PLAYPEX_TEST_PROFILE || '')} || undefined)`);
  await t.dev("reset({ screen: 'core.home' })");
  t.check('Home has rows', await t.until("document.querySelectorAll('movies-slider px-card-row .px-card').length > 5", 20000));
  await t.wait(2500);
  const row = await t.js("ng.getComponent(document.querySelector('movies-page')).catalog.rows.find(r => r.kind == 'progress')?.key");
  t.check('a Continue watching row', !!row);
  if (!row) return;
  const cards = `Array.from(document.querySelectorAll('[data-section="${row}"]'))`;
  const feet = await t.js(`${cards}.map(c => c.querySelector('.foot')?.textContent.trim() || '')`);
  t.check('every card says where it is', feet.length && feet.every(f => /min left|h left|^Next: S\d+ E\d+|Watch again/.test(f)), feet);
  t.check('a show\'s card names its episode', feet.some(f => /^(S\d+ E\d+ · |Next: S\d+ E\d+)/.test(f)), feet);

  // a show's card: its resume line, then Enter
  const index = await t.js(`${cards}.findIndex(c => /^(S\\d+ E\\d+ · |Next: )/.test(c.querySelector('.foot')?.textContent.trim() || ''))`);
  await t.js("window.SpatialNavigation.focus(document.querySelector('movies-slider px-card-row .px-card'))");
  await t.wait(400);
  for (let i = 0; i < 10 && await t.js(`document.activeElement?.dataset?.section != "${row}"`); i++) await t.key('Down');
  await t.key('Right', index);
  const foot = await t.js("document.activeElement.querySelector('.foot')?.textContent.trim()");
  t.check('the info on top: the resume line', await t.until("/^(Resume S\\d+ E\\d+|Up next: S\\d+ E\\d+)/.test(document.querySelector('movie-description px-title-info')?.innerText.split('\\n').find(l => /^(Resume|Up next)/.test(l)) || '')", 6000),
    await t.js("document.querySelector('movie-description px-title-info')?.innerText"));
  t.check('… with the episode\'s name', await t.until("/“.+”/.test(document.querySelector('movie-description px-title-info')?.innerText || '')", 6000));
  await t.shot('continue-home');
  const m = /S(\d+) E(\d+)/.exec(foot);
  await t.key('Return');
  t.check('Enter: the episode\'s page, not the show\'s', await t.until("/shows\\/show\\/\\d+\\/season\\/\\d+\\/episode\\/\\d+/.test(location.hash + location.pathname)", 10000), await t.js('location.hash'));
  const url = await t.js('location.hash + location.pathname');
  if (m && /·/.test(foot)) t.check('… the one it was on', url.includes(`/season/${m[1]}/episode/${m[2]}`), { url, foot });
  if (m && /^Next/.test(foot)) t.check('… the one after', url.includes(`/season/${m[1]}/episode/${m[2]}`), { url, foot });
  await t.wait(2500);
  await t.shot('continue-episode');

  // the show's page: Play goes back there
  const show = /shows\/show\/(\d+)/.exec(url)[1];
  await t.dev(`open({ screen: 'core.show', params: { id: '${show}' } })`);
  t.check('the show page\'s Play goes back to it', await t.until(`/^(Resume S\\d+ E\\d+|Play S\\d+ E\\d+)/.test(document.querySelector('[data-px-key="play"]')?.innerText.trim() || '')`, 10000),
    await t.js("document.querySelector('[data-px-key=\"play\"]')?.innerText.trim()"));
  if (m) t.check('… that episode', await t.js(`/S${m[1]} E${m[2]}/.test(document.querySelector('[data-px-key="play"]')?.innerText || '')`), await t.js("document.querySelector('[data-px-key=\"play\"]')?.innerText.trim()"));
  await t.shot('continue-show');
};
