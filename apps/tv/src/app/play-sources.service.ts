import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { NotificationService } from './notification.service';
import { ProfilesService } from './profiles.service';
import { ServerService } from './server.service';
import { TorrentPickerService } from './torrent-picker.service';

export type PlaySource = Schema<'PlaySource'>;
export type PlaySources = Schema<'PlaySources'>;

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
// files on this server", kids rules).
@Injectable({
  providedIn: 'root'
})
export class PlaySourcesService {

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private picker:TorrentPickerService,
    private notifications:NotificationService,
  ) { }

  find(query:SourcesQuery):Observable<PlaySources> {
    let body:Schema<'PlaySourcesRequest'> = {
      ...query,
      imdbId: query.imdbId || null,
      year: query.year || null,
      profileId: this.profiles.current.value?.id || null,
    };
    return this.http.post<PlaySources>(`${this.server.api}/play/sources`, body);
  }

  /**
   * The source to play: `prefer` (the one a Resume was playing, if it's still
   * there), else the server's autoplay (a lone file on the server), else the
   * user's pick in the source picker. Emits once; completes empty on Back or
   * when nothing is found (the user is told). `looked` runs when the server
   * answered (or failed), before the picker opens.
   */
  choose(query:SourcesQuery, label:string, options:{ prefer?:(source:PlaySource) => boolean, looked?:() => void } = {}):Observable<PlaySource> {
    let { prefer, looked } = options;
    return new Observable(subscriber => {
      let picking = null;
      let lookup = this.find(query).subscribe({
        next: result => {
          looked?.();
          let sources = result.sources;
          if (!sources.length) {
            let reason = result.errors.length ? ' (some providers are unreachable)' : '';
            this.notifications.sendNotification('error', `Nothing found to play ${label}${reason}`);
            subscriber.complete();
            return;
          }
          let chosen = (prefer && sources.find(prefer)) || PlaySourcesService.autoplay(result);
          if (chosen) {
            subscriber.next(chosen);
            subscriber.complete();
            return;
          }
          let options = sources.map(source => TorrentPickerService.fromSource(source));
          picking = this.picker.choose(label, options, 'Choose a source').subscribe({
            next: choice => subscriber.next(choice.torrent),
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
