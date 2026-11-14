'use strict';

// Plugins' title and release pages reach the menu: opened from a core title
// page (which removes the menu's section when it closes), the mouse over the
// menu focuses it and Right goes back into the page. Needs a server in plugin
// developer mode with plugins/hello in <config>/plugins-dev/hello (as
// plugin-templates.js).
module.exports = async function (t) {
  await t.dev('profile()');
  await t.until("[...document.querySelectorAll('.menuItem .description')].some(e => e.textContent.trim() == 'Hello')", 10000);
  const hover = async () => {
    let item = await t.js("(() => { let el = Array.from(document.querySelectorAll('menu .menuItem')).find(e => e.getBoundingClientRect().y > 150); let b = el.getBoundingClientRect(); return { x: 24, y: b.y + b.height / 2 } })()");
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x + 2, y: item.y });
    await t.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y });
    await t.wait(800);
    return /menuItem/.test((await t.focused())?.classes || '');
  };
  for (const [name, screen, ready] of [
    ['title', 'plugin.hello.title', "!!document.querySelector('.pluginTitle px-action [data-px-item]')"],
    ['releases', 'plugin.hello.releases', "!!document.querySelector('.rail [data-px-item], [pxsection] [data-px-item]')"],
  ]) {
    // as a user gets there: from a core title page (which removes the menu's section when it closes)
    await t.dev("open({ screen: 'core.show', params: { id: '1396' } })");
    await t.until("document.querySelectorAll('app-show-options .cast .px-card').length > 3", 15000);
    await t.wait(1500);
    await t.dev(`open({ screen: '${screen}', params: { id: '1' } })`);
    await t.until(ready, 10000);
    await t.wait(1500);
    t.check(name + ': the mouse over the menu focuses it', await hover(), await t.focused());
    await t.key('Right');
    await t.wait(500);
    t.check(name + ': Right goes back into the page', !/menuItem/.test((await t.focused())?.classes || ''), await t.focused());
  }
};
