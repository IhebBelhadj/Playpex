'use strict';

// Rows of cards (px-card-row, step 4): the movies list (translated stack),
// moving along and between rows, the description following the focus, paging
// near a row's end, a title opened and Back: the same poster, rows where they
// were. Then a title page's rows (scrolling stack): cast and similar.

module.exports = async function (t) {
  const focusedKey = async () => (await t.focused())?.key;
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.movies' })");
  t.check('the rows are there', await t.until("document.querySelectorAll('px-card-row .px-card').length > 10", 15000));
  await t.wait(1500);
  await t.js("document.querySelector('.menuItem.active')?.focus()");
  await t.key('Right');
  let first = await t.focused();
  t.check('Right from the menu: a poster', first && /px-card/.test(first.classes), first);
  const firstTitle = await t.js("document.querySelector('movie-description .px-title')?.textContent.trim()");
  await t.key('Right', 3);
  const fourth = await focusedKey();
  t.check('Right ×3 moves along the row', fourth && fourth != first.key, fourth);
  t.check('the description follows', await t.until(`document.querySelector('movie-description .px-title')?.textContent.trim() != ${JSON.stringify(firstTitle)}`, 4000));
  await t.key('Down');
  const second = await t.focused();
  t.check('Down: the next row', second && second.key != fourth, second);
  await t.key('Down');
  await t.key('Up');
  t.check('Up comes back to the remembered poster of that row', (await focusedKey()) == second.key);

  // paging: far along the first row
  await t.key('Up');
  const before = await t.js("document.querySelector('px-card-row .px-row').querySelectorAll('.px-card').length");
  const index = await t.js("Array.from(document.querySelector('px-card-row .px-row').querySelectorAll('.px-card')).indexOf(document.activeElement)");
  t.keyGap = 90;
  await t.key('Right', Math.max(1, before - index - 4));
  t.keyGap = 180;
  t.check('near the end, the row loads its next page', await t.until(`document.querySelector('px-card-row .px-row').querySelectorAll('.px-card').length > ${before}`, 8000));
  const deep = await focusedKey();

  // open and come back
  await t.key('Return');
  t.check('Enter opens the title', await t.until("window.playpexDev.screen() == 'core.movie'", 8000));
  await t.until("!!document.querySelector('[data-px-key=\"play\"]')", 8000);
  await t.wait(1000);
  await t.shot('rows-movie');
  await t.key('Escape');
  t.check('Back: the list', await t.until("window.playpexDev.screen() == 'core.movies'", 6000));
  await t.wait(800);
  t.check('… on the same poster', (await focusedKey()) == deep, await focusedKey());
  await t.shot('rows-list');

  // a title page: buttons, then cast, then similar
  await t.dev("open({ screen: 'core.movie', params: { id: 949 } })");
  await t.until("document.querySelectorAll('px-card-row .px-card').length > 3", 10000);
  await t.wait(1200);
  await t.js("window.SpatialNavigation.focus(document.querySelector('[data-px-key=\"play\"]'))");
  await t.key('Down');
  let cast = await t.focused();
  t.check('Down from the buttons: the cast', cast && /v-portrait/.test(cast.classes), cast);
  await t.key('Right', 2);
  await t.key('Down');
  let similar = await t.focused();
  t.check('Down: similar titles', similar && /v-compact/.test(similar.classes), similar);
  await t.key('Up');
  const back1 = await t.focused();
  t.check('Up: the cast again', back1 && /v-portrait/.test(back1.classes), back1);
  await t.key('Up');
  const back2 = await t.focused();
  t.check('Up: the buttons again (the one remembered)', back2 && /px-action/.test(back2.classes), back2);
  t.check('… and the page scrolled back to the top', await t.js("(document.querySelector('.pageContainer')?.scrollTop || 0) < 5"));
  await t.key('Escape');
};
