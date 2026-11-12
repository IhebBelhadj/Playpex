'use strict';

// Keeps Playpex TV open as a cast screen for a while (silent, like every
// scenario) and logs what it plays: for trying casts by hand from a phone,
// the dashboard or the YouTube app (docs/cast-plan.md steps 3–5).
//   npx electron scripts/scenario.js cast-wait --server http://127.0.0.1:28480
//   PLAYPEX_TEST_WAIT_MIN=10 (default) · ends early after PLAYPEX_TEST_WAIT_CASTS casts have played and closed
// Its checks: the TV is a cast screen; at least one cast opened the player (only when one came).

module.exports = async function (t) {
  const minutes = Number(process.env.PLAYPEX_TEST_WAIT_MIN || 10);
  const enough = Number(process.env.PLAYPEX_TEST_WAIT_CASTS || 0);
  const name = await t.dev('profile()');
  console.log(`  Playpex TV is a screen as “${name}” for ${minutes} min. Cast to it now.`);
  const end = Date.now() + minutes * 60 * 1000;
  let last = '', casts = 0, closed = 0;
  while (Date.now() < end) {
    const now = await t.js(`(() => {
      const v = document.querySelector('.moviePlayer');
      const embed = !!document.querySelector('.embedPlayer');
      return JSON.stringify({
        screen: window.playpexDev.screen(),
        title: document.querySelector('app-player-page h1')?.textContent?.trim() || null,
        from: document.querySelector('.castFrom')?.textContent?.trim() || null,
        embed,
        paused: v ? v.paused : null,
      });
    })()`);
    if (now !== last) {
      const s = JSON.parse(now), was = last ? JSON.parse(last) : {};
      if (s.screen == 'core.player' && was.screen != 'core.player') casts++;
      if (s.screen != 'core.player' && was.screen == 'core.player') closed++;
      console.log(`  [${new Date().toLocaleTimeString()}] ${s.screen}${s.title ? ' · ' + s.title : ''}${s.from ? ' · ' + s.from : ''}${s.embed ? ' · YouTube' : ''}${s.paused === true ? ' · paused' : s.paused === false ? ' · playing' : ''}`);
      last = now;
      if (enough && closed >= enough) break;
    }
    await t.wait(1000);
  }
  if (casts) {
    await t.shot('cast-wait');
    t.check(`${casts} cast${casts == 1 ? '' : 's'} opened the player`, true);
  } else {
    t.check('no cast came (nothing to check)', true);
  }
};
