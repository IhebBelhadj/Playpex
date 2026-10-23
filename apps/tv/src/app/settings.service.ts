import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, distinctUntilChanged, map, Observable, Subscription } from 'rxjs';
import { defaults, SETTINGS, validate } from '@playpex/protocol/settings';
import type { SettingKey, SettingScope, SettingValues } from '@playpex/protocol/settings';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { applySafeArea, display, saveUiScale, Toasts } from './ui/public-api';

type Values = { [key:string]:unknown };

export interface SetOptions {
  /** write after this long without another change (sliders); the value applies at once */
  debounceMs?:number;
}

// Values a client kept in localStorage before settings lived on the server
// (docs/settings-plan.md §7): pushed once when the server still has the
// default, then removed
const LEGACY:{ storage:string, key:SettingKey, parse:(raw:string) => unknown }[] = [
  { storage: 'playpex.subtitleSize', key: 'subtitles.size', parse: raw => raw },
  { storage: 'playpex.volumePercent', key: 'player.volume', parse: raw => Number(raw) },
  { storage: 'playpex.subtitleProvider', key: 'subtitles.provider', parse: raw => raw || null },
  // the first start's screen edges (ui/display.ts saveSafeArea), before any server
  { storage: 'playpex.safeArea', key: 'display.safeArea', parse: raw => Number(raw) },
];

// The user's settings (docs/settings-plan.md, docs/api/settings.md): stored on
// the server, per device (UI size, screen edges, volume, subtitle size) or per
// profile (subtitle source, autoplay). Every key always has a
// value: the registry's default (@playpex/protocol/settings) until the server
// answers, then the server's effective value. Read again when the profile
// changes and when another client changes them (`settings.changed`).
//
//   settings.value('player.volume')                     now
//   settings.changes('subtitles.size').subscribe(…)     now and on every change
//   settings.set('player.volume', 40, { debounceMs: 500 })
//
// set() is optimistic: the value applies at once; a refused write puts the
// previous one back and says so in a toast.
@Injectable({
  providedIn: 'root'
})
export class SettingsService {

  private values$ = new BehaviorSubject<Values>({ ...defaults('device'), ...defaults('profile') });
  /** true once the server answered for the current profile */
  readonly loaded$ = new BehaviorSubject<boolean>(false);
  private profileId:string | null = null;
  private pending = new Map<string, { timer:any, previous:unknown }>();
  private loadSub:Subscription | null = null;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private events:ServerEvents,
    private toasts:Toasts,
  ) {
    if (!server.connected) return;
    this.profiles.current.pipe(map(p => p?.id ?? null), distinctUntilChanged()).subscribe(id => {
      this.profileId = id;
      this.load();
    });
    this.events.on<{ scope:SettingScope, ownerId:string, keys:string[] }>('settings.changed').subscribe(e => {
      let mine = e.data.scope == 'device' ? e.data.ownerId == this.server.deviceId : e.data.ownerId == this.profileId;
      // a key being written from here wins over the echo of an older write
      if (mine && !e.data.keys.some(k => this.pending.has(k))) this.load();
    });
    this.changes('display.safeArea').subscribe(f => applySafeArea(f));
  }

  value<K extends SettingKey>(key:K):SettingValues[K] {
    return this.values$.value[key] as SettingValues[K];
  }

  changes<K extends SettingKey>(key:K):Observable<SettingValues[K]> {
    return this.values$.pipe(map(v => v[key] as SettingValues[K]), distinctUntilChanged());
  }

  set<K extends SettingKey>(key:K, value:SettingValues[K], options:SetOptions = {}) {
    let definition = SETTINGS[key];
    let problem = validate(key, value, definition.scope);
    if (problem) {
      console.error(`setting ${key}: ${problem}`);
      return;
    }
    let previous = this.pending.get(key)?.previous ?? this.values$.value[key];
    clearTimeout(this.pending.get(key)?.timer);
    this.values$.next({ ...this.values$.value, [key]: value });
    if (!this.server.connected || (definition.scope == 'profile' && !this.profileId)) return;
    let timer = options.debounceMs ? setTimeout(() => this.write(key, previous), options.debounceMs) : null;
    this.pending.set(key, { timer, previous });
    if (!timer) this.write(key, previous);
  }

  /** The server's answer again (after a failed write, another client's change) */
  load() {
    if (!this.server.connected) return;
    let profileId = this.profileId;
    let params:{ [p:string]:string } = { ...this.server.deviceParams() };
    if (profileId) params['profile'] = profileId;
    this.loadSub?.unsubscribe();
    this.loadSub = this.http.get<{ device:Values, profile:Values | null }>(`${this.server.api}/settings`, { params }).subscribe({
      next: answer => {
        if (profileId != this.profileId) return;
        let next:Values = { ...defaults('device'), ...answer.device, ...defaults('profile'), ...(answer.profile || {}) };
        // keys being written keep the value they're being written with
        this.pending.forEach((_, key) => next[key] = this.values$.value[key]);
        this.values$.next(next);
        this.loaded$.next(true);
        this.adoptLocal();
        this.syncUiScale();
      },
      error: err => console.error('settings: ', err?.message || err),
    });
  }

  private write(key:SettingKey, previous:unknown) {
    let scope = SETTINGS[key].scope;
    let value = this.values$.value[key];
    let url = scope == 'device' ? `${this.server.api}/settings/device` : `${this.server.api}/profiles/${this.profileId}/settings`;
    this.http.patch<Values>(url, { [key]: value }, { params: this.server.deviceParams() }).subscribe({
      next: () => {
        // a newer change of the same key may be waiting: it owns the entry then
        if (this.pending.get(key)?.timer == null || this.values$.value[key] === value) this.pending.delete(key);
      },
      error: err => {
        this.pending.delete(key);
        if (this.values$.value[key] === value) this.values$.next({ ...this.values$.value, [key]: previous });
        this.toasts.show({
          text: "Couldn't save the setting",
          detail: err?.status === 0 ? "The server didn't answer." : (err?.error?.error || 'The server refused it.'),
          tone: 'error',
          key: 'settings',
        });
      },
    });
  }

  // localStorage values from before (docs/settings-plan.md §7), once per device
  private adoptLocal() {
    for (let legacy of LEGACY) {
      let raw:string | null = null;
      try { raw = localStorage.getItem(legacy.storage); } catch (e) { return; }
      if (raw === null) continue;
      let definition = SETTINGS[legacy.key];
      // profile keys wait for a profile
      if (definition.scope == 'profile' && !this.profileId) continue;
      let value = legacy.parse(raw);
      if (this.values$.value[legacy.key] === definition.default && value !== definition.default
        && !validate(legacy.key, value, definition.scope)) {
        this.set(legacy.key, value as any);
      }
      try { localStorage.removeItem(legacy.storage); } catch (e) { }
    }
  }

  // UI size: client.json is the boot cache (the UI needs a size before any
  // server answers); the server is the source once connected (decision A)
  private syncUiScale() {
    let stored = this.value('display.uiScale');
    let fallback = SETTINGS['display.uiScale'].default;
    if (stored === fallback) {
      // nothing stored there yet (or the default): this device's choice goes up
      if (display.chosen && display.scale !== fallback) this.set('display.uiScale', display.scale as SettingValues['display.uiScale']);
    } else if (stored !== display.scale) {
      saveUiScale(stored).catch(err => console.error('UI scale: ', err));
    }
  }
}
