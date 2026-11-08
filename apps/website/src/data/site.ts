// Everything the site says about Playpex in one place: the release, the products, the menus, the home page's
// lists. Pages render it; scripts read what they need from the markup.

export const SITE = {
  name: 'Playpex',
  title: 'Playpex: your library on every screen',
  description: 'Playpex keeps your films and shows on a computer in your home and plays them on your TV, your phone and in any browser on your Wi-Fi.',
  repo: 'https://github.com/IhebBelhadj/Playpex',
  releases: 'https://github.com/IhebBelhadj/Playpex/releases',
  author: { name: 'Iheb Belhadj', url: 'https://github.com/IhebBelhadj' },   // who made Playpex: the footer, the page's metadata
};

export const RELEASE = {
  version: '0.10.1-alpha.1',
  date: '2026-11-05',
  dateText: '5 November 2026',
  // each app's release on GitHub (one tag per app and version)
  tags: { server: 'server-v0.10.1-alpha.1', tv: 'tv-v0.10.1-alpha.1', mobile: 'android-v0.10.1-alpha.1', manager: 'manager-v0.10.1-alpha.1' },
};

// a file of a GitHub release, downloaded directly
export const assetUrl = (tag: string, file: string) => `${SITE.releases}/download/${tag}/${file}`;
// the download dialog's choice: the file, how to install it, its link
export const dl = (app: keyof typeof RELEASE.tags, file: string, how: string) => ({ file, how, url: assetUrl(RELEASE.tags[app], file) });

export type DeviceKind = 'web' | 'tv' | 'phone';

export interface Product {
  id: string;
  name: string;
  short: string;        // the name in a tight row (the phone's app switcher)
  line: string;         // one line in the phone menu
  about: string;        // the Products menu's preview
  blurb: string;        // the home page
  systems: string;
  device: DeviceKind;
  shot: string;         // a picture in src/assets/img
  shotAlt: string;
  preview?: string;     // the Products menu's screenshot (none: "Screenshot to come")
  page?: string;        // its own page (src/pages/<page>.astro), once it has one
}

export const PRODUCTS: Product[] = [
  {
    id: 'server', name: 'Media Server', short: 'Server', line: 'Keeps your films and streams them', device: 'web',
    about: 'Keeps your films, shows and channels on a computer at home and streams them to every screen in the house. You run it from its dashboard in a browser.',
    blurb: 'Keeps the films, finds their posters and streams them. You run it from a browser.',
    systems: 'Windows, macOS, Linux', shot: 's_dashlib', shotAlt: 'The Media Server’s dashboard: the Library as a poster index, A to Z', preview: 's_dashtitles', page: 'server',
  },
  {
    id: 'tv', name: 'Playpex TV', short: 'TV', line: 'Watch on the big screen', device: 'tv',
    about: 'The big-screen app for a computer plugged into your TV. Made for a remote: arrows, OK and Back move everything.',
    blurb: 'For the computer by your TV. Arrows, OK and Back do everything.',
    systems: 'Windows, macOS, Linux', shot: 's_tvlib', shotAlt: 'Playpex TV: Sintel at the top of Recently added, the films of the server in a row', preview: 's_continue', page: 'tv',
  },
  {
    id: 'mobile', name: 'Playpex Mobile', short: 'Mobile', line: 'Watch on your phone', device: 'phone',
    about: 'Your library on your phone and tablet. Plays files as they are, with every audio track and subtitle.',
    blurb: 'Plays files as they are, with every track, and picks up at the minute the TV stopped.',
    systems: 'Phones and tablets', shot: 's_mtitle', shotAlt: 'Playpex Mobile: Sintel’s page, with Resume from 6:31', preview: 'a_home', page: 'mobile',
  },
  {
    id: 'manager', name: 'Server Manager', short: 'Manager', line: 'Run your server from your phone', device: 'phone',
    about: 'Finds your server on the Wi-Fi and opens its dashboard on your phone, with the remote control for your TV.',
    blurb: 'Finds the server on your Wi-Fi and opens its dashboard on your phone: the library, downloads and who is watching.',
    systems: 'Android', shot: 's_man', shotAlt: 'Server Manager on a phone: the Library of the server Living room', preview: 'm_lib', page: 'manager',
  },
];

// where a product's links go: its own page, else the four apps on the home page ('#products' on the home page
// itself, where the intro script scrolls to them)
export function productHref(p: Product, base: string, onHome: boolean): string {
  if (p.page) return base + p.page;
  return onHome ? '#products' : base + '#products';
}

// where Download goes: this page's own download section, or the home page's on pages that have none (the plugins, the docs)
export function downloadHref(pathname: string, base: string): string {
  const page = pathname.slice(base.replace(/\/?$/, '/').length - 1).replace(/^\/|\/$/g, '');
  return page === 'plugins' || page === 'docs' || page.startsWith('docs/') ? base.replace(/\/?$/, '/') + '#download' : '#download';
}

// the top-level pages: a bare name is a page of the site (src/pages/<name>.astro); '#…' is still on the home page
export const PAGES = [
  { href: 'plugins', name: 'Plugins' },
  { href: 'docs/', name: 'Docs' },
  { href: 'releases', name: 'Releases' },
  { href: SITE.repo, name: 'GitHub' },
];

// the bar's Docs menu: a few pages of src/content/docs by their slug (docs/<slug>)
export interface Doc { group: 'Use Playpex' | 'Build on Playpex'; title: string; slug: string }
export const DOCS: Doc[] = [
  { group: 'Use Playpex', title: 'Connect a screen', slug: 'connect-a-screen' },
  { group: 'Use Playpex', title: 'Add your library', slug: 'add-your-library' },
  { group: 'Use Playpex', title: 'Live TV', slug: 'live-tv' },
  { group: 'Use Playpex', title: 'Troubleshooting', slug: 'troubleshooting' },
  { group: 'Build on Playpex', title: 'Write a plugin', slug: 'plugins-overview' },
  { group: 'Build on Playpex', title: 'Hooks', slug: 'hooks' },
  { group: 'Build on Playpex', title: 'Publish a plugin', slug: 'publishing' },
  { group: 'Build on Playpex', title: 'Build a client', slug: 'client-api' },
];

// the remote's row: the films on the demo server, with their posters p0…p8
export const FILMS = [
  ['Sintel', '2010, on this server, resume at 5:18'], ['The Kid', '1921, on this server'], ['Tears of Steel', '2012, on this server'],
  ['The Cabinet of Dr. Caligari', '1920, on this server'], ['The General', '1926, on this server'], ['Spring', '2019, on this server'],
  ['Sherlock Jr.', '1924, on this server'], ['Night of the Living Dead', '1968, on this server'], ['Nosferatu', '1922, on this server'],
] as const;

export const DOWNLOADS = {
  Windows: dl('server', `Playpex-Media-Server-Setup-${RELEASE.version}.exe`, 'Installs for your user only. Windows may ask you to confirm the first time.'),
  Linux: dl('server', `Playpex-Media-Server-${RELEASE.version}-x86_64.AppImage`, 'Or the .deb package on the releases page.'),
};
