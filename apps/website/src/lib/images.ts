// Every picture the site draws (screens, posters, the poster wall), by file name without its extension.
// Pages render them with astro:assets (<Image>: WebP, sized, with width and height); the scripts that paint them
// into the dither shader and canvases get WebP URLs through imageMap(), handed over as JSON (#img-map).
import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';

const files = import.meta.glob<ImageMetadata>('../assets/img/*.{jpg,png}', { eager: true, import: 'default' });
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));

export const IMG: Record<string, ImageMetadata> = Object.fromEntries(Object.entries(files).map(([p, m]) => [name(p), m]));

// the Sintel loop (played in the screens scene), as a plain fingerprinted URL
export { default as LOOP_VIDEO } from '../assets/img/loop.mp4?url';

// the pictures the home page's scripts paint (home/*.js: the shader textures, the dissolves, the Who's watching pictures), at
// the width they are needed (a texture or a dithered canvas never needs more)
const SCRIPT_IMAGES = ['wall', 's_dashlib', 's_tvlib', 's_mtitle', 's_man', 's_resume', 's_player', 'loopposter', 's_subs', 's_profiles', 's_remote'];

export async function imageMap(keys: string[] = SCRIPT_IMAGES): Promise<Record<string, string>> {
  const entries = await Promise.all(keys.map(async (key) => {
    const src = IMG[key];
    const img = await getImage({ src, format: 'webp', width: Math.min(src.width, 1600), quality: 80 });
    return [key, img.src] as const;
  }));
  return Object.fromEntries(entries);
}
