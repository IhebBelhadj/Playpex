// The desktop site's intro, held while you scroll: the poster wall drifting inside the Playpex mark (taller than the
// screen, behind the words) shrinks into a screen and opens onto a folder of films through gold dots, then the library, and the window takes the shape of each of the four apps (around it, the wall's dots
// clear away to the plain ground), snapping at each stop.
import '../../stage.js';
import { Painter } from '../gl.js';
import { need } from '../preload.js';
import { IMG } from '../assets.js';
import { lerp, ramp } from '../util.js';
import { MARK_ASPECT, markMask } from '../mark.js';

const { ScrollTrigger, Stage } = window;

// u, the intro's own time: stops at 0 (hero), .5 (folder), 1 (library), 1.4 … 2.6 (each app). The section is
// 100 + 300 × END svh tall (desktop.css).
const END = 2.6;
const STOPS = [0, .5, 1, 1.4, 1.8, 2.2, 2.6];
// when each change happens, in u: m1 the mark shrinking to the screen's height (its shape kept), m2 the mark growing into
// the screen as the folder opens through its dots (inside the mark and around it), k the scrim behind the words going,
// q2 the folder into the library, hero / b1 / b2 / b3 the words (o: out), out the wall coming back around the window,
// sh / qa the apps' shapes and pictures (+1.4, +.4 each)
const T = { m1: [.04, .24], m2: [.18, .42], k: [.06, .36], q2: [.64, .88], hero: [.03, .14], b1: [.26, .36], b1o: [.55, .62], b2: [.68, .78], b2o: [1.04, 1.14], b3: [1.12, 1.24], out: [1.06, 1.3], sh: [.06, .34], qa: [.1, .34] };
const RAD = [16, 12, 6, 30, 30];   // the window's corners: the library, then each app

