// The desktop site's intro, held while you scroll: the poster wall shrinks into a screen, becomes a folder of films
// and then the library, and the window takes the shape of each of the four apps, snapping at each stop.
import '../../stage.js';
import { Painter } from '../gl.js';
import { IMG } from '../assets.js';
import { lerp, ramp } from '../util.js';

const { ScrollTrigger, Stage } = window;

// u, the intro's own time: stops at 0 (hero), .5 (folder), 1 (library), 1.4 … 2.6 (each app). The section is
// 100 + 300 × END svh tall (desktop.css).
const END = 2.6;
const STOPS = [0, .5, 1, 1.4, 1.8, 2.2, 2.6];
// when each change happens, in u: k the wall shrinking into the window, q1 / q2 its pictures, hero / b1 / b2 / b3
// the words (o: out), out the wall coming back around the window, sh / qa the apps' shapes and pictures (+1.4, +.4 each)
const T = { k: [.06, .36], q1: [.34, .5], q2: [.64, .88], hero: [.03, .14], b1: [.26, .36], b1o: [.55, .62], b2: [.68, .78], b2o: [1.04, 1.14], b3: [1.12, 1.24], out: [1.06, 1.3], sh: [.06, .34], qa: [.1, .34] };
const RAD = [16, 12, 6, 30, 30];   // the window's corners: the library, then each app

export function initIntro(apps) {
  const intro = document.getElementById('intro'), stage = intro.querySelector('.istage'), slot = document.getElementById('slot');
  const hero = document.getElementById('heroblock'), b1 = document.getElementById('b1'), b2 = document.getElementById('b2'), b3 = document.getElementById('b3');
  const scrim = document.getElementById('iscrim'), list = document.getElementById('b3-list'), fact = document.getElementById('b3-fact');
  const wide = window.innerWidth >= 1000;
  const P = Painter(document.getElementById('gl'), IMG.wall, [folderPicture(), IMG.s_dashlib, IMG.s_tvlib, IMG.s_mtitle, IMG.s_man]);
  // not held (no WebGL, no motion): the static layout, the wall (if any) behind the hero
  if (!P || !Stage.live || Stage.reduced) {
    intro.classList.remove('is-held');
    document.documentElement.classList.remove('held');
    if (P) { P.win = [0, 0, 0, 0]; P.outVis = 1; P.q = 0; P.invalidate(); }
    return;
  }

  const rel = (el) => { const s = el.getBoundingClientRect(), g = stage.getBoundingClientRect(); return [s.left - g.left, s.top - g.top, s.width, s.height]; };
  const mix4 = (A, B, k) => A.map((a, i) => lerp(a, B[i], k));
  function show(el, k, dir) {
    el.style.opacity = k;
    el.style.visibility = k > .01 ? 'visible' : 'hidden';
    el.style.transform = k > .99 || k < .01 ? '' : 'translateY(' + ((1 - k) * 28 * dir) + 'px)';
  }
  // the screen the wall shrinks into (the slot beside the words), then the four shapes of the window
  const box = () => rel(slot);
  function shapes() {
    const B = box(), H = stage.clientHeight, cx = B[0] + B[2] / 2, cy = B[1] + B[3] / 2;
    const ph = wide ? H - 64 - 72 : Math.min(B[3] * 1.5, H * .42), dy = wide ? 32 : 0;
    const sw = B[2] * .86, sh = sw * 10 / 16, pw = ph * 540 / 1077, aw = ph * 540 / 1047;
    return [B, [cx - sw / 2, cy - sh / 2, sw, sh], B, [cx - aw / 2, cy - ph / 2 + dy, aw, ph], [cx - pw / 2, cy - ph / 2 + dy, pw, ph]];
  }

  let cur = -1, st;
  function setApp(i) {
    if (i === cur) return;
    cur = i;
    list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
    fact.innerHTML = '<p>' + apps[i].blurb + '</p><span>' + apps[i].systems + '</span>';
  }
  function go(u) {
    const y = st.start + (st.end - st.start) * u / END;
    if (Stage.lenis) Stage.lenis.scrollTo(y); else window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function frame(p) {
    const R = (u, ab, off = 0) => ramp(u, ab[0] + off, ab[1] + off);
    const u = p * END, k = R(u, T.k);
    P.win = mix4([0, 0, stage.clientWidth, stage.clientHeight], box(), k); P.rad = RAD[0] * k;
    P.outVis = Math.max(1 - k, R(u, T.out)); P.dim = u > 1 ? .5 : 1;
    P.shade = R(u, T.out); P.shadeV = wide ? 0 : 1;
    P.q = R(u, T.q1) + R(u, T.q2); P.pan = .5;
    scrim.style.opacity = 1 - k;
    show(hero, 1 - R(u, T.hero), -1);
    show(b1, R(u, T.b1) * (1 - R(u, T.b1o)), R(u, T.b1o) > 0 ? -1 : 1);
    show(b2, R(u, T.b2) * (1 - R(u, T.b2o)), R(u, T.b2o) > 0 ? -1 : 1);
    show(b3, R(u, T.b3), 1);
    if (u > 1) {
      const S = shapes();
      let w = S[0], r = RAD[0];
      for (let i = 0; i < 4; i++) { const s = R(u, T.sh, 1 + i * .4); w = mix4(w, S[i + 1], s); r = lerp(r, RAD[i + 1], s); }
      P.win = w; P.rad = r; P.q = 2 + R(u, T.qa, 1.4) + R(u, T.qa, 1.8) + R(u, T.qa, 2.2);
    }
    setApp(Math.max(0, Math.min(3, Math.round((u - 1.4) / .4))));
    P.invalidate();
  }

  // the app names scroll to their stop
  list.innerHTML = apps.map((a) => '<li><button type="button" tabindex="-1"><span class="long">' + a.name + '</span><span class="short">' + a.short + '</span></button></li>').join('');
  list.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => go(1.4 + i * .4)));

  st = ScrollTrigger.create({
    trigger: intro, start: 'top top', end: 'bottom bottom', invalidateOnRefresh: true, onUpdate: (s) => frame(s.progress),
    snap: { snapTo: STOPS.map((s) => s / END), inertia: false, delay: .12, duration: { min: .3, max: .8 }, ease: 'power2.inOut' },
  });
  frame(0);
  P.onready = () => frame(st.progress);
  window.addEventListener('resize', () => frame(st.progress));

  document.getElementById('how-link').addEventListener('click', (e) => { e.preventDefault(); go(.5); });
  document.querySelectorAll('a[href="#products"]:not(#how-link)').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(1.4); }));
}

