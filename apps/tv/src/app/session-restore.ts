import { Location } from '@angular/common';
import { Injector } from '@angular/core';
import { distinctUntilChanged, firstValueFrom, map, skip, timeout } from 'rxjs';
import { PositionStore, Position } from './movement/position-store.service';
import { Entry, FocusSnapshot } from './nav/screen';
import { Navigator } from './nav/navigator.service';
import { RemotePlugins } from './plugins/remote';
import { Profile, ProfilesService } from './profiles.service';
import { connection } from './server-config';
import { SplashService } from './splash.service';

// A reload (a browser's refresh, Electron's Ctrl+R) comes back where it was:
// the profile watching, the history (Back still works) and where each row
// was. Kept in sessionStorage: this tab only, gone when it closes (a new tab
// or the next start shows "Who's watching?"), never the server's data. A
// locked profile comes back only if the server says this device opened it
// lately (POST /profiles/{id}/resume), else the picker.

const KEY = 'playpex.session';
const LOG_KEY = 'playpex.session.restore';
// ms the boot waits for the server: a second, longer try when it's slow (a
// stream it's still busy with), before the picker
const RESUME_TIMEOUTS = [4000, 8000];
const PLUGINS_TIMEOUT = 8000;

// What the restore decided and why, in the console and kept for this tab
// (sessionStorage['playpex.session.restore']): a reload that ends on the
// picker says here which step stopped it
function note(step:string, detail?:unknown) {
  console.info('[restore]', step, detail === undefined ? '' : detail);
  try {
    sessionStorage.setItem(LOG_KEY, JSON.stringify({ at: new Date().toISOString(), step, detail: detail ?? null }));
  } catch (e) { }
}

// A path as compared: decoded, no trailing slash or index.html
function samePath(url:string | null | undefined):string {
  let path = (url || '').split(/[?#]/)[0].replace(/\/?index\.html$/, '').replace(/\/+$/, '');
  try {
    path = decodeURIComponent(path);
  } catch (e) { }
  return path;
}

interface SavedEntry {
  id: number;
  screen: string;
  params: Record<string, any>;
  payload?: unknown;
  state?: Record<string, any>;
  focus?: FocusSnapshot;
  lost?: boolean;
}

interface Saved {
  server: string;
  profile: string;
  url: string;                      // the top entry's, where the reload happens
  stack: SavedEntry[];
  positions: [string, Position][];
}

// What a screen adds just before the session is written as the page goes (the
// player: where it was in the video, into its entry's state)
const beforeSave = new Set<() => void>();

export function onSessionSave(fn:() => void):() => void {
  beforeSave.add(fn);
  return () => beforeSave.delete(fn);
}

function read():Saved | null {
  try {
    let saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return saved && typeof saved.profile == 'string' && Array.isArray(saved.stack) ? saved : null;
  } catch (e) {
    return null;
  }
}

function write(saved:Saved | null) {
  try {
    if (saved) sessionStorage.setItem(KEY, JSON.stringify(saved));
    else sessionStorage.removeItem(KEY);
  } catch (e) { /* not kept: a reload starts over */ }
}

const MAX_STATE = 16 * 1024;        // characters of JSON per state key

// Data only: no functions, class instances, elements or cycles (a plugin
// page's models carry their actions; JSON would keep them without them)
function isData(value:unknown, depth = 0):boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (typeof value != 'object' || depth > 20) return false;
  if (Array.isArray(value)) return value.every(v => isData(v, depth + 1));
  let proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every(v => v === undefined || isData(v, depth + 1));
}

// An entry's state, the keys that are small data (the rest is built again)
function keptState(state:Record<string, any>):Record<string, any> | undefined {
  let kept:Record<string, any> = {};
  Object.keys(state || {}).forEach(key => {
    if (!isData(state[key])) return;
    let json = JSON.stringify(state[key]);
    if (json !== undefined && json.length <= MAX_STATE) kept[key] = JSON.parse(json);
  });
  return Object.keys(kept).length ? kept : undefined;
}

// The JSON copy of a value, or undefined when it has none (cycles, elements)
function plain(value:unknown):unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return undefined;
  }
}

function restorable(entry:Entry):boolean {
  let screen = entry.screen;
  if (screen.restore !== undefined) return screen.restore;
  return screen.kind == 'section' || screen.kind == 'detail';
}

function serverId():string {
  return connection?.server?.id || connection?.server?.url || '';
}

// APP_INITIALIZER: before the first navigation
export function restoreSession(injector:Injector):() => Promise<void> {
  return async () => {
    let saved = read();
    try {
      if (!saved) note('nothing saved in this tab');
      else if (saved.server != serverId()) note('saved for another server', { saved: saved.server, now: serverId() });
      else await resume(injector, saved);
    } catch (e) {
      note('failed', String(e?.message || e));
    }
    unknownPluginAddress(injector);
    remember(injector);
  };
}

