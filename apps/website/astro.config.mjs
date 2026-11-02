// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import docLinks from './src/lib/doc-links.mjs';

// always with a trailing slash: pages join paths to it (home + 'plugins')
const base = (process.env.BASE_PATH || '/').replace(/\/?$/, '/');

// A static site. SITE_URL / BASE_PATH set where it is published (GitHub Pages under /Playpex, a domain at /).
export default defineConfig({
  site: process.env.SITE_URL || 'https://ihebbelhadj.github.io',
  base,
  output: 'static',
  server: { port: 4321 },
  devToolbar: { enabled: false },
  // the stylesheets are small: inline them, so the first paint waits on no request
  build: { inlineStylesheets: 'always' },
  // the docs (src/content/docs): links between pages by name, code in a dark theme close to the site's ground
  markdown: { processor: satteri({ mdastPlugins: [docLinks(base)] }), shikiConfig: { theme: 'github-dark-default', wrap: false } },
});
