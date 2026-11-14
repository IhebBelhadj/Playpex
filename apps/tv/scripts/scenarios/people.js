'use strict';

// A person's page (docs/people-plan.md §4.5): Breaking Bad's show page → Cast
// → Enter on Bryan Cranston → his page (rows Known for, Movies, TV shows);
// Enter on a movie → its page; Back → the same card; an episode's guest star
// → their page; search "bryan cranston" → People first → Enter → the page;
// the biography's dialog. Read-only. Use a throwaway server (--server).

module.exports = async function (t) {
  await t.dev('profile()');
  const person = "ng.getComponent(document.querySelector('app-person-page'))";
  const rowTitles = () => t.js("Array.from(document.querySelectorAll('app-person-page px-card-row')).map(r => r.querySelector('.px-row-title')?.textContent.trim()).filter(Boolean)");

  // the show page's Cast row: Enter on its first card
  await t.dev("open({ screen: 'core.show', params: { id: '1396' } })");
  t.check('the show page has its cast', await t.until("document.querySelectorAll('app-show-options .cast .px-card').length > 3", 15000));
  await t.until("document.querySelectorAll('app-show-options .similar .px-card').length > 3", 15000);
  await t.wait(1500);
  await t.js("SpatialNavigation.focus(document.querySelector('app-show-options .cast [data-px-item]'))");
  await t.wait(500);
  let cast = await t.focused();
  t.check('a cast card has the focus', cast && /Bryan Cranston/.test(cast.text || ''), cast);
  await t.key('Return');
  t.check('Enter opens his page', await t.until(`${person}?.person?.personId == 17419`, 15000), await t.js(`${person}?.error`));
  t.check('his name shows', await t.js("document.querySelector('app-person-page .name')?.textContent.includes('Bryan Cranston')"));
  t.check('who he is: Acting, born…', await t.js("/Acting · Born/.test(document.querySelector('app-person-page .line')?.textContent || '')"),
    await t.js("document.querySelector('app-person-page .line')?.textContent"));
  await t.wait(1500);
  let titles = await rowTitles();
  t.check('rows: Known for, Movies, TV shows', titles[0] == 'Known for' && titles.includes('Movies') && titles.includes('TV shows'), titles);
  t.check('Breaking Bad is in Known for', await t.js("Array.from(document.querySelectorAll('app-person-page .row')[0].querySelectorAll('.titleText')).some(e => e.textContent.trim() == 'Breaking Bad')"));
  t.check('a card has the focus', /px-card/.test((await t.focused())?.classes || ''), await t.focused());
  await t.shot('person-top');

  // the menu: Left reaches it, Right comes back; the mouse over it focuses it
  // (the title page below removed its menu section when it closed)
  await t.key('Left');
  await t.wait(400);
  t.check('Left from the first title: the menu', /menuItem/.test((await t.focused())?.classes || ''), await t.focused());
  await t.key('Right');
  await t.wait(500);
  t.check('Right: back on the page', (await t.focused())?.section == 'personPage', await t.focused());
  let item = await t.js("(() => { let el = Array.from(document.querySelectorAll('menu .menuItem')).find(e => e.getBoundingClientRect().y > 150); let b = el.getBoundingClientRect(); return { x: 24, y: b.y + b.height / 2 } })()");
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x + 2, y: item.y });
  await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y });
  await t.wait(800);
  t.check('the mouse over the menu focuses it', /menuItem/.test((await t.focused())?.classes || ''), await t.focused());
  await t.key('Right');
  await t.wait(500);

  // the biography's tile, then the dialog
  if (await t.js("!!document.querySelector('app-person-page [data-px-key=\"biography\"]')")) {
    await t.js("SpatialNavigation.focus(document.querySelector('app-person-page [data-px-key=\"biography\"] [data-px-item]'))");
    await t.wait(400);
    await t.key('Return');
    t.check('Biography opens the whole of it', await t.until("!!document.querySelector('#personBiography, [id=personBiography], .px-dialog .bioParagraph')", 4000));
    await t.wait(600);
    await t.shot('person-biography');
    await t.key('Down', 3);
    await t.key('Escape');
    t.check('Back closes it', await t.until("!document.querySelector('.bioParagraph')", 4000));
    await t.wait(400);
  }

  // down to the Movies row, its second card → its page; Back → the same card
  let movies = titles.indexOf('Movies');
  await t.js("SpatialNavigation.focus(document.querySelector('app-person-page .row [data-px-item]'))");
  await t.wait(400);
  await t.key('Down', movies);
  await t.wait(600);
  await t.key('Right');
  await t.wait(800);
  let card = await t.focused();
  t.check('a movie card has the focus', card && /px-card/.test(card.classes), card);
  await t.shot('person-rows');
  await t.key('Return');
  t.check('Enter opens the movie', await t.until("!!document.querySelector('app-movie-options')", 10000));
  await t.wait(2000);
  await t.key('Escape');
  t.check('Back: his page again', await t.until(`${person}?.person?.personId == 17419`, 8000));
  await t.wait(1500);
  t.check('on the same card', (await t.focused())?.key == card.key, { was: card, now: await t.focused() });

  // an episode's guest star → their page
  await t.dev("open({ screen: 'core.episode', params: { id: '1396', season: 1, episode: 1 } })");
  if (await t.until("document.querySelectorAll('app-episode-page .guests .px-card').length > 0", 15000)) {
    await t.wait(1500);
    let name = await t.js("document.querySelector('app-episode-page .guests .px-card .titleText')?.textContent.trim()");
    await t.js("SpatialNavigation.focus(document.querySelector('app-episode-page .guests [data-px-item]'))");
    await t.wait(400);
    await t.key('Return');
    t.check('a guest star opens their page', await t.until(`${person}?.person?.name == ${JSON.stringify(name)}`, 15000), name);
  } else {
    t.check('the episode has guest stars', false);
  }

  // search: a person's name puts People first; Enter → the page
  await t.dev("open({ screen: 'core.search' })");
  await t.wait(1500);
  await t.until("!!document.querySelector('text-keyboard')", 5000);
  await t.js(`[...'bryan cranston'].forEach(k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))`);
  await t.js("window.SpatialNavigation.focus(document.querySelector('text-keyboard [data-key=\"done\"]'))");
  await t.key('Return');
  t.check('People first for a name', await t.until("document.querySelector('app-search-page .resultRow')?.getAttribute('data-row') == 'people'", 15000),
    await t.js("Array.from(document.querySelectorAll('app-search-page .resultRow')).map(r => r.getAttribute('data-row'))"));
  let sub = await t.js("document.querySelector('app-search-page .resultRow[data-row=people] .px-card .meta')?.textContent.trim()");
  t.check('a person result says what they are known for', /Breaking Bad|Malcolm/.test(sub || ''), sub);
  await t.js("SpatialNavigation.focus(document.querySelector('app-search-page .resultRow[data-row=people] [data-px-item]'))");
  await t.wait(400);
  await t.key('Return');
  t.check('Enter opens the person page', await t.until(`${person}?.person?.personId == 17419`, 15000));
  await t.wait(800);
  await t.key('Escape');
  t.check('Back: the search, results kept', await t.until("document.querySelector('app-search-page .resultRow')?.getAttribute('data-row') == 'people'", 8000));
};
