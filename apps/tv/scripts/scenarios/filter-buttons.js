'use strict';

// A catalog's filter groups with a toolbar button of their own (`button: true`,
// plugin API 1.4): each button says its group and choice ("View: For you"),
// opens a panel of that group only, on its current choice; one press on a
// single-choice option applies it, closes the panel and gives the focus back
// to the button, whose label follows; Back closes without a change; no shared
// Filters button when every group has its own.
// Needs a server in plugin developer mode with a plugin whose catalog screen
// `plugin.<id>.home` answers two such groups `view` and `category` (the test
// plugin in the scenario's notes: PLAYPEX_TEST_PLUGIN=<id>, default btntest):
//   npx electron scripts/scenario.js filter-buttons --server http://127.0.0.1:28494

const label = key => `document.querySelector('.pluginCatalog [data-px-key="${key}"]')?.textContent.trim()`;

module.exports = async function (t) {
  const id = process.env.PLAYPEX_TEST_PLUGIN || 'btntest';
  await t.dev('profile()');
  await t.wait(500);
  await t.dev(`open({ screen: 'plugin.${id}.home' })`);
  t.check('a button per group, saying its choice', await t.until(`${label('group:view')} == 'View: For you' && ${label('group:category')} == 'Category: All'`, 8000),
    { view: await t.js(label('group:view')), category: await t.js(label('group:category')) });
  t.check('no shared Filters button', await t.js("!document.querySelector('.pluginCatalog [data-px-key=\"filters\"]')"));
  await t.shot('filter-buttons');

  await t.js(`window.SpatialNavigation.focus(document.querySelector('.pluginCatalog [data-px-key="group:view"]'))`);
  await t.key('Return');
  t.check('View opens its own panel', await t.until("document.querySelector('#pluginGroupPanel')", 3000));
  t.check('only its options', await t.js("[...document.querySelectorAll('#pluginGroupPanel [data-px-key]')].every(e => /^view:/.test(e.dataset.pxKey))"));
  t.check('no automatic All in a view', await t.js("!document.querySelector('#pluginGroupPanel [data-px-key=\"view:any\"]')"));
  t.check('focused on the current choice', await t.until("document.activeElement?.closest('[data-px-key]')?.dataset.pxKey == 'view:a' || document.activeElement?.dataset.pxKey == 'view:a'", 2000),
    await t.js('document.activeElement?.dataset.pxKey || document.activeElement?.closest("[data-px-key]")?.dataset.pxKey'));
  await t.shot('filter-buttons-panel');
  await t.key('Right');
  await t.key('Return');
  t.check('one press applies it and closes', await t.until("!document.querySelector('#pluginGroupPanel')", 3000));
  t.check('the button says the new choice', await t.until(`${label('group:view')} == 'View: Liked videos'`, 5000), await t.js(label('group:view')));
  t.check('the rows follow', await t.until("document.querySelector('.pluginCatalog px-card-row')?.textContent.includes('Liked videos')", 5000));
  t.check('the focus is back on the button', await t.until("document.activeElement?.closest('[data-px-key]')?.dataset.pxKey == 'group:view' || document.activeElement?.dataset.pxKey == 'group:view'", 3000));

  // Category: its own panel, a choice next to the view
  await t.js(`window.SpatialNavigation.focus(document.querySelector('.pluginCatalog [data-px-key="group:category"]'))`);
  await t.key('Return');
  t.check('Category opens its own panel', await t.until("document.querySelector('#pluginGroupPanel [data-px-key=\"category:20\"]')", 3000));
  await t.js(`window.SpatialNavigation.focus(document.querySelector('#pluginGroupPanel [data-px-key="category:20"]'))`);
  await t.key('Return');
  t.check('both apply together', await t.until(`${label('group:category')} == 'Category: Gaming' && ${label('group:view')} == 'View: Liked videos'`, 5000),
    { view: await t.js(label('group:view')), category: await t.js(label('group:category')) });
  await t.shot('filter-buttons-chosen');

  await t.js(`window.SpatialNavigation.focus(document.querySelector('.pluginCatalog [data-px-key="group:view"]'))`);
  await t.key('Return');
  await t.until("document.querySelector('#pluginGroupPanel')", 3000);
  await t.key('Down');
  await t.key('Escape');
  t.check('Back closes it, nothing changed', await t.until(`!document.querySelector('#pluginGroupPanel') && ${label('group:view')} == 'View: Liked videos'`, 3000));
};
