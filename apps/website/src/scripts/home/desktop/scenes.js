// The desktop site's scroll scenes (scripts/stage.js): the screens (server → TV → title → resume, then the film
// on the whole screen), on the page's own scroll, and the rooms (what the server does), a track moving by whole
// rooms.
import '../../stage.js';
import { IMG, LOOP } from '../assets.js';

const { Stage, Scenes } = window;

export function initScenes() {
  Scenes.screens = (root) => screens(root);

  Scenes.rooms = (root) => {
    const track = root.querySelector('.rooms'), count = root.querySelectorAll('.rooms-count i'), rooms = track.querySelectorAll('.room');
    return Stage.scene(root, {
      hold: 3, snap: [0, 1 / 3, 2 / 3, 1],
      onUpdate(p) {
        const k = Math.round(p * 3);
        count.forEach((c, i) => c.classList.toggle('on', i === k));
        rooms.forEach((r, i) => r.classList.toggle('cur', i === k));
      },
      // every stop centres one room: the track moves by whole rooms
      build(tl, ctx) {
        const step = () => rooms[1].offsetLeft - rooms[0].offsetLeft;
        const first = () => (ctx.stage.clientWidth - rooms[0].offsetWidth) / 2 - rooms[0].offsetLeft;
        tl.fromTo(track, { x: () => first() }, { x: () => first() - step() * (rooms.length - 1), duration: 1 }, 0);
      },
    });
  };
}

// The screens, on the page's own scroll (not held): the steps listed on the left, the one beside its screen in
// full ink; the screens pass on the right as themselves. "And it plays." is the ending: its frame grows from the
// column to the whole screen while it is pinned, and the film plays with the words over it.
function screens(root) {
  const wrap = root.querySelector('.sc-wrap'), beats = [...root.querySelectorAll('.beat')], last = beats.pop();
  const box = document.getElementById('screens-screen'), video = box.querySelector('video'), scrim = box.querySelector('.scrim');
  root.classList.add('flow');
  // the four steps' screens
  const col = document.createElement('div');
  col.className = 'flow-shots';
  [IMG.s_dashlib, IMG.s_tvlib, IMG.s_resume].forEach((src, i) => {
    const f = document.createElement('figure');
    f.innerHTML = '<img src="' + src + '" alt="" decoding="async" loading="lazy">';
    f.dataset.i = i;
    col.appendChild(f);
  });
  box.hidden = true;
  wrap.appendChild(col);
  // the ending: pinned for one screen of scroll to grow and half a screen to watch
  const end = document.createElement('div'), stage = document.createElement('div'), frame = document.createElement('figure');
  end.className = 'flow-end'; stage.className = 'fe-stage'; frame.className = 'fe-frame';
  frame.innerHTML = '<img src="' + IMG.s_player + '" alt="" decoding="async" loading="lazy">';
  video.removeAttribute('aria-hidden'); video.setAttribute('aria-label', 'Sintel playing');
  frame.appendChild(video);
  scrim.className = 'fe-scrim';
  frame.appendChild(scrim);
  last.classList.add('fe-words');
  stage.append(frame, last);
  end.appendChild(stage);
  wrap.appendChild(end);   // in the section's grid, under the screens: the list stays beside it until the film covers it

  // the step beside the middle of the screen is in full ink; clicking a step brings its screen there
  const figs = [...col.children];
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) beats.forEach((b, i) => b.classList.toggle('on', i === +e.target.dataset.i));
  }), { rootMargin: '-45% 0px -45% 0px' });
  figs.forEach((f) => io.observe(f));
  beats.forEach((b, i) => {
    b.tabIndex = 0; b.setAttribute('role', 'button');
    const go = () => figs[i].scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
    b.addEventListener('click', go);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  beats[0].classList.add('on');

  // the ending's growth: from where the column's frames sit to the whole screen, over the first screen of scroll
  let playing = false;
  function play(on) {
    if (on === playing) return;
    playing = on;
    if (!on) { video.pause(); return; }
    if (!video.src) { video.poster = IMG.loopposter; video.src = LOOP; }
    video.play().catch(() => {});
  }
  function from() {
    const c = figs[0].getBoundingClientRect(), W = document.documentElement.clientWidth, H = window.innerHeight;
    const w = c.width, h = w * 9 / 16, x = c.left, y = (H - h) / 2;
    return { x, y, w, h, W, H };
  }
  function place() {
    stage.style.setProperty('--fe-left', end.getBoundingClientRect().left + 'px');
    stage.style.setProperty('--fe-w', document.documentElement.clientWidth + 'px');
  }
  function update() {
    place();
    const r = end.getBoundingClientRect(), H = window.innerHeight;
    const p = Math.max(0, Math.min(1, -r.top / H));                // 0 when the ending reaches the top, 1 a screen later
    const k = still() ? (p > 0 ? 1 : 0) : p * p * (3 - 2 * p);
    const f = from();
    const x = f.x * (1 - k), y = f.y * (1 - k), w = f.w + (f.W - f.w) * k, h = f.h + (f.H - f.h) * k;
    root.style.setProperty('--k', k.toFixed(3));   // the list fades as the film covers it
    frame.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    frame.style.width = w + 'px'; frame.style.height = h + 'px';
    frame.style.borderRadius = (12 * (1 - k)) + 'px';
    stage.style.setProperty('--k', k.toFixed(3));
    const inView = r.top < H && r.bottom > 0;
    play(inView && k > .6);
  }
  window.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  window.addEventListener('resize', () => { place(); update(); });
  place();
  update();
  return true;
}
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
