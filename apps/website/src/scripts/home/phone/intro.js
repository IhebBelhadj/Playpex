// The phone site's intro: the hero over the poster wall, then one move (a swipe runs it at once) straight to the
// four apps, the picture filling the screen and the words at its foot. The apps switch by a tap or a swipe, not by
// scrolling; the snapping ends on them.
import '../../stage.js';
import { Painter } from '../gl.js';
import { IMG } from '../assets.js';
import { still, lerp, ramp, pl } from '../util.js';

const { gsap, ScrollTrigger, Stage } = window;

// u, the intro's own time: 0 the hero, 1.4 the four apps (each app at + .4, moved by hand). The section is
// 100 + 100 × END svh tall (phone.css): a short run, one move.
const END = 1.4;
// when each change happens, in u: k the wall filling the screen, q1 / q2 its pictures (the wall dissolves straight
// into the library: no folder), hero / b3 the words, out the dim wall, sh / qa the apps' shapes and pictures
const T = { k: [.04, .5], q1: [.12, .7], q2: [.7, .9], hero: [.02, .18], b3: [.85, 1.25], out: [.85, 1.3], sh: [.04, .36], qa: [.04, .36] };
const RAD = [0, 0, 0, 26, 26];   // the window's corners: the library, then each app

export function initIntro(apps) {
  const intro = document.getElementById('intro'), stage = intro.querySelector('.istage');
  const hero = document.getElementById('heroblock'), b3 = document.getElementById('b3');
  const scrim = document.getElementById('iscrim'), list = document.getElementById('b3-list'), fact = document.getElementById('b3-fact');
  const P = Painter(document.getElementById('gl'), IMG.wall, [IMG.s_dashlib, IMG.s_dashlib, IMG.s_tvlib, IMG.s_mtitle, IMG.s_man]);
  // not held (no WebGL, no motion): the static layout, the wall (if any) behind the hero
  if (!P || !Stage.live || Stage.reduced) {
    intro.classList.remove('is-held');
    document.documentElement.classList.remove('held');
    if (P) { P.win = [0, 0, 0, 0]; P.outVis = 1; P.q = 0; P.invalidate(); }
    return;
  }

  const mix4 = (A, B, k) => A.map((a, i) => lerp(a, B[i], k));
  function show(el, k, dir) {
    el.style.opacity = k;
    el.style.visibility = k > .01 ? 'visible' : 'hidden';
    el.style.transform = k > .99 || k < .01 ? '' : 'translateY(' + ((1 - k) * 28 * dir) + 'px)';
  }
  // the whole screen, then the four shapes of the window: the server and the TV full width, the two phone apps as phones
  const box = () => [0, 0, stage.clientWidth, stage.clientHeight];
  function shapes() {
    const B = box(), W = stage.clientWidth, H = stage.clientHeight;
    const ph = H * .5, top = 76, pa = ph * 540 / 1047, pm = ph * 540 / 1077;
    return [B, B, [0, 0, W, Math.round(H * .6)], [W / 2 - pa / 2, top, pa, ph], [W / 2 - pm / 2, top, pm, ph]];
  }
  // where the camera looks across a landscape picture (0 its left edge, 1 its right)
  const panAt = (u) => pl(u, [[0, .2], [.5, .2], [1, .7], [1.4, .9], [1.8, .3], [2.2, .5]]);

  let cur = -1, st;
  function setApp(i) {
    if (i === cur) return;
    cur = i;
    list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
    fact.innerHTML = '<p>' + apps[i].blurb + '</p><span>' + apps[i].systems + '</span>';
  }
  // which app the window shows (0…3), moved by a tap or a swipe
  const AV = { v: 0 };
  const pick = (i) => gsap.to(AV, { v: Math.max(0, Math.min(3, i)), duration: still ? 0 : .9, ease: 'power2.inOut', overwrite: true, onUpdate: () => frame(st.progress) });

  function frame(p) {
    const R = (u, ab, off = 0) => ramp(u, ab[0] + off, ab[1] + off);
    let u = p * END;
    if (u >= 1.399) u = 1.4 + AV.v * .4;
    else if (AV.v) { gsap.killTweensOf(AV); AV.v = 0; }
    const k = R(u, T.k);
    P.win = mix4([0, 0, stage.clientWidth, stage.clientHeight], box(), k); P.rad = RAD[0] * k;
    P.outVis = Math.max(1 - k, R(u, T.out)); P.dim = u > 1 ? .5 : 1;
    P.shade = 0; P.shadeV = 1;
    P.q = R(u, T.q1) + R(u, T.q2); P.pan = panAt(u);
    scrim.style.opacity = 1 - k;
    show(hero, 1 - R(u, T.hero), -1);
    show(b3, R(u, T.b3), 1);
    if (u > 1) {
      const S = shapes();
      let w = S[0], r = RAD[0];
      for (let i = 0; i < 4; i++) { const s = R(u, T.sh, 1 + i * .4); w = mix4(w, S[i + 1], s); r = lerp(r, RAD[i + 1], s); }
      P.win = w; P.rad = r; P.q = 2 + R(u, T.qa, 1.4) + R(u, T.qa, 1.8) + R(u, T.qa, 2.2);
    }
    setApp(Math.max(0, Math.min(3, Math.round((u - 1.4) / .4))));
    stage.style.setProperty('--foot', String(ramp(u, .08, .2)));
    P.invalidate();
  }

  // the short app names, tapped to switch
  list.innerHTML = apps.map((a) => '<li><button type="button"><span class="long">' + a.name + '</span><span class="short">' + a.short + '</span></button></li>').join('');
  list.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => pick(i)));

  st = ScrollTrigger.create({
    trigger: intro, start: 'top top', end: 'bottom bottom', invalidateOnRefresh: true, onUpdate: (s) => frame(s.progress),
    snap: { snapTo: [0, 1], directional: true, inertia: false, delay: .02, duration: { min: .22, max: .38 }, ease: 'power2.out' },
  });
  // the folder and the library aren't part of the phone's intro: their words stay hidden
  ['b1', 'b2'].forEach((id) => show(document.getElementById(id), 0, 1));
  frame(0);
  P.onready = () => frame(st.progress);
  window.addEventListener('resize', () => frame(st.progress));

  gestures(stage, st, pick, AV);
  document.getElementById('how-link').addEventListener('click', (e) => {
    e.preventDefault();
    const y = st.end;
    if (Stage.lenis) Stage.lenis.scrollTo(y); else window.scrollTo({ top: y, behavior: 'smooth' });
  });
}

