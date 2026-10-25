'use strict';

// The catalog through the server (docs/providers-plan.md §7.1, step 6: the TV
// calls /catalog/*, never TMDB): a movie's page (cast, similar titles,
// trailer), a show's seasons and episodes, an episode's page (credits, guest
// stars), the section's search and filters, the search page (people and their
// titles), the watch list's details.
//   npx electron scripts/scenario.js catalog --server http://127.0.0.1:28480
// Needs a profile without a PIN on that server, and TMDB reachable from it.
// PLAYPEX_TEST_METADATA=1: the server has a metadata provider like this one in
// <config>/plugins-dev/rater/ (metadata.details: a rating 84/100 named "Rater",
// the tag "Heist"): the movie's meta line shows them (providers plan step 7).

module.exports = async function (t) {
  const text = selector => t.js(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() || ''`);
  const count = selector => t.js(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const component = selector => `ng.getComponent(document.querySelector(${JSON.stringify(selector)}))`;

  await t.dev('profile()');

  // ── a movie ──────────────────────────────────────────────────────────────
  await t.dev("open({ screen: 'core.movie', params: { id: '949' } })");
  t.check('the movie page: its cast', await t.until("document.querySelectorAll('.casts .px-card').length > 3", 15000));
  t.check('… its similar titles', await t.until("document.querySelectorAll('.similar .px-card').length > 0", 10000));
  t.check('the description: Heat (1995), IMDb, genres', await t.until(
    "/Heat/.test(document.querySelector('movie-description')?.innerText) && /1995/.test(document.querySelector('movie-description')?.innerText) && /Crime/.test(document.querySelector('movie-description')?.innerText)", 10000),
    await text('movie-description'));
  t.check('… and its IMDb rating', await t.until("!!document.querySelector('movie-description px-score img[alt=\"IMDb\"]')", 10000));
  t.check('a trailer from the page\'s videos', await t.js(`!!${component('app-movie-options')}.trailer`));
  t.check('cast cards have photos', await t.js("Array.from(document.querySelectorAll('.casts .px-card img')).every(i => /image\\.tmdb\\.org\\/t\\/p\\/\\w+\\//.test(i.src))"));
  if (process.env.PLAYPEX_TEST_METADATA === '1') {
    t.check('a metadata provider\'s rating and tag on the meta line', await t.until(
      "/Rater\\s*8\\.4/.test(document.querySelector('movie-description')?.innerText) && /Heist/.test(document.querySelector('movie-description')?.innerText)", 8000),
      await text('movie-description'));
  }
  await t.shot('catalog-movie');

  // ── a show, its seasons ──────────────────────────────────────────────────
  await t.dev("open({ screen: 'core.show', params: { id: '1396' } })");
  t.check('the show page: its seasons', await t.until("document.querySelectorAll('.seasons .season').length >= 5", 15000), await count('.seasons .season'));
  t.check('… season 1\'s 7 episodes', await t.until("document.querySelectorAll('.episodes .px-card').length == 7", 10000), await count('.episodes .px-card'));
  t.check('the description: 5 seasons, TMDB score', await t.until("/5 seasons/.test(document.querySelector('movie-description')?.innerText) && /TMDB/.test(document.querySelector('movie-description')?.innerText)", 8000),
    await text('movie-description'));
  await t.js("window.SpatialNavigation.focus(document.querySelector('.seasons .season[data-season=\"2\"]'))");
  t.check('focusing season 2: its 13 episodes', await t.until("document.querySelectorAll('.episodes .px-card').length == 13", 10000), await count('.episodes .px-card'));
  await t.shot('catalog-show');

  // ── an episode ───────────────────────────────────────────────────────────
  await t.dev("open({ screen: 'core.episode', params: { id: '1396', season: '1', episode: '1' } })");
  t.check('the episode page: Pilot', await t.until("/Pilot/.test(document.querySelector('.episodeHeader')?.innerText)", 15000), await text('.episodeHeader'));
  t.check('… directed by Vince Gilligan', /Directed by[\s\S]*Vince Gilligan/.test(await text('.episodeHeader')), await text('.episodeHeader'));
  t.check('… the season\'s episodes and guest stars', await t.until("document.querySelectorAll('.episodePageContainer .episodes .px-card').length == 7 && document.querySelectorAll('.guests .px-card').length > 0", 8000));
  await t.shot('catalog-episode');

  // ── the movies section: search and filters ───────────────────────────────
  await t.dev("reset({ screen: 'core.movies' })");
  await t.until("document.querySelectorAll('px-card-row .px-card').length > 10", 15000);
  await t.wait(1000);
  await t.js(`${component('movies-page')}.onSearchDone('heat')`);
  t.check('a search: one row of results', await t.until("Array.from(document.querySelectorAll('px-card-row')).some(r => /Results for/.test(r.innerText)) && document.querySelectorAll('px-card-row .px-card').length > 2", 10000));
  t.check('… Heat among them', await t.until("Array.from(document.querySelectorAll('px-card-row .px-card')).some(c => /^Heat$/.test(c.getAttribute('aria-label') || c.textContent.trim()))", 5000));
  await t.js(`${component('movies-page')}.clearSearch()`);
  await t.js(`${component('movies-page')}.onFiltersApplied({ genre: 35, period: '1990s', rating: 7, language: '' })`);
  t.check('filters: three discover rows named after them', await t.until(
    "['Popular comedy from the 1990s scoring 7+', 'Top rated comedy', 'Newest comedy'].every(n => Array.from(document.querySelectorAll('px-card-row')).some(r => r.innerText.includes(n)))", 10000),
    await t.js("Array.from(document.querySelectorAll('px-card-row')).map(r => r.querySelector('h2,h3')?.textContent.trim())"));
  t.check('… with posters', await t.until("document.querySelectorAll('px-card-row .px-card img').length > 10", 10000));
  t.check('… of the 1990s', await t.js(`(() => { const c = ${component('movies-page')}.catalog; return Object.values(c.items.value).flat().every(m => m.year >= '1990' && m.year <= '1999'); })()`));
  await t.shot('catalog-filters');
  await t.js(`${component('movies-page')}.clearSearch()`);

  // ── the search page ──────────────────────────────────────────────────────
  await t.dev("open({ screen: 'core.search' })");
  await t.until("!!document.querySelector('.inputValue')", 8000);
  await t.js(`(() => { const input = document.querySelector('.inputValue'); input.value = 'pacino'; ${component('app-search-page')}.onInputChange(input); })()`);
  t.check('search: a People row', await t.until("Array.from(document.querySelectorAll('.resultRow')).some(r => r.dataset.row == 'people')", 10000));
  await t.js(`${component('app-search-page')}.showCredits(${component('app-search-page')}.state.rows.find(r => r.key == 'people').items[0])`);
  t.check('a person: a row of their titles', await t.until("document.querySelectorAll('.resultRow[data-row=\"credits\"] .result, .resultRow[data-row=\"credits\"] .px-card').length > 5", 10000));
  t.check('… "With Al Pacino"', /With Al Pacino/.test(await t.js("document.querySelector('.resultRow[data-row=\"credits\"]')?.innerText || ''")));
  await t.shot('catalog-search');

  // ── the watch list's details ─────────────────────────────────────────────
  const api = await t.dev('api');
  const profile = await t.js("JSON.parse(localStorage.getItem('playpex.profile') || 'null')?.id || null").catch(() => null);
  const profileId = profile || await t.js(`fetch(${JSON.stringify(api)} + '/profiles').then(r => r.json()).then(p => p.profiles.find(x => !x.hasPin && !x.isKid).id)`);
  await t.js(`fetch(${JSON.stringify(api)} + '/profiles/${profileId}/watchlist/movie/949', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Heat', posterPath: '/umSVjVdbVwtx5ryCA2QXL44Durm.jpg', backdropPath: null }) })`);
  await t.dev("reset({ screen: 'core.watchlist' })");
  t.check('the watch list: Heat with its length and score', await t.until("/2h 50m/.test(document.body.innerText) && /TMDB/.test(document.body.innerText)", 12000),
    await t.js("document.querySelector('px-title-info')?.innerText"));
  await t.js(`fetch(${JSON.stringify(api)} + '/profiles/${profileId}/watchlist/movie/949', { method: 'DELETE' })`);

  t.check('no request to TMDB\'s API from the TV', await t.js("performance.getEntriesByType('resource').every(e => !/api\\.themoviedb\\.org/.test(e.name))"));
};
