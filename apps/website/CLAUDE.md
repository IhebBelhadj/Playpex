# apps/website — the Playpex website

A static Astro 7 site: the product site where people learn about Playpex and download it (the releases host).
Educational project: keep that framing in every page (the footer already says it).

## Commands

| Goal | Command |
|---|---|
| Development | `npm run website` (repo root) or `npm run dev -w apps/website`: http://localhost:4321 |
| Build | `npm run build:website` → `apps/website/dist/` (static files) |
| Preview the build | `npx astro preview` from `apps/website` (runs as a daemon: `astro preview stop`) |
| Published under a path | `SITE_URL=https://<user>.github.io BASE_PATH=/Playpex npm run build:website` (the config adds a trailing slash: `BASE_URL` is always `…/`) |

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
├── components/              SiteNav.astro (the bar, server-rendered), SiteFooter.astro (the dot-matrix name, lib/led.ts),
│                            Remote, Rooms, DownloadField (home sections; DownloadField also closes the product pages),
│                            ShotCarousel (the product pages' screenshots: the slide in view itself, the others gold dots)
├── pages/index.astro        the home page: every word in the HTML, pictures through <Image> (WebP, srcset)
├── pages/tv.astro, server.astro, mobile.astro, manager.astro   product pages, plain scroll (no held scenes), each its own
│                            structure (never repeat one): TV = dot-matrix remote driving a screen + ShotCarousel;
│                            server = folder hero, library, the download strip, playpex.local; mobile = Sintel's
│                            resume line + MobileBody (sticky phone that turns sideways, mosaic); manager = gold dots
│                            rippling from the phone until it finds "Living room", a strip of phone screens, the real
│                            remote (touchpad, arrows). All end on
│                            DownloadField. A product links to its page through data/site.ts `page` (productHref).
│                            The phone app is "Playpex Mobile" (React Native: Android now, iOS later): never call it Android-only
├── pages/plugins.astro       the plugins (data/plugins.ts): a display-size search, kinds, rows that open in place, pages of
│                            6; the query lives in the address (?q, ?kind, ?page). Never the 18+ plugin; the torrent-site
│                            and scraper plugins aren't listed. Site pages in data/site.ts PAGES are bare names (SiteNav `link`)
├── pages/releases.astro      the releases (data/releases.ts: each version, each app's files and notes, newest first): four app
│                            tiles (their screens) as tabs, ?app=<id> opens one (product pages' "All releases" do); each
│                            version with its notes and files, this visitor's system first in gold; a search by number or
│                            change and pages of 5, both in the address (?v, ?page; plugins' pagination). Files are downloaded
│                            from the GitHub releases page (SITE.releases). Add a release at the top of RELEASES and
│                            bump RELEASE in site.ts
├── content/docs/*.md         the docs (content.config.ts: title, description, group in GROUPS, order): features, plugin
│                            writing, the client API, sanitized from the repo's docs/ (no 18+ / Velvet / `audience: adults`).
│                            Link another page by its bare slug ("hooks", "install-the-server#…"), the site by "/plugins":
│                            lib/doc-links.mjs (a Sätteri mdast plugin, astro.config.mjs) adds docs/ and the base path.
│                            Quote titles / descriptions holding a colon (YAML)
├── layouts/Docs.astro, pages/docs/   the docs pages, deliberately conventional: sections + search on the left, the article
│                            (breadcrumb, previous / next, Edit on GitHub), "On this page" on the right (≥1200px); phones get
│                            a "Docs menu" button. Search reads docs/search.json (titles, sections, text) on first focus; "/"
│                            focuses it. The bar's Docs menu lists data/site.ts DOCS by slug
├── pages/robots.txt.ts, sitemap.xml.ts, manifest.webmanifest.ts   base-aware; add new pages to the sitemap's list
├── lib/images.ts            IMG (pictures in src/assets/img by name), imageMap() (WebP URLs the scripts paint, as #img-map JSON)
├── lib/icons.ts             the inline SVG icons
├── assets/img/              real screenshots from the demo server, posters, the poster wall, the Sintel loop
├── scripts/nav.js           opens and closes the bar's menus; the phone menu; hides the bar while reading down
├── scripts/stage.js         the scroll-scene stage (design-taste-frontend skill) on npm's GSAP, ScrollTrigger, Lenis
├── scripts/home.js          the home page's entry: the shared parts, then the site for this screen (a chunk of its own)
└── scripts/home/            shared: util.js (helpers, THEME, PHONE), assets.js (#img-map), gl.js (the dither shaders:
                             Painter, Morph; the Painter's mask draws the wall in a shape), mark.js (the hero's Playpex mark:
                             its outline as that mask), dither.js (dotted canvases, Pic), remote.js,
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

**The hero (agreed 2026-11-04):** the drifting poster wall inside the Playpex mark, 1.3 × the screen's height on desktop
(its tip at the right margin, behind the words under the scrim). Scrolling shrinks the mark to the first screen's
height (its shape kept), then it grows into the screen while the folder opens through its dots, inside the mark and
around it. Reduced motion: the mark stands still behind the words. Phones have their own hero (reworked 2026-11-05): two
rows of the library's posters fill the top of the screen under the bar, drifting in opposite directions (`#prow`), the
words, one full-width Download and a text "See how it works" at the foot (thumb zone). The swipe is one camera push
(`home/phone/intro.js` T): the words drop out, the rows grow and fade, gone before a flat ground veil (`#iscrim`)
lifts off the server's library, which settles from a slight zoom; then "Four apps" rises. Never two shelves visible
at once, no dots and no pan during this move. Picture frames never use the class `ph`: scripts/images.js adds and removes it while a picture loads. Dots only ever show while moving between stops: one wheel gesture is one stop. On desktop the intro and the rooms step
through `home/desktop/steps.js` (the move's curve cubic-bezier(.2, 0, 0, 1), a new swipe rising out of the last one's
inertia chains into the next stop without stopping, a gesture coming in from outside lands on the first stop it meets).
Phones: one curve too (`util.js` EASE, also the app switch and the Screens buttons); a hero swipe is spent until the
finger lifts (else a long swipe scrolled on past the apps); the painter rests (`P.paused`) while its wall is out of
sight. WebGL pictures are decoded before upload and uploaded one per frame, only while the page is still
(`gl.js` loadAll / uploadAll): a texture upload inside a move was a quarter-second freeze on phones.

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
- Markdown goes through Sätteri (Astro 7's default; `@astrojs/markdown-satteri`): plugins are `{ name, link(node, ctx) }`
  visitors that change nodes with `ctx.setProperty`, never remark plugins (those need `@astrojs/markdown-remark`).
- "You are here" is one lit dot (6px, `--dot`), nothing else: left of the bar's link (the Products button on a product page),
  before the current product in the Products menu, the current docs page (bar menu, sidebar, On this page). Pointing
  only turns words white. The nav works out the current product / docs page from the address.
- Download links: `downloadHref()` (data/site.ts) sends pages without a download section (plugins, docs) to the home page's.
- Respect `prefers-reduced-motion` (the stage and home.js already fall back to still frames).
