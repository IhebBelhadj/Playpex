# apps/website — the Playpex website

A static Astro 7 site: the product site where people learn about Playpex and download it (the releases host).
Educational project: keep that framing in every page (the footer already says it).

## Commands

| Goal | Command |
|---|---|
| Development | `npm run website` (repo root) or `npm run dev -w apps/website`: http://localhost:4321 |
| Build | `npm run build:website` → `apps/website/dist/` (static files) |
| Preview the build | `npx astro preview` from `apps/website` (runs as a daemon: `astro preview stop`) |
| Published under a path | `SITE_URL=https://<user>.github.io BASE_PATH=/Playpex npm run build:website` |

Astro is pinned to **7.4.1**: 7.4.2 and later need Node ≥ 22.23.4 and this machine has 22.23.2. Raise the pin
once Node is upgraded.

## Layout

```
src/
├── layouts/Base.astro       <head>, the Jost font (@fontsource-variable), the bar's mount #live, the footer
├── components/SiteFooter.astro
├── pages/index.astro        the home page markup
├── lib/images.ts            IMG: every file in src/assets/img by name → its fingerprinted URL (pages and scripts)
├── assets/img/              real screenshots from the demo server, posters, the poster wall, the Sintel loop
├── scripts/nav.js           the site bar (drawn by script into #live; exports `os` for the Download labels)
├── scripts/stage.js         the scroll-scene stage (from the design-taste-frontend skill) on npm's GSAP, ScrollTrigger, Lenis
├── scripts/home.js          the home page: the WebGL ordered-dither shader, the held intro, scenes, Who's watching, download
└── styles/                  nav.css (bar), base.css (tokens, shared), stage.css, home.css
```

The home page is a port of the agreed design (claude.ai artifact "Playpex Home", Version 7). **Don't change
sections the user has already agreed on** without being asked; propose options for new pieces instead.

## Rules

- **Never show the 18+ section, Velvet, or anything adult** in a picture or text. Screenshots come from a throwaway
  demo server (Blender open films, public-domain classics, demo profiles), never the user's own server (real
  profile names, the computer's name, torrent-site errors).
- Colours: ink `#141414`, gold dots `#edcc75`, gold `#f6e084`. The dither (Bayer) is the one motif; real screens
  are shown crisp, dots only as texture and transition.
- The bar's CSS owns `.stage`, `.bar`, `.empty`, `.dev`: don't reuse those class names in pages.
- Pictures go in `src/assets/img/` and are read through `IMG` (never hard-coded `/_astro/…` or root-absolute
  paths: the site may be published under a base path).
- Respect `prefers-reduced-motion` (the stage and home.js already fall back to still frames).
