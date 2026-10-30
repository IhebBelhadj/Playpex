'use strict';

// The search page (core.search): the keyboard opens by itself (<text-keyboard>),
// typed words searched on Done; the catalog's rows, the plugins' videos and the
// torrents under All; the Torrents chip's list, its sort and filter panel (a
// filter narrows the list, the filter on shows as a chip that removes it);
// Clear. Needs stream or torrent plugins on the server for the last parts.

const QUERY = process.env.PLAYPEX_TEST_QUERY || 'night';

module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.search' })");
  await t.until("!!document.querySelector('text-keyboard .key')", 4000);
  t.check('a fresh page opens the keyboard', true);

  // typing (a physical keyboard: the keyboard takes it as is), then Search
  await t.js(`[...${JSON.stringify(QUERY)}].forEach(k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))`);
  await t.js("window.SpatialNavigation.focus(document.querySelector('text-keyboard [data-key=\"done\"]'))");
  await t.key('Return');
  await t.until("!document.querySelector('text-keyboard')", 3000);
  t.check('the field shows the query', await t.js(`document.querySelector('.searchHead').textContent.includes(${JSON.stringify(QUERY)})`));
  await t.until("document.querySelectorAll('.resultRow').length >= 2", 20000);
  await t.wait(1500);
  const rows = await t.js("[...document.querySelectorAll('.resultRow .px-row-title, .resultRow h2, .resultRow [class*=title]')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 8)");
  t.check('All: the catalog rows, then videos / torrents', rows.length >= 2, rows);
  await t.shot('search-all');
  // All: the best torrents as list rows, then "Show all"
  if (await t.js("!!document.querySelector('.foundList [data-found]')")) {
    await t.js("window.SpatialNavigation.focus(document.querySelector('.foundList [data-found]'))");
    await t.wait(600);
    t.check('All: the best torrents, then "Show all"', await t.js("document.querySelectorAll('.foundList [data-found]').length <= 5 && !!document.querySelector('[data-more=\"all-torrents\"]')"));
    await t.shot('search-all-torrents');
  }

  // the Torrents chip
  const chips = await t.js("[...document.querySelectorAll('.filters [data-px-key]')].map(e => e.dataset.pxKey)");
  t.check('Videos and Torrents among the filters', chips.includes('torrents'), chips);
  if (!chips.includes('torrents')) return;
  await t.js("window.SpatialNavigation.focus(document.querySelector('.filters [data-px-key=\"torrents\"]'))");
  await t.key('Return');
  await t.until("document.querySelectorAll('.foundList .found').length > 0", 20000);
  const count = await t.js("document.querySelector('.toolsCount')?.textContent.trim()");
  t.check('Torrents: a ranked list, its count', !!count, count);
  await t.key('Down');
  let f = await t.focused();
  t.check('Down from the filters: the sort and filter button', f && /^refine:/.test(f.key), f);
  await t.shot('search-torrents');

  // the panel: a quality narrows the list at once
  await t.key('Return');
  await t.until("!!document.querySelector('search-refine-panel .px-chip, search-refine-panel [data-px-key]')", 3000);
  await t.shot('search-refine');
  const quality = await t.js("[...document.querySelectorAll('search-refine-panel [data-px-key^=\"qualities:\"]')].map(e => e.dataset.pxKey)[0]");
  t.check('the panel offers qualities', !!quality, quality);
  if (quality) {
    await t.js(`window.SpatialNavigation.focus(document.querySelector('search-refine-panel [data-px-key="${quality}"]'))`);
    await t.key('Return');
    await t.wait(300);
    await t.key('Escape');
    await t.until("!document.querySelector('search-refine-panel')", 3000);
    const narrowed = await t.js("document.querySelector('.toolsCount')?.textContent.trim()");
    t.check('the list narrowed: "N of M torrents"', / of /.test(narrowed || ''), narrowed);
    t.check('the filter on shows as a chip', await t.js("!!document.querySelector('.tools [data-px-key^=\"off:\"]')"));
    await t.shot('search-filtered');
  }
};
