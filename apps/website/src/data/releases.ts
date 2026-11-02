// The releases: each version, the files of each app, what changed. Newest first. Downloads go to the GitHub
// releases page (SITE.releases); file names are what people will find there.
import { SITE } from './site';

export type AppId = 'server' | 'tv' | 'mobile' | 'manager';
export type Os = 'Windows' | 'macOS' | 'Linux' | 'Android';
export const APPS: { id: AppId; name: string; page: string }[] = [
  { id: 'server', name: 'Playpex Media Server', page: 'server' },
  { id: 'tv', name: 'Playpex TV', page: 'tv' },
  { id: 'mobile', name: 'Playpex Mobile', page: 'mobile' },
  { id: 'manager', name: 'Server Manager', page: 'manager' },
];
export const OSES: Os[] = ['Windows', 'macOS', 'Linux', 'Android'];

export interface AppRelease { version: string; files: Partial<Record<Os, string[]>>; notes: string[] }
export interface Release { version: string; date: string; dateText: string; title: string; summary: string; apps: Partial<Record<AppId, AppRelease>> }

const desktop = (name: string, v: string, mac = '') => ({
  Windows: [`${name}-Setup-${v}.exe`], macOS: [`${name}-${v}${mac}.dmg`], Linux: [`${name}-${v}.AppImage`, `${name}_${v}_amd64.deb`],
});

export const RELEASES: Release[] = [
  {
    version: '0.10.1-alpha.1', date: '2026-11-01', dateText: '1 November 2026', title: 'Remote control',
    summary: 'The dashboard and your phone can now drive any screen in the house, and Server Manager arrives.',
    apps: {
      server: { version: '0.10.1-alpha.1', files: desktop('Playpex-Media-Server', '0.10.1-alpha.1'), notes: [
        'Remote control from the dashboard: play, pause, seek and stop on any screen, or take over its keyboard and pointer.',
        'Commands travel over a direct connection between the dashboard and the screen when the network allows it.',
      ] },
      tv: { version: '0.10.1-alpha.1', files: desktop('Playpex-TV', '0.10.1-alpha.1', '-arm64'), notes: [
        'Can be controlled from the dashboard or a phone; a badge and a drawn pointer show while it is.',
        'Remote control can be switched off for this screen in Settings.',
      ] },
      mobile: { version: '0.10.1-alpha.1', files: { Android: ['Playpex-0.10.1-alpha.1-arm64.apk'] }, notes: [
        'The phone is a remote for any screen: a touchpad, the arrows, OK and Back, and typing.',
      ] },
      manager: { version: '0.10.1-alpha.1', files: { Android: ['Playpex-Server-Manager-0.10.1-alpha.1.apk'] }, notes: [
        'First release. Finds the Playpex server on your Wi-Fi by itself and opens its dashboard on your phone.',
        'The remote for every screen in the house, with a touchpad and the arrows.',
      ] },
    },
  },
  {
    version: '0.10.0-alpha.1', date: '2026-10-30', dateText: '30 October 2026', title: 'First alpha',
    summary: 'The server and its apps, separate for the first time: a library of your folders, downloads, plugins, live TV and a phone app.',
    apps: {
      server: { version: '0.10.0-alpha.1', files: { Windows: ['Playpex-Media-Server-Setup-0.9.0.exe'] }, notes: [
        'A library of your folders: every file matched to its title, poster and story, with fixes for wrong matches.',
        'Downloads as a full torrent client: a queue, per-download rules and speed limits, three engines to choose from.',
        'Plugins: sources, live TV, ratings and more from signed repositories, each running in a sandbox.',
        'Live TV with a programme guide, from your own M3U playlist.',
        'One search for everything the server can reach, and pasted links read by the server.',
        'A DLNA server for the TVs on your network, and the name playpex.local.',
      ] },
      tv: { version: '0.10.0-alpha.1', files: { Windows: ['Playpex-TV-Setup-0.9.0.exe'] }, notes: [
        'Play opens a chooser: files on this server, streams and torrents, each with how soon it plays.',
        'Every audio track and subtitle of a file can be switched in the player.',
        'A Library section for what is on the server, and search with the on-screen keyboard.',
        'Choose how big Playpex looks on this screen.',
      ] },
      mobile: { version: '0.1.0-alpha.1', files: { Android: ['Playpex-0.1.0-alpha.1-x86_64.apk'] }, notes: [
        'First release. Your library on your phone; files play as they are, with every audio track and subtitle.',
      ] },
    },
  },
];

// every file is on the GitHub releases page (one release per app and version there)
export const releaseUrl = (_app: AppId, _version: string) => SITE.releases;
