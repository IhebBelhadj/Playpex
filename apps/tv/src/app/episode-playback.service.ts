import { Injectable } from '@angular/core';
import { catchError, defaultIfEmpty, map, Observable, of, switchMap } from 'rxjs';
import { CatalogDetails, EpisodeItem, MoviesService } from './movies.service';
import { NotificationService } from './notification.service';
import { PlaybackService, PlaybackSource } from './playback.service';
import { LibraryService } from './library.service';
import { PlayChoiceService } from './play-choice.service';
import { PlaySource, PlaySourcesService, SourcesQuery } from './play-sources.service';

// Playing one episode of a show, shared by the show page and the episode page:
// with a saved position, Resume / Play from the beginning first; then the
// episode's sources (the server's play pipeline: files on the server, its
// downloads, plugins' streams and torrents) → a lone file on the
// server plays at once, else the Play chooser → the player
// (PlaybackService.play). Download picks among torrents only (chooseRelease).

export interface EpisodeTarget {
  show: CatalogDetails;      // the show's page (catalog)
  imdbId: string;
  season: number;
  episode: EpisodeItem;      // the catalog's episode (+ upcoming)
}

// The player's "Up next": the episode and the source that would play
export interface NextEpisode extends EpisodeTarget {
  code: string;              // S01E02
  source: PlaySource | null; // best source (null: none found, or not looked up yet)
}

@Injectable({
  providedIn: 'root'
})
export class EpisodePlaybackService {

  // "<tmdbId>x<season>x<episode>" while its state / torrents are looked up
  resolving:string | null = null;

  constructor(
    private notificationService:NotificationService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
    private playback:PlaybackService,
    private movies:MoviesService,
    private sources:PlaySourcesService,
  ) { }

  static code(season:number, episode:number):string {
    let pad = n => (n < 10 ? '0' : '') + n;
    return `S${pad(season)}E${pad(episode)}`;
  }

  static keyOf(show:{ tmdbId:number } | null, season:number, episode:number):string {
    return `${show?.tmdbId}x${season}x${episode}`;
  }

  isResolving(show:{ tmdbId:number } | null, season:number, episode:number):boolean {
    return this.resolving === EpisodePlaybackService.keyOf(show, season, episode);
  }

  play(target:EpisodeTarget) {
    let ep = target.episode;
    if (!ep || this.resolving !== null) return;
    let code = EpisodePlaybackService.code(target.season, ep.episodeNumber);

    if (ep.upcoming) {
      this.notificationService.sendNotification("error", `${code} hasn't aired yet`);
      return;
    }

    let key = { mediaType: 'tv' as const, tmdbId: Number(target.show.tmdbId), season: target.season, episode: ep.episodeNumber };
    this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, ep.episodeNumber);
    // no current profile: state() completes empty → play as usual
    this.library.state(key).pipe(defaultIfEmpty({ resume: null, finished: false })).subscribe({
      next: state => {
        this.resolving = null;
        let resume = state.resume;
        if (!resume) {
          this.findAndPlay(target, code);
          return;
        }
        this.playChoice.choose(`${target.show.title} ${code}`, resume).subscribe(choice => {
          if (choice == 'restart') this.findAndPlay(target, code, 0);
          // same file / release as last time, so the saved position matches
          else if (resume.fileId) this.findAndPlay(target, code, resume.positionS, source => source.ref == 'f_' + resume.fileId);
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
    let aired = ep => !!ep?.airDate && new Date(ep.airDate) <= new Date();
    return this.movies.getTvDetails(tmdbId).pipe(
      switchMap(show => this.movies.getTvSeason(tmdbId, season).pipe(
        switchMap(current => {
          let ep = (current.episodes || []).find(e => e.episodeNumber == episode + 1);
          if (ep) return of({ season, ep });
          let following = (show.seasons || [])
            .map(x => x.seasonNumber)
            .filter(n => n > season)
            .sort((a, b) => a - b)[0];
          if (following === undefined) return of(null);
          return this.movies.getTvSeason(tmdbId, following).pipe(
            map(next => ({ season: following, ep: (next.episodes || [])[0] })),
          );
        }),
        map(found => {
          if (!found?.ep || !aired(found.ep)) return null;
          return {
            show,
            imdbId: imdbId || show.imdbId,
            season: found.season,
            episode: found.ep,
            code: EpisodePlaybackService.code(found.season, found.ep.episodeNumber),
            source: null,
          } as NextEpisode;
        }),
      )),
      catchError(() => of(null)),
    );
  }

  // Its best source (the server's ranking: a file on the server first when
  // the profile prefers them, else the first that plays here), looked up
  // ahead so "Play next" starts at once
  bestSource(next:NextEpisode):Observable<PlaySource | null> {
    return this.sources.find(EpisodePlaybackService.query(next)).pipe(
      map(result => PlaySourcesService.best(result)),
      catchError(() => of(null)),
    );
  }

  // From the player: straight to that source, no picker, from the next
  // episode's saved position if it has one, in place of the current player
  playNext(next:NextEpisode) {
    if (!next.source) return;
    let key = { mediaType: 'tv' as const, tmdbId: Number(next.show.tmdbId), season: next.season, episode: next.episode.episodeNumber };
    // through the server's plugins first (they may ask, refuse, or give a stream)
    this.sources.start(next.source).subscribe(source => {
      this.library.state(key).pipe(defaultIfEmpty({ resume: null, finished: false }), catchError(() => of({ resume: null }))).subscribe(state => {
        let resume = state.resume;
        this.start(next, next.code, PlaybackService.target(source), resume ? resume.positionS : 0, true);
      });
    });
  }

  static query(target:EpisodeTarget):SourcesQuery {
    return {
      kind: 'episode',
      tmdbId: Number(target.show.tmdbId),
      imdbId: target.imdbId,
      title: target.show.title,
      year: PlaySourcesService.year(target.show.releaseDate),
      season: target.season,
      episode: target.episode.episodeNumber,
    };
  }

  private findAndPlay(target:EpisodeTarget, code:string, startAt?:number, prefer?:(source:PlaySource) => boolean) {
    this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, target.episode.episodeNumber);
    this.sources.choose(EpisodePlaybackService.query(target), `${target.show.title} ${code}`, { prefer, looked: () => this.resolving = null })
      .subscribe(source => this.start(target, code, PlaybackService.target(source), startAt));
  }

  /**
   * The episode's torrents (the server's play pipeline: plugins' torrent
   * sources) → the Play chooser, torrents only → the picked one (with its
   * `magnet`); completes empty on Back. The Download action's.
   */
  chooseRelease(target:EpisodeTarget):Observable<PlaySource> {
    let ep = target.episode, code = EpisodePlaybackService.code(target.season, ep.episodeNumber);
    this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, ep.episodeNumber);
    return this.sources.choose(EpisodePlaybackService.query(target), `${target.show.title} ${code}`,
      { kind: 'download', only: ['torrent'], looked: () => this.resolving = null });
  }

  private start(target:EpisodeTarget, code:string, what:{ magnet?:string, source?:PlaybackSource }, startAt?:number, replace = false) {
    let ep = target.episode;
    this.playback.play({
      title: target.show.title,
      subtitle: `${code} · ${ep.name}`,
      year: (ep.airDate || '').slice(0, 4),
      runtimeMinutes: ep.runtime,
      ...what,
      imdbId: target.imdbId,
      season: target.season,
      episode: ep.episodeNumber,
      mediaType: 'tv',
      tmdbId: target.show.tmdbId,
      artwork: LibraryService.artworkOf(target.show),
      startAt,
    }, { replace });
  }
}