async function resume(injector:Injector, saved:Saved) {
  let navigator = injector.get(Navigator);
  let location = injector.get(Location);

  // the profile first: whatever else, a reload doesn't end on the picker
  let profile = await resumeProfile(injector, saved.profile);
  if (!profile) return;
  injector.get(ProfilesService).current.next(profile);

  // where the page was reloaded: the saved top (a browser), the app's start
  // (Electron reloads index.html); another address typed in the tab opens
  // there, with the profile, without the history
  let here = samePath(location.path());
  let elsewhere = !!here && here != samePath(saved.url);

  // plugins' screens exist once the server said what the profile gets: asked
  // now (their routes too), before the first navigation needs them: for the
  // history, or for a plugin's address opened as it is (else NG04002, blank)
  if (saved.stack.some(e => e.screen.startsWith('plugin.')) || here.startsWith('/p/')) {
    let answered = await firstValueFrom(injector.get(RemotePlugins).reload().pipe(timeout(PLUGINS_TIMEOUT))).catch(() => null);
    if (!answered) note('the plugins didn\'t answer: their screens are left out');
  }

  if (elsewhere) {
    note('opened at another address: the profile only', { here, saved: saved.url });
    return;
  }

  // the entries a reload brings back. The root stays the root (a section, or
  // what a menu entry opened, e.g. a plugin's last view): without it (the
  // picker, /connect) nothing is
  let entries = saved.stack.map(s => s.lost ? null : navigator.restoredEntry({ ...s, state: keptState(s.state) }));
  if (!entries[0] || !restorable(entries[0])) {
    note('the history\'s first screen can\'t come back: the profile only', saved.stack[0]?.screen);
    return;
  }
  let stack = entries.filter((e):e is Entry => !!e && restorable(e));
  let left = saved.stack.filter((s, i) => !entries[i] || !restorable(entries[i])).map(s => s.screen);

  // after the profile: PositionStore starts over when the profile changes
  let kept = new Set(stack.map(e => e.screen.kind == 'section' ? '' : `e${e.id}:`));
  let scopeOf = (key:string) => (/^e\d+:/.exec(key) || [''])[0];
  injector.get(PositionStore).load((saved.positions || []).filter(([key]) => kept.has(scopeOf(key))));

  let top = stack[stack.length - 1];
  navigator.prime(stack);
  location.replaceState(navigator.urlFor({ screen: top.screen.id, params: top.params }));
  injector.get(SplashService).skip = true;
  note('restored', { stack: stack.map(e => e.screen.id), leftOut: left });
}

// A plugin's address the router can't know yet (a new tab, no profile, the
// plugins not answering, a plugin gone): its routes only exist once the
// server listed the profile's plugins, and an address no route matches is a
// blank app (NG04002). Home with a profile, else the picker
function unknownPluginAddress(injector:Injector) {
  let location = injector.get(Location);
  let path = samePath(location.path());
  if (!path.startsWith('/p/') || injector.get(Navigator).registry.match(path)) return;
  let profile = injector.get(ProfilesService).current.value;
  note('a plugin\'s address that isn\'t there', path);
  location.replaceState(profile ? '/home/list' : '/profiles');
}

// POST /profiles/{id}/resume, tried again with more time when the server is
// slow; a refusal (a PIN, a profile gone) is final
async function resumeProfile(injector:Injector, id:string):Promise<Profile | null> {
  for (let wait of RESUME_TIMEOUTS) {
    try {
      return await firstValueFrom(injector.get(ProfilesService).resume(id).pipe(timeout(wait)));
    } catch (e) {
      let status = e?.status;
      if (status == 403 || status == 404) {
        note(status == 403 ? 'the profile needs its PIN again' : 'the profile is gone', id);
        return null;
      }
      note('the server didn\'t answer in time', { waitedMs: wait, error: String(e?.message || e) });
    }
  }
  return null;
}

// From now on: what a reload needs, on every navigation and as the page goes
function remember(injector:Injector) {
  let navigator = injector.get(Navigator);
  let profiles = injector.get(ProfilesService);
  let positions = injector.get(PositionStore);

  let save = () => {
    let profile = profiles.current.value;
    let top = navigator.current;
    if (!profile || !top) return write(null);
    write({
      server: serverId(),
      profile: profile.id,
      url: navigator.urlFor({ screen: top.screen.id, params: top.params }),
      stack: navigator.stack.map(e => ({
        id: e.id,
        screen: e.screen.id,
        params: e.params,
        payload: restorable(e) && isData(e.payload) ? plain(e.payload) : undefined,
        // what it was opened with can't be written down: not brought back
        lost: e.payload !== undefined && !isData(e.payload) || undefined,
        state: restorable(e) ? keptState(e.state) : undefined,
        focus: e.focus,
      })),
      positions: positions.all(),
    });
  };

  navigator.stack$.pipe(skip(1)).subscribe(save);
  profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged(), skip(1)).subscribe(save);
  window.addEventListener('pagehide', () => {
    navigator.saveFocus();
    beforeSave.forEach(fn => { try { fn(); } catch (e) { } });
    save();
  });
}
