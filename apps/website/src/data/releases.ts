// The releases: each version, the files of each app, what changed. Newest first. Each app's version is a GitHub
// release of its own (`tag`); every file links straight to its download there.
import { SITE, assetUrl } from './site';

export type AppId = 'server' | 'tv' | 'mobile' | 'manager';
export type Os = 'Windows' | 'macOS' | 'Linux' | 'Android';
export const APPS: { id: AppId; name: string; page: string }[] = [
  { id: 'server', name: 'Playpex Media Server', page: 'server' },
  { id: 'tv', name: 'Playpex TV', page: 'tv' },
  { id: 'mobile', name: 'Playpex Mobile', page: 'mobile' },
  { id: 'manager', name: 'Server Manager', page: 'manager' },
];
export const OSES: Os[] = ['Windows', 'macOS', 'Linux', 'Android'];

export interface AppRelease { version: string; tag: string; files: Partial<Record<Os, string[]>>; notes: string[] }
export interface Release { version: string; date: string; dateText: string; title: string; summary: string; apps: Partial<Record<AppId, AppRelease>> }

// a desktop app's files as electron-builder names them (macOS: none built yet)
const desktop = (name: string, v: string) => ({
  Windows: [`${name}-Setup-${v}.exe`], Linux: [`${name}-${v}-x86_64.AppImage`, `${name}-${v}-amd64.deb`],
});

