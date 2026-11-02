// @ts-check
import { defineConfig } from 'astro/config';

// A static site. SITE_URL / BASE_PATH set where it is published (GitHub Pages under /Playpex, a domain at /).
export default defineConfig({
  site: process.env.SITE_URL || 'https://ihebbelhadj.github.io',
  base: process.env.BASE_PATH || '/',
  output: 'static',
  server: { port: 4321 },
  devToolbar: { enabled: false },
  // the stylesheets are small: inline them, so the first paint waits on no request
  build: { inlineStylesheets: 'always' },
});
