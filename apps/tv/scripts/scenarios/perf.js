'use strict';

// Performance journeys (docs/ui-system-plan.md §13.5): fixed routes through
// the app with the frame times, long tasks and JS heap measured, checked
// against the budget and written to .perf/<name>.json (PLAYPEX_PERF_NAME,
// default `latest`) to compare between steps:
//
//   first rows      picking a profile → the first poster row on screen (warm cache)
//   hold right      Right held on a row of posters for 5 s
//   down rows       Down through 10 rows
//   detail ×10      open a movie page and leave it, 10 times (heap before / after)
//   player tabs     the player's Settings, across its tabs (PLAYPEX_TEST_CLIP)
//
// Budget: ≤ 1 dropped frame per move at 60 fps; no long task over 50 ms while
// moving; first rows ≤ 1.5 s; heap back within 10 % after the detail pages.

const fs = require('fs');
const path = require('path');

const FRAME_MS = 1000 / 60;

module.exports = async function (t) {
  const results = { date: new Date().toISOString(), journeys: {} };

  // a frame recorder (requestAnimationFrame deltas) and long tasks, in the page
  await t.js(`(() => {
    const perf = window.__perf = { frames: [], long: [], last: 0, on: false };
    const tick = now => { if (perf.on && perf.last) perf.frames.push(now - perf.last); perf.last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try { new PerformanceObserver(list => { if (perf.on) list.getEntries().forEach(e => perf.long.push(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) { }
    return 1;
  })()`);

  async function measure(name, moves, run) {
    await t.js('(window.__perf.frames = [], window.__perf.long = [], window.__perf.last = 0, window.__perf.on = true, 1)');
    const start = Date.now();
    await run();
    const data = await t.js('(window.__perf.on = false, { frames: window.__perf.frames, long: window.__perf.long })');
    const dropped = data.frames.reduce((sum, d) => sum + Math.max(0, Math.round(d / FRAME_MS) - 1), 0);
    const result = {
      ms: Date.now() - start,
      moves,
      frames: data.frames.length,
      dropped,
      droppedPerMove: moves ? +(dropped / moves).toFixed(2) : null,
      longTasks: data.long.length,
      longestTaskMs: data.long.length ? Math.round(Math.max(...data.long)) : 0,
      worstFrameMs: data.frames.length ? Math.round(Math.max(...data.frames)) : 0,
    };
    results.journeys[name] = result;
    console.log('  ' + name + ': ' + JSON.stringify(result));
    if (moves) t.check(`budget ${name}: ≤ 1 dropped frame per move`, result.droppedPerMove <= 1, result.droppedPerMove);
    t.check(`budget ${name}: no long task over 50 ms`, result.longestTaskMs <= 50, result.longestTaskMs);
    return result;
  }

  async function heap() {
    await t.cdp('HeapProfiler.collectGarbage');
    const { metrics } = await t.cdp('Performance.getMetrics');
    return metrics.find(m => m.name == 'JSHeapUsedSize').value;
  }
  await t.cdp('Performance.enable');

  // first rows (warm: the second time)
  for (let pass = 0; pass < 2; pass++) {
    await t.dev("reset({ screen: 'core.profiles' })");
    await t.wait(1500);
    const start = Date.now();
    await t.dev('profile()');
    await t.dev("reset({ screen: 'core.movies' })");
    await t.until("!!document.querySelector('px-card-row .px-card img') && document.querySelector('px-card-row .px-card img').complete", 15000);
    results.journeys.firstRows = { ms: Date.now() - start, warm: pass == 1 };
  }
  console.log('  first rows: ' + results.journeys.firstRows.ms + ' ms');
  t.check('budget first rows ≤ 1.5 s (warm)', results.journeys.firstRows.ms <= 1500, results.journeys.firstRows.ms);
  await t.wait(2000);

  // onto the first poster
  await t.js("document.querySelector('.menuItem.active')?.focus()");
  await t.key('Right');
  await t.wait(800);

  t.keyGap = 80;
  await measure('holdRight', 60, () => t.key('Right', 60));
  t.keyGap = 250;
  await t.wait(800);
  await measure('downRows', 10, () => t.key('Down', 10));
  t.keyGap = 180;

  // detail pages: heap before and after (after 3 to warm the caches: TMDB
  // answers, images), then a second round (growth that goes on = a leak)
  const details = async n => {
    for (let i = 0; i < n; i++) {
      await t.dev("open({ screen: 'core.movie', params: { id: 949 } })");
      await t.until("!!document.querySelector('[data-px-key=\"play\"]')", 8000);
      await t.wait(700);
      await t.key('Escape');
      await t.wait(500);
    }
  };
  await details(3);
  const before = await heap();
  await measure('detail', 20, () => details(10));
  await t.wait(1500);
  const after = await heap();
  await details(10);
  await t.wait(1500);
  const again = await heap();
  Object.assign(results.journeys.detail, {
    heapBefore: before, heapAfter: after, heapAfter20: again,
    heapGrowth: +((after - before) / before).toFixed(3), heapGrowthSecond: +((again - after) / after).toFixed(3),
  });
  console.log('  heap: ' + [before, after, again].map(h => (h / 1e6).toFixed(1)).join(' → ') + ' MB');
  t.check('budget heap within 10 % after 10 detail pages', after <= before * 1.1, results.journeys.detail.heapGrowth);

  // the player's settings tabs
  const clip = process.env.PLAYPEX_TEST_CLIP;
  if (clip) {
    await t.dev(`player(${JSON.stringify('file://' + clip)}, 'movie')`);
    await t.until("document.querySelector('.moviePlayer')?.readyState >= 3", 20000);
    await t.wait(2500);
    await t.key('Down');
    await t.js("document.querySelector('.buttons [data-px-key=\"settings\"]') && window.SpatialNavigation.focus(document.querySelector('.buttons [data-px-key=\"settings\"]'))");
    await t.key('Return');
    await t.until("!!document.querySelector('.px-tab.active')", 3000);
    await measure('playerTabs', 8, async () => {
      await t.key('Right', 4);
      await t.key('Left', 4);
    });
    await t.key('Escape');
    await t.key('Escape');
  }

  const dir = path.join(__dirname, '..', '..', '.perf');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (process.env.PLAYPEX_PERF_NAME || 'latest') + '.json');
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log('  → ' + path.relative(process.cwd(), file));
};
