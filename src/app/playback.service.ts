import { Injectable } from '@angular/core';

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
  playMovie(movie, torrent = movie['torrents'][0]) {
    let magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie['original_title'] + torrent.quality)}`;
    TRACKERS.forEach(tracker => magnet += "&tr=" + tracker);

    this.play({
      title: movie['original_title'],
      year: (movie['release_date'] || '').slice(0, 4),
      runtimeMinutes: movie['runtime'],
      magnet: magnet,
      imdbId: movie['imdb_id'],
    });
  }
}
