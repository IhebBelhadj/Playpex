// The download dialog, already open: the visitor's system chosen, the file and how to install it for each.
import { ICON } from '../../lib/icons';

export function initDownload(os) {
  const seg = document.getElementById('seg'), name = document.getElementById('dl-name'), how = document.getElementById('dl-how'), go = document.getElementById('dl-go');
  const opts = [...seg.querySelectorAll('button')];
  function set(b) {
    opts.forEach((o) => { const on = o === b; o.setAttribute('aria-checked', String(on)); o.tabIndex = on ? 0 : -1; });
    name.textContent = b.dataset.file; how.textContent = b.dataset.how;
    go.innerHTML = ICON.download + 'Download for ' + b.dataset.k;
  }
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) set(b); });
  // a radio group: the arrows move the choice
  seg.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const b = opts[(opts.findIndex((o) => o.getAttribute('aria-checked') === 'true') + d + opts.length) % opts.length];
    set(b); b.focus();
  });
  set(opts.find((o) => o.dataset.k === os) || opts[0]);
}
