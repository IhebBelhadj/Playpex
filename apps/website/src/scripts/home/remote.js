// The remote: a row of Playpex TV (the films on the demo server, as dithered posters that light up when focused),
// driven by the pad or the arrow keys. OK on Sintel opens its resume question; Back closes it.
import { dots } from './dither.js';
import { whenNear } from './util.js';

const HINT = 'OK on Sintel opens it, Back closes it.';
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok', Escape: 'back', Backspace: 'back' };

export function initRemote() {
  const row = document.getElementById('tvrow'), track = document.getElementById('track'), chooser = document.getElementById('chooser');
  const title = document.getElementById('tv-title'), sub = document.getElementById('tv-sub'), hint = document.getElementById('pad-hint');
  const pad = document.querySelector('.pad-wrap');
  const posters = [...track.querySelectorAll('.poster')];
  let at = 0;

  whenNear(row, () => posters.forEach((p) => {
    const im = p.querySelector('img');
    const draw = () => dots(im, p.querySelector('canvas'), 3);
    if (im.complete && im.naturalWidth) draw(); else im.addEventListener('load', draw, { once: true });
  }));

  function focus(i) {
    at = Math.max(0, Math.min(posters.length - 1, i));
    posters.forEach((p, k) => { p.classList.toggle('on', k === at); p.setAttribute('aria-selected', String(k === at)); });
    row.setAttribute('aria-activedescendant', posters[at].id);
    title.textContent = posters[at].dataset.title; sub.textContent = posters[at].dataset.sub;
    const w = posters[0].offsetWidth + 14, room = row.clientWidth - 56;
    const shift = Math.max(0, Math.min(at * w - room / 2 + w / 2, posters.length * w - 14 - room));
    track.style.transform = 'translateX(' + (-shift) + 'px)';
  }
  function press(k) {
    const btn = pad.querySelector('[data-k="' + k + '"]');
    if (btn) { btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 140); }
    if (!chooser.hidden) { if (k === 'back') { chooser.hidden = true; hint.textContent = HINT; } return; }
    if (k === 'left') focus(at - 1);
    else if (k === 'right') focus(at + 1);
    else if (k === 'ok') {
      if (at === 0) { chooser.hidden = false; hint.textContent = 'Press Back to return to the row.'; }
      else hint.textContent = 'In the app, OK opens ' + posters[at].dataset.title + '. Here, only Sintel opens.';
    } else if (k === 'up' || k === 'down') hint.textContent = 'In the app, up and down move between rows. This sample has one.';
  }
  pad.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
  track.addEventListener('click', (e) => {
    const i = posters.indexOf(e.target.closest('.poster'));
    if (i < 0) return;
    if (i === at) press('ok'); else focus(i);
  });
  // the arrow keys drive the row while it is focused, or while it is in view and nothing else has focus
  let inView = false;
  new IntersectionObserver((es) => { inView = es[0].intersectionRatio > .6; }, { threshold: [0, .6, 1] }).observe(row);
  document.addEventListener('keydown', (e) => {
    const k = KEYS[e.key], a = document.activeElement;
    if (!k || e.altKey || e.ctrlKey || e.metaKey) return;
    const onPad = a && a.closest && a.closest('.pad-wrap'), mine = a === row || onPad, idle = !a || a === document.body;
    if (!(mine || (idle && inView))) return;
    if ((k === 'up' || k === 'down') && !mine) return;
    if (k === 'ok' && onPad) return;
    e.preventDefault();
    press(k);
  });
  window.addEventListener('resize', () => focus(at));
  focus(0);
}
