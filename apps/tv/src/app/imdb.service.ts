import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, catchError, shareReplay } from 'rxjs';
import { STREAMING_SERVER } from './server-config';

// IMDb ratings via the local server (lib/imdb.js): a title's, and a series'
// seasons (mean of the rated episodes) and episodes. Cached per id for the
// session; a failed lookup answers null and is tried again next time.

export interface ImdbRating {
  id: string;
  rating: number | null;
  votes: number;
}

export interface ImdbEpisode {
  episode: number;
  id: string;
  rating: number | null;
  votes: number;
}

export interface ImdbSeason {
  season: number;
  rating: number | null;      // mean of the rated episodes
  rated: number;              // how many episodes have a rating
  episodes: ImdbEpisode[];
}

export interface ImdbSeries extends ImdbRating {
  seasons: ImdbSeason[];
}

@Injectable({
  providedIn: 'root'
})
export class ImdbService {

  private titles = new Map<string, Observable<ImdbRating | null>>();
  private series = new Map<string, Observable<ImdbSeries | null>>();

  constructor(private http:HttpClient) { }

  title(imdbId:string):Observable<ImdbRating | null> {
    return this.cached(this.titles, imdbId, `${STREAMING_SERVER}/api/imdb/${imdbId}`);
  }

  episodes(imdbId:string):Observable<ImdbSeries | null> {
    return this.cached(this.series, imdbId, `${STREAMING_SERVER}/api/imdb/${imdbId}/episodes`);
  }

  static season(series:ImdbSeries | null, season:number):ImdbSeason | null {
    return series?.seasons.find(s => s.season === season) || null;
  }

  static episode(series:ImdbSeries | null, season:number, episode:number):ImdbEpisode | null {
    return ImdbService.season(series, season)?.episodes.find(e => e.episode === episode) || null;
  }

  // 1234567 → "1.2M", 41234 → "41K"
  static votes(count:number):string {
    if (count >= 1e6) return (Math.round(count / 1e5) / 10) + 'M';
    if (count >= 1e4) return Math.round(count / 1e3) + 'K';
    if (count >= 1e3) return (Math.round(count / 100) / 10) + 'K';
    return String(count);
  }

  private cached<T>(cache:Map<string, Observable<T | null>>, id:string, url:string):Observable<T | null> {
    if (!id) return of(null);
    if (!cache.has(id)) {
      cache.set(id, this.http.get<T>(url).pipe(
        catchError(() => {
          cache.delete(id);
          return of(null);
        }),
        shareReplay(1),
      ));
    }
    return cache.get(id);
  }
}
