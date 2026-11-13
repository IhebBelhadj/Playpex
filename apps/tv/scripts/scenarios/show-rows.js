'use strict';

// A show's people and similar shows: the show page has a Cast row and a
// Similar shows row (the server's: TMDB's recommendations for shows); Enter
// on a similar show opens its page over this one, Back comes to the same card;
// an episode page has the show's seasons, its Cast above its Guest stars and
// Similar shows; a focused season shows its episodes there, Enter on one opens
// it in place; the show's name above the title goes back to
// the show page, on that season. Read-only.

module.exports = async function (t) {
  await t.dev('profile()');
  const rowTitles = page => t.js(`Array.from(document.querySelectorAll('${page} px-card-row')).map(r => r.querySelector('.px-row-title')?.textContent.trim()).filter(Boolean)`);

  await t.dev("open({ screen: 'core.show', params: { id: '1396' } })");
  t.check('the show page has its cast', await t.until("document.querySelectorAll('app-show-options .cast .px-card').length > 3", 15000));
  t.check('and similar shows', await t.until("document.querySelectorAll('app-show-options .similar .px-card').length > 3", 15000));
  let titles = await rowTitles('app-show-options');
  t.check('rows: Seasons, episodes, Cast, Similar shows', titles.includes('Cast') && titles.includes('Similar shows') && titles.indexOf('Cast') < titles.indexOf('Similar shows'), titles);
  let first = await t.js("document.querySelector('app-show-options .similar .px-card .titleText')?.textContent.trim()");
  t.check('Breaking Bad: Better Call Saul is similar', first == 'Better Call Saul', first);
  let cast = await t.js("document.querySelector('app-show-options .cast .px-card .titleText')?.textContent.trim()");
  t.check('Bryan Cranston leads the cast', cast == 'Bryan Cranston', cast);
  await t.wait(1500);

  // down to the similar row, its second card
  await t.key('Down', 4);
  await t.wait(600);
  await t.key('Right');
  await t.wait(800);
  let card = await t.focused();
  t.check('a similar show has the focus', card && /px-card/.test(card.classes), card);
  await t.shot('show-rows');
  await t.key('Return');
  const shownId = "String(ng.getComponent(document.querySelector('app-show-options'))?.show?.tmdbId)";
  t.check('Enter opens that show', await t.until(`${shownId} == '${card && card.key}'`, 8000), await t.js(shownId));
  t.check('its page has its own rows', await t.until("document.querySelectorAll('app-show-options .similar .px-card').length > 0", 15000));
  await t.wait(1500);
  await t.key('Escape');
  t.check('Back: Breaking Bad again', await t.until(`${shownId} == '1396'`, 8000));
  await t.until("document.querySelectorAll('app-show-options .similar .px-card').length > 3", 15000);
  await t.wait(1200);
  t.check('on the same card', (await t.focused())?.key == card.key, await t.focused());

  await t.dev("open({ screen: 'core.episode', params: { id: '1396', season: 1, episode: 2 } })");
  t.check('the episode page has the cast', await t.until("document.querySelectorAll('app-episode-page .cast .px-card').length > 3", 15000));
  titles = await rowTitles('app-episode-page');
  t.check('episode rows: Seasons, Cast, Guest stars, Similar shows',
    ['Seasons', 'Cast', 'Similar shows'].every((x, i, a) => titles.indexOf(x) >= 0 && (i == 0 || titles.indexOf(a[i - 1]) < titles.indexOf(x)))
    && (!titles.includes('Guest stars') || titles.indexOf('Cast') < titles.indexOf('Guest stars')), titles);
  t.check('the show above the title is a button', await t.js("!!document.querySelector('app-episode-page [data-px-key=\"show\"]')"));
  await t.wait(1500);
  await t.shot('episode-top');
  await t.key('Down', 2);
  await t.wait(1000);
  await t.shot('episode-cast');

  // the seasons row: Right to season 2 shows its episodes; Enter, Enter opens S2E1
  await t.key('Up', 2);
  await t.wait(600);
  await t.key('Down');
  await t.wait(600);
  let chip = await t.focused();
  t.check('Down from the buttons: the seasons row', chip && /season/.test(chip.classes), chip);
  await t.key('Right');
  const ep = "ng.getComponent(document.querySelector('app-episode-page'))";
  t.check('season 2 focused: its episodes below', await t.until(`${ep}.rowSeason == 2 && document.querySelector('app-episode-page .episodes .sectionTitle')?.textContent.includes('Season 2')`, 8000), await t.js(`${ep}.rowSeason`));
  t.check('this page is still S1E2', await t.js(`${ep}.seasonNumber == 1 && ${ep}.episode.episodeNumber == 2`));
  await t.wait(800);
  await t.shot('episode-seasons');
  await t.key('Return');
  await t.wait(600);
  card = await t.focused();
  t.check('Enter on the season: its first episode', card && card.key == '1', card);
  await t.key('Return');
  t.check('Enter: S2E1 here', await t.until(`${ep}.seasonNumber == 2 && ${ep}.episode?.episodeNumber == 1`, 8000));
  await t.wait(1500);

  // the show's name above the title, Up from the buttons: the show page below, on season 2
  await t.key('Up');
  await t.wait(600);
  let crumb = await t.focused();
  t.check('Up from Play: the show above the title', crumb?.key == 'show', crumb);
  await t.shot('episode-trail');
  await t.key('Return');
  t.check('Go to show: Breaking Bad, season 2', await t.until(`${shownId} == '1396' && ng.getComponent(document.querySelector('app-show-options')).selectedSeason == 2`, 8000),
    await t.js(`ng.getComponent(document.querySelector('app-show-options'))?.selectedSeason`));
};
