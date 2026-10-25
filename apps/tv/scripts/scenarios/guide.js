'use strict';

// Live TV (docs/providers-plan.md step 9): the plugin m3u's section drawn by
// the core's guide template, then a channel in the player. Lines are
// channels with their programmes over a 3 h window from the current half
// hour, an amber now rule; ↑/↓ move between channels by time, ←/→ along one;
// Later moves the window; a group narrows the channels; Enter on what is on
// now plays the channel (the Live mark, its banner), ↑/↓ flip channels in
// the player (the banner first, then the next stream), OK opens the mini
// guide; Back leaves. Needs the throwaway server of
// apps/server/test/helpers/live-server.js (the made-up IPTV provider):
//   node apps/server/test/helpers/live-server.js --port 28491
//   npx electron scripts/scenario.js guide --server http://127.0.0.1:28491

const guide = "ng.getComponent(document.querySelector('plugin-guide'))";
const player = "ng.getComponent(document.querySelector('app-player-page'))";
const video = "document.querySelector('.moviePlayer')";

module.exports = async function (t) {
  await t.dev('profile()');
  t.check('the Live TV section is in the menu', await t.until("[...document.querySelectorAll('.menuItem')].some(m => /Live TV/.test(m.textContent))", 10000));
  await t.dev("open({ screen: 'plugin.m3u.guide' })");
  t.check('the guide shows the channels', await t.until("document.querySelectorAll('.pluginGuide .line').length >= 20", 15000),
    await t.js("document.querySelectorAll('.pluginGuide .line').length"));
  t.check('… 40 lines at first (more as the focus goes down)', await t.js("document.querySelectorAll('.pluginGuide .line').length == 40"));
  t.check('programmes arrived', await t.until("document.querySelectorAll('.pluginGuide .cell:not(.unknown)').length > 40", 15000));
  t.check('six half hours on the ruler', await t.js("document.querySelectorAll('.pluginGuide .tick').length == 6"));
  t.check('the now rule on every line', await t.js("document.querySelectorAll('.pluginGuide .nowLine').length == 40"));
  t.check('a programme of the first line has the focus', await t.until("document.activeElement?.closest('.pluginGuide .line')", 5000),
    await t.focused());
  const first = await t.focused();
  t.check('… what is on now', /@/.test(first.key) && await t.js("document.activeElement.classList.contains('onAir')"), first);
  t.check('its details on top', await t.js("/Show \\d+ on Channel 1/.test(document.querySelector('.pluginGuide .spotTitle')?.textContent)"),
    await t.js("document.querySelector('.pluginGuide .spotTitle')?.textContent"));
  await t.shot('guide');

  await t.key('Right');
  const right = await t.focused();
  t.check('Right: the next programme of the same channel', right.key != first.key && right.key.split('@')[0] == first.key.split('@')[0], right);
  await t.key('Down');
  const down = await t.focused();
  t.check('Down: the next channel', down.key.split('@')[0] != right.key.split('@')[0], down);
  for (let i = 0; i < 34; i++) await t.key('Down');
  t.check('going down draws more lines', await t.until("document.querySelectorAll('.pluginGuide .line').length > 40", 5000),
    await t.js("document.querySelectorAll('.pluginGuide .line').length"));

  // Later, then Now
  await t.key('Up', 40);
  t.check('Up from the first line: the toolbar', await t.until("document.activeElement?.closest('.pluginGuide .toolbar')", 3000), await t.focused());
  await t.js("document.querySelector('.pluginGuide [data-px-key=\"later\"]').focus()");
  await t.key('Return');
  t.check('Later: the window moves 2 h on', await t.until(`${guide}.state.offset == 2`, 3000));
  t.check('… no now rule', await t.until("!document.querySelector('.pluginGuide .nowLine')", 3000));
  await t.js("document.querySelector('.pluginGuide [data-px-key=\"now\"]').focus()");
  await t.key('Return');
  t.check('Now: back', await t.until(`${guide}.state.offset == 0 && !!document.querySelector('.pluginGuide .nowLine')`, 3000));

  // a group
  await t.js("document.querySelector('.pluginGuide [data-px-key=\"groups\"]').focus()");
  await t.key('Return');
  t.check('the groups panel', await t.until("document.querySelector('#guideGroups')", 3000));
  await t.shot('guide-groups');
  await t.js("document.querySelector('#guideGroups [data-px-key=\"group:Sport\"]').focus()");
  await t.key('Return');
  t.check('Sport only', await t.until(`${guide}.state.group == 'Sport' && ${guide}.lines.every(l => l.channel.group == 'Sport')`, 3000));
  await t.key('Down');
  t.check('Down from the toolbar: a programme', await t.until("document.activeElement?.closest('.pluginGuide .lines')", 3000), await t.focused());
  // a later programme: its details, no playing
  if (!(await t.js("document.activeElement.classList.contains('onAir')"))) {
    await t.key('Return');
    t.check('Enter on a later programme: its details', await t.until("[...document.querySelectorAll('px-dialog')].some(d => /Channel \\d+ · (Today|Tomorrow)/.test(d.innerText))", 3000));
    await t.shot('guide-programme');
    await t.key('Escape');
    await t.until("!document.querySelector('px-dialog')", 3000);
  }

  // play what is on now
  await t.js("window.SpatialNavigation.focus(document.querySelector('.pluginGuide .lines .cell.onAir'))");
  t.check('what is on now has the focus', await t.until("document.activeElement?.classList.contains('onAir')", 3000), await t.focused());
  const chosen = await t.js("document.activeElement.closest('.line').querySelector('.number').textContent.trim()");
  await t.key('Return');
  const streams = await t.js(`fetch(window.playpexDev.api + '/live').then(r => r.json()).then(() => true)`);
  t.check('Enter on what is on now: the player', await t.until("document.querySelector('app-player-page')", 8000), streams);
  t.check('… a channel, live', await t.until(`${player}?.live && ${player}?.playback?.channel?.number == ${chosen}`, 5000),
    await t.js(`${player}?.playback?.channel`));
  const plays = await t.until(`${video}?.currentTime > 1`, 25000);
  t.check('it plays (no ffmpeg: skipped)', plays || !(await t.js("fetch(window.playpexDev.api + '/server').then(r => r.json()).then(s => s.features.transcode)")),
    await t.js(`${video}?.currentTime`));
  if (plays) {
    t.check('its banner once the picture is there', await t.until("document.querySelector('.channelBanner')", 5000));
    t.check('… with what is on', await t.until("/Show \\d+/.test(document.querySelector('.channelBanner .onAir')?.textContent)", 5000));
    await t.shot('guide-player');
  }

  if (plays) {
    await t.until(`${player}.playerReady`, 5000);
    await t.key('Down');
    t.check('↓: the next channel\'s banner at once', await t.until(`document.querySelector('.channelBanner .channelNumber')?.textContent != '${chosen}'`, 2000),
      await t.js("document.querySelector('.channelBanner .channelNumber')?.textContent"));
    t.check('… then its stream (the player replaced)', await t.until(`${player}?.playback?.channel?.number != ${chosen}`, 8000),
      await t.js(`${player}?.playback?.channel`));
    t.check('… which plays', await t.until(`${video}?.currentTime > 1`, 25000), await t.js(`${video}?.currentTime`));
    await t.until(`${player}.playerReady`, 5000);
    await t.key('Return');
    t.check('OK: the mini guide', await t.until("document.querySelector('#playerChannels .channelRow.focused.current')", 3000), await t.focused());
    await t.shot('guide-channels');
    await t.key('Escape');
    t.check('Back closes it', await t.until("!document.querySelector('#playerChannels')", 3000));
  }
  await t.key('Escape');
  await t.key('Escape');
  await t.key('Escape');
  t.check('Back leaves to the guide', await t.until("!document.querySelector('app-player-page') && !!document.querySelector('plugin-guide')", 6000));
};
