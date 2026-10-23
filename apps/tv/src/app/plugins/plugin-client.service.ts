import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, EMPTY, map, Observable, of, Subject, tap, throwError } from 'rxjs';
import { DownloadRef, DownloadsService } from '../downloads.service';
import { Navigator } from '../nav/public-api';
import { PlaybackRequest, PlaybackService } from '../playback.service';
import { ProfilesService } from '../profiles.service';
import { ServerService } from '../server.service';
import { formatBytes, TorrentOption, TorrentPickerService } from '../torrent-picker.service';
import {
  ActionModel, CardModel, Dialogs, MetaItem, RowModel, RowPage, TitleInfoModel, Toasts,
} from '../ui/public-api';
import {
  PluginAction, PluginAnswer, PluginCall, PluginCard, PluginEffect, PluginIntent, PluginMetaItem, PluginPlayRequest,
  PluginRelease, PluginRow, PluginRowPage, PluginScope, PluginSource, PluginTitleInfo,
} from './plugin-models';

// The core's side of a packaged plugin (docs/plugins-plan.md §5.3): calls its
// data handlers (`POST <api>/plugins/{id}/data/{name}` for the current
// profile), turns what it answers into the UI system's view models (images
// and icons of its package resolved, `call`s bound to this service) and
// performs the effects it asks for: open a screen, play, a toast, refresh a
// screen or slot, confirm then do something, download. Nothing the plugin
// sends runs as code here.
@Injectable({
  providedIn: 'root'
})
export class PluginClient {

