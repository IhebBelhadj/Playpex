'use strict';

// Bridged Stremio add-ons drawn by the core's templates (docs/stremio-bridge-plan.md
// §8): no client code of their own. Needs a server on this machine with two
// add-ons installed through the bridge (their plugin ids in the environment):
//   STREMIO_SECTION  an add-on with catalogs in its own section and title pages of its own ids (an anime catalog)
//   STREMIO_ROWS     an add-on whose movie catalogs are rows in Movies (a tt catalog), optional
// and a stream add-on answering those ids, for Play (optional: without one the page says so)
//   STREMIO_SECTION=st-… STREMIO_ROWS=st-… npx electron scripts/scenario.js stremio --server <url>
// Play stops at the source picker: nothing is downloaded.

const SECTION = process.env.STREMIO_SECTION, ROWS = process.env.STREMIO_ROWS;
const CARD = "document.querySelector('.pluginCatalog .rows px-card [data-px-item]')";

module.exports = async function (t) {
  if (!SECTION) {
    t.check('STREMIO_SECTION names a bridged add-on', false);
    return;
  }
  await t.dev('profile()');
  t.check('the TV knows the add-on\'s plugin', (await t.dev('plugins()') || []).includes(SECTION));

  // 1. its section: its catalogs as rows, pictures through the server
  await t.dev(`reset({ screen: 'plugin.${SECTION}.home' })`);
  t.check('its section renders rows', await t.until(CARD, 15000));
  t.check('posters come from the server\'s image proxy', await t.until(
    `[...document.querySelectorAll('.pluginCatalog px-card img')].some(i => /\\/plugins\\/${SECTION}\\/images\\//.test(i.src) && i.naturalWidth > 0)`, 15000));
  const foreign = await t.js("[...document.querySelectorAll('img')].map(i => i.src).filter(s => /^https?:/.test(s) && !/\\/api\\/v1\\//.test(s))");
  t.check('no picture from the add-on\'s hosts', foreign.length === 0, { foreign: foreign.slice(0, 3) });
  await t.js(`window.SpatialNavigation.focus(${CARD})`);
  await t.wait(800);
  t.check('the focused card\'s info', await t.until("(document.querySelector('.pluginCatalog .titleInfo')?.innerText || '').length > 20", 5000));
  await t.shot('stremio-section');

  // a genre filter from the catalog's options
  const hasFilters = await t.js("!!document.querySelector('.pluginCatalog [data-px-key=\"filters\"]')");
  t.check('a Filters button (its genres)', hasFilters);

  // 2. a title page of its own id
  await t.js(`window.SpatialNavigation.focus(${CARD})`);
  await t.key('Return');
  t.check('Enter opens its title page', await t.until(`window.playpexDev.screen() == 'plugin.${SECTION}.title'`, 8000));
  t.check('the page: info and episode rows', await t.until("document.querySelectorAll('.pluginTitle px-card').length > 0", 15000));
  await t.wait(1200);
  await t.shot('stremio-title');
  const url = await t.js('location.hash || location.href');
  t.check('its id (with ":") survives the address', /\/title\/[^/]+\/[^/]*(:|%3A)[^/]+$/.test(url), { url });

  // 3. an episode: every bridged add-on's streams, the source picker (not played)
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginTitle px-card [data-px-item]'))");
  await t.key('Return');
  const picker = await t.until("document.querySelectorAll('#torrentPicker px-option').length > 0", 25000);
  const toast = await t.js("document.querySelector('px-toast-host')?.innerText || ''");
  t.check('an episode opens the source picker (or says no add-on has it)', picker || /No add-on|didn't answer/.test(toast), { toast });
  if (picker) {
    await t.wait(600);
    await t.shot('stremio-picker');
    await t.key('Escape');
    t.check('Back closes it', await t.until("!document.querySelector('#torrentPicker')", 4000));
  }
  await t.key('Escape');
  t.check('Back returns to its section', await t.until(`window.playpexDev.screen() == 'plugin.${SECTION}.home'`, 6000));

  // 4. rows in Movies, opening the core's own pages
  if (ROWS) {
    await t.dev("reset({ screen: 'core.movies' })");
    const titles = "[...document.querySelectorAll('px-slot px-card-row')].map(r => (r.innerText || '').split('\\n')[0].trim())";
    const row = await t.until(`${titles}.some(x => /^(Popular|Featured|New)$/.test(x))`, 25000);
    t.check('its catalogs are rows in Movies (the section\'s plugin rows)', row, { rows: await t.js(titles) });
    await t.wait(1500);
    await t.shot('stremio-movies');
  }
};
