import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import type { Schema } from '@playpex/protocol';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';

export type Download = Schema<'Download'>;

// Which title a download is (the server keeps it as the download's `title`)
export interface DownloadRef {
  mediaType:'movie' | 'tv';
  tmdbId:number;
  season?:number;
  episode?:number;
}

// What a title page's Download tile shows for it
export interface DownloadTile {
  label:string;
  on:boolean;               // done: "On this server"
  progress:number | null;   // the amber line while it downloads
}

// The torrents the server keeps (docs/media-server-plan.md §4.4): the list,
// live through the events socket (download.added / updated / removed), the
// download of a title, and the title pages' "Download" action.
@Injectable({
  providedIn: 'root'
})
export class DownloadsService {

  private list = new BehaviorSubject<Download[] | null>(null);
  private watching = false;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private events:ServerEvents,
    private profiles:ProfilesService,
  ) { }

  // The list, loaded on first use and kept live from then on
  private watch() {
    if (this.watching) return;
    this.watching = true;
    this.refresh();
    this.events.on<any>('download.').subscribe(e => {
      if (e.topic !== 'download.updated') {
        this.refresh();
        return;
      }
      let list = this.list.value;
      if (list?.some(d => d.infoHash === e.data.infoHash)) {
        this.list.next(list.map(d => d.infoHash === e.data.infoHash ? e.data : d));
      }
    });
  }

  refresh() {
    this.http.get<Download[]>(`${this.server.api}/downloads`).subscribe({
      next: list => this.list.next(list),
      error: () => {},
    });
  }

  /** The download of a title (the most advanced one if there are several), or null */
  forTitle(ref:DownloadRef):Observable<Download | null> {
    this.watch();
    let rank = (d:Download) => d.state === 'completed' ? 0 : ['downloading', 'seeding', 'checking'].includes(d.state) ? 1 : d.state === 'queued' ? 2 : 3;
    return this.list.pipe(
      map(list => (list || []).filter(d => DownloadsService.matches(d, ref)).sort((a, b) => rank(a) - rank(b))[0] || null),
      distinctUntilChanged((a, b) => a?.infoHash === b?.infoHash && a?.state === b?.state && a?.doneBytes === b?.doneBytes),
    );
  }

  static matches(d:Download, ref:DownloadRef):boolean {
    let t = d.title;
    if (!t || t.mediaType !== ref.mediaType || t.tmdbId !== ref.tmdbId) return false;
    return ref.mediaType === 'movie' || (t.season === ref.season && t.episode === ref.episode);
  }

  /** Downloads a release on the server (to the end, without a player) */
  add(link:string, ref:DownloadRef, title:string):Observable<Download> {
    return this.http.post<Download>(`${this.server.api}/downloads`, {
      link,
      media: ref,
      title,
      profileId: this.profiles.current.value?.id,
    }).pipe(map(d => {
      this.refresh();
      return d;
    }));
  }

  start(infoHash:string):Observable<Download> {
    return this.http.post<Download>(`${this.server.api}/downloads/${infoHash}/start`, null);
  }

  /** The tile's label for a title's download (null: none yet) */
  static tile(d:Download | null):DownloadTile {
    if (!d) return { label: 'Download', on: false, progress: null };
    let pct = d.progress === null ? null : Math.floor(d.progress * 100);
    switch (d.state) {
      case 'completed': return { label: 'On this server', on: true, progress: null };
      case 'seeding': return { label: d.intent === 'download' ? 'On this server' : `Downloaded ${pct ?? 100} %`, on: d.intent === 'download', progress: null };
      case 'downloading': return { label: pct === null ? 'Downloading…' : `Downloading ${pct} %`, on: false, progress: d.progress };
      case 'checking': return { label: 'Checking…', on: false, progress: d.progress };
      case 'queued': return { label: 'Queued', on: false, progress: d.progress };
      case 'error': return { label: 'Download failed', on: false, progress: null };
      default: return { label: pct ? `Paused at ${pct} %` : 'Download', on: false, progress: pct ? d.progress : null };
    }
  }
}