export function initIntro(apps) {
  const intro = document.getElementById('intro'), stage = intro.querySelector('.istage'), slot = document.getElementById('slot');
  const hero = document.getElementById('heroblock'), b1 = document.getElementById('b1'), b2 = document.getElementById('b2'), b3 = document.getElementById('b3');
  const scrim = document.getElementById('iscrim'), list = document.getElementById('b3-list'), fact = document.getElementById('b3-fact');
  const wide = window.innerWidth >= 1000;
  const P = Painter(document.getElementById('gl'), IMG.wall, [folderPicture(), IMG.s_dashlib, IMG.s_tvlib, IMG.s_mtitle, IMG.s_man]);
  if (P) P.mask = markMask();   // the wall drifts inside the mark (the painter's mask, while mk is on)
  const wallIn = need();   // the loading screen waits for the wall's pictures (none without WebGL)
  if (!P) wallIn();
  // not held (no WebGL, no motion): the static layout, the mark (with its wall, standing still) behind the hero
  if (!P || !Stage.live || Stage.reduced) {
    intro.classList.remove('is-held');
    document.documentElement.classList.remove('held');
    if (P) {
      const canvas = document.getElementById('gl'), wrap = document.getElementById('iwrap');
      const place = () => {
        const right = wrap.getBoundingClientRect().right - parseFloat(getComputedStyle(wrap).paddingRight) - canvas.getBoundingClientRect().left;
        P.win = heroMark(canvas.clientHeight, right);
        const cue = document.getElementById('scroll-cue'), c = cue.getBoundingClientRect(), g = canvas.getBoundingClientRect();
        P.hole = cue.offsetWidth ? [c.left - g.left + c.width / 2, c.top - g.top + c.height / 2, 64] : [0, 0, 0];
        P.invalidate();
      };
      P.mk = 1; P.outVis = 0; P.q = 0; P.onready = wallIn;
      place();
      window.addEventListener('resize', place);
    }
    return;
  }

  const rel = (el) => { const s = el.getBoundingClientRect(), g = stage.getBoundingClientRect(); return [s.left - g.left, s.top - g.top, s.width, s.height]; };
  const mix4 = (A, B, k) => A.map((a, i) => lerp(a, B[i], k));
  // the scroll cue at the hero's foot fades with the words; the wall's dots clear around it
  const cue = document.getElementById('scroll-cue');
  function cueAt(o) {
    cue.style.opacity = o;
    if (!cue.offsetWidth) { P.hole = [0, 0, 0]; return; }
    const c = cue.getBoundingClientRect(), g = stage.getBoundingClientRect();
    P.hole = [c.left - g.left + c.width / 2, c.top - g.top + c.height / 2, 64 * o];
  }
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
    return [B, [cx - sw / 2, cy - sh / 2, sw, sh], B, [cx - aw / 2, cy - ph / 2 + dy, aw, ph], [cx - pw / 2, cy - ph / 2 + dy, pw, ph]].map((R, i) => (i ? clear(R) : R));   // the first is the library's screen as it is
  }
  // a shape that would reach under the Up next card (short screens: the TV, the phones) shrinks, keeping its proportions,
  // its top and its centre across, until it ends above the card; the card keeps its picture
  const card = document.querySelector('#upnext .un-card');
  function clear(R) {
    if (!card || !card.offsetWidth) return R;
    const c = card.getBoundingClientRect(), g = stage.getBoundingClientRect(), left = c.left - g.left, top = c.top - g.top - 16;
    if (R[0] + R[2] <= left || R[1] + R[3] <= top) return R;
    const s = Math.max(.5, (top - R[1]) / R[3]), w = R[2] * s;
    return [R[0] + (R[2] - w) / 2, R[1], w, R[3] * s];
  }

  let cur = -1, st;
  function setApp(i) {
    if (i === cur) return;
    cur = i;
    list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
    fact.innerHTML = '<p>' + apps[i].blurb + '</p><span>' + apps[i].systems + '</span>';
  }
  // to a stop in one eased move (its length grows with the way to go), so the dotted states between stops are only
  // ever seen moving; without lenis, the browser's smooth scroll and the snap
  const uNow = () => Math.max(0, Math.min(END, (window.scrollY - st.start) / (st.end - st.start) * END));
  const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let moving = false;
  function go(u, done) {
    const y = st.start + (st.end - st.start) * u / END;
    if (!Stage.lenis) { window.scrollTo({ top: y, behavior: 'smooth' }); return; }
    moving = true;
    Stage.lenis.scrollTo(y, { duration: Math.min(.8, .32 + .5 * Math.abs(u - uNow())), easing: ease, force: true, onComplete: () => { moving = false; if (done) done(); } });
  }
  // the wheel, while the intro holds the screen: one gesture is one stop, in its direction. The rest of the gesture
  // (a trackpad's inertia, a wheel still turning) is spent while it moves and until it pauses; at either end of the
  // intro the wheel scrolls the page as usual
  function wheelSteps() {
    if (!Stage.lenis) return;
    let last = 0, spent = false;
    const prev = Stage.lenis.options.virtualScroll;
    Stage.lenis.options.virtualScroll = (data) => {
      if (prev && prev(data) === false) return false;
      const e = data.event, dir = Math.sign(data.deltaY);
      if (!e.type.includes('wheel') || e.ctrlKey || !dir) return true;
      const y = window.scrollY;
      if (y < st.start - 2 || y > st.end + 2) return true;
      const u = uNow(), now = performance.now(), pause = now - last > 220;
      if (!moving && (dir > 0 ? u >= END - .005 : u <= .005)) { last = now; return true; }
      e.preventDefault();
      last = now;
      if (moving || (spent && !pause)) return false;
      const to = dir > 0 ? STOPS.find((s) => s > u + .005) : STOPS.filter((s) => s < u - .005).pop();
      if (to === undefined) return true;
      spent = true;
      go(to);
      return false;
    };
  }

  let frame = function (p) {
    const R = (u, ab, off = 0) => ramp(u, ab[0] + off, ab[1] + off);
    const u = p * END, k = R(u, T.k);
    // the mark shrinks to the screen's height keeping its shape (m1), then grows into the screen while the folder opens
    // through its dots, inside the mark and around it (m2: the painter's dissolve; the mask on until it is done)
    const B = box(), H = stage.clientHeight, h1 = B[3], w1 = h1 * MARK_ASPECT, M1 = [B[0] + (B[2] - w1) / 2 + w1 * .03, B[1], w1, h1];
    const m1 = R(u, T.m1), m2 = R(u, T.m2);
    P.win = mix4(mix4(heroMark(H, B[0] + B[2]), M1, m1 * m1 * (3 - 2 * m1)), B, m2); P.rad = RAD[0] * m2; P.mk = m2 < 1 ? 1 : 0;
    P.outVis = R(u, T.out); P.dim = u > 1 ? .5 : 1;
    P.shade = R(u, T.out); P.shadeV = wide ? 0 : 1; P.clear = R(u, T.out);
    P.q = m2 + R(u, T.q2); P.pan = .5;
    scrim.style.opacity = 1 - k;
    show(hero, 1 - R(u, T.hero), -1);
    cueAt(1 - R(u, T.hero));
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
  };

  // the app names scroll to their stop
  list.innerHTML = apps.map((a) => '<li><button type="button" tabindex="-1"><span class="long">' + a.name + '</span><span class="short">' + a.short + '</span></button></li>').join('');
  list.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => go(1.4 + i * .4)));

  st = ScrollTrigger.create({
    trigger: intro, start: 'top top', end: 'bottom bottom', invalidateOnRefresh: true, onUpdate: (s) => frame(s.progress),
    // the snap stays for what the wheel steps don't cover (the scrollbar, the keys, a scroll ending inside the intro)
    snap: { snapTo: STOPS.map((s) => s / END), inertia: false, delay: .1, duration: { min: .2, max: .5 }, ease: 'power2.inOut' },
  });
  wheelSteps();
  // "Up next": where the tour goes from here, and a way past it
  const next = upNext(go, st);
  if (next) {
    const base = frame;
    frame = (p) => { base(p); next.update(p * END, P.win); };
    // shown while the intro holds the screen, its very end included (checked on every scroll: past the intro its
    // frames stop)
    const holding = () => { const r = intro.getBoundingClientRect(); next.show(r.top <= 1 && r.bottom >= window.innerHeight - 1); };
    window.addEventListener('scroll', holding, { passive: true });
    holding();
  }
  frame(0);
  P.onready = () => { frame(st.progress); wallIn(); };
  window.addEventListener('resize', () => frame(st.progress));

  document.getElementById('how-link').addEventListener('click', (e) => { e.preventDefault(); go(.5); });
  document.querySelectorAll('a[href="#products"]:not(#how-link)').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(1.4); }));
}

