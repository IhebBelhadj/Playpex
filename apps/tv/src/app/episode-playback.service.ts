import { Injectable } from '@angular/core';
import { catchError, defaultIfEmpty, map, Observable, of, switchMap } from 'rxjs';
import { MoviesService } from './movies.service';
import { NotificationService } from './notification.service';
import { PlaybackService } from './playback.service';
import { TorrentService } from './torrent.service';
import { TorrentPickerService } from './torrent-picker.service';
import { LibraryService } from './library.service';
import { PlayChoiceService } from './play-choice.service';

// Playing one episode of a show, shared by the show page and the episode page:
// with a saved position, Resume / Play from the beginning first; then the
// episode's torrents (EZTV + TheRARBG via the server, best match first) → the
// torrent picker → the player (PlaybackService.play).

export interface EpisodeTarget {
  show: any;                 // TMDB show details
  imdbId: string;
  season: number;
  episode: any;              // TMDB episode (episode_number, name, air_date, runtime, upcoming)
}

// The player's "Up next": the episode and the release that would play
export interface NextEpisode extends EpisodeTarget {
  code: string;              // S01E02
  torrent: any | null;       // best match (null: none found, or not looked up yet)
}

@Injectable({
  providedIn: 'root'
})
export class EpisodePlaybackService {

  // "<tmdbId>x<season>x<episode>" while its state / torrents are looked up
  resolving:string | null = null;

  constructor(
    private notificationService:NotificationService,
    private torrentService:TorrentService,
    private torrentPicker:TorrentPickerService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
    private playback:PlaybackService,
    private movies:MoviesService,
  ) { }

  static code(season:number, episode:number):string {
    let pad = n => (n < 10 ? '0' : '') + n;
    return `S${pad(season)}E${pad(episode)}`;
  }

  static keyOf(show:any, season:number, episode:number):string {
    return `${show?.['id']}x${season}x${episode}`;
  }

  isResolving(show:any, season:number, episode:number):boolean {
    return this.resolving === EpisodePlaybackService.keyOf(show, season, episode);
  }

