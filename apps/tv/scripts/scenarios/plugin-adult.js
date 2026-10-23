'use strict';

// The 18+ section as a plugin (docs/plugins-plan.md step P5): plugins/adult
// on a server in plugin developer mode (copied into <config>/plugins-dev/adult,
// its TMDB key entered on the dashboard, an adult profile first), against the
// real sites: the poster layout, a title page, Play up to the source picker
// (never played: these are multi-GB downloads), the View filter switching to
// the list layout in place and back, the search page's chip.
//   npx electron scripts/scenario.js plugin-adult --server <url>

const CARD = "document.querySelector('.pluginCatalog .rows px-card [data-px-item]')";

module.exports = async function (t) {
  await t.dev('profile()');
  let ids = await t.dev('plugins()');
  t.check('the server\'s plugins include it', (ids || []).includes('adult'), { ids });

  // 1. the poster layout
  await t.dev("reset({ screen: 'plugin.adult.browse' })");
  t.check('its rows of posters', await t.until(CARD + " && document.querySelector('.pluginCatalog px-card img')", 20000));
  await t.wait(1500);
  t.check('the 18+ accent', await t.js("document.querySelector('[data-px-accent]')?.dataset.pxAccent == 'adult'"));
  t.check('a row per studio', await t.js("[...document.querySelectorAll('.pluginCatalog px-card-row')].some(r => /Brazzers|Vixen/.test(r.innerText))"));
  await t.js(`window.SpatialNavigation.focus(${CARD})`);
  await t.wait(600);
  t.check('the focused poster info', await t.until("/18\\+/.test(document.querySelector('.pluginCatalog .titleInfo')?.innerText || '')", 4000));
  await t.shot('adult-browse');

  // 2. a title
  await t.key('Return');
  t.check('its title page', await t.until("window.playpexDev.screen() == 'plugin.adult.title'", 8000));
  t.check('Play and Find releases', await t.until("document.querySelector('.pluginTitle [data-px-key=\"adult:play\"]') && document.querySelector('.pluginTitle [data-px-key=\"adult:releases\"]')", 10000));
  await t.wait(1200);
  await t.shot('adult-title');

  // 3. Play: the source picker with its torrents (not played)
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginTitle [data-px-key=\"adult:play\"]'))");
  await t.key('Return');
  let picker = await t.until("document.querySelectorAll('#torrentPicker px-option').length > 0", 20000);
  let toast = await t.js("document.querySelector('px-toast-host')?.innerText || ''");
  t.check('Play opens the source picker (or says none were found)', picker || /No torrents/.test(toast), { toast });
  if (picker) {
    await t.wait(600);
    await t.shot('adult-picker');
    await t.key('Escape');
    t.check('Back closes it', await t.until("!document.querySelector('#torrentPicker')", 4000));
  }

  // 4. Find releases for the title
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginTitle [data-px-key=\"adult:releases\"]'))");
  await t.key('Return');
  t.check('Find releases: its list searched for the title', await t.until("window.playpexDev.screen() == 'plugin.adult.find'", 6000));
  await t.until("document.querySelector('.pluginReleases .release') || document.querySelector('.pluginReleases .listNote')", 15000);
  t.check('no layout switch there', !(await t.js("!!document.querySelector('.pluginReleases [data-px-key^=\"view:\"]')")));
  await t.key('Escape');
  await t.until("window.playpexDev.screen() == 'plugin.adult.title'", 4000);
  await t.key('Escape');
  t.check('Back to the posters', await t.until("window.playpexDev.screen() == 'plugin.adult.browse'", 6000));

  // 5. View: List → the list layout in place of the posters, kept for the profile
  await t.until(CARD, 10000);
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginCatalog [data-px-key=\"filters\"]'))");
  await t.key('Return');
  t.check('the filter panel', await t.until("document.querySelector('#pluginFilterPanel [data-px-key=\"view:list\"]')", 4000));
  await t.js("window.SpatialNavigation.focus(document.querySelector('#pluginFilterPanel [data-px-key=\"view:list\"]'))");
  await t.key('Return');
  await t.js("window.SpatialNavigation.focus(document.querySelector('#pluginFilterPanel [data-px-key=\"apply\"]'))");
  await t.key('Return');
  t.check('List: the release list in its place', await t.until("window.playpexDev.screen() == 'plugin.adult.releases'", 8000));
  t.check('its releases, most seeded first', await t.until("document.querySelectorAll('.pluginReleases .release').length >= 10", 20000));
  await t.wait(800);
  await t.shot('adult-releases');
  await t.dev("reset({ screen: 'core.movies' })");
  await t.dev("reset({ screen: 'plugin.adult.browse' })");
  t.check('the section opens the list now', await t.until("window.playpexDev.screen() == 'plugin.adult.releases'", 10000));
  await t.until("document.querySelector('.pluginReleases [data-px-key=\"view:posters\"]')", 15000);
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginReleases [data-px-key=\"view:posters\"]'))");
  await t.key('Return');
  t.check('Posters: back to the poster layout', await t.until("window.playpexDev.screen() == 'plugin.adult.browse'", 10000));

  // 6. the search page's chip
  await t.dev("reset({ screen: 'core.search' })");
  t.check('its chip on the search page', await t.until("document.querySelector('.filters [data-px-key^=\"plugin:adult\"]')", 8000));
  await t.js("(() => { let i = document.querySelector('.inputValue'); i.value = 'wife'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await t.wait(500);
  await t.js("window.SpatialNavigation.focus(document.querySelector('.filters [data-px-key^=\"plugin:adult\"]'))");
  await t.key('Return');
  t.check('… its results', await t.until("/Adult movies/.test(document.querySelector('.results')?.innerText || '')", 15000));
  await t.wait(1000);
  await t.shot('adult-search');
};
