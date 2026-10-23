import { Injectable } from '@angular/core';
import { Artwork, LibraryService, MediaType } from './library.service';
import { Navigator } from './nav/navigator.service';
import type { PlaySource } from './play-sources.service';

// A file the server has (POST /play/sources: a library file, a download's
// file), played through /media/{ref} with no torrent request
export interface PlaybackSource {
  ref: string;
  infoHash?: string;        // a download's file: its torrent (stats, progress)
  path?: string;            //   and its path in it
}

// What the player plays: the payload of its screen (core.player), opened by
// PlaybackService.play().
export interface PlaybackRequest {
  title: string;            // movie or show title
  subtitle?: string;        // e.g. "S01E03 · The Bear"; shown instead of year/runtime
  year?: string;
  runtimeMinutes?: number;
  // what plays: a torrent (`magnet`, or an info hash it already has), or a
  // file on the server (`source`)
  magnet?: string;
  source?: PlaybackSource;
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
  // none: played without touching the profile's library: no resume point,
  // progress, history, Up next or markers, no title on the keepalive (so the
  // download isn't named and no playback event names it). Set for an
  // `audience: adults` plugin's plays, and any plugin may ask for it
  tracking?: 'full' | 'none';
  // Development builds only: a video URL played directly, no torrent (the
  // player's screenshots and scenarios: window.playpexDev.player())
  devSrc?: string;
}

let session = 0;

// The server also adds its maintained list (apps/server/lib/trackers.js)
// to every torrent, so this only needs a couple of reliable ones
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
];

@Injectable({
  providedIn: 'root'
})
export class PlaybackService {

  constructor(private navigator:Navigator) { }

  // A movie torrent's magnet: its own, else built from the YTS hash
  static movieMagnet(movie, torrent):string {
    let magnet = torrent.magnet;
    if (!magnet) {
      magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie['original_title'] + torrent.quality)}`;
      TRACKERS.forEach(tracker => magnet += "&tr=" + tracker);
    }
    return magnet;
  }

  // What a play source gives the player: its file, else its torrent
  static target(source:PlaySource):{ magnet?:string, source?:PlaybackSource } {
    if (source.ref) return { source: { ref: source.ref, infoHash: source.infoHash, path: source.path } };
    return { magnet: source.magnet || source.infoHash };
  }

  // The player, over the current screen (Back returns to it). `replace`: in
  // place of the current entry (the next episode, from the player itself).
  // Each playback is its own session (`player/:session`): a new component,
  // never the previous one reused by the router
  play(request: PlaybackRequest, options:{ replace?:boolean } = {}) {
    let intent = { screen: 'core.player', params: { session: (Date.now() + ++session).toString(36) }, payload: request };
    if (options.replace) this.navigator.replace(intent);
    else this.navigator.open(intent);
  }

  // Movie from MoviesService.selectedmovie, enriched with YTS `torrents`;
  // `torrent` is one of them (defaults to the first)
  // `torrent` needs only `hash` (+ `quality`): resuming passes the saved info hash.
  playMovie(movie, torrent = movie['torrents'][0], startAt?:number) {
    this.playMovieFrom(movie, { magnet: PlaybackService.movieMagnet(movie, torrent) }, startAt);
  }

  // The same with a play source's target (PlaybackService.target)
  playMovieFrom(movie, target:{ magnet?:string, source?:PlaybackSource }, startAt?:number) {
    this.play({
      title: movie['original_title'],
      year: (movie['release_date'] || '').slice(0, 4),
      runtimeMinutes: movie['runtime'],
      ...target,
      imdbId: movie['imdb_id'],
      mediaType: 'movie',
      tmdbId: movie['id'],
      artwork: LibraryService.artworkOf(movie),
      startAt,
    });
  }
}
