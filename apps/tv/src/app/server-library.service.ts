import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, debounceTime, distinctUntilChanged, map, merge, Observable, of, shareReplay, skip, startWith, Subject, switchMap } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { defineContribution, CONTRIBUTIONS, MetaItem } from './ui/public-api';

export type ServerLibrary = Schema<'ServerLibrary'>;
export type ServerLibraryEntry = Schema<'ServerLibraryEntry'>;
export type ServerLibraryTitle = Schema<'ServerLibraryTitle'>;
export type ServerLibraryFolder = Schema<'ServerLibraryFolder'>;
export type ServerLibraryVideo = ServerLibraryFolder['videos'][number];

// The server's media library as the current profile browses it
// (`<api>/library/*`, docs/media-server-plan.md §5.5): what is on this server.
// Not the profile's own "library" (watch list, progress: LibraryService).
//   home()                      movies, shows, recently added, folders of other videos
//   title(mediaType, tmdbId)    a title's files on this server (marks), cached until
//                               the library or the profile changes
//   folder(id, path)            one level of a folder's other videos
//   changes                     emits (debounced) when the server says the library
//                               changed (`library.changed`) or the profile changed
// Also the core's "On this server" item on titles' meta lines (core.title.meta).
@Injectable({
  providedIn: 'root'
})
export class ServerLibraryService {

  private changed = new Subject<void>();
  readonly changes:Observable<void> = this.changed.asObservable();

  private titles = new Map<string, Observable<ServerLibraryTitle | null>>();

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    events:ServerEvents,
  ) {
    // the app's socket stays open anyway (settings, downloads)
    let profile$ = this.profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged(), skip(1));
    merge(events.on('library.changed'), profile$).pipe(debounceTime(500)).subscribe(() => {
      this.titles.clear();
      this.changed.next();
    });
    this.contribute();
  }

  home():Observable<ServerLibrary> {
    return this.http.get<ServerLibrary>(`${this.server.api}/library/home`, { params: this.params() });
  }

  /** A movie's / a show's files on this server; null when the server can't tell */
  title(mediaType:'movie' | 'tv', tmdbId:number):Observable<ServerLibraryTitle | null> {
    let key = `${mediaType}:${tmdbId}`;
    let cached = this.titles.get(key);
    if (!cached) {
      cached = this.http.get<ServerLibraryTitle>(`${this.server.api}/library/titles/${mediaType}/${tmdbId}`, { params: this.params() }).pipe(
        catchError(() => of(null)),
        shareReplay(1),
      );
      this.titles.set(key, cached);
    }
    return cached;
  }

  /** The same, again whenever the library changes */
  live(mediaType:'movie' | 'tv', tmdbId:number):Observable<ServerLibraryTitle | null> {
    return this.changes.pipe(startWith(null), switchMap(() => this.title(mediaType, tmdbId)));
  }

  folder(id:string, path = ''):Observable<ServerLibraryFolder> {
    let params = this.params();
    if (path) params['path'] = path;
    return this.http.get<ServerLibraryFolder>(`${this.server.api}/library/folders/${encodeURIComponent(id)}`, { params });
  }

  // "On this server" / "3 episodes on this server"; null when none is
  static onServerText(title:ServerLibraryTitle | null):string | null {
    if (!title?.fileCount) return null;
    if (title.mediaType == 'movie') return 'On this server';
    let n = title.episodes.length;
    return n == 1 ? '1 episode on this server' : `${n} episodes on this server`;
  }

  // "S01E02" → whether that episode is on this server
  static episodesOf(title:ServerLibraryTitle | null):Set<string> {
    return new Set((title?.episodes || []).map(e => `${e.season}x${e.episode}`));
  }

  private params():{ [name:string]:string } {
    let profile = this.profiles.current.value;
    return profile ? { profile: profile.id } : {};
  }

  // The meta line of movies and shows (list pages, title pages): the core's own contribution
  private contribute() {
    CONTRIBUTIONS.remove('core.library.on-server');
    defineContribution({
      id: 'core.library.on-server',
      slot: 'core.title.meta',
      order: 10,
      meta: ctx => ctx.kind == 'episode' || !ctx.tmdbId ? [] : this.live(ctx.kind, ctx.tmdbId).pipe(
        map(title => {
          let text = ServerLibraryService.onServerText(title);
          return text ? [{ kind: 'chip', text, icon: 'server' } as MetaItem] : [];
        }),
      ),
    });
  }
}
