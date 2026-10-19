import { Injectable } from '@angular/core';
import { defaultIfEmpty } from 'rxjs';
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

  private findAndPlay(target:EpisodeTarget, code:string, startAt?:number) {
    if (!target.imdbId) {
      this.notificationService.sendNotification("error", "This show has no IMDb id, so torrents can't be looked up");
      return;
    }

    let ep = target.episode;
    this.resolving = EpisodePlaybackService.keyOf(target.show, target.season, ep.episode_number);
    this.torrentService.findEpisodeTorrents(target.imdbId, target.show['name'], target.season, ep.episode_number)
      .subscribe(result => {
        this.resolving = null;
        if (!result.torrents.length) {
          let reason = result.providerErrors ? " (some providers are unreachable)" : "";
          this.notificationService.sendNotification("error", `No torrents found for ${code}${reason}`);
          return;
        }

        let options = result.torrents.map((torrent, i) => TorrentPickerService.fromEpisode(torrent, i));
        this.torrentPicker.choose(`${target.show['name']} ${code}`, options)
          .subscribe(choice => this.start(target, code, choice.torrent, startAt));
      }, () => {
        this.resolving = null;
        this.notificationService.sendNotification("error", "Couldn't reach the torrent providers. Try again later");
      });
  }

  private start(target:EpisodeTarget, code:string, torrent, startAt?:number) {
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
    });
  }
}
