// The site bar (markup in components/SiteNav.astro): desktop menus open on click and close on Escape or outside;
// the phone menu opens over the page, with the TV app's focus following the finger; the bar steps out of the way
// while you read down and comes back as soon as you scroll up.
import { system } from './home/util.js';

export const os = system();

const nav = document.getElementById('site-nav');
const burger = nav.querySelector('.burger');
const sheet = document.getElementById('nav-sheet');
const narrow = window.matchMedia('(max-width: 899px)');

// "Download for Linux" where the system is known
if (os) nav.querySelectorAll('[data-os-label]').forEach((el) => { el.textContent = 'Download for ' + os; });

// ── desktop menus ──
let open = null;
function setMenu(key) {
  open = key;
  nav.querySelectorAll('[data-menu]').forEach((b) => {
    const on = b.dataset.menu === key;
    b.setAttribute('aria-expanded', String(on));
    document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
  });
}
// pointing at (or tabbing to) a product shows it on the right
function pick(e) {
  const it = e.target.closest && e.target.closest('.pitem');
  if (!it || it.classList.contains('sel')) return;
  const menu = it.closest('.menu');
  menu.querySelectorAll('.pitem').forEach((x) => x.classList.toggle('sel', x === it));
  menu.querySelectorAll('.pv').forEach((v) => { v.hidden = v.dataset.i !== it.dataset.i; });
}
nav.addEventListener('mouseover', pick);
nav.addEventListener('focusin', pick);

// ── the phone menu ──
function lock(on) {
  document.documentElement.classList.toggle('nav-lock', on);
  if (window.Stage && window.Stage.lenis) window.Stage.lenis[on ? 'stop' : 'start']();
}
function setSheet(on, refocus) {
  sheet.hidden = !on;
  nav.classList.toggle('is-open', on);
  burger.setAttribute('aria-expanded', String(on));
  burger.setAttribute('aria-label', on ? 'Close menu' : 'Menu');
  lock(on);
  if (on) { setAway(false); resetFocus(); }
  if (refocus) burger.focus();
}

// the TV app's focus on a phone: a white fill follows the finger (or the mouse, or Tab) down the list
const list = sheet.querySelector('.alist');
const pill = sheet.querySelector('.fpill');
let focused = null;
function focusItem(it) {
  if (!it || it === focused) return;
  if (focused) focused.classList.remove('on');
  focused = it;
  it.classList.add('on');
  pill.style.transform = 'translateY(' + it.offsetTop + 'px)';
  pill.style.height = it.offsetHeight + 'px';
  if (!pill.classList.contains('shown')) { void pill.offsetWidth; pill.classList.add('shown'); }
}
function resetFocus() {
  if (focused) focused.classList.remove('on');
  focused = null;
  pill.classList.remove('shown');
}
const itemAt = (t) => { const el = document.elementFromPoint(t.clientX, t.clientY); return el && el.closest('.fi'); };
list.addEventListener('pointerover', (e) => focusItem(e.target.closest('.fi')));
list.addEventListener('focusin', (e) => focusItem(e.target.closest('.fi')));
list.addEventListener('touchstart', (e) => focusItem(itemAt(e.touches[0])), { passive: true });
list.addEventListener('touchmove', (e) => focusItem(itemAt(e.touches[0])), { passive: true });

// ── clicks, Escape ──
nav.addEventListener('click', (e) => {
  const m = e.target.closest('[data-menu]');
  if (m) { setMenu(open === m.dataset.menu ? null : m.dataset.menu); return; }
  if (e.target.closest('.burger')) { setSheet(sheet.hidden, false); return; }
  if (e.target.closest('a')) { setMenu(null); if (!sheet.hidden) setSheet(false); }
});
document.addEventListener('click', (e) => { if (open && !nav.contains(e.target)) setMenu(null); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!sheet.hidden) setSheet(false, true);
  else if (open) { const b = nav.querySelector('[data-menu="' + open + '"]'); setMenu(null); b.focus(); }
});

// ── scrolling ──
let lastY = window.scrollY, away = false, scrolled = false;
function setAway(on) { if (on !== away) { away = on; nav.classList.toggle('away', on); } }
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if ((y > 8) !== scrolled) { scrolled = y > 8; nav.classList.toggle('scrolled', scrolled); }
  if (!sheet.hidden) { lastY = y; return; }
  if (y <= 120) { setAway(false); lastY = y; return; }
  if (Math.abs(y - lastY) > 6) { setAway(narrow.matches && y > lastY); lastY = y; }
}, { passive: true });