  /** `refresh` effects: the plugin's open screen ('screen') or one of its slots */
  readonly refresh$ = new Subject<{ plugin:string, target:string }>();

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private navigator:Navigator,
    private playback:PlaybackService,
    private picker:TorrentPickerService,
    private downloads:DownloadsService,
    private dialogs:Dialogs,
    private toasts:Toasts,
  ) { }

  /** One handler's answer; effects are the caller's to perform */
  data<T>(plugin:string, name:string, args:Record<string, unknown> = {}):Observable<PluginAnswer<T>> {
    let profile = this.profiles.current.value?.id;
    return this.http.post<PluginAnswer<T>>(`${this.server.api}/plugins/${plugin}/data/${name}`, { args },
      { params: profile ? { profile } : {} });
  }

  /** A `call` (an action, a card, a list item, a confirm's `then`): its effects performed, its data passed on */
  call<T = unknown>(scope:PluginScope, call:PluginCall, extra:Record<string, unknown> = {}):Observable<T | null> {
    return this.data<T>(scope.id, call.data, { ...(call.args || {}), ...extra }).pipe(
      tap(answer => this.perform(scope, answer.effects)),
      map(answer => answer.data),
      catchError(err => {
        this.failed(scope, err);
        return throwError(() => err);
      }),
    );
  }

  /** Runs a call for its effects only (Enter on a tile, a card, a list item) */
  run(scope:PluginScope, call:PluginCall) {
    this.call(scope, call).subscribe({ error: () => { } });
  }

  failed(scope:PluginScope, err:any) {
    let busy = err?.status == 429;
    this.toasts.show({
      text: busy ? `${scope.name} is busy` : `${scope.name} didn't answer`,
      detail: busy ? 'Try again in a moment.' : undefined,
      tone: 'error',
      key: `plugin:${scope.id}`,
    });
  }

  // ── effects ─────────────────────────────────────────────────────────────

  perform(scope:PluginScope, effects:PluginEffect[] | null | undefined) {
    for (let effect of effects || []) {
      switch (effect.type) {
        case 'open': this.open(scope, effect.intent); break;
        case 'play': this.play(scope, effect.request); break;
        case 'toast': this.toasts.show({ text: effect.text, tone: effect.tone || 'info', key: `plugin:${scope.id}` }); break;
        case 'refresh': this.refresh$.next({ plugin: scope.id, target: effect.target }); break;
        case 'confirm': {
          let then = effect.then;
          this.dialogs.confirm({ title: effect.question, confirm: effect.yes || 'OK', cancel: effect.no || 'Cancel' })
            .subscribe(yes => {
              if (!yes) return;
              if (then.type == 'call') this.run(scope, (then as { call:PluginCall }).call);
              else this.perform(scope, [then as PluginEffect]);
            });
          break;
        }
        case 'download': this.download(effect.request); break;
      }
    }
  }

  /** A plugin's intent: its own screens, or the core's title / search screens the server allowed */
  open(scope:PluginScope, intent:PluginIntent) {
    if (!this.navigator.registry.has(intent.screen)) {
      this.toasts.show({ text: `${scope.name} can't show that here`, tone: 'error', key: `plugin:${scope.id}` });
      return;
    }
    let params:Record<string, string> = {};
    Object.entries(intent.params || {}).forEach(([k, v]) => params[k] = String(v));
    this.navigator.open({ screen: intent.screen, params });
  }

  /**
   * The core player for a play effect (or a release of a releases screen):
   * one source plays at once, several open the source picker. Adults
   * plugins and `tracking: 'none'` play without touching the profile's
   * library (no resume point, history, Continue watching)
   */
  play(scope:PluginScope, request:PluginPlayRequest) {
    let base:PlaybackRequest = { title: request.title, subtitle: request.subtitle };
    let untracked = scope.adults || request.tracking == 'none';
    let ref = request.ref;
    if (untracked) base.adult = true;
    else if (ref?.tmdbId && ref.kind != 'video') {
      base.mediaType = ref.kind == 'movie' ? 'movie' : 'tv';
      base.tmdbId = ref.tmdbId;
      if (ref.imdbId) base.imdbId = ref.imdbId;
      if (ref.kind == 'episode') {
        base.season = ref.season;
        base.episode = ref.episode;
      }
    }
    if (ref?.year) base.year = String(ref.year);
    let go = (source:PluginSource) => this.playback.play({ ...base, ...target(source) });
    if (request.sources.length == 1) return go(request.sources[0]);
    this.picker.choose(request.title, request.sources.map(sourceOption), 'Choose a source')
      .subscribe(option => go(option.torrent));
  }

  /** Enter on a release of a releases screen: plays it when the plugin may hand play requests to the core */
  playRelease(scope:PluginScope, release:PluginRelease, title?:string) {
    if (!scope.play) {
      this.toasts.show({ text: `${scope.name} can't start playback`, tone: 'error', key: `plugin:${scope.id}` });
      return;
    }
    let source:PluginSource = { kind: 'magnet', magnet: release.magnet, infoHash: release.infoHash, label: release.title };
    this.play(scope, { title: title || release.title, subtitle: title ? release.title : undefined, sources: [source] });
  }

  private download(request:{ title:string, ref?:any, source:PluginSource }) {
    let link = linkOf(request.source);
    if (!link) return;
    let ref = request.ref?.tmdbId && request.ref.kind != 'video' ? {
      mediaType: request.ref.kind == 'movie' ? 'movie' : 'tv',
      tmdbId: request.ref.tmdbId,
      ...(request.ref.kind == 'episode' ? { season: request.ref.season, episode: request.ref.episode } : {}),
    } as DownloadRef : null;
    this.downloads.add(link, ref, request.title).subscribe({
      next: () => this.toasts.show({ text: `Downloading ${request.title}`, tone: 'success', key: 'download' }),
      error: () => this.toasts.show({ text: `Couldn't download ${request.title}`, tone: 'error', key: 'download' }),
    });
  }

  // ── view models ─────────────────────────────────────────────────────────

  /** assets/… of the package → its URL on the server; https URLs as they are; else null */
  asset(plugin:string, path:string | null | undefined):string | null {
    if (!path) return null;
    if (/^assets\/[\w./-]+$/.test(path) && !path.includes('..')) return `${this.server.api}/plugins/${plugin}/${path}`;
    if (/^https:\/\//.test(path)) return path;
    return null;
  }

  /** A core icon name, or an asset of the package */
  icon(plugin:string, icon:string | undefined):string {
    if (icon && /^[a-z][a-z0-9-]*$/.test(icon)) return icon;
    return this.asset(plugin, icon) || 'opts';
  }

  card(scope:PluginScope, c:PluginCard):CardModel {
    return {
      key: c.key,
      title: c.title,
      variant: c.variant,
      image: this.asset(scope.id, c.image),
      subtitle: c.subtitle,
      badges: c.badges,
      progress: c.progress,
      rating: c.rating ? { source: 'provider', value: c.rating.value } : null,
      intent: c.intent ? { screen: c.intent.screen, params: c.intent.params } : undefined,
      run: c.call ? () => this.run(scope, c.call) : c.intent ? () => this.open(scope, c.intent) : undefined,
      info: c.info ? this.info(scope, c.info) : undefined,
    };
  }

  row(scope:PluginScope, r:PluginRow):RowModel {
    let page = r.page;
    return {
      key: r.key,
      title: r.title,
      variant: r.variant,
      source: page
        ? { page: (n:number) => this.rowPage(scope, page, n) }
        : { items: (r.items || []).map(c => this.card(scope, c)) },
    };
  }

  rowPage(scope:PluginScope, page:PluginCall, n:number):Observable<RowPage> {
    return this.data<PluginRowPage>(scope.id, page.data, { ...(page.args || {}), page: n }).pipe(
      map(answer => ({
        items: (answer.data?.items || []).map(c => this.card(scope, c)),
        last: answer.data ? !!answer.data.last : true,
      })),
    );
  }

  action(scope:PluginScope, a:PluginAction):ActionModel {
    return {
      key: a.key,
      label: a.label,
      icon: this.icon(scope.id, a.icon),
      on: a.on,
      progress: a.progress,
      disabled: a.disabled,
      run: a.call ? () => this.run(scope, a.call) : a.intent ? () => this.open(scope, a.intent) : undefined,
    };
  }

  meta(scope:PluginScope, m:PluginMetaItem):MetaItem | null {
    switch (m?.kind) {
      case 'text': return { kind: 'text', text: m.text, small: !!m.small };
      case 'seal': return { kind: 'seal', text: m.text };
      case 'score': return { kind: 'score', source: 'provider', value: m.value, votes: m.votes ?? null, label: m.label };
      case 'chip': {
        let icon = m.icon ? (/^[a-z][a-z0-9-]*$/.test(m.icon) ? m.icon : this.asset(scope.id, m.icon)) : null;
        return { kind: 'chip', text: m.text, ...(icon ? { icon } : {}) };
      }
      default: return null;
    }
  }

  info(scope:PluginScope, i:PluginTitleInfo):TitleInfoModel {
    return {
      title: i.title,
      eyebrow: i.eyebrow,
      meta: (i.meta || []).map(m => this.meta(scope, m)).filter(Boolean),
      genres: i.genres,
      overview: i.overview,
      overviewFallback: i.overviewFallback,
      credits: i.credits,
      notes: i.notes,
      backdrop: this.asset(scope.id, i.backdrop),
    };
  }

  /** Nothing when a call fails (already toasted): for streams that must go on */
  quiet<T>(source:Observable<T>, fallback?:T):Observable<T> {
    return source.pipe(catchError(() => fallback === undefined ? EMPTY : of(fallback)));
  }
}

function linkOf(source:PluginSource):string | null {
  if (source.kind == 'media') return null;
  if (source.magnet) return source.magnet;
  return source.infoHash ? `magnet:?xt=urn:btih:${source.infoHash}&dn=${encodeURIComponent(source.label)}` : null;
}

function target(source:PluginSource):Pick<PlaybackRequest, 'magnet' | 'source'> {
  return source.kind == 'media' ? { source: { ref: source.ref } } : { magnet: linkOf(source) };
}

function sourceOption(source:PluginSource, index:number):TorrentOption {
  return {
    quality: source.quality || (source.kind == 'magnet' ? 'SD' : 'Video'),
    tags: [source.kind == 'media' ? 'Stream' : null, source.codec && source.codec != 'h264' ? source.codec : null].filter(Boolean),
    size: source.size ? formatBytes(source.size) : undefined,
    seeds: source.kind == 'magnet' ? source.seeds : undefined,
    name: source.label,
    warnings: source.notes || [],
    recommended: index == 0,
    torrent: source,
  };
}
