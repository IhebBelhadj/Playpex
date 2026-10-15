import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, shareReplay, catchError, distinctUntilChanged, map } from 'rxjs';
import { STREAMING_SERVER } from './server-config';
import { ProfilesService } from './profiles.service';

export interface AdultProvider {
  id: string;
  name: string;
  paged: boolean;       // more results on request (TheRARBG), or one list (The Pirate Bay)
  default: boolean;
}

// One release as the server lists it (lib/adult.js#browse)
export interface AdultRelease {
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
  scenes: boolean;      // split scenes: one file per scene
}

export type AdultQuality = '' | '2160p' | '1080p' | '720p' | 'SD';

// What the 18+ page shows; kept here so coming back from the player restores it
export interface AdultState {
  provider: string | null;    // null: the server's default
  query: string;
  quality: AdultQuality;
  playableOnly: boolean;
  releases: AdultRelease[];
  page: number;               // last page read
  hasMore: boolean;
  loaded: boolean;
  focusKey: string | null;    // hash of the focused release
}

export const EMPTY_ADULT_STATE: AdultState = {
  provider: null,
  query: '',
  quality: '',
  playableOnly: false,
  releases: [],
  page: 0,
  hasMore: false,
  loaded: false,
  focusKey: null,
};

// ── catalog (metadata providers, lib/adultMeta) ─────────────────────────────

export interface MetaProvider {
  id: string;
  name: string;
  description: string;
  enabled: boolean;      // false: needs an API key on the server
  default: boolean;
  periods: { id: string, label: string }[];
}

export interface AdultStudio {
  id: string;
  name: string;
}

// One title, whatever the provider (image fields are full URLs)
export interface AdultTitle {
  id: string;
  title: string;
  year: number | null;
  releaseDate: string | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  rating: number | null;
  studio: AdultStudio | null;
}

export interface AdultTitleDetails extends AdultTitle {
  runtime: number | null;
  performers: { name: string, photo: string | null }[];
  director: string | null;
  studios: AdultStudio[];
  browsableStudio: string | null;   // a studio of the provider's list: "More from …"
}

export interface AdultPage {
  items: AdultTitle[];
  page: number;
  totalPages: number;
}

export type AdultSort = 'popular' | 'newest' | 'rated';

// How the section looks and where its catalog comes from: per profile, in
// the server's profile preferences (`preferences.adult`). Settings will edit them.
export type AdultLayout = 'posters' | 'compact';

export interface AdultPreferences {
  layout: AdultLayout;
  metadataProvider: string | null;    // null: the server's default
}

export const DEFAULT_ADULT_PREFERENCES: AdultPreferences = { layout: 'posters', metadataProvider: null };

// One row of the poster layout
export interface PosterRow {
  key: string;
  title: string;
  items: AdultTitle[];
  page: number;
  totalPages: number;
}

// What the poster layout shows, kept while visiting a title or the player
export interface BrowseState {
  provider: string | null;    // the provider these rows came from
  query: string;
  studio: AdultStudio | null;
  period: string;
  rows: PosterRow[];
  loaded: boolean;
  focusKey: string | null;    // "<row>:<title id>"
}

export const EMPTY_BROWSE_STATE: BrowseState = {
  provider: null,
  query: '',
  studio: null,
  period: '',
  rows: [],
  loaded: false,
  focusKey: null,
};

// The 18+ section: metadata (poster layout) and one provider's releases,
// most seeded first (compact layout).
@Injectable({
  providedIn: 'root'
})
export class AdultService {

  state:AdultState = { ...EMPTY_ADULT_STATE };
  browseState:BrowseState = { ...EMPTY_BROWSE_STATE };
  // the title being opened, so its page renders before the details arrive
  openedTitle:AdultTitle | null = null;

  private providers$:Observable<AdultProvider[]>;
  private metaProviders$:Observable<MetaProvider[]>;
  private meta = `${STREAMING_SERVER}/api/adult/meta`;

