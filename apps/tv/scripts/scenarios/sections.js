'use strict';

// Section rows from the server (docs/rows-plan.md step 3): Home first after
// "Who's watching?", its rows in the server's order (GET /sections/home/rows),
// Movies the same; a Home card opens its title (a show in the TV shows frame)
// and Back comes to the same card; the options key on a card: the row's menu,
// Move row down (the server's layout changes, the row moves, the card keeps
// the focus), Hide row; Rows on the toolbar: the editor lists it hidden, Show
// brings it back, Reset to default. Leaves the profile's layouts as they were
// (reset at the end). Run against a test server: it edits the profile's rows.

module.exports = async function (t) {
  const name = await t.dev('profile()');
  const api = await t.dev('api');
  const pid = await t.js("window.playpexDev && (await fetch(window.playpexDev.api + '/profiles').then(r => r.json())).profiles.find(p => p.name == " + JSON.stringify(name) + ").id");
  const serverRows = async section => t.js(`(await fetch(${JSON.stringify(api)} + '/sections/${section}/rows?profile=${pid}').then(r => r.json())).rows.map(r => r.title)`);
  const shownRows = () => t.js("Array.from(document.querySelectorAll('movies-slider px-card-row')).map(r => r.querySelector('.px-row-title')?.textContent.trim())");
  await t.js(`fetch(${JSON.stringify(api)} + '/sections/home/layout?profile=${pid}', { method: 'DELETE' })`);
  await t.js(`fetch(${JSON.stringify(api)} + '/sections/movies/layout?profile=${pid}', { method: 'DELETE' })`);

  // Home
  await t.dev("reset({ screen: 'core.home' })");
  t.check('Home has rows', await t.until("document.querySelectorAll('movies-slider px-card-row .px-card').length > 10", 20000));
  await t.wait(2500);
  let expected = await serverRows('home');
  let shown = await shownRows();
  t.check('Home: the server\'s rows in its order', JSON.stringify(shown) == JSON.stringify(expected.slice(0, shown.length)) && shown.length >= Math.min(3, expected.length), { shown, expected });
  t.check('Home is in the menu, active', await t.js("document.querySelector('.menuItem.active')?.textContent.includes('Home')"));
  await t.shot('home');

  // a card → its title → Back: the same card
  await t.js("document.querySelector('.menuItem.active')?.focus()");
  await t.key('Right');
  await t.key('Right', 2);
  let card = await t.focused();
  t.check('a card has the focus', card && /px-card/.test(card.classes), card);
  t.check('it is described', await t.until("document.querySelector('movie-description .px-title')?.textContent.trim().length > 0", 6000));
  await t.key('Return');
  t.check('Enter opens its title', await t.until("/\\/(movies\\/movie|shows\\/show)\\//.test(location.hash + location.pathname)", 8000));
  await t.wait(1500);
  await t.key('Escape');
  t.check('Back: Home again', await t.until("document.querySelector('.menuItem.active')?.textContent.includes('Home') && document.querySelectorAll('movies-slider .px-card').length > 0", 8000));
  await t.wait(800);
  t.check('on the same card', (await t.focused())?.key == card.key, await t.focused());

  // a plugin's row (when the server has one: plugins/hello offers one to Home and Movies)
  await t.dev("reset({ screen: 'core.movies' })");
  await t.until("document.querySelectorAll('movies-slider px-card-row .px-card').length > 10", 20000);
  await t.wait(2500);
  const pluginRow = await t.js("ng.getComponent(document.querySelector('movies-page')).catalog.rows.find(r => r.kind == 'cards')?.key");
  if (pluginRow) {
    t.check('a plugin\'s row has its cards', await t.until(`document.querySelectorAll('[data-section="${pluginRow}"]').length > 3`, 10000));
    // with the keys, as a user would: Down from the first row until the plugin's
    await t.js("window.SpatialNavigation.focus(document.querySelector('movies-slider px-card-row .px-card'))");
    await t.wait(500);
    for (let i = 0; i < 20 && await t.js(`document.activeElement?.dataset?.section != "${pluginRow}"`); i++) await t.key('Down');
    t.check('the description is the card\'s own info', await t.until("document.querySelector('movie-description .px-title')?.textContent.trim() == document.activeElement.getAttribute('aria-label').split(',')[0]", 5000),
      await t.js("document.querySelector('movie-description .px-title')?.textContent.trim()"));
    await t.shot('plugin-row');
    await t.key('Return');
    t.check('Enter on its card: the plugin\'s screen', await t.until("/\\/p\\//.test(location.hash + location.pathname)", 8000), await t.js('location.hash'));
    await t.wait(1000);
    await t.key('Escape');
    t.check('Back: Movies again, on that card', await t.until(`document.activeElement?.dataset?.section == "${pluginRow}"`, 8000), await t.focused());
  }

  // Movies: the row menu
  await t.dev("reset({ screen: 'core.movies' })");
  t.check('Movies has rows', await t.until("document.querySelectorAll('movies-slider px-card-row .px-card').length > 10", 20000));
  await t.wait(2500);
  expected = await serverRows('movies');
  shown = await shownRows();
  t.check('Movies: the server\'s rows in its order', JSON.stringify(shown) == JSON.stringify(expected.slice(0, shown.length)), { shown, expected });
  // the first row's first card (Right from the menu goes back to the card remembered last)
  await t.js("window.SpatialNavigation.focus(document.querySelector('movies-slider px-card-row .px-card'))");
  await t.wait(600);
  card = await t.focused();
  const firstRow = shown[0];
  await t.js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))");
  t.check('the options key: the row\'s menu', await t.until("!!document.querySelector('px-dialog [data-px-key=\"down\"]')", 4000));
  await t.shot('row-menu');
  await t.js("document.querySelector('px-dialog [data-px-key=\"down\"]').focus()");
  await t.key('Return');
  t.check('Move row down: the server has it second', await t.until(`(async () => (await fetch(${JSON.stringify(api)} + '/sections/movies/rows?profile=${pid}').then(r => r.json())).rows[1]?.title == ${JSON.stringify(firstRow)})()`, 6000));
  t.check('and the TV shows it second', await t.until(`Array.from(document.querySelectorAll('movies-slider px-card-row')).map(r => r.querySelector('.px-row-title')?.textContent.trim())[1] == ${JSON.stringify(firstRow)}`, 8000));
  await t.wait(800);
  t.check('the card keeps the focus', (await t.focused())?.key == card.key, await t.focused());

  // Hide it
  await t.js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))");
  t.check('the row menu again', await t.until("!!document.querySelector('px-dialog [data-px-key=\"hide\"]')", 4000), await t.focused());
  await t.js("document.querySelector('px-dialog [data-px-key=\"hide\"]').focus()");
  await t.key('Return');
  t.check('Hide row: the server has it hidden', await t.until(`(async () => (await fetch(${JSON.stringify(api)} + '/sections/movies/layout?profile=${pid}').then(r => r.json())).rows.some(e => e.hidden))()`, 6000));
  t.check('Hide row: gone', await t.until(`!Array.from(document.querySelectorAll('movies-slider px-card-row .px-row-title')).some(e => e.textContent.trim() == ${JSON.stringify(firstRow)})`, 8000));

  // the editor: hidden there, Show, Done
  await t.wait(800);
  await t.js("document.querySelector('.sectionToolbar [data-px-key=\"rows\"]')?.focus()");
  await t.key('Return');
  t.check('Rows opens the editor', await t.until("!!document.querySelector('#rowsEditor .entries')", 5000));
  await t.wait(500);
  t.check('it lists the row as hidden', await t.js(`Array.from(document.querySelectorAll('#rowsEditor .label.hidden .name')).some(e => e.textContent.trim() == ${JSON.stringify(firstRow)})`));
  await t.shot('editor');
  const hiddenKey = await t.js(`(() => { let l = Array.from(document.querySelectorAll('#rowsEditor .label')).find(e => e.querySelector('.name').textContent.trim() == ${JSON.stringify(firstRow)}); let b = l; while (b && !(b.matches && b.matches('px-button') && b.querySelector('[data-px-key^="hide:"]'))) b = b.nextElementSibling; return b?.querySelector('[data-px-key]')?.dataset.pxKey; })()`);
  await t.js(`document.querySelector('#rowsEditor [data-px-key="${hiddenKey}"]').focus()`);
  await t.key('Return');
  t.check('Show: no longer hidden', await t.until(`document.querySelector('#rowsEditor [data-px-key="${hiddenKey}"]')?.textContent.includes('Hide')`, 3000));
  t.check('the focus stays on it', (await t.focused())?.key == hiddenKey, await t.focused());
  // Up moves it
  const upKey = hiddenKey.replace('hide:', 'up:');
  await t.js(`document.querySelector('#rowsEditor [data-px-key="${upKey}"]').focus()`);
  await t.key('Return');
  t.check('Up: first again in the editor', await t.until(`document.querySelector('#rowsEditor .label .name')?.textContent.trim() == ${JSON.stringify(firstRow)}`, 3000));
  await t.js("document.querySelector('#rowsEditor [data-px-key=\"done\"]').focus()");
  await t.key('Return');
  t.check('Done: the row is back, first', await t.until(`document.querySelector('movies-slider px-card-row .px-row-title')?.textContent.trim() == ${JSON.stringify(firstRow)}`, 8000));

  // Reset to default
  await t.wait(800);
  await t.js("document.querySelector('.sectionToolbar [data-px-key=\"rows\"]')?.focus()");
  await t.key('Return');
  await t.until("!!document.querySelector('#rowsEditor [data-px-key=\"reset\"]')", 5000);
  await t.js("document.querySelector('#rowsEditor [data-px-key=\"reset\"]').focus()");
  await t.key('Return');
  t.check('Reset: the profile has no layout of its own', await t.until(`(async () => !(await fetch(${JSON.stringify(api)} + '/sections/movies/layout?profile=${pid}').then(r => r.json())).own)()`, 6000));
  await t.js(`fetch(${JSON.stringify(api)} + '/sections/home/layout?profile=${pid}', { method: 'DELETE' })`);
};
