import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { Schema } from '@playpex/protocol';
import { catchError, distinctUntilChanged, forkJoin, map, merge, Observable, of, shareReplay, switchMap, tap } from 'rxjs';
import { PlaybackService } from '../playback.service';
import { ProfilesService } from '../profiles.service';
import { ServerEvents } from '../server-events.service';
import { ServerService } from '../server.service';
import { CONTRIBUTIONS, defineContribution, Toasts } from '../ui/public-api';
import { NotificationService } from '../notification.service';
import { RemotePlugins } from '../plugins/remote';

export type LiveChannel = Schema<'LiveChannel'>;
export type LiveChannels = Schema<'LiveChannels'>;
export type LiveProgramme = Schema<'LiveProgramme'>;
export type LiveProvider = Schema<'LiveProvider'>;

/** The channels a channel was played from: ↑ / ↓ in the player flip through them */
export interface Lineup {
  plugin:string;
  name:string;
  guide:boolean;
  channels:LiveChannel[];
}

/** What plays now on a channel and after it */
export interface NowNext {
  now:LiveProgramme | null;
  next:LiveProgramme | null;
}

const GUIDE_BATCH = 200;

// Live TV from the server's plugins (docs/providers-plan.md §8, step 9;
// `<api>/live/*`): their channels (kept here per plugin and profile, asked
// again on `plugin.changed`), programmes, and playing a channel: the server
// asks the plugin for its stream at once (IPTV addresses expire) and answers a
// media ref the player plays like any plugin stream (hls / live), with
// nothing remembered (tracking none). It also adds a chip per live plugin to
// the search page (slot core.search.filters): its channels whose name matches.
@Injectable({
  providedIn: 'root'
})
export class LiveService {

