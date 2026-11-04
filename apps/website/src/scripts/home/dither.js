// The dot, drawn on 2D canvases: the remote's dithered posters, and Pic, a picture that is gold dots while its
// switch is off and itself when on.
import { BAYER4, THEME, dpr, still } from './util.js';

const C = THEME.css;
const lit = (l, x, y) => l > (BAYER4[(y % 4) * 4 + x % 4] + .5) / 16;
const luma = (px, i) => (px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114) / 255;

// a picture drawn as round gold dots on the ground, one dot per cell
function dotted(g, src, w, h, cell, gain, r) {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell), s = document.createElement('canvas');
  s.width = cw; s.height = ch;
  const sg = s.getContext('2d');
  sg.drawImage(src, 0, 0, cw, ch);
  const px = sg.getImageData(0, 0, cw, ch).data;
  g.fillStyle = C.ground; g.fillRect(0, 0, w, h);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    g.fillStyle = lit(Math.pow(luma(px, (y * cw + x) * 4), .8) * gain, x, y) ? C.dot : C.unlit;
    g.beginPath(); g.arc(x * cell + cell / 2, y * cell + cell / 2, cell * r, 0, 6.2832); g.fill();
  }
}

// a poster as dots, filling its canvas
export function dots(img, canvas, cell) {
  const w = Math.round((canvas.clientWidth || 160) * dpr), h = Math.round((canvas.clientHeight || 240) * dpr);
  canvas.width = w; canvas.height = h;
  dotted(canvas.getContext('2d'), img, w, h, Math.max(3, Math.round(cell * dpr)), 1.15, .4);
}

// Pic: a canvas in fig showing a picture as dots (off) or as itself (on); a new picture passes through the dots
// ax: where the picture is anchored across (0 left, .5 centre, 1 right), as its CSS object-position
export function Pic(fig, ax = .5) {
  const c = document.createElement('canvas'), x = c.getContext('2d'), cache = {};
  let cur = null, next = null, k = 0, target = 0, raf = 0;
  c.setAttribute('aria-hidden', 'true');
  fig.appendChild(c);
  function load(src, cb) {
    let o = cache[src];
    if (o && o.ok) return cb(o);
    if (!o) {
      o = cache[src] = { im: new Image(), ok: false, cbs: [] };
      o.im.onload = () => { o.ok = true; o.cbs.forEach((f) => f(o)); };
      o.im.src = src;
    }
    o.cbs.push(cb);
  }
  // the picture cropped to the figure (P) and its dotted version (D), at the figure's size
  function size(o) {
    const w = Math.round(fig.clientWidth * dpr), h = Math.round(fig.clientHeight * dpr);
    if (!w || !h || (o.w === w && o.h === h)) return;
    o.w = w; o.h = h;
    o.P = document.createElement('canvas'); o.P.width = w; o.P.height = h;
    const im = o.im, s = Math.max(w / im.width, h / im.height);
    o.P.getContext('2d').drawImage(im, (w - im.width * s) * ax, 0, im.width * s, im.height * s);
    o.cell = Math.round(6 * dpr);
    o.D = document.createElement('canvas'); o.D.width = w; o.D.height = h;
    dotted(o.D.getContext('2d'), o.P, w, h, o.cell, 1.2, .38);
  }
  function draw() {
    if (!cur) return;
    size(cur);
    if (!cur.P) return;
    const w = cur.w, h = cur.h, cell = cur.cell;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (k >= 1) { x.drawImage(cur.P, 0, 0); return; }
    x.drawImage(cur.D, 0, 0);
    if (k <= 0) return;
    for (let yy = 0, j = 0; yy < h; yy += cell, j++) for (let xx = 0, i = 0; xx < w; xx += cell, i++) {
      if ((BAYER4[(j & 3) * 4 + (i & 3)] + .5) / 16 < k) x.drawImage(cur.P, xx, yy, cell, cell, xx, yy, cell, cell);
    }
  }
  function step() {
    const sp = still ? 1 : .07;
    if (next) { k = Math.max(0, k - sp * 1.6); if (k === 0) { cur = next; next = null; } }
    else k = target > k ? Math.min(target, k + sp) : Math.max(target, k - sp);
    draw();
    raf = next || k !== target ? requestAnimationFrame(step) : 0;
  }
  window.addEventListener('resize', draw);
  return {
    show(src, on) {
      load(src, (o) => {
        if (!cur) cur = o; else if (o !== cur) next = o;
        target = on ? 1 : 0;
        if (!raf) raf = requestAnimationFrame(step);
      });
    },
  };
}
