// The phone site's scenes: the screens stay one screen tall, the picture filling it, and move from beat to beat
// with buttons, the arrow keys or a swipe (not with the scroll); the rooms are a carousel. Both share a row of
// round buttons and a track of dots that fills as they move.
import '../../stage.js';
import { Morph } from '../gl.js';
import { IMG, LOOP } from '../assets.js';
import { still, pl, onSwipe, EASE } from '../util.js';
import { ICON } from '../../../lib/icons';
import { has } from '../try.js';   // DRAFT: the options being compared
import { Pic } from '../dither.js';

const { gsap, Stage, Scenes } = window;

export function initScenes() {
  const box = document.getElementById('screens-screen'), video = box.querySelector('video'), scrim = box.querySelector('.scrim');
  box.dataset.grow = '1';
  const morph = Morph(box, [IMG.s_dashlib, IMG.s_tvlib, IMG.s_resume, IMG.s_player], .08);
  let playing = false;
  function play(on) {
    if (on === playing) return;
    playing = on;
    if (!on) { video.pause(); return; }
    if (!video.src) { video.poster = IMG.loopposter; video.src = LOOP; }
    video.play().catch(() => {});
  }

  function buildScreens(tl, ctx) {
    const st = { f: 0 }, beats = ctx.q('.beat'), stage = ctx.stage, wrap = stage.querySelector('.sc-wrap');
    // the transform that makes the picture cover the whole stage
    function grow() {
      const x0 = wrap.offsetLeft + box.offsetLeft, y0 = wrap.offsetTop + box.offsetTop, w = box.offsetWidth, h = box.offsetHeight;
      const s = Math.max(stage.clientWidth / w, stage.clientHeight / h);
      return { x: (stage.clientWidth - w * s) / 2 - x0, y: (stage.clientHeight - h * s) / 2 - y0, s };
    }
    // the camera looks across each landscape picture
    tl.to(st, { f: 3, duration: .76, onUpdate() { morph.pan = pl(st.f, [[0, .7], [1, .25], [2, .5], [3, .5]]); morph.set(st.f); } }, 0);
    // the words crossfade half-way between two pictures, nothing held back at the end
    for (let i = 1; i < 4; i++) {
      const t = (i - .5) / 3 * .76;
      tl.to(beats[i - 1], { autoAlpha: 0, y: -24, duration: .1 }, t - .08)
        .fromTo(beats[i], { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: .1 }, t - .02);
    }
    tl.to(box, { x: () => grow().x, y: () => grow().y, scale: () => grow().s, borderRadius: 0, duration: .14 }, .8)
      .to(scrim, { autoAlpha: 1, duration: .06 }, .9)
      .to(video, { autoAlpha: 1, duration: .05, onStart: () => play(true), onReverseComplete: () => play(false) }, .94);
  }

  // the screens move by hand where motion is allowed; otherwise the stage shows the finished composition
  Scenes.screens = (root) => {
    if (Stage.live && !Stage.reduced) return manualScene(root, buildScreens, [0, .76 / 3, .76 * 2 / 3, 1], 'Screens of Playpex');   // each picture whole, then the film
    return Stage.scene(root, { hold: 3, beats: 4, build: buildScreens });
  };
  // the rooms: the finished composition (no scene), made a carousel below
  Scenes.rooms = (root) => Stage.scene(root, { phone: 'rest', hold: 3, build() {} });

  carousel(document.getElementById('rooms'), 'What the server does');
  if (has('rooms-a') || has('rooms-b')) roomsPeek(document.getElementById('rooms'), has('rooms-b'));
}

// DRAFT rooms-a / rooms-b: only the room in view shows its words; the next one peeks in with its picture alone
// (b: in gold dots, turning into itself as it comes into view, like the product pages' carousel)
function roomsPeek(track, dotted) {
  const rooms = [...track.children];
  track.classList.add(dotted ? 'peek-dots' : 'peek');
  const pics = dotted ? rooms.map((r) => {
    const f = r.querySelector('figure'), img = f.querySelector('img'), x = parseFloat(getComputedStyle(img).objectPosition), p = Pic(f, Number.isNaN(x) ? .5 : x / 100);
    img.style.visibility = 'hidden';   // the canvas paints it: dots, or itself in view
    return { p, img };
  }) : null;
  let cur = -1;
  const step = () => (rooms.length > 1 ? rooms[1].offsetLeft - rooms[0].offsetLeft : 1);
  function set() {
    const k = Math.max(0, Math.min(rooms.length - 1, Math.round(track.scrollLeft / step())));
    if (k === cur) return;
    cur = k;
    rooms.forEach((r, i) => {
      r.classList.toggle('cur', i === k);
      if (pics) {
        const { p, img } = pics[i], show = () => p.show(img.currentSrc || img.src, i === k);
        if (img.complete && img.naturalWidth) show(); else img.addEventListener('load', show, { once: true });
      }
    });
  }
  if (pics) rooms.forEach((r) => { const img = r.querySelector('img'); img.loading = 'eager'; });   // the dots need each picture
  track.addEventListener('scroll', () => requestAnimationFrame(set), { passive: true });
  set();
}

