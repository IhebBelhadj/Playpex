import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { EMPTY, Observable } from 'rxjs';
import { ServerService } from './server.service';
import { ProfilesService } from './profiles.service';

// The current profile's watch list, playback progress and history
// (server: apps/server/lib/routes/library.js).

export type MediaType = 'movie' | 'tv';

export interface MediaRef {
  mediaType: MediaType;
  tmdbId: number;
}

// season/episode are 0 (or absent) for movies
export interface EpisodeKey extends MediaRef {
  season?: number;
  episode?: number;
}

// Denormalized so rows render without asking TMDB again
export interface Artwork {
  title?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  genreIds?: number[];
}

export interface ContinueItem extends MediaRef {
  kind: 'resume' | 'next';           // 'next': the episode is finished, the next one is up
  season: number;
  episode: number;
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  positionS: number;
  durationS: number;
  ratio: number;
  updatedAt: string;
}

export interface WatchlistItem extends MediaRef {
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  addedAt: string;
}

export interface WatchedItem extends MediaRef {
  title: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  season: number;                    // latest episode watched (shows)
  episode: number;
  episodesWatched?: number;
  watchedAt: string;
}

export interface Library {
  continueWatching: ContinueItem[];
  watchlist: WatchlistItem[];
  watched: WatchedItem[];
}

export interface PlaybackState {
  resume: { positionS: number, durationS: number, infoHash: string | null, filePath: string | null, fileId?: string | null,
    audioTrack?: string | null, subtitleTrack?: string | null } | null;
  finished: boolean;
}

export interface EpisodeProgress {
  season: number;
  episode: number;
  ratio: number;
  finished: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class LibraryService {

  constructor(private http:HttpClient, private profiles:ProfilesService, private server:ServerService) { }

  library():Observable<Library> {
    return this.call(base => this.http.get<Library>(`${base}/library`));
  }

  inWatchlist(ref:MediaRef):Observable<{ inWatchlist:boolean }> {
    return this.call(base => this.http.get<{ inWatchlist:boolean }>(`${base}/watchlist/${ref.mediaType}/${ref.tmdbId}`));
  }

  addToWatchlist(ref:MediaRef, artwork:Artwork):Observable<WatchlistItem> {
    return this.call(base => this.http.put<WatchlistItem>(`${base}/watchlist/${ref.mediaType}/${ref.tmdbId}`, artwork));
  }

  removeFromWatchlist(ref:MediaRef):Observable<{ removed:boolean }> {
    return this.call(base => this.http.delete<{ removed:boolean }>(`${base}/watchlist/${ref.mediaType}/${ref.tmdbId}`));
  }

  state(key:EpisodeKey):Observable<PlaybackState> {
    return this.call(base => this.http.get<PlaybackState>(`${base}/progress/${key.mediaType}/${key.tmdbId}`, { params: this.episodeParams(key) }));
  }

  episodesProgress(ref:MediaRef):Observable<EpisodeProgress[]> {
    return this.call(base => this.http.get<EpisodeProgress[]>(`${base}/progress/${ref.mediaType}/${ref.tmdbId}/episodes`));
  }

  saveProgress(key:EpisodeKey, body:Artwork & { positionS:number, durationS:number, infoHash?:string | null, filePath?:string | null, fileId?:string | null,
    audioTrack?:string | null, subtitleTrack?:string | null }) {
    return this.call(base => this.http.put(`${base}/progress/${key.mediaType}/${key.tmdbId}`, { ...body, season: key.season, episode: key.episode }));
  }

  markWatched(key:EpisodeKey, artwork:Artwork) {
    return this.call(base => this.http.put(`${base}/watched/${key.mediaType}/${key.tmdbId}`, { ...artwork, season: key.season, episode: key.episode }));
  }

  markUnwatched(key:EpisodeKey) {
    return this.call(base => this.http.delete(`${base}/watched/${key.mediaType}/${key.tmdbId}`, { params: this.episodeParams(key) }));
  }

  // TMDB title object (movie details, show details or a list item) → what the server keeps
  static artworkOf(item:any):Artwork {
    return {
      title: item['title'] || item['original_title'] || item['name'] || null,
      posterPath: item['poster_path'] || null,
      backdropPath: item['backdrop_path'] || null,
      genreIds: item['genre_ids'] || (item['genres'] || []).map(g => g['id']),
    };
  }

  // Everything here belongs to the current profile; none → nothing to do
  private call<T>(request:(base:string) => Observable<T>):Observable<T> {
    let profile = this.profiles.current.value;
    return profile ? request(`${this.server.api}/profiles/${profile.id}`) : EMPTY;
  }

  private episodeParams(key:EpisodeKey):{ [param:string]:string } {
    return key.mediaType == 'tv' ? { season: String(key.season), episode: String(key.episode) } : {};
  }
}