  /** The last list a channel was played from (the guide's, a search's) */
  lineup:Lineup | null = null;
  private channelsCache = new Map<string, Observable<LiveChannels>>();
  private guideCache = new Map<string, Observable<LiveProgramme[]>>();
  private chips:string[] = [];
  private started = false;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private events:ServerEvents,
    private playback:PlaybackService,
    private toasts:Toasts,
    private notifications:NotificationService,
    private plugins:RemotePlugins,
  ) { }

  /** From AppComponent: the search chips of the live plugins, and the caches' lifetime */
  start() {
    if (this.started || !this.server.connected) return;
    this.started = true;
    merge(
      this.profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()),
      this.events.on('plugin.changed'),
    ).subscribe(() => this.forget());
    this.plugins.capabilities$.pipe(
      map(c => !!(c as { live?:boolean }).live),
      switchMap(live => live && this.profiles.current.value ? this.providers() : of([])),
    ).subscribe(providers => this.defineChips(providers));
  }

  private forget() {
    this.channelsCache.clear();
    this.guideCache.clear();
  }

  private params(extra:Record<string, string> = {}):Record<string, string> {
    let profile = this.profiles.current.value?.id;
    return { ...(profile ? { profile } : {}), ...extra };
  }

  /** The live plugins for the current profile */
  providers():Observable<LiveProvider[]> {
    return this.http.get<{ providers:LiveProvider[] }>(`${this.server.api}/live`, { params: this.params() }).pipe(
      map(a => a.providers || []),
      catchError(() => of([])),
    );
  }

  /** A live plugin's channels (all of them: groups and search filter here) */
  channels(plugin:string):Observable<LiveChannels> {
    let key = `${plugin} ${this.profiles.current.value?.id || ''}`;
    if (!this.channelsCache.has(key)) {
      let request = this.http.get<LiveChannels>(`${this.server.api}/live/${plugin}/channels`, { params: this.params() }).pipe(
        catchError(err => {
          this.channelsCache.delete(key);
          throw err;
        }),
        shareReplay(1),
      );
      this.channelsCache.set(key, request);
    }
    return this.channelsCache.get(key);
  }

  /** The programmes of these channels between `from` and `to` (batched by 200; failures answer none) */
  guide(plugin:string, ids:string[], from:Date, to:Date):Observable<LiveProgramme[]> {
    if (!ids.length) return of([]);
    let batches:string[][] = [];
    for (let i = 0; i < ids.length; i += GUIDE_BATCH) batches.push(ids.slice(i, i + GUIDE_BATCH));
    return forkJoin(batches.map(batch => {
      let key = `${plugin} ${from.toISOString()} ${to.toISOString()} ${batch.join(',')}`;
      if (!this.guideCache.has(key)) {
        this.guideCache.set(key, this.http.get<{ programmes:LiveProgramme[] }>(`${this.server.api}/live/${plugin}/guide`, {
          params: this.params({ channels: batch.join(','), from: from.toISOString(), to: to.toISOString() }),
        }).pipe(
          map(a => a.programmes || []),
          catchError(() => {
            this.guideCache.delete(key);
            return of([] as LiveProgramme[]);
          }),
          shareReplay(1),
        ));
      }
      return this.guideCache.get(key);
    })).pipe(map(lists => lists.flat()));
  }

  /** Now and next on each channel (the next 4 h): { id: NowNext } */
  nowNext(plugin:string, ids:string[]):Observable<Record<string, NowNext>> {
    let from = new Date(Math.floor(Date.now() / 1800000) * 1800000);
    let to = new Date(from.getTime() + 4 * 3600000);
    return this.guide(plugin, ids, from, to).pipe(map(list => {
      let out:Record<string, NowNext> = {};
      let now = Date.now();
      ids.forEach(id => out[id] = { now: null, next: null });
      list.forEach(p => {
        let slot = out[p.channel];
        if (!slot) return;
        let start = Date.parse(p.start), end = Date.parse(p.end);
        if (start <= now && end > now) slot.now = p;
        else if (start > now && (!slot.next || start < Date.parse(slot.next.start))) slot.next = p;
      });
      return out;
    }));
  }

  /** A logo's URL: an https one as it is, else the server's path */
  logo(channel:LiveChannel | null | undefined):string | null {
    let logo = channel?.logo;
    if (!logo) return null;
    return logo.startsWith('/') ? `${this.server.api}${logo}` : logo;
  }

  /**
   * Plays a channel in the player (over the current screen, or `replace`:
   * in place of the player, a channel flip). `lineup`: the list ↑ / ↓ flip through
   */
  play(plugin:string, channel:LiveChannel, options:{ lineup?:Lineup, replace?:boolean } = {}):Observable<boolean> {
    if (options.lineup) this.lineup = options.lineup;
    return this.http.post<{ channel:LiveChannel, source:{ ref:string, format:'hls' | 'live', label:string } }>(
      `${this.server.api}/live/${plugin}/channels/${encodeURIComponent(channel.id)}/play`, {}, { params: this.params() },
    ).pipe(
      tap(answer => this.playback.play({
        title: answer.channel.name,
        subtitle: [String(answer.channel.number), answer.channel.group].filter(Boolean).join(' · '),
        source: { ref: answer.source.ref, format: answer.source.format },
        tracking: 'none',
        channel: { plugin, id: answer.channel.id, number: answer.channel.number, name: answer.channel.name, logo: this.logo(answer.channel) },
      }, { replace: options.replace })),
      map(() => true),
      catchError(err => {
        let message = err?.error?.error || `${channel.name} can't play now`;
        if (options.replace) this.toasts.show({ text: `${channel.name} can't play now`, detail: message, tone: 'error', key: 'live' });
        else this.notifications.sendNotification('error', message);
        return of(false);
      }),
    );
  }

  /** The lineup's channel `step` away from `id` (wraps), or null */
  neighbour(id:string, step:number):LiveChannel | null {
    let list = this.lineup?.channels || [];
    let i = list.findIndex(c => c.id == id);
    if (i < 0 || list.length < 2) return null;
    return list[((i + step) % list.length + list.length) % list.length];
  }

  // ── the search page's chips ─────────────────────────────────────────────

  private defineChips(providers:LiveProvider[]) {
    this.chips.forEach(id => CONTRIBUTIONS.remove(id));
    this.chips = [];
    providers.forEach((p, i) => {
      let id = `core.live.search.${p.plugin}`;
      defineContribution({
        id,
        slot: 'core.search.filters',
        order: 200 + i,
        searchFilter: ctx => this.channels(p.plugin).pipe(
          map(answer => {
            let query = (ctx?.query || '').trim().toLowerCase();
            let words = query.split(/\s+/).filter(Boolean);
            let found = !words.length ? [] : answer.channels.filter(c => {
              let hay = `${c.name} ${c.number} ${c.group || ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
              return words.every(w => hay.some(h => h.startsWith(w)));
            }).slice(0, 100);
            let lineup:Lineup = { plugin: p.plugin, name: p.name, guide: p.guide, channels: found };
            return [{
              key: `live:${p.plugin}`,
              label: p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name,
              rows: found.length ? [{
                key: `live:${p.plugin}:channels`,
                title: 'Channels',
                variant: 'compact' as const,
                source: {
                  items: found.map(c => ({
                    key: c.id,
                    title: c.name,
                    subtitle: [String(c.number), c.group].filter(Boolean).join(' · '),
                    image: this.logo(c),
                    variant: 'compact' as const,
                    run: () => this.play(p.plugin, c, { lineup }).subscribe(),
                  })),
                },
              }] : [],
            }];
          }),
          catchError(() => of([])),
        ),
      });
      this.chips.push(id);
    });
  }
}
