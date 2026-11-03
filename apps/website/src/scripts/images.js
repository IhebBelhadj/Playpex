// Pictures still on their way: their frame shows unlit dots drifting (base.css .ph) and the picture comes forward
// once it is decoded, instead of popping in. Only lazy pictures that are not in yet, and none a scene paints or
// hides itself (those are eager, or start hidden). Without script pictures simply load as they are.
import { THEME } from './home/util.js';

// the dot, in the theme's unlit colour, as the placeholder's tile (base.css reads --ph-dots)
const dotTile = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="1.7" fill="' + THEME.css.unlit + '"/></svg>') + '")';
document.documentElement.style.setProperty('--ph-dots', dotTile);

function waitFor(img) {
  if (img.complete && img.naturalWidth) return;           // already in (the cache): nothing to wait for
  if (img.closest('.istage, .sc-screen') || getComputedStyle(img).opacity !== '1') return;   // a scene shows it in its own time
  const box = img.parentElement;
  box.classList.add('ph');
  img.classList.add('ph-img');
  const show = () => {
    img.classList.add('ph-in');
    // once it has come forward, the picture is left to its own rules again
    setTimeout(() => { box.classList.remove('ph'); img.classList.remove('ph-img', 'ph-in'); }, 700);
  };
  img.addEventListener('load', () => (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(show), { once: true });
  img.addEventListener('error', () => { box.classList.remove('ph'); img.classList.remove('ph-img'); }, { once: true });
}

document.querySelectorAll('main img[loading="lazy"], footer img[loading="lazy"]').forEach(waitFor);
