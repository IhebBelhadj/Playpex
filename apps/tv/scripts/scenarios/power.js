'use strict';

// The power screen (core.power): Close Playpex focused first, nothing moves as
// the focus does (every option keeps room for its second line), Down reaches
// the computer's options down to Shut down, Back closes it. Never presses OK.
module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("open({ screen: 'core.show', params: { id: '1396' } })");
  await t.wait(3500);
  await t.dev("open({ screen: 'core.power' })");
  await t.wait(1500);
  t.check('first option focused', (await t.focused())?.key == 'quit', await t.focused());
  await t.shot('power');
  const where = () => t.js("Array.from(document.querySelectorAll('.powerPage .option')).map(b => Math.round(b.getBoundingClientRect().top))");
  let before = await where();
  await t.key('Down');
  await t.wait(500);
  t.check('nothing moves as focus does', JSON.stringify(before) == JSON.stringify(await where()), { before, after: await where() });
  t.check('Down: Sleep', (await t.focused())?.key == 'sleep', await t.focused());
  await t.shot('power-sleep');
  await t.key('Down', 2);
  await t.wait(500);
  t.check('Shut down last', (await t.focused())?.key == 'shutdown', await t.focused());
  await t.shot('power-shutdown');
  await t.key('Escape');
  await t.wait(800);
  t.check('Back closes it', !(await t.js("!!document.querySelector('power-page')")));
};