// the round buttons and the dot track, as one element
const DOTS = 30;
export function controls(cls, noun) {
  const ctl = document.createElement('div');
  ctl.className = cls;
  ctl.innerHTML = '<div class="rdots" aria-hidden="true">' + '<i></i>'.repeat(DOTS) + '</div>' +
    '<div class="rbtns"><button type="button" class="rprev" aria-label="Previous ' + noun + '">' + ICON.prev + '</button>' +
    '<button type="button" class="rnext" aria-label="Next ' + noun + '">' + ICON.next + '</button></div>';
  const dots = ctl.querySelectorAll('.rdots i');
  return {
    el: ctl, prev: ctl.querySelector('.rprev'), next: ctl.querySelector('.rnext'),
    fill(p) { const lit = Math.round(p * (DOTS - 6)) + 6; dots.forEach((d, j) => d.classList.toggle('on', j < lit)); },
  };
}
const arrowKey = (e) => ({ ArrowRight: 1, ArrowLeft: -1 })[e.key];

// phones: a native scroll-snap carousel with the buttons and the dot track under it
export function carousel(track, label) {
  const items = track.children, n = items.length;
  track.classList.add('pcar');
  track.setAttribute('aria-roledescription', 'carousel'); track.setAttribute('aria-label', label); track.tabIndex = 0;
  [...items].forEach((r, i) => { r.setAttribute('aria-roledescription', 'slide'); r.setAttribute('aria-label', (i + 1) + ' of ' + n); });
  const c = controls('rctl', 'slide');
  track.after(c.el);
  const step = () => (n > 1 ? items[1].offsetLeft - items[0].offsetLeft : 1);
  const at = () => Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / step())));
  const go = (d) => track.scrollTo({ left: (at() + d) * step(), behavior: still ? 'auto' : 'smooth' });
  function update() {
    const max = track.scrollWidth - track.clientWidth, k = at();
    c.fill(max > 0 ? track.scrollLeft / max : 0);
    c.prev.disabled = k <= 0; c.next.disabled = k >= n - 1;
  }
  c.prev.addEventListener('click', () => go(-1));
  c.next.addEventListener('click', () => go(1));
  track.addEventListener('keydown', (e) => { const d = arrowKey(e); if (d) { e.preventDefault(); go(d); } });
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  update();
}

// phones: a scene that stays one screen tall and moves between stops (timeline progress) with the buttons,
// the arrow keys or a swipe, instead of the scroll
export function manualScene(root, build, stops, label) {
  const stage = root.querySelector('.scene-stage');
  root.classList.add('is-live', 'is-manual');
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
  build(tl, { root, stage, phone: true, q: (sel) => [...root.querySelectorAll(sel)] });
  if (tl.duration() < 1) tl.to({}, { duration: 1 - tl.duration() }, tl.duration());
  const c = controls('rctl mctl', 'screen');
  stage.appendChild(c.el);
  stage.setAttribute('role', 'group'); stage.setAttribute('aria-roledescription', 'carousel'); stage.setAttribute('aria-label', label);
  stage.tabIndex = 0;
  let k = 0;
  tl.eventCallback('onUpdate', () => c.fill(tl.progress()));
  function go(d) {
    const to = Math.max(0, Math.min(stops.length - 1, k + d));
    if (to === k) return;
    k = to;
    c.prev.disabled = k <= 0; c.next.disabled = k >= stops.length - 1;
    // EASE: the next screen starts coming as the button is pressed (an ease-in-out sat still for its first tenth of a
    // second); a press while moving carries on from where the screens are
    gsap.to(tl, { progress: stops[k], duration: still ? 0 : .45 + Math.abs(stops[k] - tl.progress()) * .8, ease: EASE, overwrite: true });
  }
  c.prev.addEventListener('click', () => go(-1));
  c.next.addEventListener('click', () => go(1));
  stage.addEventListener('keydown', (e) => { const d = arrowKey(e); if (d) { e.preventDefault(); go(d); } });
  onSwipe(stage, go);
  c.prev.disabled = true;
  c.fill(0);
  return true;
}
