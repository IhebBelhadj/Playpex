// The Playpex mark as the hero's shape (both sites' intro.js): the wall drifts inside it (the painter's mask), then the
// mark grows into the first screen. Its outline is the loading screen's clip path (index.astro, .preload-mark).

// the mark's width over its height (its viewBox, 20.8 × 18.6)
export const MARK_ASPECT = 20.8 / 18.6;

// the outline, white on black, as the wall's mask
export function markMask() {
  const c = document.createElement('canvas'); c.width = 1040; c.height = 930;
  const g = c.getContext('2d'), k = 50;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);   // a mask, not a colour of the page
  g.fillStyle = '#fff';
  g.beginPath();
  [[9.24, 11.1], [21.58, 17.23], [14.34, 24.17], [26.79, 16.99], [7, 7.21], [7, 11.5], [7, 24.79]].forEach(([x, y], i) => (i ? g.lineTo((x - 6.5) * k, (y - 6.7) * k) : g.moveTo((x - 6.5) * k, (y - 6.7) * k)));
  g.closePath(); g.fill();
  return c;
}
