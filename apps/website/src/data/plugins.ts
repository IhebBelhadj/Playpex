// The plugins the site lists (pages/plugins.astro): first-party ones a visitor can install, from their manifests in
// plugins/*/playpex-plugin.json, in plain words. Never the 18+ plugin. The torrent-site and scraper plugins live in
// repositories of their own and aren't listed here.
import trakt from '../assets/plugins/trakt.svg?raw';
import live from '../assets/plugins/live.svg?raw';
import hello from '../assets/plugins/hello.svg?raw';

export type Kind = 'Films' | 'Live TV' | 'Your history' | 'Ratings' | 'For developers';
export type Repo = 'official' | 'folder';

export interface Plugin {
  id: string;
  name: string;
  version: string;
  icon?: string;                 // inline SVG
  kinds: Kind[];
  repo: Repo;
  line: string;                  // one sentence
  adds: string[];                // what it adds to Playpex
  asks: string[];                // what it may do (its permissions, in plain words)
  site?: string;
}

export const KINDS: Kind[] = ['Films', 'Live TV', 'Your history', 'Ratings', 'For developers'];

export const REPOS: Record<Repo, { name: string; how: string }> = {
  official: { name: 'Official repository', how: 'Already in every server: open Plugins › Browse on the dashboard and press Install.' },
  folder: { name: 'From its folder', how: 'Copy its folder into the server’s plugins-dev folder and turn on developer mode on the dashboard’s Plugins page.' },
};

export const OFFICIAL_INDEX = 'https://ihebbelhadj.github.io/playpex-official/index.json';

export const PLUGINS: Plugin[] = [
  {
    id: 'trakt', name: 'Trakt', version: '1.0.0', icon: trakt, kinds: ['Your history', 'Ratings'], repo: 'official', site: 'https://trakt.tv',
    line: 'Scrobbles what you watch to Trakt and keeps your watch list, history and ratings in sync.',
    adds: ['What you watch is scrobbled as you watch it', 'Your watch list, history and ratings in sync, both ways', 'Trakt’s ratings on every title page', 'Rows from your Trakt lists'],
    asks: ['Talks to api.trakt.tv', 'Your Trakt app keys, kept on the server', 'Sees what each profile plays and saves', 'Writes to the watch list, watched and ratings of the profiles that allow it', 'Links your Trakt account', 'Runs on a schedule and can notify you'],
  },
  {
    id: 'm3u', name: 'Live TV (M3U)', version: '1.0.0', icon: live, kinds: ['Live TV'], repo: 'official',
    line: 'Your own IPTV channels from an M3U playlist, with their programme guide from XMLTV.',
    adds: ['Your playlist’s channels on every screen', 'The programme guide, now and next', 'Channel flipping in the player', 'A Live TV chip in Search'],
    asks: ['Reads the playlist and guide addresses you give it', 'Plays live and HLS streams through the server'],
  },
  {
    id: 'archive', name: 'Internet Archive', version: '1.0.0', kinds: ['Films'], repo: 'folder', site: 'https://archive.org',
    line: 'Public-domain and openly licensed films from the Internet Archive, found in Search and offered when you press Play.',
    adds: ['Films found by keywords in Search', 'Offered as a source when you press Play', 'Played and downloaded through the server'],
    asks: ['Talks to archive.org', 'Offers direct video files'],
  },
  {
    id: 'hello', name: 'Hello', version: '1.0.0', icon: hello, kinds: ['For developers'], repo: 'folder',
    line: 'The example plugin: every screen template, slot and setting, with made-up titles. Start your own from it.',
    adds: ['Every screen template and slot, filled', 'Every kind of setting', 'Events, a scheduled job, a linked account and notifications'],
    asks: ['Keeps 1 MB on the server', 'A made-up API token', 'Writes to the watch list of the profiles that allow it'],
  },
];