  play(target:EpisodeTarget) {
    let ep = target.episode;
    if (!ep || this.resolving !== null) return;
    let code = EpisodePlaybackService.code(target.season, ep.episode_number);

    if (ep.upcoming) {
      this.notificationService.sendNotification("error", `${code} hasn't aired yet`);
      return;
    }

    let key = { mediaType: 'tv' as const, tmdbId: Number(target.show['id']), season: target.season, episode: ep.episode_number };
    this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, ep.episode_number);
    // no current profile: state() completes empty → play as usual
    this.library.state(key).pipe(defaultIfEmpty({ resume: null, finished: false })).subscribe({
      next: state => {
        this.resolving = null;
        let resume = state.resume;
        if (!resume) {
          this.findAndPlay(target, code);
          return;
        }
        this.playChoice.choose(`${target.show['name']} ${code}`, resume).subscribe(choice => {
          if (choice == 'restart') this.findAndPlay(target, code, 0);
          // same release as last time, so the saved position matches
          else if (resume.infoHash) this.start(target, code, { magnet: resume.infoHash }, resume.positionS);
          else this.findAndPlay(target, code, resume.positionS);
        });
      },
      // no saved state (or no server): play as usual
      error: () => {
        this.resolving = null;
        this.findAndPlay(target, code);
      },
    });
  }

  // ── the next episode (the player's "Up next") ────────────────────────────

  // The episode after `season` / `episode`: the next one of its season, else
  // the first of the following season; null when there is none that has aired
  next(tmdbId:number, season:number, episode:number, imdbId?:string):Observable<NextEpisode | null> {
    let aired = ep => !!ep?.['air_date'] && new Date(ep['air_date']) <= new Date();
    return this.movies.getTvDetails(tmdbId).pipe(
      switchMap((show:any) => this.movies.getTvSeason(tmdbId, season).pipe(
        switchMap((current:any) => {
          let ep = (current['episodes'] || []).find(e => e['episode_number'] == episode + 1);
          if (ep) return of({ season, ep });
          let following = (show['seasons'] || [])
            .map(x => x['season_number'])
            .filter(n => n > season)
            .sort((a, b) => a - b)[0];
          if (following === undefined) return of(null);
          return this.movies.getTvSeason(tmdbId, following).pipe(
            map((next:any) => ({ season: following, ep: (next['episodes'] || [])[0] })),
          );
        }),
        map(found => {
          if (!found?.ep || !aired(found.ep)) return null;
          return {
            show,
            imdbId: imdbId || show['external_ids']?.['imdb_id'],
            season: found.season,
            episode: found.ep,
            code: EpisodePlaybackService.code(found.season, found.ep['episode_number']),
            torrent: null,
          } as NextEpisode;
        }),
      )),
      catchError(() => of(null)),
    );
  }

  // Its best release (the server's ranking; the first that plays here when
  // the ranking has one), looked up ahead so "Play next" starts at once
  bestTorrent(next:NextEpisode):Observable<any | null> {
    if (!next.imdbId) return of(null);
    return this.torrentService.findEpisodeTorrents(next.imdbId, next.show['name'], next.season, next.episode['episode_number']).pipe(
      map(result => result.torrents.find(t => t['playable'] !== false && t['audio'] != 'unsupported') || result.torrents[0] || null),
      catchError(() => of(null)),
    );
  }

  // From the player: straight to that release, no picker, from the next
  // episode's saved position if it has one, in place of the current player
  playNext(next:NextEpisode) {
    if (!next.torrent) return;
    let key = { mediaType: 'tv' as const, tmdbId: Number(next.show['id']), season: next.season, episode: next.episode['episode_number'] };
    this.library.state(key).pipe(defaultIfEmpty({ resume: null, finished: false }), catchError(() => of({ resume: null }))).subscribe(state => {
      let resume = state.resume;
      this.start(next, next.code, next.torrent, resume ? resume.positionS : 0, true);
    });
  }

  private findAndPlay(target:EpisodeTarget, code:string, startAt?:number) {
    this.chooseRelease(target).subscribe(torrent => this.start(target, code, torrent, startAt));
  }

  /**
   * The episode's releases (the server's ranking) → the torrent picker →
   * the picked torrent (with its `magnet`); completes empty on Back or when
   * nothing is found (the user is told). Play and Download use it.
   */
  chooseRelease(target:EpisodeTarget):Observable<any> {
    return new Observable(subscriber => {
      if (!target.imdbId) {
        this.notificationService.sendNotification("error", "This show has no IMDb id, so torrents can't be looked up");
        subscriber.complete();
        return undefined;
      }
      let ep = target.episode, code = EpisodePlaybackService.code(target.season, ep.episode_number);
      this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, ep.episode_number);
      let picking = null;
      let lookup = this.torrentService.findEpisodeTorrents(target.imdbId, target.show['name'], target.season, ep.episode_number)
        .subscribe(result => {
          this.resolving = null;
          if (!result.torrents.length) {
            let reason = result.providerErrors ? " (some providers are unreachable)" : "";
            this.notificationService.sendNotification("error", `No torrents found for ${code}${reason}`);
            subscriber.complete();
            return;
          }
          let options = result.torrents.map((torrent, i) => TorrentPickerService.fromEpisode(torrent, i));
          picking = this.torrentPicker.choose(`${target.show['name']} ${code}`, options).subscribe({
            next: choice => subscriber.next(choice.torrent),
            complete: () => subscriber.complete(),
          });
        }, () => {
          this.resolving = null;
          this.notificationService.sendNotification("error", "Couldn't reach the torrent providers. Try again later");
          subscriber.complete();
        });
      return () => {
        lookup.unsubscribe();
        picking?.unsubscribe();
      };
    });
  }

  private start(target:EpisodeTarget, code:string, torrent, startAt?:number, replace = false) {
    let ep = target.episode;
    this.playback.play({
      title: target.show['name'],
      subtitle: `${code} · ${ep.name}`,
      year: (ep.air_date || '').slice(0, 4),
      runtimeMinutes: ep.runtime,
      magnet: torrent.magnet,
      imdbId: target.imdbId,
      season: target.season,
      episode: ep.episode_number,
      mediaType: 'tv',
      tmdbId: target.show['id'],
      artwork: LibraryService.artworkOf(target.show),
      startAt,
      adult: !!target.show['adult'],
    }, { replace });
  }
}
