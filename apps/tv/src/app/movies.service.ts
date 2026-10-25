import { Injectable } from '@angular/core';
import {HttpClient} from '@angular/common/http'
import { BehaviorSubject, Observable, of, map, catchError, shareReplay } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { Catalog, MediaType } from './catalog';
import { CatalogQuery, categories, showCategories } from './categories';
import { ServerService } from './server.service';

// The server's catalog (GET /catalog/*: TMDB behind the server, in its own
// shapes; docs/providers-plan.md §7.1): the TV holds no TMDB key.
export type CatalogTitle = Schema<'CatalogTitle'>;
export type CatalogPerson = Schema<'CatalogPerson'>;
export type CatalogDetails = Schema<'CatalogDetails'>;
export type CatalogPage = Schema<'CatalogPage'>;
export type CatalogCredits = Schema<'CatalogCredits'>;
export type CatalogSeason = Schema<'CatalogSeason'>;
export type CatalogEpisode = Schema<'CatalogEpisode'>;
export type CatalogPersonCredits = Schema<'CatalogPersonCredits'>;

// A title as the TV holds it: a list item, completed by its page once read,
// with its IMDb rating once known
export type TitleItem = CatalogTitle & Partial<CatalogDetails> & { rating?: number };

// An episode of a season row (upcoming: not aired yet)
export type EpisodeItem = CatalogEpisode & { upcoming?: boolean };

// The name a title is shown and searched by: a movie's original title (as
// before the catalog moved to the server), a show's name
export function displayTitle(item:Partial<CatalogTitle> | null | undefined):string {
  if (!item) return '';
  return (item.mediaType == 'movie' ? item.originalTitle || item.title : item.title || item.originalTitle) || '';
}

// Search kinds: 'multi' = movies, TV shows and people together
export type SearchKind = 'multi' | 'movie' | 'tv' | 'person';

// What the search page shows; kept here so it survives a trip to a title page
export interface SearchItem {
  key: string;                          // `${kind}-${id}`
  kind: 'movie' | 'tv' | 'person';
  id: number;
  title: string;
  sub: string;                          // year, or a person's department
  image: string;                        // poster / profile image path
  badge?: string;                       // shown on mixed rows ("TV")
}

export interface SearchRow {
  key: string;
  title: string;
  items: SearchItem[];
}

export interface SearchState {
  query: string;
  filter: string;
  rows: SearchRow[];
  searched: boolean;                    // a search ran for this query/filter
}

export const EMPTY_SEARCH: SearchState = { query: '', filter: 'all', rows: [], searched: false };

@Injectable({
  providedIn: 'root'
})

export class MoviesService {


  //Description of thes observable subjects is in the
  //method definitions below

  // Browsable sections; the home page/slider pick one via route data `media`
  catalogs: { [media in MediaType]: Catalog } = {
    movie: new Catalog('movie', categories, 'core.movies', 'core.movie'),
    tv: new Catalog('tv', showCategories, 'core.shows', 'core.show'),
  };

  // Item shown in <movie-description>: a movie or a show (mediaType), {} = none
  selectedmovie = new BehaviorSubject<Partial<TitleItem>>({});
  searchData = new BehaviorSubject<SearchState>(EMPTY_SEARCH);

  constructor(
    private http:HttpClient,
    private server:ServerService,
    ) { }

  private get base():string {
    return `${this.server.api}/catalog`;
  }

  // The genres of a kind ('movie' | 'tv'), fetched once
  private genres$ = {};
  getGenres(kind:MediaType):Observable<{ id:number, name:string }[]> {
    if (!this.genres$[kind]) {
      this.genres$[kind] = this.http.get<{ genres:{ id:number, name:string }[] }>(`${this.base}/genres/${kind}`).pipe(
        map(data => data.genres || []),
        catchError(() => {
          this.genres$[kind] = null;
          return of([]);
        }),
        shareReplay(1),
      );
    }
    return this.genres$[kind];
  }

  // A row's page: a list, discover or search (categories.ts)
  getMovies(query:CatalogQuery):Observable<CatalogPage> {
    return this.http.get<CatalogPage>(`${this.base}/${query.path}`, { params: query.params as any });
  }

  getCredits(id:number | string):Observable<CatalogCredits> {
    return this.http.get<CatalogCredits>(`${this.base}/titles/movie/${id}/credits`);
  }

  getSimilarMovies(id:number | string):Observable<CatalogPage> {
    return this.http.get<CatalogPage>(`${this.base}/titles/movie/${id}/similar`);
  }

  // A movie's page (runtime, IMDb id, genres, videos)
  getTmdbMovieDetails(tmdbId:number | string):Observable<CatalogDetails> {
    return this.http.get<CatalogDetails>(`${this.base}/titles/movie/${tmdbId}`);
  }

  // regular titles only (the server never asks for adult ones)
  search(kind:SearchKind , query:string , page = 1):Observable<CatalogPage> {
    return this.http.get<CatalogPage>(`${this.base}/search/${kind}`, { params: { q: query, page } });
  }

  // Movies and shows a person played in or worked on
  getPersonCredits(personId:number):Observable<CatalogPersonCredits> {
    return this.http.get<CatalogPersonCredits>(`${this.base}/people/${personId}/credits`);
  }

  // A show's page: IMDb id (torrents, subtitles), seasons, trailers
  getTvDetails(tmdbId:number | string):Observable<CatalogDetails> {
    return this.http.get<CatalogDetails>(`${this.base}/titles/tv/${tmdbId}`);
  }

  getTvSeason(tmdbId:number | string, season:number):Observable<CatalogSeason> {
    return this.http.get<CatalogSeason>(`${this.base}/titles/tv/${tmdbId}/seasons/${season}`);
  }



  // ****RXJS Subjects for sharing data between components****



  //Keeps track of the object movie that is going to be
  //sent to the movie description and later display its properties in the view
      assignSelection(movie:Partial<TitleItem>){
        this.selectedmovie.next(movie);
      }

      checkSelection():Observable<Partial<TitleItem>>{
        return this.selectedmovie.asObservable();
      }

}