// the "before" picture: a folder of films in a file manager, drawn (its colours are that app's, not the theme's)
function folderPicture() {
  const c = document.createElement('canvas'); c.width = 1600; c.height = 900;
  const g = c.getContext('2d'), F = '"Jost", "Futura", sans-serif';   // as agreed: "Jost" (not the page's "Jost Variable"), so the picture keeps its own face
  g.fillStyle = '#17171a'; g.fillRect(0, 0, 1600, 900);
  g.fillStyle = '#0f0f11'; g.fillRect(0, 0, 300, 900);
  g.fillStyle = '#26262b'; g.fillRect(0, 0, 1600, 64);
  g.font = '500 24px ' + F; g.fillStyle = '#e4e4e7'; g.fillText('Films', 336, 42);
  g.fillStyle = '#a1a1aa'; g.font = '400 20px ' + F; g.fillText('/media/Films', 420, 42);
  [['Home', 0], ['Desktop', 0], ['Downloads', 0], ['Films', 1], ['Series', 0], ['Music', 0], ['nas (network)', 0]].forEach((s, i) => {
    const y = 120 + i * 54;
    if (s[1]) { g.fillStyle = '#2a2a30'; g.fillRect(16, y - 34, 268, 48); }
    g.fillStyle = s[1] ? '#ffffff' : '#a1a1aa'; g.font = '400 22px ' + F; g.fillText(s[0], 40, y);
  });
  g.fillStyle = '#71717a'; g.font = '500 18px ' + F; g.fillText('Name', 336, 112); g.fillText('Size', 1160, 112); g.fillText('Modified', 1330, 112);
  [['A Trip to the Moon (1902).mkv', '612 MB', '3 Mar 2024'], ['Big Buck Bunny (2008).mkv', '1.1 GB', '9 Jan 2025'], ['Carnival of Souls (1962).mkv', '3.4 GB', '28 Oct 2023'],
    ['Charade (1963).mkv', '4.2 GB', '14 Feb 2024'], ['Coffee Run (2020).mp4', '210 MB', '2 Jul 2025'], ['Cosmos Laundromat (2015).mkv', '1.4 GB', '9 Jan 2025'], ['Detour (1945).avi', '1.2 GB', '11 Nov 2022'],
    ['Elephants Dream (2006).mkv', '890 MB', '9 Jan 2025'], ['His Girl Friday (1940).mkv', '3.9 GB', '5 May 2024'], ['Metropolis (1927).mkv', '6.8 GB', '19 Sep 2023'],
    ['Night of the Living Dead (1968).mkv', '3.1 GB', '31 Oct 2024'], ['Nosferatu (1922).mkv', '2.2 GB', '31 Oct 2024'], ['Sherlock Jr. (1924).mkv', '1.6 GB', '7 Aug 2024']].forEach((f, i) => {
    const y = 168 + i * 54;
    if (i === 9) { g.fillStyle = '#27272d'; g.fillRect(320, y - 34, 1260, 50); }
    g.fillStyle = '#3f3f46'; g.fillRect(336, y - 24, 26, 32); g.fillStyle = '#52525b'; g.fillRect(340, y - 18, 18, 4);
    g.fillStyle = '#e4e4e7'; g.font = '400 22px ' + F; g.fillText(f[0], 380, y);
    g.fillStyle = '#a1a1aa'; g.fillText(f[1], 1160, y); g.fillText(f[2], 1330, y);
  });
  return c;
}
