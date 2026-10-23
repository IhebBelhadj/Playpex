'use strict';

// A plugin's writes and notifications on the TV (docs/plugins-plan.md step
// P3b) with the example plugin plugins/hello on a server in plugin developer
// mode, where the admin granted Hello "Can change your watch list" for the
// profile (dashboard: Plugins › Hello › Settings › Profiles): Hello's tile on a
// movie page adds the movie to the profile's list through the core (its
// toast), and when the profile adds a title itself, Hello's notification
// shows as a toast.
//   npx electron scripts/scenario.js plugin-events --server <url>

const TOAST = "document.querySelector('px-toast-host')?.innerText || ''";

module.exports = async function (t) {
  const profile = await t.dev('profile()');   // its name
  await t.until("[...document.querySelectorAll('.menuItem .description')].some(e => e.textContent.trim() == 'Hello')", 10000);

  // 1. a write through the core: Hello's tile on The Matrix
  await t.dev("reset({ screen: 'core.movie', params: { id: 603 } })");
  t.check('Hello\'s tile on the movie page', await t.until("!!document.querySelector('[data-px-key=\"hello:list\"]')", 10000));
  await t.wait(500);
  await t.js("window.SpatialNavigation.focus(document.querySelector('[data-px-key=\"hello:list\"]'))");
  await t.key('Return');
  t.check('… adds it to the list (its toast)', await t.until(`/Hello added The Matrix to your list/.test(${TOAST})`, 8000), { toast: await t.js(TOAST) });
  // (the page's own tile learns it the next time the page loads: clients aren't told of plugins' writes)
  const list = await t.js(`fetch(window.playpexDev.api + '/profiles').then(r => r.json())
    .then(a => a.profiles.find(p => p.name == ${JSON.stringify(profile)}).id)
    .then(id => fetch(window.playpexDev.api + '/profiles/' + id + '/watchlist')).then(r => r.json())`);
  t.check('… it is on the profile\'s list', Array.isArray(list) && list.some(w => w.tmdbId === 603), { list });
  await t.shot('write-toast');

  // 2. the profile adds a title itself: Hello's notification
  await t.wait(4500);
  await t.dev("reset({ screen: 'core.movie', params: { id: 550 } })");
  t.check('another movie page', await t.until("!!document.querySelector('[data-px-key=\"watchlist\"]')", 10000));
  await t.wait(500);
  await t.js("window.SpatialNavigation.focus(document.querySelector('[data-px-key=\"watchlist\"]'))");
  await t.key('Return');
  t.check('Hello\'s notification shows as a toast', await t.until(`/Hello saw “Fight Club” on your list/.test(${TOAST})`, 10000), { toast: await t.js(TOAST) });
  await t.wait(300);
  await t.shot('notification-toast');

  // 3. the linked account, read by a call (the menu's "Who am I?")
  await t.dev("open({ screen: 'plugin.hello.menu' })");
  await t.until("!!document.querySelector('.pluginList [data-px-key=\"hello:whoami\"]')", 6000);
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginList [data-px-key=\"hello:whoami\"]'))");
  await t.wait(4500);
  await t.key('Return');
  t.check('the linked account (link.status)', await t.until(`/Linked as Ana B/.test(${TOAST})`, 8000), { toast: await t.js(TOAST) });
};
