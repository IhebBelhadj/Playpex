// Everything the site says about Playpex in one place: the release, the products, the menus, the home page's
// lists. Pages render it; scripts read what they need from the markup.

export const SITE = {
  name: 'Playpex',
  title: 'Playpex: your library on every screen',
  description: 'Playpex keeps your films and shows on a computer in your home and plays them on your TV, your phone and in any browser on your Wi-Fi.',
  repo: 'https://github.com/IhebBelhadj/Playpex',
  releases: 'https://github.com/IhebBelhadj/Playpex/releases',
};

export const RELEASE = {
  version: '0.10.1-alpha.1',
  date: '2026-11-01',
  dateText: '1 November 2026',
};

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
}

export const PRODUCTS: Product[] = [
  {
    id: 'server', name: 'Media Server', short: 'Server', line: 'Keeps your films and streams them', device: 'web',
    about: 'Keeps your films, shows and channels on a computer at home and streams them to every screen in the house. You run it from its dashboard in a browser.',
    blurb: 'Keeps the films, finds their posters and streams them. You run it from a browser.',
    systems: 'Windows, macOS, Linux', shot: 's_dashlib', shotAlt: 'The Media Server’s dashboard: the Library as a poster index, A to Z',
  },
  {
    id: 'tv', name: 'Playpex TV', short: 'TV', line: 'Watch on the big screen', device: 'tv',
    about: 'The big-screen app for a computer plugged into your TV. Made for a remote: arrows, OK and Back move everything.',
    blurb: 'For the computer by your TV. Arrows, OK and Back do everything.',
    systems: 'Windows, macOS, Linux', shot: 's_tvlib', shotAlt: 'Playpex TV: Sintel at the top of Recently added, the films of the server in a row', preview: 's_continue',
  },
  {
    id: 'android', name: 'Playpex for Android', short: 'Android', line: 'Watch on your phone', device: 'phone',
    about: 'Your library on your phone and tablet. Plays files as they are, with every audio track and subtitle.',
    blurb: 'Plays files as they are, with every track, and picks up at the minute the TV stopped.',
    systems: 'Phones and tablets', shot: 's_mtitle', shotAlt: 'Playpex for Android: Sintel’s page, with Resume from 6:31',
  },
  {
    id: 'manager', name: 'Server Manager', short: 'Manager', line: 'Run your server from your phone', device: 'phone',
    about: 'Finds your server on the Wi-Fi and opens its dashboard on your phone, with the remote control for your TV.',
    blurb: 'Finds the server on your Wi-Fi and opens its dashboard on your phone: the library, downloads and who is watching.',
    systems: 'Android', shot: 's_man', shotAlt: 'Server Manager on a phone: the Library of the server Living room',
  },
];

// the top-level pages (not built yet: their links stay on this page)
export const PAGES = [
  { href: '#plugins', name: 'Plugins' },
  { href: '#docs', name: 'Docs' },
  { href: '#releases', name: 'Releases' },
  { href: SITE.repo, name: 'GitHub' },
];

export interface Doc { group: 'Use Playpex' | 'Build on Playpex'; title: string }
export const DOCS: Doc[] = [
  { group: 'Use Playpex', title: 'Get started' },
  { group: 'Use Playpex', title: 'Pair a screen' },
  { group: 'Use Playpex', title: 'Add your library' },
  { group: 'Use Playpex', title: 'Live TV and channels' },
  { group: 'Use Playpex', title: 'Troubleshooting' },
  { group: 'Build on Playpex', title: 'Client API' },
  { group: 'Build on Playpex', title: 'Plugin guide' },
  { group: 'Build on Playpex', title: 'API reference' },
];

// the remote's row: the films on the demo server, with their posters p0…p8
export const FILMS = [
  ['Sintel', '2010, on this server, resume at 5:18'], ['The Kid', '1921, on this server'], ['Tears of Steel', '2012, on this server'],
  ['The Cabinet of Dr. Caligari', '1920, on this server'], ['The General', '1926, on this server'], ['Spring', '2019, on this server'],
  ['Sherlock Jr.', '1924, on this server'], ['Night of the Living Dead', '1968, on this server'], ['Nosferatu', '1922, on this server'],
] as const;

// Who's watching: each profile of the demo house, its colours (fill behind the row, face) and the feature it switches on
export const PEOPLE = [
  { name: 'Sam', fill: 'var(--who-sam)', face: 'var(--face-sam)', line: 'Sam starts on the TV and finishes in bed.', toggle: 'Resume on any screen',
    note: 'Sintel opens on Sam’s phone at 6:31, the minute the TV stopped.', shot: 's_mtitle', alt: 'Playpex for Android: Sintel, Resume from 6:31', tall: true },
  { name: 'Alex', fill: 'var(--who-alex)', face: 'var(--face-alex)', line: 'Alex keeps the film’s own sound.', toggle: 'Sound for every film',
    note: 'Dolby and DTS tracks are turned into AAC by the server, so no film plays silent.', shot: 's_player', alt: 'Playpex TV playing Sintel', tall: false },
  { name: 'Noor', fill: 'var(--who-noor)', face: 'var(--face-noor)', line: 'Noor watches with subtitles.', toggle: 'Subtitles in any language',
    note: 'From the file or online, in Noor’s language, at Noor’s size.', shot: 's_subs', alt: 'Playpex TV: the subtitles for Sintel, in English, French, Spanish and German', tall: false },
  { name: 'Kids', fill: 'var(--who-kids)', face: 'var(--face-kids)', line: 'The kids see what’s for them.', toggle: 'Kids profile', dark: true,
    note: 'Only titles for children, and the grown-ups’ profiles locked with a PIN.', shot: 's_profiles', alt: 'Playpex TV: Who’s watching, with Sam, Alex, Noor and the Kids profile', tall: false },
  { name: 'Everyone', fill: 'var(--who-all)', face: '', line: 'Everyone pauses the TV from the sofa.', toggle: 'Your phone as the remote',
    note: 'Any phone in the house is a remote for any screen, with a touchpad and the keys.', shot: 's_remote', alt: 'The remote control on a phone: Sintel playing on the Living room TV', tall: true },
];

export const DOWNLOADS = {
  Windows: { file: `Playpex-Media-Server-Setup-${RELEASE.version}.exe`, how: 'Installs for your user only. Windows may ask you to confirm the first time.' },
  macOS: { file: `Playpex-Media-Server-${RELEASE.version}.dmg`, how: 'Drag Playpex Media Server to Applications.' },
  Linux: { file: `Playpex-Media-Server-${RELEASE.version}.AppImage`, how: 'Or the .deb package on the releases page.' },
};