  constructor(private http:HttpClient, private profiles:ProfilesService) {
    // what one profile searched isn't the next one's business (a preferences
    // update re-emits the same profile: keep the state then)
    profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()).subscribe(() => this.reset());
  }

  // ── preferences ─────────────────────────────────────────────────────────

  get preferences():AdultPreferences {
    let saved = this.profiles.current.value?.preferences?.['adult'] || {};
    return {
      layout: saved['layout'] == 'compact' ? 'compact' : 'posters',
      metadataProvider: saved['metadataProvider'] || null,
    };
  }

  // Saved to the profile on the server
  setPreferences(patch:Partial<AdultPreferences>): Observable<AdultPreferences> {
    let profile = this.profiles.current.value;
    let next = { ...this.preferences, ...patch };
    if (!profile) return of(next);
    return this.profiles.update(profile.id, { preferences: { adult: next } }).pipe(map(() => this.preferences));
  }

  layoutUrl(layout:AdultLayout = this.preferences.layout):string {
    return layout == 'compact' ? '/adult/releases' : '/adult/browse';
  }

  // ── catalog ─────────────────────────────────────────────────────────────

  metaProviders(): Observable<MetaProvider[]> {
    if (!this.metaProviders$) {
      this.metaProviders$ = this.http.get<MetaProvider[]>(`${this.meta}/providers`).pipe(
        catchError(() => {
          this.metaProviders$ = null;
          return of([]);
        }),
        shareReplay(1),
      );
    }
    return this.metaProviders$;
  }

  // The profile's provider when it's usable, otherwise the server's default
  metaProvider(): Observable<MetaProvider | null> {
    let wanted = this.preferences.metadataProvider;
    return this.metaProviders().pipe(map(list =>
      list.find(p => p.id == wanted && p.enabled) || list.find(p => p.default) || null));
  }

  home(provider:string): Observable<{ provider:string, rows:{ key:string, title:string }[] }> {
    return this.http.get<any>(`${this.meta}/${provider}/home`);
  }

  row(provider:string, key:string, page = 1): Observable<AdultPage> {
    return this.http.get<AdultPage>(`${this.meta}/${provider}/rows/${encodeURIComponent(key)}`, { params: { page } });
  }

  discover(provider:string, options:{ studio?:string | null, period?:string, sort?:AdultSort, page?:number }): Observable<AdultPage> {
    let params:any = { page: options.page || 1, sort: options.sort || 'popular' };
    if (options.studio) params.studio = options.studio;
    if (options.period) params.period = options.period;
    return this.http.get<AdultPage>(`${this.meta}/${provider}/discover`, { params });
  }

  searchTitles(provider:string, query:string, period:string, page = 1): Observable<AdultPage> {
    let params:any = { q: query, page };
    if (period) params.period = period;
    return this.http.get<AdultPage>(`${this.meta}/${provider}/search`, { params });
  }

  studios(provider:string): Observable<AdultStudio[]> {
    return this.http.get<AdultStudio[]>(`${this.meta}/${provider}/studios`);
  }

  title(provider:string, id:string): Observable<AdultTitleDetails> {
    return this.http.get<AdultTitleDetails>(`${this.meta}/${provider}/titles/${encodeURIComponent(id)}`);
  }

  // ── releases (compact layout) ───────────────────────────────────────────

  providers(): Observable<AdultProvider[]> {
    if (!this.providers$) {
      this.providers$ = this.http.get<AdultProvider[]>(`${STREAMING_SERVER}/api/adult/providers`).pipe(
        catchError(() => {
          this.providers$ = null;     // try again next time
          return of([]);
        }),
        shareReplay(1),
      );
    }
    return this.providers$;
  }

  browse(provider:string, query:string, quality:AdultQuality, playableOnly:boolean, page = 1)
    : Observable<{ provider:string, page:number, hasMore:boolean, torrents:AdultRelease[] }> {
    let params:any = { provider, page };
    if (query) params.q = query;
    if (quality) params.quality = quality;
    if (playableOnly) params.playable = 1;
    return this.http.get<any>(`${STREAMING_SERVER}/api/adult/browse`, { params });
  }

  // Forget everything (another profile)
  reset() {
    this.state = { ...EMPTY_ADULT_STATE };
    this.browseState = { ...EMPTY_BROWSE_STATE };
  }
}
