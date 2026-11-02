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
├── data/site.ts             everything the site says: the release, the products, menus, the home page's lists
├── styles/tokens.css        every colour (and type and space token): change a theme here; the canvases and
│                            shaders read --ground, --dot, --unlit from it (scripts/home/util.js THEME)
├── styles/                  nav.css (bar), base.css (shared: page, remote, download, footer), stage.css (scenes),
│                            desktop.css (the desktop site, ≥768px), phone.css (the phone site, ≤767px; html.is-phone)
├── layouts/Base.astro       <head>: title, description, canonical, Open Graph / Twitter, JSON-LD, icons, font preload
├── components/              SiteNav.astro (the bar, server-rendered), SiteFooter.astro (the dot-matrix name, lib/led.ts)
├── pages/index.astro        the home page: every word in the HTML, pictures through <Image> (WebP, srcset)
├── pages/robots.txt.ts, sitemap.xml.ts, manifest.webmanifest.ts   base-aware; add new pages to the sitemap's list
├── lib/images.ts            IMG (pictures in src/assets/img by name), imageMap() (WebP URLs the scripts paint, as #img-map JSON)
├── lib/icons.ts             the inline SVG icons
├── assets/img/              real screenshots from the demo server, posters, the poster wall, the Sintel loop
├── scripts/nav.js           opens and closes the bar's menus; the phone menu; hides the bar while reading down
├── scripts/stage.js         the scroll-scene stage (design-taste-frontend skill) on npm's GSAP, ScrollTrigger, Lenis
├── scripts/home.js          the home page's entry: the shared parts, then the site for this screen (a chunk of its own)
└── scripts/home/            shared: util.js (helpers, THEME, PHONE), assets.js (#img-map), gl.js (the dither shaders:
                             Painter, Morph), dither.js (dotted canvases, Pic), remote.js, people.js (Who's watching),
                             download.js, switch.js (the gold-dot curtain between the two sites)
                             desktop/ and phone/: each site's intro.js (the held intro) and scenes.js (screens, rooms;
                             the phone's buttons and carousel), started by its index.js
public/                      favicon.svg / -32.png, apple-touch-icon.png, icon-192/512.png, og.jpg (the social card)
```

**Two sites, one page.** The desktop and the phone sites share the HTML (the words, for SEO) and nothing else:
each has its own stylesheet (`desktop.css`, `phone.css`, each inside its own media query) and its own scripts
(`home/desktop/`, `home/phone/`, loaded as separate chunks). Change one without touching the other. Crossing 768px
(rotation, resizing) switches site: gold dots cover the page, it reloads with the same section in view, the dots
clear (`home/switch.js`; the head's script keeps the page covered meanwhile, `html.switching`).

The home page is a port of the agreed design (claude.ai artifact "Playpex Home", Version 7), with phones' own
composition (one move from the hero to the four apps, button-driven screens, a rooms carousel). **Don't change
the look of sections the user has agreed on**, not even while refactoring or optimising; propose options for
new pieces instead.

## Rules

- **Never show the 18+ section, Velvet, or anything adult** in a picture or text. Screenshots come from a throwaway
  demo server (Blender open films, public-domain classics, demo profiles), never the user's own server (real
  profile names, the computer's name, torrent-site errors).
- Colours only through `styles/tokens.css` (`var(--…)`), never a literal in a stylesheet; ground `#141414`, gold dots
  `#edcc75`, gold `#f6e084`. The dither (Bayer) is the one motif; real screens are shown crisp, dots only as texture
  and transition.
- The bar's CSS owns `.stage`, `.bar`, `.empty`, `.dev`: don't reuse those class names in pages.
- Pictures go in `src/assets/img/`: pages render them with `<Image>` (sizes, `loading="lazy"` below the fold); a
  picture a script paints is listed in `lib/images.ts` `SCRIPT_IMAGES` and read from `home/assets.js` `IMG`. Never
  hard-code `/_astro/…` or root-absolute paths: the site may be published under a base path.
- Words a visitor reads go in the HTML (data in `data/site.ts`), not in scripts: crawlers and the first paint see them.
- Lighthouse (production build, `npx astro preview`): desktop 100 in every category; mobile 100 for accessibility,
  best practices and SEO. Mobile performance is held down by the hero's WebGL wall, which Lighthouse renders on the
  CPU (each frame a long task).
- Respect `prefers-reduced-motion` (the stage and home.js already fall back to still frames).
