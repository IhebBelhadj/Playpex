'use strict';

// The example plugin (src/app/plugins-dev/hello): its action on a movie page
// opens its own screen, whose action asks (Dialogs.confirm) and answers (a
// toast); its paged row at the end of the Movies section; its own section.
// Off again at the end.

module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("plugin('hello', true)");

  await t.dev("open({ screen: 'core.movie', params: { id: 949 } })");
  t.check('the plugin\'s action is on the movie page', await t.until("!!document.querySelector('[data-px-key=\"hello:party\"]')", 10000));
  const keys = await t.js("Array.from(document.querySelectorAll('px-action-bar .px-action')).map(b => b.dataset.pxKey)");
  t.check('… after the core\'s tiles', keys[keys.length - 1] == 'hello:party', keys);
  await t.js("window.SpatialNavigation.focus(document.querySelector('[data-px-key=\"hello:party\"]'))");
  await t.key('Return');
  t.check('Enter opens the plugin\'s screen', await t.until("window.playpexDev.screen() == 'plugin.hello.title'", 5000));
  await t.until("!!document.querySelector('[data-px-key=\"hello:wave\"]')", 4000);
  await t.js("window.SpatialNavigation.focus(document.querySelector('[data-px-key=\"hello:wave\"]'))");
  await t.key('Return');
  t.check('its action asks (Dialogs.confirm)', await t.until("window.playpexDev.layers().length > 0", 3000));
  await t.key('Return');
  t.check('… and answers with a toast', await t.until("!!document.querySelector('.px-toast')", 3000));
  await t.shot('plugin-title');
  await t.key('Escape');
  t.check('Back: the movie page again', await t.until("window.playpexDev.screen() == 'core.movie'", 4000));

  await t.dev("reset({ screen: 'core.movies' })");
  t.check('the plugin\'s row is in the Movies section', await t.until("!!document.querySelector('px-slot px-card-row')", 10000));
  t.check('… with its first page', await t.until("document.querySelectorAll('px-slot px-card-row .px-card').length >= 12", 5000));

  await t.dev("open({ screen: 'plugin.hello.section' })");
  t.check('its own section opens', await t.until("document.querySelectorAll('hello-section .px-card').length >= 12", 5000));
  await t.shot('plugin-section');

  await t.dev("plugin('hello', false)");
  await t.dev("reset({ screen: 'core.movies' })");
  await t.wait(1500);
  t.check('off: no plugin row', await t.js("!document.querySelector('px-slot px-card-row')"));
};
