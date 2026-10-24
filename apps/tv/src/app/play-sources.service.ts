import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { EMPTY, Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import type { Schema } from '@playpex/protocol';
import { NotificationService } from './notification.service';
import { ProfilesService } from './profiles.service';
import { ServerService } from './server.service';
import { PlayChooserService, PlayGroupName } from './play-chooser.service';
import { Dialogs } from './ui/public-api';

export type PlaySource = Schema<'PlaySource'>;
export type PlaySources = Schema<'PlaySources'>;
export type PlayStart = Schema<'PlayStart'>;
// intro / recap / credits / chapter of what plays, from the server's plugins (player.markers)
export interface Marker { plugin:string; kind:'intro' | 'recap' | 'credits' | 'chapter'; start:number; end?:number; label?:string; }

// The title asked for: a movie, or an episode of a show (tmdbId / imdbId /
// title are the show's)
export interface SourcesQuery {
  kind:'movie' | 'episode';
  tmdbId:number;
  imdbId?:string | null;
  title:string;
  year?:number | null;
  season?:number;
  episode?:number;
}

// The server's play pipeline (POST /play/sources, docs/media-server-plan.md
// §6): every way to play a title, best first — files on the server, its
// downloads, torrents — and whether the top one may start without asking
// (`policy.autoplay`, a source id). For the current profile (its "Prefer
// files on this server", kids rules). Whatever is chosen goes through
// `start()` (POST /play/start): the server's plugins may ask first, refuse,
// or turn a "cached" torrent into a stream (docs/plugins-plan.md §4.3).
@Injectable({
  providedIn: 'root'
})
export class PlaySourcesService {

  // which sources answer a source came from (POST /play/start needs its `request`)
  private requests = new WeakMap<PlaySource, string>();

  constructor(
    private http:HttpClient,
    private dialogs:Dialogs,
    private server:ServerService,
    private profiles:ProfilesService,
    private chooser:PlayChooserService,
    private notifications:NotificationService,
  ) { }

  find(query:SourcesQuery):Observable<PlaySources> {
    let body:Schema<'PlaySourcesRequest'> = {
      ...query,
      imdbId: query.imdbId || null,
      year: query.year || null,
      profileId: this.profiles.current.value?.id || null,
    };
    return this.http.post<PlaySources>(`${this.server.api}/play/sources`, body).pipe(
      map(result => {
        result.sources.forEach(source => this.requests.set(source, result.request));
        return result;
      }),
    );
  }

  /**
   * What to play of a source from `find()`: the server's plugins may ask a
   * question first (a dialog; no → completes empty), refuse (the reason is
   * notified, completes empty) or give another source (a torrent a debrid
   * service has, as a stream). A server without /play/start, or an answer
   * that has expired: the source as it is.
   */
  start(source:PlaySource, confirmed = false):Observable<PlaySource> {
    let request = this.requests.get(source);
    if (!request) return of(source);
    return this.http.post<PlayStart>(`${this.server.api}/play/start`, { request, source: source.id, confirmed }).pipe(
      catchError(() => of({ action: 'play', source } as PlayStart)),
      switchMap(answer => {
        if (answer.action == 'play') return of(answer.source);
        if (answer.action == 'refuse') {
          this.notifications.sendNotification('error', `${answer.reason} (${answer.by})`);
          return EMPTY;
        }
        return this.dialogs.confirm({ title: answer.question, text: answer.by, confirm: answer.yes, cancel: answer.no }).pipe(
          switchMap(yes => yes ? this.start(source, true) : EMPTY),
        );
      }),
    );
  }

  /**
   * The source to play: `prefer` (the one a Resume was playing, if it's still
   * there), else the server's autoplay (a lone file on the server, or the
   * profile's player.autoplayKind), else the user's pick in the Play chooser
   * (docs/providers-plan.md §5.2: the ways to play by kind; empty, it says
   * where sources come from). `kind: 'download'` + `only` (e.g. torrents): the
   * Download action's chooser, never autoplayed. Emits once; completes empty
   * on Back. `looked` runs when the server answered (or failed), before the
   * chooser opens.
   */
  choose(query:SourcesQuery, label:string, options:{ prefer?:(source:PlaySource) => boolean, looked?:() => void,
    kind?:'play' | 'download', only?:PlayGroupName[] } = {}):Observable<PlaySource> {
    let { prefer, looked, kind = 'play', only } = options;
    return new Observable(subscriber => {
      let picking = null;
      let lookup = this.find(query).subscribe({
        next: result => {
          looked?.();
          let sources = result.sources;
          let chosen = kind == 'play' ? (prefer && sources.find(prefer)) || PlaySourcesService.autoplay(result) : null;
          let footnotes = PlaySourcesService.hiddenNotes(result);
          if (result.errors.length) footnotes.push(result.errors.length == 1 ? 'One source didn\'t answer' : `${result.errors.length} sources didn't answer`);
          let picked:Observable<PlaySource> = chosen ? of(chosen) : this.chooser.choose(label, result, { kind, only, footnotes });
          picking = picked.pipe(switchMap(source => this.start(source))).subscribe({
            next: source => subscriber.next(source),
            complete: () => subscriber.complete(),
          });
        },
        error: () => {
          looked?.();
          this.notifications.sendNotification('error', "Couldn't look up what plays this title. Is the Playpex server running?");
          subscriber.complete();
        },
      });
      return () => {
        lookup.unsubscribe();
        picking?.unsubscribe();
      };
    });
  }

  // The markers of what plays (POST /play/markers); none when the server has none or fails
  markers(query:SourcesQuery & { duration:number, fileName?:string }):Observable<Marker[]> {
    let body = { ...query, imdbId: query.imdbId || null, year: query.year || null, profileId: this.profiles.current.value?.id || null };
    return this.http.post<{ markers:Marker[] }>(`${this.server.api}/play/markers`, body).pipe(
      map(answer => answer.markers || []),
      catchError(() => of([])),
    );
  }

  // "Hidden by <plugin>: <reason>" lines for the picker (play.rank), one per plugin and reason
  static hiddenNotes(result:PlaySources):string[] {
    let counts = new Map<string, number>();
    (result.hidden || []).forEach(h => {
      let line = `Hidden by ${h.by}: ${h.reason}`;
      counts.set(line, (counts.get(line) || 0) + 1);
    });
    return [...counts].map(([line, n]) => n > 1 ? `${line} (${n})` : line);
  }

  // The source to play without asking (the server's policy), else null
  static autoplay(result:PlaySources):PlaySource | null {
    let id = result.policy.autoplay;
    return id ? result.sources.find(s => s.id === id) || null : null;
  }

  // Up next: the first source that plays here
  static best(result:PlaySources):PlaySource | null {
    return PlaySourcesService.autoplay(result)
      || result.sources.find(s => s.playable === 'yes' || s.playable === 'audio-converted')
      || result.sources[0] || null;
  }

  // "2009" → 2009, else null
  static year(date?:string | null):number | null {
    let year = parseInt((date || '').slice(0, 4), 10);
    return year > 1800 ? year : null;
  }
}
