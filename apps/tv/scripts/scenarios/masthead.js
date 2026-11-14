'use strict';

// The masthead (--px-masthead, src/styles/_tokens.scss): every page's first
// line is level with the clock: the middle of a title's capitals (or of a
// box: the list's search bar, the episode's trail, Search's field) within
// 1.5 px of the middle of the clock's capitals. Home, Movies, a show, a movie,
// an episode, a person, the watch list, Library, Search, Settings. Read-only;
// a throwaway server (--server) with the TMDB titles it opens.
const MID = `(sel, kind) => { let el = document.querySelector(sel); if (!el) return null; let r = el.getBoundingClientRect(); if (kind == 'box') return r.top + r.height / 2; let s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; el.appendChild(s); let b = s.getBoundingClientRect().bottom; s.remove(); return b - 0.355 * parseFloat(getComputedStyle(el).fontSize); }`;
module.exports = async function (t) {
  await t.dev('profile()');
  const pages = [
    ['home', "open({ screen: 'core.home' })", '.px-title', 'text'],
    ['movies (search bar)', "open({ screen: 'core.movies' })", '.sectionToolbar px-search-field .px-search-field, .sectionToolbar px-search-field [data-px-item]', 'box'],
    ['show', "open({ screen: 'core.show', params: { id: '1396' } })", 'app-show-options ~ * .px-title, movie-description .px-title', 'text'],
    ['movie', "open({ screen: 'core.movie', params: { id: '64690' } })", 'movie-description .px-title', 'text'],
    ['episode (trail)', "open({ screen: 'core.episode', params: { id: '1396', season: 1, episode: 2 } })", 'app-episode-page .trail .toShow', 'box'],
    ['person', "open({ screen: 'core.person', params: { id: '17419' } })", 'app-person-page .name', 'text'],
    ['watchlist', "open({ screen: 'core.watchlist' })", 'app-watchlist-page .px-title, app-watchlist-page px-empty .title', 'text'],
    ['library', "open({ screen: 'core.library' })", 'app-library-page .px-title, app-library-page px-empty .title', 'text'],
    ['search (field)', "open({ screen: 'core.search' })", 'app-search-page .headLine [data-px-item]', 'box'],
    ['settings', "open({ screen: 'core.settings' })", 'app-settings-page .heading', 'text'],
  ];
  for (const [name, open, sel, kind] of pages) {
    await t.dev(open);
    await t.until(`!!document.querySelector(${JSON.stringify(sel)})`, 15000);
    await t.wait(2500);
    if (name.startsWith('search')) { await t.key('Escape'); await t.wait(800); }
    let r = await t.js(`(() => { const mid = ${MID}; let c = mid('clock.clock span', 'text'), p = mid(${JSON.stringify(sel)}, ${JSON.stringify(kind)}); return { clock: Math.round(c * 10) / 10, page: Math.round(p * 10) / 10 }; })()`);
    t.check(name + ': level with the clock', Math.abs(r.clock - r.page) <= 1.5, r);
    await t.shot('m-' + name.split(' ')[0]);
  }
};