// the mark at the hero: 1.3 times the screen's height (cut off above and below), its tip at the content's right edge
// (right), the rest behind the words (under the scrim)
function heroMark(H, right) {
  const h = H * 1.3, w = h * MARK_ASPECT;
  return [right - w, (H - h) / 2, w, h];
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

// "Up next" (as on Playpex TV, the episode after this one): a card with the next stop's name and screen, and a row of
// dots that fills on the way to it. The card, or ↓ / ↑ (the remote's keys), moves by whole stops; "Skip the tour"
// goes past the intro. Its words are in the page (index.astro #upnext); the pictures are the intro's own.
function upNext(go, st) {
  const el = document.getElementById('upnext');
  if (!el) return null;
  const names = [...el.querySelectorAll('.un-stops li')].map((li) => li.textContent);
  const card = el.querySelector('.un-card'), img = el.querySelector('.un-pic img'), name = el.querySelector('.un-name'), track = el.querySelector('.un-dots');
  const DOTS = 32;
  track.innerHTML = '<i></i>'.repeat(DOTS);
  const dots = [...track.children];
  // the next stop's picture: the folder (drawn, shrunk for the card), the library, each app, then the player
  const small = document.createElement('canvas');
  small.width = 480; small.height = 270;
  small.getContext('2d').drawImage(folderPicture(), 0, 0, 480, 270);
  const pics = [IMG.wall, small.toDataURL('image/webp', .8), IMG.s_dashlib, IMG.s_dashlib, IMG.s_tvlib, IMG.s_mtitle, IMG.s_man, IMG.s_player];
  const after = () => {
    const y = document.getElementById('screens').getBoundingClientRect().top + window.scrollY;
    if (window.Stage.lenis) window.Stage.lenis.scrollTo(y); else window.scrollTo({ top: y, behavior: 'smooth' });
  };
  let u0 = 0, cur = -1;
  const ahead = () => STOPS.findIndex((s) => s > u0 + .01);
  const forward = () => { const n = ahead(); if (n < 0) after(); else go(STOPS[n]); };
  const back = () => { let k = -1; STOPS.forEach((s, i) => { if (s < u0 - .01) k = i; }); if (k >= 0) go(STOPS[k]); };
  card.addEventListener('click', forward);
  el.querySelector('.un-skip').addEventListener('click', after);
  window.addEventListener('keydown', (e) => {
    if (!el.classList.contains('on') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); forward(); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); back(); }
  });
  el.hidden = false;
  return {
    show(on) { el.classList.toggle('on', on); },
    update(u, win) {
      u0 = u;
      let n = ahead();
      if (n < 0) n = STOPS.length;   // past the last stop: the rest of the page
      const from = STOPS[Math.max(0, n - 1)], to = n < STOPS.length ? STOPS[n] : from;
      const lit = Math.round((to > from ? Math.max(0, Math.min(1, (u - from) / (to - from))) : 1) * DOTS);
      dots.forEach((d, j) => d.classList.toggle('lit', j < lit));
      if (n === cur) return;
      cur = n;
      name.textContent = names[n];
      img.src = pics[n];
      card.setAttribute('aria-label', 'Up next: ' + names[n]);
    },
  };
}
