import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, shareReplay, catchError, distinctUntilChanged, map } from 'rxjs';
import { STREAMING_SERVER } from './server-config';
import { ProfilesService } from './profiles.service';
import { Artwork } from './library.service';

// Release lists ("Find releases"): one torrent source's releases, most seeded
// first, for 18+ titles, movies or TV shows (server lib/releases.js,
// /api/releases/*). One list state per kind, kept while visiting the player.

export type ReleasesKind = 'adult' | 'movie' | 'tv';

export interface ReleaseProvider {
  id: string;
  name: string;
  paged: boolean;       // more results on request (TheRARBG, YTS…), or one list (The Pirate Bay)
  default: boolean;
}

// One release as the server lists it
export interface Release {
  provider: string;
  name: string;         // raw release name
  title: string;        // cleaned: no studio tag, resolution, encoder…
  studio: string | null;
  year: number | null;
  hash: string;
  magnet: string;
  seeds: number;
  peers: number;
  size: number;         // bytes
  added: number;        // unix seconds
  quality: string;      // '2160p' | '1080p' | '720p' | '480p' | 'SD'
  codec: string;
  audio: 'supported' | 'unknown' | 'unsupported';
  playable: boolean;
  scenes: boolean;      // 18+ split scenes: one file per scene
  // TV: what the release holds (an episode, or a season / complete pack)
  season?: number | null;
  episode?: number | null;
  pack?: boolean;
}

export type ReleaseQuality = '' | '2160p' | '1080p' | '720p' | 'SD';

// The title a list was opened for: playing a release then plays that title
// (subtitles by IMDb id, saved progress, artwork in Continue watching)
export interface ReleasesContext {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  imdbId?: string;
  title: string;
  year?: string;
  artwork?: Artwork;
}

// The page a release list was opened from ("Find releases" on a title page),
// passed as the navigation's history state (`RELEASES_FROM`), so it survives a
// trip to the player and back. The list then offers "Back to <label>" and
// Escape returns there.
export const RELEASES_FROM = 'releasesFrom';
export interface ReleasesOrigin {
  label: string;     // the title, shown as "Back to <label>"
  url: string;
  context?: ReleasesContext;
}

// What a release list shows; kept so coming back from the player restores it
export interface ReleasesState {
  provider: string | null;    // null: the server's default
  query: string;
  imdb: string | null;        // the show's IMDb id (EZTV lists by it)
  quality: ReleaseQuality;
  playableOnly: boolean;
  releases: Release[];
  page: number;               // last page read
  hasMore: boolean;
  loaded: boolean;
}

export const EMPTY_RELEASES_STATE: ReleasesState = {
  provider: null,
  query: '',
  imdb: null,
  quality: '',
  playableOnly: false,
  releases: [],
  page: 0,
  hasMore: false,
  loaded: false,
};

const URLS: Record<ReleasesKind, string> = {
  adult: '/adult/releases',
  movie: '/releases/movies',
  tv: '/releases/shows',
};

@Injectable({
  providedIn: 'root'
})
export class ReleasesService {

  states:Record<ReleasesKind, ReleasesState> = this.emptyStates();

  private providers$:Partial<Record<ReleasesKind, Observable<ReleaseProvider[]>>> = {};

  constructor(private http:HttpClient, private router:Router, profiles:ProfilesService) {
    // what one profile searched isn't the next one's business (a preferences
    // update re-emits the same profile: keep the states then)
    profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()).subscribe(() => this.reset());
  }

  url(kind:ReleasesKind):string {
    return URLS[kind];
  }

  // "Find releases" on a title page: a new list searched for `query`, on the
  // source last used for this kind; Back on it returns to `origin`
  open(kind:ReleasesKind, query:string, origin:ReleasesOrigin, imdb:string | null = null) {
    this.states[kind] = { ...EMPTY_RELEASES_STATE, provider: this.states[kind].provider, query, imdb };
    this.router.navigateByUrl(URLS[kind], { state: { [RELEASES_FROM]: origin } });
  }

  providers(kind:ReleasesKind): Observable<ReleaseProvider[]> {
    if (!this.providers$[kind]) {
      this.providers$[kind] = this.http.get<ReleaseProvider[]>(`${STREAMING_SERVER}/api/releases/providers`, { params: { kind } }).pipe(
        catchError(() => {
          this.providers$[kind] = null;     // try again next time
          return of([]);
        }),
        shareReplay(1),
      );
    }
    return this.providers$[kind];
  }

  browse(kind:ReleasesKind, state:ReleasesState, page = 1)
    : Observable<{ provider:string, page:number, hasMore:boolean, torrents:Release[] }> {
    let params:any = { kind, provider: state.provider, page };
    if (state.query) params.q = state.query;
    if (state.imdb) params.imdb = state.imdb;
    if (state.quality) params.quality = state.quality;
    if (state.playableOnly) params.playable = 1;
    return this.http.get<any>(`${STREAMING_SERVER}/api/releases/browse`, { params });
  }

  // Forget every list (another profile)
  reset() {
    this.states = this.emptyStates();
  }

  private emptyStates():Record<ReleasesKind, ReleasesState> {
    return { adult: { ...EMPTY_RELEASES_STATE }, movie: { ...EMPTY_RELEASES_STATE }, tv: { ...EMPTY_RELEASES_STATE } };
  }
}