export const RELEASES: Release[] = [
  {
    version: '0.11.0-beta.1', date: '2026-11-14', dateText: '14 November 2026', title: 'Cast, Home and people',
    summary: 'Send what you are watching to any screen, a Home made from what each profile watches, Stremio add-ons as plugins, and a page for every actor.',
    apps: {
      server: { version: '0.11.0-beta.1', tag: 'server-v0.11.0-beta.1', files: desktop('Playpex-Media-Server', '0.11.0-beta.1'), notes: [
        'Cast to any Playpex screen from the dashboard, or move what plays in its player to a screen with “Continue on a screen”.',
        'Playpex screens can show up in the YouTube app’s Cast list (Settings › Casting, off at first).',
        'Stremio add-ons install by their address and work as plugins: their streams in Play, their subtitles, their catalogs as rows. Your Stremio account’s add-ons can be imported at once.',
        'The rows of Home, Movies and TV shows are set on the server, for everyone or per profile, with recommendations from what each profile watches.',
        'Videos stored in rar, zip and tar archives play like any other file.',
        'People in Search, each with a page of their films and shows by role.',
      ] },
      tv: { version: '0.11.0-beta.1', tag: 'tv-v0.11.0-beta.1', files: desktop('Playpex-TV', '0.11.0-beta.1'), notes: [
        'A Home section, where the app now opens: Continue watching, For you, Because you watched, and the rows you choose.',
        'Rows can be moved or hidden with the menu key, or in Settings › Rows.',
        'Every actor has a page: open it from a cast card or a search result.',
        'Show and episode pages have the cast, every season and similar shows.',
        'The screen plays what a phone or the dashboard casts to it, and the player can send what plays to another screen.',
        'With the mouse, Back shows where it goes, beside the clock; page titles line up with the clock; a new power screen.',
      ] },
      mobile: { version: '0.11.0-beta.1', tag: 'android-v0.11.0-beta.1', files: { Android: ['Playpex-0.11.0-beta.1-arm64.apk', 'Playpex-0.11.0-beta.1-x86_64.apk'] }, notes: [
        'Cast to any Playpex screen, with a mini player and a remote; bring it back with “Continue on phone”.',
        'Share to Playpex from any app: a link, a video or a YouTube video opens on your phone or goes straight to a screen.',
        'People in search, each with a page of their films and shows.',
      ] },
      manager: { version: '0.11.0-beta.1', tag: 'manager-v0.11.0-beta.1', files: { Android: ['Playpex-Server-Manager-0.11.0-beta.1.apk'] }, notes: [
        'The phone’s volume buttons change the volume of the screen you are controlling.',
        'When a screen opens a text field, your phone’s own keyboard types into it.',
      ] },
    },
  },
  {
    version: '0.10.1-alpha.1', date: '2026-11-05', dateText: '5 November 2026', title: 'Remote control',
    summary: 'The dashboard and your phone can now drive any screen in the house, and Server Manager arrives.',
    apps: {
      server: { version: '0.10.1-alpha.1', tag: 'server-v0.10.1-alpha.1', files: desktop('Playpex-Media-Server', '0.10.1-alpha.1'), notes: [
        'Remote control from the dashboard: play, pause, seek and stop on any screen, or take over its keyboard and pointer.',
        'Commands travel over a direct connection between the dashboard and the screen when the network allows it.',
      ] },
      tv: { version: '0.10.1-alpha.1', tag: 'tv-v0.10.1-alpha.1', files: desktop('Playpex-TV', '0.10.1-alpha.1'), notes: [
        'Can be controlled from the dashboard or a phone; a badge and a drawn pointer show while it is.',
        'Remote control can be switched off for this screen in Settings.',
        'Settings has an About page with this app’s version and its licence.',
      ] },
      mobile: { version: '0.10.1-alpha.1', tag: 'android-v0.10.1-alpha.1', files: { Android: ['Playpex-0.10.1-alpha.1-arm64.apk', 'Playpex-0.10.1-alpha.1-x86_64.apk'] }, notes: [
        'The phone is a remote for any screen: a touchpad, the arrows, OK and Back, and typing.',
      ] },
      manager: { version: '0.10.1-alpha.1', tag: 'manager-v0.10.1-alpha.1', files: { Android: ['Playpex-Server-Manager-0.10.1-alpha.1.apk'] }, notes: [
        'First release. Finds the Playpex server on your Wi-Fi by itself and opens its dashboard on your phone.',
        'The remote for every screen in the house, with a touchpad and the arrows.',
      ] },
    },
  },
  {
    version: '0.10.0-alpha.1', date: '2026-10-30', dateText: '30 October 2026', title: 'First alpha',
    summary: 'The server and its apps, separate for the first time: a library of your folders, downloads, plugins, live TV and a phone app.',
    apps: {
      server: { version: '0.10.0-alpha.1', tag: 'server-v0.10.0-alpha.1', files: { Windows: ['Playpex-Media-Server-Setup-0.9.0.exe'] }, notes: [
        'A library of your folders: every file matched to its title, poster and story, with fixes for wrong matches.',
        'Downloads as a full torrent client: a queue, per-download rules and speed limits, three engines to choose from.',
        'Plugins: sources, live TV, ratings and more from signed repositories, each running in a sandbox.',
        'Live TV with a programme guide, from your own M3U playlist.',
        'One search for everything the server can reach, and pasted links read by the server.',
        'A DLNA server for the TVs on your network, and the name playpex.local.',
      ] },
      tv: { version: '0.10.0-alpha.1', tag: 'client-v0.10.0-alpha.1', files: { Windows: ['Playpex-TV-Setup-0.9.0.exe'] }, notes: [
        'Play opens a chooser: files on this server, streams and torrents, each with how soon it plays.',
        'Every audio track and subtitle of a file can be switched in the player.',
        'A Library section for what is on the server, and search with the on-screen keyboard.',
        'Choose how big Playpex looks on this screen.',
      ] },
      mobile: { version: '0.1.0-alpha.1', tag: 'android-v0.1.0-alpha.1', files: { Android: ['Playpex-0.1.0-alpha.1-x86_64.apk'] }, notes: [
        'First release. Your library on your phone; files play as they are, with every audio track and subtitle.',
      ] },
    },
  },
];

// a file of an app's release, downloaded directly
export const fileUrl = (ar: AppRelease, file: string) => assetUrl(ar.tag, file);
