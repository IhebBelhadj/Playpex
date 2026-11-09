'use strict';

// The left menu when its sections don't fit (many plugins' sections, a large UI
// size: run with --scale 1.15): the sections list scrolls (pxStack
// "menuSections"), every section reached with the keys is shown inside it,
// Down past the last section reaches the server / profile items, Up comes back,
// the wheel scrolls it, the active section is brought into view when Back
// focuses it.
//
//   npx electron scripts/scenario.js menu --scale 1.15

module.exports = async function (t) {
  await t.dev('profile()');
  await t.dev("reset({ screen: 'core.movies' })");
  await t.until("document.querySelectorAll('.menuContainer .sections .menuItem').length > 0");
  await t.wait(800);

  const geometry = "(() => { const s = document.querySelector('.menuContainer .sections');" +
    " return { count: s.querySelectorAll('.menuItem').length, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: s.scrollTop }; })()";
  const g = await t.js(geometry);
  t.check('the sections overflow at this size (else this run proves nothing)', g.scrollHeight > g.clientHeight + 4, g);

  // is the focused item wholly inside the sections list's visible box?
  const inView = "(() => { const s = document.querySelector('.menuContainer .sections'), a = document.activeElement;" +
    " if (!s.contains(a)) return null; const r = a.getBoundingClientRect(), b = s.getBoundingClientRect();" +
    " return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; })()";

  await t.js("document.querySelector('.menuContainer .sections .menuItem')?.focus()");
  await t.wait(400);
  t.check('the first section focused', (await t.focused()).classes.includes('menuItem'));

  // Down through every section: each one in view
  const seen = [];
  for (let i = 1; i < g.count; i++) {
    await t.key('Down');
    await t.wait(320);
    const f = await t.focused();
    seen.push(f.text);
    t.check('Down ' + i + ': "' + f.text + '" in view', (await t.js(inView)) === true, await t.js(geometry));
  }
  t.check('the list scrolled to show the last sections', (await t.js(geometry)).scrollTop > 0);
  await t.shot('menu-bottom');

  // past the last section: the account items
  await t.key('Down');
  await t.wait(320);
  let f = await t.focused();
  t.check('Down past the last section: the server / profile item', /serverItem|profileItem/.test(f.classes), f);

  // Up again: a section, in view
  await t.key('Up');
  await t.wait(320);
  f = await t.focused();
  t.check('Up from the account items: a section, in view', f.classes.includes('menuItem') && (await t.js(inView)) === true, f);

  // Up to the first one: the list back at its start
  for (let i = 0; i < g.count; i++) {
    await t.key('Up');
    await t.wait(200);
  }
  await t.wait(400);
  t.check('Up to the first section: the list back at the top', (await t.js(geometry)).scrollTop === 0, await t.js(geometry));
  await t.shot('menu-top');

  // the wheel scrolls it (native scrolling)
  await t.js("document.querySelector('.menuContainer .sections').scrollBy(0, 400)");
  await t.wait(300);
  t.check('the list scrolls (wheel / trackpad)', (await t.js(geometry)).scrollTop > 0);

  // Back from the page focuses the active section: brought into view when it's off screen
  await t.js("document.querySelector('.menuContainer .sections').scrollTop = 0");
  await t.js("(() => { const items = document.querySelectorAll('.menuContainer .sections .menuItem'); items[items.length - 1].focus(); })()");
  await t.wait(500);
  t.check('a focus() from code on a hidden section brings it into view', (await t.js(inView)) === true, await t.js(geometry));
};
