// The web app manifest: the name, the theme's ground colour and the icons (public/).
import type { APIRoute } from 'astro';
import { SITE } from '../data/site';

export const GET: APIRoute = () => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return new Response(JSON.stringify({
    name: SITE.name, short_name: SITE.name, description: SITE.description, start_url: base, scope: base, display: 'browser',
    background_color: '#141414', theme_color: '#141414',
    icons: [
      { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${base}favicon.svg`, sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2), { headers: { 'Content-Type': 'application/manifest+json' } });
};