// a sideways swipe on the apps switches app; a swipe up on the hero runs the whole move at once (without
// waiting for the scroll to settle) and a swipe down on the apps runs it back. The snap stays for wheels and keys.
function gestures(stage, st, pick, AV) {
  let x0 = 0, y0 = 0, mode = null;
  window.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (st.progress < .93) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) pick(Math.round(AV.v) + (dx < 0 ? 1 : -1));
  }, { passive: true });
  if (!Stage.touch) return;
  function run(y) {
    mode = 'run';
    const o = { y: window.scrollY };
    gsap.to(o, { y, duration: .42, ease: 'power3.out', onUpdate: () => window.scrollTo(0, o.y), onComplete: () => { mode = null; } });
  }
  window.addEventListener('touchstart', () => {
    if (mode === 'run') return;
    const y = window.scrollY;
    mode = y <= st.start + 2 ? 'hero' : Math.abs(y - st.end) < 4 ? 'apps' : null;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!mode) return;
    if (mode === 'run') { e.preventDefault(); return; }
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) < 8 || Math.abs(dx) > Math.abs(dy)) return;
    if (mode === 'hero' && dy < 0) { e.preventDefault(); run(st.end); }
    else if (mode === 'apps' && dy > 0 && e.target.closest('#intro')) { e.preventDefault(); run(st.start); }
    else mode = null;
  }, { passive: false });
}

