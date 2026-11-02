// Who's watching: a row per profile of the demo house. Each row's switch turns on what that person needs, the
// row takes their colour and their picture forms out of the gold dots. A row switches itself on when it reaches the
// middle of the screen, unless it was touched first.
import { Pic } from './dither.js';
import { IMG } from './assets.js';
import { still, whenNear } from './util.js';

export function initPeople() {
  const rows = [...document.querySelectorAll('.person')], touched = new Set();
  const pics = rows.map((r) => {
    const fig = r.querySelector('.pic'), pic = Pic(fig);
    whenNear(r, () => pic.show(IMG[fig.dataset.shot], r.classList.contains('on')));
    return pic;
  });
  function set(i, on) {
    rows[i].querySelector('.sw2').setAttribute('aria-checked', String(on));
    rows[i].classList.toggle('on', on);
    pics[i].show(IMG[rows[i].querySelector('.pic').dataset.shot], on);
  }
  document.getElementById('features').addEventListener('click', (e) => {
    const b = e.target.closest('.sw2');
    if (!b) return;
    const i = rows.indexOf(b.closest('.person'));
    touched.add(i);
    set(i, b.getAttribute('aria-checked') !== 'true');
  });
  const io = new IntersectionObserver((es) => es.forEach((en) => {
    const i = rows.indexOf(en.target);
    if (en.isIntersecting && !touched.has(i)) { touched.add(i); setTimeout(() => set(i, true), still ? 0 : 350); }
  }), { rootMargin: '-40% 0px -40% 0px' });
  rows.forEach((r) => io.observe(r));
}
