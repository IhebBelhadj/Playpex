// Small helpers shared by the home page's modules: the visitor's system, motion and pixel density, easing
// arithmetic, the Bayer matrix and the theme's colours (read from the CSS tokens, so canvases and shaders follow
// a theme change).

export function system() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macOS';
  if (/Linux|X11/i.test(ua)) return 'Linux';
  return null;
}

export const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const dpr = Math.min(window.devicePixelRatio || 1, 2);
// phones get their own composition (styles/phone.css): one move into the four apps, buttons, a carousel
export const PHONE = window.matchMedia('(max-width: 767px)').matches;

export const lerp = (a, b, k) => a + (b - a) * k;
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
// cubic-bezier(x1, y1, x2, y2) as an easing of t (0…1)
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) { const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= (X(t) - x) / d; }
    t = Math.max(0, Math.min(1, t));
    return ((ay * t + by) * t + cy) * t;
  };
}
// the site's one move: starts at once, does most of the way early, lands softly (both sites' stops, the phone's
// buttons and app switches)
export const EASE = bezier(.2, 0, 0, 1);

// smoothstep from a to b
export function ramp(p, a, b) { const k = clamp01((p - a) / (b - a)); return k * k * (3 - 2 * k); }
// piecewise linear through [x, y] points (x rising)
export function pl(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
  }
  return pts[pts.length - 1][1];
}

// the 4 × 4 ordered-dither thresholds (0…15)
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// the theme's colours, as CSS strings (canvas) and as 0…1 triples (shaders)
function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function rgb(css) {
  const g = document.createElement('canvas').getContext('2d');
  g.fillStyle = css;
  const hex = g.fillStyle;                               // the browser normalises any colour to #rrggbb
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export const THEME = (() => {
  const css = { ground: token('--ground'), dot: token('--dot'), unlit: token('--unlit') };
  return { css, gl: { ground: rgb(css.ground), dot: rgb(css.dot), unlit: rgb(css.unlit) } };
})();

// runs fn once, when el comes within a screen of the viewport (canvas work waits until it can be seen)
export function whenNear(el, fn) {
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); fn(); } }, { rootMargin: '100% 0px' });
  io.observe(el);
}

// a horizontal swipe on el: calls fn(-1 | 1) (1 = to the next, a swipe to the left)
export function onSwipe(el, fn, accept = () => true) {
  let x0 = 0, y0 = 0;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (accept() && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) fn(dx < 0 ? 1 : -1);
  }, { passive: true });
}
