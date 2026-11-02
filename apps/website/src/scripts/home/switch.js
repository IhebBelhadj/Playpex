// Switching between the two sites. The desktop and the phone sites share the page's words but nothing of their
// layout or motion, so crossing the width between them (rotating a tablet, resizing a window) loads the other
// site: a front of the brand's gold ordered-dither dots runs down the screen and covers the page, the page reloads
// under the cover with the same section in view, and the dots clear.
import { THEME, still } from './util.js';

const KEY = 'playpex.switch';             // sessionStorage: the section to come back to after the switch
const PHONE_QUERY = '(max-width: 767px)';

// 8 × 8 Bayer thresholds (0…63): the order in which the dots light
const BAYER8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

function overlay() {
  let cv = document.getElementById('switch-cover');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'switch-cover';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
  }
  return cv;
}

// covers (dir 1) or uncovers (dir -1) the screen: a gold front of dots with the ground behind it
function curtain(dir, done) {
  const cv = overlay();
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = window.innerWidth, H = window.innerHeight, S = 8;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = Math.ceil(W / S), rows = Math.ceil(H / S), D = dir > 0 ? 640 : 560, t0 = performance.now();
  const { ground, dot, unlit } = THEME.css;
  function frame(now) {
    const t = still ? 1 : Math.min(1, (now - t0) / D), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const p = dir > 0 ? e : 1 - e, gold = p * 1.32, ink = gold - .32;
    c.clearRect(0, 0, W, H);
    for (let y = 0; y < rows; y++) {
      const row = y / rows * .72;
      for (let x = 0; x < cols; x++) {
        const k = BAYER8[(y & 7) * 8 + (x & 7)] / 64 * .28 + row;
        if (k >= gold) continue;
        c.fillStyle = ground; c.fillRect(x * S, y * S, S, S);
        if (k >= ink) { c.fillStyle = k < ink + .1 ? unlit : dot; c.fillRect(x * S + 1.5, y * S + 1.5, S - 3, S - 3); }
      }
    }
    if (dir < 0) document.documentElement.classList.remove('switching');   // the canvas holds the cover from here
    if (t < 1) requestAnimationFrame(frame); else done(cv);
  }
  requestAnimationFrame(frame);
}

// the section the visitor is looking at (the one across the middle of the screen)
function currentSection() {
  const mid = window.innerHeight / 2;
  const el = [...document.querySelectorAll('main > section[id], footer')].find((s) => { const r = s.getBoundingClientRect(); return r.top <= mid && r.bottom > mid; });
  return el ? el.id || 'footer' : '';
}

// call once the site has started: watches the width, and finishes a switch that brought us here
export function initSwitch() {
  // the section in view, kept up to date while the visitor scrolls. A resize lays the page out again (with the
  // other site's stylesheet once the width crosses over) and moves the scroll, so what follows a resize is ignored:
  // the switch comes back to the section that was in view before it.
  let here = currentSection(), resizing = 0;
  window.addEventListener('scroll', () => { if (!resizing) here = currentSection(); }, { passive: true });
  window.addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(() => { resizing = 0; }, 400); });

  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', () => {
    curtain(1, () => {
      try { sessionStorage.setItem(KEY, here); } catch (e) { /* no storage: the page reloads at the top */ }
      history.scrollRestoration = 'manual';   // the other site has other heights: switch.js places the section itself
      location.reload();
    });
  });

  let back = null;
  try { back = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch (e) { /* no storage */ }
  if (back === null) return;
  // arriving from the other site: the head's script has covered the page (html.switching). Once the page is laid
  // out (the stage refreshes its scenes on load), bring the section into view under the cover, then clear it.
  const arrive = () => {
    const el = back === 'footer' ? document.querySelector('footer') : back && document.getElementById(back);
    const y = el ? el.getBoundingClientRect().top + window.scrollY : 0;
    const lenis = window.Stage && window.Stage.lenis;
    if (lenis) { lenis.resize(); lenis.scrollTo(y, { immediate: true, force: true }); } else window.scrollTo(0, y);   // lenis measures the page first
    requestAnimationFrame(() => curtain(-1, (cv) => cv.remove()));
  };
  const laidOut = () => (window.Stage ? window.Stage.ready() : Promise.resolve()).then(arrive);
  if (document.readyState === 'complete') laidOut(); else window.addEventListener('load', laidOut, { once: true });
}
