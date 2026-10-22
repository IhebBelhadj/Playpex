'use strict';

// Settings page (core.settings): the rail of groups, moving between them, a
// chip choice and a switch saved to the server, a slider written once it
// stops, the screen edges calibration (preview, Back restores, OK keeps), Back
// ladder. Puts every value it changed back at the end.

module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.settings' })");
  await t.until("!!document.querySelector('.settingsRail .px-tab')");
  const before = await t.js("fetch(window.playpexDev.api + '/settings?device=' + window.playpexDev.deviceId).then(r => r.json()).catch(() => null)");

  // from the menu into the rail
  await t.js("document.querySelector('.menuItem.active')?.focus()");
  await t.key('Right');
  let f = await t.focused();
  t.check('Right from the menu lands on the shown group', f && f.key == 'tab:display', f);

  // moving onto a group shows it
  await t.key('Down');
  f = await t.focused();
  t.check('Down in the rail: Playback', f && f.key == 'tab:playback', f);
  t.check('Playback group shown', await t.js("!!document.querySelector('.settingsMain [data-px-key=\"volume\"]')"));

  // into the settings: the volume slider first
  await t.key('Right');
  f = await t.focused();
  t.check('Right from the rail: the first setting (volume)', f && f.key == 'volume', f);
  const volume = await t.js("Number(document.querySelector('[data-px-key=\"volume\"]').getAttribute('aria-valuenow'))");
  await t.key('Left');
  await t.key('Left');
  const lowered = await t.js("Number(document.querySelector('[data-px-key=\"volume\"]').getAttribute('aria-valuenow'))");
  t.check('Left twice lowers the volume by 10', lowered == volume - 10, { volume, lowered });
  await t.wait(900);
  const stored = await t.js("fetch(window.playpexDev.api + '/settings?device=' + window.playpexDev.deviceId).then(r => r.json())");
  t.check('the volume is on the server once the slider stops', stored.device['player.volume'] == lowered, stored.device);

  // subtitle size: Down enters the chips on the current size
  await t.key('Down');
  f = await t.focused();
  t.check('Down: the current subtitle size', f && f.key == 'size:' + stored.device['subtitles.size'], f);
  await t.key('Right');
  const picked = (await t.focused()).key;
  await t.key('Return');
  await t.wait(500);
  const afterSize = await t.js("fetch(window.playpexDev.api + '/settings?device=' + window.playpexDev.deviceId).then(r => r.json())");
  t.check('OK on a size stores it', 'size:' + afterSize.device['subtitles.size'] == picked, { picked, stored: afterSize.device['subtitles.size'] });
  t.check('the chosen chip shows selected', await t.js(`document.querySelector('[data-px-key="${picked}"]').classList.contains('selected')`));

  // the autoplay switch (a profile setting)
  await t.key('Down', 2);
  f = await t.focused();
  t.check('Down twice: the autoplay switch', f && f.key == 'autoplay', f);
  const on = await t.js("document.querySelector('[data-px-key=\"autoplay\"]').getAttribute('aria-checked') == 'true'");
  await t.key('Return');
  t.check('OK flips it', await t.js(`document.querySelector('[data-px-key="autoplay"]').getAttribute('aria-checked') == '${!on}'`));
  await t.key('Return');
  await t.shot('settings-playback');

  // Back: the rail (on the shown group), then the menu
  await t.key('Escape');
  f = await t.focused();
  t.check('Back from a setting: the shown group', f && f.key == 'tab:playback', f);

  // screen edges
  await t.key('Up');
  await t.key('Right');
  await t.key('Down');
  f = await t.focused();
  t.check('Display › the Adjust button', f && f.key == 'edges', f);
  await t.key('Return');
  t.check('the calibration opens', await t.until("!!document.querySelector('screen-edges .edges')", 3000));
  f = await t.focused();
  t.check('its slider has the focus', f && f.key == 'edges', f);
  await t.key('Right', 4);
  const inset = await t.js("getComputedStyle(document.documentElement).getPropertyValue('--px-safe-x')");
  t.check('Right moves the frame in (the whole UI)', /0\.02/.test(inset), inset);
  await t.shot('settings-edges');
  await t.key('Escape');
  t.check('Back closes it', await t.until("!document.querySelector('screen-edges')", 2000));
  const restored = await t.js("getComputedStyle(document.documentElement).getPropertyValue('--px-safe-x')");
  t.check('… and puts the previous inset back', /\* 0\)|\* 0$/.test(restored.trim()) || restored.includes('* 0)'), restored);
  f = await t.focused();
  t.check('the focus is back on Adjust', f && f.key == 'edges', f);

  await t.key('Return');
  await t.until("!!document.querySelector('screen-edges .edges')", 3000);
  await t.key('Right', 2);
  await t.key('Return');
  await t.wait(500);
  const edges = await t.js("fetch(window.playpexDev.api + '/settings?device=' + window.playpexDev.deviceId).then(r => r.json())");
  t.check('OK keeps it: stored on the server', edges.device['display.safeArea'] == 0.01, edges.device);

  // put things back as they were
  await t.js(`fetch(window.playpexDev.api + '/settings/device?device=' + window.playpexDev.deviceId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify({
    'player.volume': before && before.device['player.volume'],
    'subtitles.size': before && before.device['subtitles.size'],
    'display.safeArea': before && before.device['display.safeArea'],
  })}) }).then(r => r.status)`);
};
