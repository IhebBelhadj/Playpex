// The pictures the home page's scripts paint (textures, dithered canvases), as WebP URLs, and the Sintel loop.
// index.astro writes them into the page as JSON (#img-map), so the URLs carry Astro's fingerprints and base path.
const data = JSON.parse(document.getElementById('img-map').textContent);

export const IMG = data.images;
export const LOOP = data.loop;
