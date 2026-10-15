import { Injectable } from '@angular/core';
import { Artwork, LibraryService, MediaType } from './library.service';

// What /player should play. Set it, then navigate to /player.
export interface PlaybackRequest {
  title: string;            // movie or show title
  subtitle?: string;        // e.g. "S01E03 · The Bear"; shown instead of year/runtime
  year?: string;
  runtimeMinutes?: number;
  magnet: string;
  imdbId?: string;          // movie or show IMDb id ("tt…"), used for subtitles
  season?: number;          // set for TV episodes: picks the episode file
  episode?: number;         //   inside season packs and looks up episode subtitles
  // Which title this is, so the player can resume it and save the position for
  // the current profile (Continue watching, history)
  mediaType?: MediaType;
  tmdbId?: number;          // the movie's / show's TMDB id
  artwork?: Artwork;
  // Where to start, in seconds: the saved position ("Resume") or 0 ("Play from
  // the beginning"). Unset: the player resumes from the saved position, if any.
  startAt?: number;
  // 18+ title: played without touching the profile's library (no saved
  // position, no Continue watching / Watched entry)
  adult?: boolean;
}

// The server also adds its maintained list (src/server/streamingServer/lib/trackers.js)
// to every torrent, so this only needs a couple of reliable ones
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
];

@Injectable({
  providedIn: 'root'
})
export class PlaybackService {

  current: PlaybackRequest;

  play(request: PlaybackRequest) {
    this.current = request;
  }

  // Movie from MoviesService.selectedmovie, enriched with YTS `torrents`;
  // `torrent` is one of them (defaults to the first)
  // `torrent` needs only `hash` (+ `quality`): resuming passes the saved info hash.
  // 18+ movies get server results (lib/adult.js) that carry their own `magnet`
  playMovie(movie, torrent = movie['torrents'][0], startAt?:number) {
    let magnet = torrent.magnet;
    if (!magnet) {
      magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie['original_title'] + torrent.quality)}`;
      TRACKERS.forEach(tracker => magnet += "&tr=" + tracker);
    }

    this.play({
      title: movie['original_title'],
      year: (movie['release_date'] || '').slice(0, 4),
      runtimeMinutes: movie['runtime'],
      magnet: magnet,
      imdbId: movie['imdb_id'],
      mediaType: 'movie',
      tmdbId: movie['id'],
      artwork: LibraryService.artworkOf(movie),
      startAt,
      adult: !!movie['adult'],
    });
  }
}
