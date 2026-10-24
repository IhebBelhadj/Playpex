'use strict';

// Where Play's torrents come from (docs/providers-plan.md step 5): the server
// reads no torrent site of its own, plugins do.
//   • a server with no source plugin: a movie page has no Find releases, Play
//     opens the chooser's empty state ("Nothing to play this from yet");
//   • PLAYPEX_TEST_SOURCES=1, a server in plugin developer mode with the test
//     plugin apps/server/test/fixtures/plugins/fake-torrents in
//     <config>/plugins-dev/: Find releases shows, Play offers its torrents.
//   npx electron scripts/scenario.js sources --server http://127.0.0.1:28480
// Needs a profile without a PIN on that server. Nothing is downloaded.

module.exports = async function (t) {
  const withSources = process.env.PLAYPEX_TEST_SOURCES === '1';
  await t.dev('profile()');
  await t.dev("open({ screen: 'core.movie', params: { id: '949' } })");
  t.check('the movie page opens', await t.until("document.querySelector('app-movie-options [data-px-key=\"play\"]')", 15000));
  // the plugins' capabilities are read with the profile
  await t.wait(1500);
  const releases = await t.js("!!document.querySelector('app-movie-options [data-px-key=\"releases\"]')");
  t.check(withSources ? 'Find releases shows (a plugin lists releases)' : 'no Find releases (no plugin lists releases)',
    releases === withSources, { releases });
  await t.shot(withSources ? 'sources-movie' : 'no-sources-movie');

  await t.click('app-movie-options [data-px-key="play"]');
  const panel = "document.querySelector('#playChooser')";
  t.check('the chooser opens', await t.until(panel, 15000));
  await t.wait(500);
  const text = await t.js(`${panel}.innerText`);
  if (withSources) {
    t.check('its torrents are offered', /Torrent/.test(text) && /1080p/.test(text), { text });
    t.check('no empty state', !/Nothing to play this from yet/.test(text), { text });
  } else {
    t.check('the empty state says so', /Nothing to play this from yet/.test(text), { text });
    t.check('and where sources come from', /dashboard/i.test(text), { text });
  }
  await t.shot(withSources ? 'sources-chooser' : 'no-sources-chooser');
  await t.key('Escape');
  t.check('Back closes it', await t.until(`!${panel}`, 3000));
};
