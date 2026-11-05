// One wheel gesture is one stop (desktop, on Lenis): the held intro and the rooms move between their stops through
// here, so both feel the same.
// - The move starts at once and lands softly (EASE: most of the way early, a long gentle end), its length growing with
//   the way to go; there is no slow wind-up between the hand and the picture.
// - A gesture is new after a pause, a change of direction, or a fresh swipe rising out of the last one's inertia (a
//   trackpad keeps sending a decaying tail for about a second: waiting for silence swallowed the next swipe). The rest
//   of a gesture is spent.
// - A new gesture while moving retargets to the stop after the one being reached, on GLIDE (already at speed), so two
//   swipes are one continuous move, never a stop and a restart.
// At either end of a stepper's range the wheel scrolls the page as usual.

import { EASE } from '../util.js';

const { Stage } = window;

const GLIDE = (t) => 1 - Math.pow(1 - t, 3);

const all = [];
let wired = false;
// the wheel's gesture, tracked on every wheel event (inside a stepper's range or not, so one coming in from outside is
// known as the same gesture): when it began, its last delta and peak, its direction, whether it has made its step
const G = { last: 0, lastAbs: 0, peak: 0, dir: 0, at: 0, used: false };

// a stepper over a ScrollTrigger's range: stops are progress values (0…1), rising
export function stepper(st, stops) {
  const S = { st, stops, moving: false, target: 0 };
  const yOf = (p) => st.start + (st.end - st.start) * p;
  S.now = () => Math.max(0, Math.min(1, (window.scrollY - st.start) / Math.max(1, st.end - st.start)));
  // to stop p; chained: a move already under way carries on into it
  S.go = (p, done, chained) => {
    const y = yOf(p);
    if (!Stage.lenis) { window.scrollTo({ top: y, behavior: 'smooth' }); return; }
    const screens = Math.abs(y - window.scrollY) / window.innerHeight;
    S.moving = true; S.target = p;
    Stage.lenis.scrollTo(y, {
      duration: Math.min(.8, .34 + screens / 6), easing: chained ? GLIDE : EASE, force: true,
      onComplete: () => { S.moving = false; if (done) done(); },
    });
  };
  all.push(S);
  wire();
  return S;
}

function wire() {
  if (wired || !Stage.lenis) return;
  wired = true;
  const prev = Stage.lenis.options.virtualScroll;
  Stage.lenis.options.virtualScroll = (data) => {
    if (prev && prev(data) === false) return false;
    const e = data.event, dir = Math.sign(data.deltaY);
    if (!e.type.includes('wheel') || e.ctrlKey || !dir) return true;
    const now = performance.now(), abs = Math.abs(data.deltaY);
    // a new gesture: a pause, the other way, or a swipe rising out of a decaying tail
    const decaying = G.lastAbs < G.peak * .6;
    const fresh = now - G.last > 220 || dir !== G.dir || (decaying && abs > G.lastAbs * 1.8 && abs >= 6 && now - G.at > 300);
    if (fresh) { G.peak = abs; G.used = false; G.at = now; } else G.peak = Math.max(G.peak, abs);
    G.last = now; G.lastAbs = abs; G.dir = dir;
    const y = window.scrollY;
    const S = all.find((s) => y >= s.st.start - 2 && y <= s.st.end + 2);
    if (!S) return true;
    const p = S.moving ? S.target : S.now();
    // at an end the page scrolls on, unless this gesture already made its step (its tail is spent here too)
    if (!S.moving && (dir > 0 ? p >= .9995 : p <= .0005)) {
      if (G.used && !fresh) { e.preventDefault(); return false; }
      return true;
    }
    e.preventDefault();
    if (!fresh) {
      // a gesture that came in from outside the range (the page scrolling into it): carried on to the stop nearest
      // where it is (the first one it meets: no stop is skipped), rather than left between stops
      if (!G.used && !S.moving) {
        const to = S.stops.reduce((a, s) => (Math.abs(s - p) < Math.abs(a - p) ? s : a), S.stops[0]);
        G.used = true;
        S.go(to, null, true);
      }
      return false;
    }
    const to = dir > 0 ? S.stops.find((s) => s > p + .0005) : S.stops.filter((s) => s < p - .0005).pop();
    if (to === undefined) return S.moving ? false : true;
    G.used = true;
    S.go(to, null, S.moving);
    return false;
  };
}
