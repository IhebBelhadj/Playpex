'use strict';

// A packaged plugin drawn by the core's templates (docs/plugins-plan.md step
// P1): the example plugin plugins/hello on a server in plugin developer mode
// (copied into <config>/plugins-dev/hello): its menu entry and catalog
// section, a title page whose action asks then answers with a toast, its
// release list, its list screen, its contributions to core screens (a movie
// page's action and meta chip, a row of the Movies section, a search chip).
//   npx electron scripts/scenario.js plugin-templates --server <url>

const CARD = "document.querySelector('.pluginCatalog .rows px-card [data-px-item]')";

module.exports = async function (t) {
  await t.dev('profile()');
  t.check('the plugin\'s menu entry', await t.until("[...document.querySelectorAll('.menuItem .description')].some(e => e.textContent.trim() == 'Hello')", 10000));

  // 1. the catalog section
  await t.dev("reset({ screen: 'plugin.hello.home' })");
  t.check('the catalog renders its rows', await t.until(CARD, 8000));
  await t.wait(800);
  t.check('its title in the toolbar', /Hello/.test(await t.js("document.querySelector('.pluginCatalog .heading')?.textContent || ''")));
  t.check('a paged row and a fixed one', (await t.js("document.querySelectorAll('.pluginCatalog px-card-row').length")) === 2);
  t.check('card images from the package', /\/plugins\/hello\/assets\/poster-\d\.svg/.test(await t.js("document.querySelector('.pluginCatalog px-card img')?.src || ''")));
  await t.js(`window.SpatialNavigation.focus(${CARD})`);
  await t.wait(400);
  t.check('the focused card\'s info', /Example/.test(await t.js("document.querySelector('.pluginCatalog .titleInfo')?.innerText || ''")));
  await t.shot('catalog');

  // filters: a panel of its groups
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginCatalog [data-px-key=\"filters\"]'))");
  await t.key('Return');
  t.check('the filter panel opens', await t.until("document.querySelector('#pluginFilterPanel')", 4000));
  await t.wait(400);
  await t.shot('catalog-filters');
  await t.js("window.SpatialNavigation.focus(document.querySelector('#pluginFilterPanel [data-px-key=\"decade:1980\"]'))");
  await t.key('Return');
  await t.js("window.SpatialNavigation.focus(document.querySelector('#pluginFilterPanel [data-px-key=\"apply\"]'))");
  await t.key('Return');
  t.check('filtered rows', await t.until("/1980s/.test(document.querySelector('.pluginCatalog px-card-row')?.innerText || '')", 6000));

  // 2. a title page
  await t.until(CARD, 6000);
  await t.js(`window.SpatialNavigation.focus(${CARD})`);
  await t.key('Return');
  t.check('Enter opens its title screen', await t.until("window.playpexDev.screen() == 'plugin.hello.title'", 6000));
  t.check('title info and tiles', await t.until("document.querySelector('.pluginTitle [data-px-key=\"hello:wave\"]')", 6000));
  await t.wait(800);
  await t.shot('title');
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginTitle [data-px-key=\"hello:wave\"]'))");
  await t.key('Return');
  t.check('its call asks first (confirm effect)', await t.until("/Say Hello to/.test(document.body.innerText)", 6000));
  await t.wait(300);
  await t.shot('confirm');
  await t.key('Return');
  t.check('… then a toast', await t.until("/from the example plugin/.test(document.querySelector('px-toast-host')?.innerText || '')", 6000));
  await t.wait(800);

  // 3. its release list
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginTitle [data-px-key=\"hello:releases\"]'))");
  await t.key('Return');
  t.check('the releases template', await t.until("document.querySelectorAll('.pluginReleases .release').length >= 20", 6000));
  await t.wait(600);
  t.check('most seeded first', await t.js("(() => { let s = [...document.querySelectorAll('.pluginReleases .seedCount')].map(e => +e.textContent.replace(/\\D/g, '')); return s.every((v, i) => !i || s[i - 1] >= v); })()"));
  await t.shot('releases');
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginReleases [data-px-key=\"quality:720p\"]'))");
  await t.key('Return');
  t.check('a filter chip asks again', await t.until("[...document.querySelectorAll('.pluginReleases .tag.quality')].every(e => e.textContent.trim() == '720p') && document.querySelectorAll('.pluginReleases .release').length > 0", 6000));
  await t.key('Escape');
  t.check('Back returns to the title', await t.until("window.playpexDev.screen() == 'plugin.hello.title'", 4000));
  await t.key('Escape');
  t.check('… and to the catalog as it was (1980s)', await t.until("window.playpexDev.screen() == 'plugin.hello.home' && /1980s/.test(document.querySelector('.pluginCatalog px-card-row')?.innerText || '')", 6000));

  // 4. the list template
  await t.dev("open({ screen: 'plugin.hello.menu' })");
  t.check('the list template', await t.until("document.querySelectorAll('.pluginList .row').length == 5", 6000));
  await t.wait(400);
  await t.shot('list');
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginList [data-px-key=\"hello:movie\"]'))");
  await t.key('Return');
  t.check('an intent to a core screen', await t.until("window.playpexDev.screen() == 'core.movie'", 6000));

  // 5. contributions to core screens (the movie page opened above: The Matrix)
  t.check('its action on a movie page', await t.until("!!document.querySelector('[data-px-key=\"hello:party\"]')", 10000));
  t.check('its chip on the meta line', await t.until("[...document.querySelectorAll('movie-description px-meta, .pageContainer px-meta')].some(e => /Hello/.test(e.textContent))", 8000));
  await t.wait(600);
  await t.shot('movie-contributions');
  await t.dev("reset({ screen: 'core.movies' })");
  t.check('its row in the Movies section', await t.until("[...document.querySelectorAll('.px-row-title')].some(e => /Hello picks/.test(e.textContent))", 15000));

  // 6. the search page's chip
  await t.dev("reset({ screen: 'core.search' })");
  t.check('its chip on the search page', await t.until("document.querySelector('.filters [data-px-key=\"plugin:hello:search\"]')", 6000));
  await t.js("(() => { let i = document.querySelector('.inputValue'); i.value = 'harbour'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await t.wait(500);
  await t.js("window.SpatialNavigation.focus(document.querySelector('.filters [data-px-key=\"plugin:hello:search\"]'))");
  await t.wait(300);
  t.check('the chip has the focus', await t.js("document.activeElement?.dataset?.pxKey == 'plugin:hello:search'"),
    { active: await t.js("document.activeElement?.className") });
  await t.key('Return');
  t.check('… its rows for the query', await t.until("/Made-up titles/.test(document.querySelector('.results')?.innerText || '') && [...document.querySelectorAll('.results px-card .px-card-title, .results px-card')].length > 0", 8000));
  await t.wait(600);
  await t.shot('search-chip');
};
