// The home page's loading screen. Until the page's parts are in (the font, this screen's site, the WebGL wall's
// pictures, the eager images), the page waits under the ground with the Playpex mark drawn in unlit dots; its dots
// light gold in scattered order as the parts arrive, like a torrent's pieces. Then the mark steps back and the gold
// front of dots (switch.js) uncovers the page. index.astro covers the page (html.preloading) before anything paints.
import { THEME, still } from './util.js';
import { curtain } from './switch.js';
import { has } from './try.js';   // DRAFT: the options being compared

const html = document.documentElement, root = document.getElementById('preload');
const active = !!root && html.classList.contains('preloading');
const LONGEST = 7000;   // past this the page shows anyway (a slow network): what's missing arrives in place

let total = 0, arrived = 0, shown = 0, over = !active;

// one part the page waits for: call the function it returns once that part is in
export function need() {
  if (over) return () => {};
  total++;
  let done = false;
  return () => { if (!done) { done = true; arrived++; } };
}

// the mark as dots: which grid cells fall inside the logo's polygon (lib/icons.ts), each with its turn to light
const PTS = [9.24, 11.1, 21.58, 17.23, 14.34, 24.17, 26.79, 16.99, 7, 7.21, 7, 11.5, 7, 24.79];
const BOX = [6.5, 6.7, 20.8, 18.6];   // the logo's viewBox
function cells(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), h = cv.clientHeight, w = cv.clientWidth;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  // 34 rows over the mark's height: the same grid as the page's first frame (the SVG in index.astro)
  const S = h / 34, u = h / BOX[3], path = new Path2D();
  for (let i = 0; i < PTS.length; i += 2) path[i ? 'lineTo' : 'moveTo']((PTS[i] - BOX[0]) * u, (PTS[i + 1] - BOX[1]) * u);
  path.closePath();
  const probe = document.createElement('canvas').getContext('2d'), out = [];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = S / 2; y < h; y += S) for (let x = S / 2; x < w; x += S) if (probe.isPointInPath(path, x, y)) out.push({ x, y, k: rand() });
  return { dpr, w, h, S, list: out };
}

function run() {
  const cv = root.querySelector('canvas'), num = document.getElementById('preload-n'), g = cv.getContext('2d');
  const M = cells(cv), { dot, unlit } = THEME.css, t0 = performance.now();
  g.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
  root.classList.add('run');
  function draw(p) {
    g.clearRect(0, 0, M.w, M.h);
    const r = M.S * .36;
    for (const c of M.list) {
      g.fillStyle = c.k < p ? dot : unlit;
      g.beginPath(); g.arc(c.x, c.y, r, 0, 6.2832); g.fill();
    }
    num.textContent = Math.round(p * 100);
  }
  (function frame(now) {
    const target = total ? arrived / total : 0, late = now - t0 > LONGEST;
    // what's shown chases what has arrived (never faster than about a second for the whole mark)
    // (a part announced later lowers the target: what's lit stays lit)
    shown = Math.max(shown, still ? target : Math.min(target, shown + Math.max(.012, (target - shown) * .14)));
    if (late) shown = 1;
    draw(shown);
    if (shown < .999 || (!late && arrived < total)) { requestAnimationFrame(frame); return; }
    finish();
  })(t0);
}

function finish() {
  over = true;
  const clear = () => {
    // the dots cover the screen at once, the loading screen goes under them, then they clear downwards
    curtain(-1, (cv) => cv.remove());
    requestAnimationFrame(() => { html.classList.remove('preloading'); root.remove(); });
  };
  if (still) { html.classList.remove('preloading'); root.remove(); return; }
  // DRAFT load-c: the mark sat beside the headline, where the wall goes: it fades there, no curtain
  if (has('load-c')) { root.classList.add('out'); setTimeout(() => { html.classList.remove('preloading'); root.remove(); }, 320); return; }
  setTimeout(() => { root.classList.add('out'); setTimeout(clear, 260); }, 140);
}

if (active) {
  // DRAFT load-b / load-c: only what the first screen needs (the font, the site, the wall), not every eager image
  if (!has('load-b') && !has('load-c')) {
    const loaded = need();
    if (document.readyState === 'complete') loaded(); else window.addEventListener('load', loaded, { once: true });
  }
  run();
}
