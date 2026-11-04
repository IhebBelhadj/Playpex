// The home page. It holds two sites over the same words: the desktop site and the phone site, each with its own
// layout (styles/desktop.css, styles/phone.css) and motion (home/desktop/, home/phone/); only the one for this screen
// is loaded. Crossing the width between them switches site behind a curtain of gold dots (home/switch.js).
// Shared by both: the remote, the download dialog, the dither shaders (home/gl.js, home/dither.js).
import { need } from './home/preload.js';   // first: the loading screen starts drawing at once
import { os } from './nav.js';
import { PRODUCTS } from '../data/site';
import { PHONE } from './home/util.js';
import { initRemote } from './home/remote.js';
import { initDownload } from './home/download.js';
import { initSwitch } from './home/switch.js';
import { ICON } from '../lib/icons';
import { picker } from './home/try.js';   // DRAFT: the options panel (only with ?try)

picker();

// "Download for Linux" where the system is known
if (os && os !== 'Android') document.querySelectorAll('[data-dl]').forEach((el) => { el.innerHTML = ICON.download + 'Download for ' + os; });

// the sections that rise into place as they enter
const rise = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); rise.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
document.querySelectorAll('.rv').forEach((el) => rise.observe(el));

initRemote();
initDownload(os);

// the site for this screen (its own code chunk); the scenes measure text, so they start once the font is in
const site = PHONE ? import('./home/phone/index.js') : import('./home/desktop/index.js');
const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
const fontsIn = need(), siteIn = need();
fonts.then(fontsIn, fontsIn);
Promise.all([site, fonts]).then(([{ start }]) => {
  start(PRODUCTS);   // the intro announces what it waits for (its wall's pictures) before this returns
  initSwitch();
}).finally(siteIn);
