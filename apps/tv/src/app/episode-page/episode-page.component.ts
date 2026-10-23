import { profileContext, titleRef } from '../slot-contexts';
import { ProfilesService } from '../profiles.service';
import { formatDate } from '@angular/common';
import { MediaKeys } from '../media-keys.service';
import { Component, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { forkJoin, Observable, Subscription } from 'rxjs';
import { MenuServiceService } from '../menu-service.service';
import { MoviesService } from '../movies.service';
import { NavigationService } from '../navigation.service';
import { NotificationService } from '../notification.service';
import { BackgroundService } from '../background.service';
import { EpisodeKey, EpisodeProgress, LibraryService, PlaybackState } from '../library.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { ReleasesService } from '../releases.service';
import { EpisodePlaybackService } from '../episode-playback.service';
import { Download, DownloadTile, DownloadsService } from '../downloads.service';
import { ServerLibraryService } from '../server-library.service';
import { ImdbEpisode, ImdbSeries, ImdbService } from '../imdb.service';
import { Navigator, useScreen } from '../nav/public-api';
import { Badge, EpisodeContext, MetaItem, TitleInfoModel, tmdbImageBase } from '../ui/public-api';
import { Toasts } from '../ui/public-api';

// One episode of a show (/shows/show/:id/season/:season/episode/:episode),
// laid out like the movie page: the episode's title block (IMDb rating and
// votes, TMDB score, air date, runtime, overview, director / writers), Play
// (or Resume) / Find releases (this episode's releases) / Mark as watched,
// then the season's episodes (with the season's IMDb curve; Enter shows that
// episode here, replacing this one in the history: Navigator.replace, the
// component stays) and the guest stars. Movement: the buttons (`pxGrid`) and
// both rows are entries of movies-page's scrolling `.pageContainer` stack.
// Back → the show page (the nav system's pop).
@Component({
  selector: 'app-episode-page',
  templateUrl: './episode-page.component.html',
  styleUrls: ['./episode-page.component.scss']
})
export class EpisodePageComponent implements AfterViewInit, OnDestroy {

  private toasts = inject(Toasts);

  private profiles = inject(ProfilesService);

  private downloads = inject(DownloadsService);
  // the server's download of this episode: the Download tile
  download:Download | null = null;
  downloadTile:DownloadTile = DownloadsService.tile(null);
  private downloadSub:Subscription | null = null;
  // the show's episodes with a file on the Playpex server ("<season>x<episode>"), live
  private serverLibrary = inject(ServerLibraryService);
  private onServer = new Set<string>();
  private onServerSub:Subscription | null = null;

  stillBase = tmdbImageBase('still', 270);
  profileBase = tmdbImageBase('profile', 130);

  show;
  imdbId:string;
  seasonNumber:number;
  seasonName = '';
  episodes = [];
  episode;
  directors:string[] = [];
  writers:string[] = [];
  guests = [];

  imdb:ImdbSeries = null;
  imdbEpisode:ImdbEpisode = null;
  topOfSeason = false;              // the season's best-rated episode
  focusedEpisode:number = null;     // lights its bar in the season curve

  // The current profile's state for this episode / the season's episodes
  watched = false;
  resumeLabel = '';
  resumeRatio = 0;
  private episodeProgress = new Map<string, EpisodeProgress>();
  private libraryBusy = false;

  private loaded:{ showId:string, season:number } = null;
  private subscriptions:Subscription[] = [];
  private focusListener;
  private today = new Date().toISOString().slice(0, 10);
  // params { id, season, episode }; another episode replaces the entry (`reuse`)
  private screen = useScreen<{ id:string, season:string, episode:string }>();
  // a remote's Play key = the Play button (§13.2)
  private mediaSub = inject(MediaKeys).for(this.screen).subscribe(a => (a == 'playPause' || a == 'play') && this.play());

  constructor(
    private navigator:Navigator,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private menu:MenuServiceService,
    private notificationService:NotificationService,
    private background:BackgroundService,
    private library:LibraryService,
    private releases:ReleasesService,
    private episodePlayback:EpisodePlaybackService,
    private imdbService:ImdbService,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  ngAfterViewInit(): void {
    this.menu.sendInstruction('collapse', this);

    // section `episodePage` is a pxSection in the template
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: "self-only",
      leaveFor: {
        right: '@episodePage'
      }
    });

    this.subscriptions.push(
      this.screen.params$.subscribe(params => this.load(params.id, Number(params.season), Number(params.episode))),
    );

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  // the title block (<px-title-info>): IMDb (+ votes), TMDB, air date, runtime,
  // best of the season, watched; overview; director / writers
  get titleInfo():TitleInfoModel {
    let ep = this.episode;
    let meta:MetaItem[] = [];
    if (this.imdbEpisode?.rating) {
      meta.push({ kind: 'score', source: 'imdb', value: this.imdbEpisode.rating,
        votes: this.imdbEpisode.votes ? this.votes(this.imdbEpisode.votes) + ' votes' : null });
    }
    if (ep.vote_average) meta.push({ kind: 'score', source: 'tmdb', value: ep.vote_average });
    if (ep.air_date) meta.push({ kind: 'text', small: true, text: (ep.upcoming ? 'Airs ' : 'Aired ') + formatDate(ep.air_date, 'd MMMM y', 'en-US') });
    if (ep.runtime) meta.push({ kind: 'chip', text: ep.runtime + ' min' });
    if (this.topOfSeason) meta.push({ kind: 'chip', text: 'Best rated of season ' + this.seasonNumber });
    if (this.watched) meta.push({ kind: 'chip', text: 'Watched', icon: 'tick' });
    if (this.onServer.has(`${this.seasonNumber}x${ep.episode_number}`)) meta.push({ kind: 'chip', text: 'On this server', icon: 'server' });
    let credits = [];
    if (this.directors.length) credits.push({ label: 'Directed by', names: this.directors });
    if (this.writers.length) credits.push({ label: 'Written by', names: this.writers.slice(0, 3) });
    return {
      eyebrow: this.show?.name || '',
      title: ep.name,
      meta,
      overview: ep.overview || '',
      overviewFallback: 'No description for this episode yet.',
      credits,
    };
  }

  // what plugins' actions on this page get (ui/slots)
  slotContext:EpisodeContext | null = null;

  byEpisode = (i:number, ep:any) => ep.episode_number;
  byCredit = (i:number, g:any) => g.credit_id;

  // an episode card's runtime and air date
  episodeMeta(ep):string[] {
    let meta = [];
    if (ep.runtime) meta.push(ep.runtime + ' min');
    if (ep.air_date) meta.push(formatDate(ep.air_date, 'd MMM y', 'en-US'));
    return meta;
  }

  // this page's own episode is marked; others: upcoming, watched
  episodeBadges(ep):Badge[] | null {
    if (ep === this.episode) return ['current'];
    if (ep.upcoming) return ['upcoming'];
    let badges:Badge[] = [];
    if (this.progressOf(ep)?.finished) badges.push('watched');
    if (this.onServer.has(`${this.seasonNumber}x${ep.episode_number}`)) badges.push('server');
    return badges.length ? badges : null;
  }

  // The server's download of this episode, live
  private watchDownload() {
    this.downloadSub?.unsubscribe();
    this.download = null;
    this.downloadTile = DownloadsService.tile(null);
    if (!this.show || !this.episode) return;
    this.downloadSub = this.downloads.forTitle(this.downloadRef()).subscribe(d => {
      this.download = d;
      this.downloadTile = DownloadsService.tile(d);
    });
  }

  private downloadRef() {
    return { mediaType: 'tv' as const, tmdbId: Number(this.show['id']), season: this.seasonNumber, episode: this.episode.episode_number };
  }

  // Download: a release of this episode kept on the server (the same lookup and
  // picker as Play); one already there is started again, or just reported
  onDownload() {
    let d = this.download, title = `${this.show['name']} · ${this.code}`;
    if (d) {
      if (['paused', 'error'].includes(d.state)) {
        this.downloads.start(d.infoHash).subscribe({
          next: () => this.toasts.show({ text: 'Downloading again', detail: title, tone: 'success', key: 'download' }),
          error: () => this.toasts.show({ text: "Couldn't start the download", tone: 'error', key: 'download' }),
        });
      } else {
        this.toasts.show({ text: this.downloadTile.label, detail: title, tone: 'info', key: 'download' });
      }
      return;
    }
    if (this.episode?.upcoming) {
      this.notificationService.sendNotification("error", `${this.code} hasn't aired yet`);
      return;
    }
    let ref = this.downloadRef();
    this.episodePlayback.chooseRelease({ show: this.show, imdbId: this.imdbId, season: this.seasonNumber, episode: this.episode })
      .subscribe(torrent => this.downloads.add(torrent.magnet, ref, title).subscribe({
        next: added => this.toasts.show({
          text: added.state === 'queued' ? 'Queued on the server' : 'Downloading on the server',
          detail: title, tone: 'success', key: 'download',
        }),
        error: () => this.toasts.show({ text: "Couldn't start the download", detail: 'Is the Playpex server running?', tone: 'error', key: 'download' }),
      }));
  }

  ngOnDestroy(): void {
    this.downloadSub?.unsubscribe();
    this.onServerSub?.unsubscribe();
    this.mediaSub.unsubscribe();
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
  }

  // Another episode of the same season only swaps the episode
  load(showId:string, season:number, episodeNumber:number) {
    if (this.loaded?.showId === showId && this.loaded?.season === season) {
      this.showEpisode(episodeNumber);
      return;
    }

    this.loaded = { showId, season };
    this.positions.clear('seasonEpisodes');
    this.positions.clear('guests');
    this.imdb = null;
    forkJoin([this.moviesService.getTvDetails(showId), this.moviesService.getTvSeason(showId, season)])
      .subscribe(([show, seasonData]) => {
        this.show = show;
        this.imdbId = show['external_ids']?.['imdb_id'];
        this.seasonNumber = season;
        this.seasonName = seasonData['name'];
        this.episodes = (seasonData['episodes'] || []).map(ep => ({
          ...ep,
          upcoming: !ep.air_date || ep.air_date > this.today
        }));
        this.showEpisode(episodeNumber, true);
        this.onServerSub?.unsubscribe();
        this.onServerSub = this.serverLibrary.live('tv', Number(show['id'])).subscribe(title => {
          this.onServer = ServerLibraryService.episodesOf(title);
        });
        this.loadImdb();
        this.loadSeasonProgress();
      }, () => {
        this.notificationService.sendNotification("error", "Couldn't load this episode");
      });
  }

  showEpisode(episodeNumber:number, focusPlay = false) {
    let episode = this.episodes.find(ep => ep.episode_number === episodeNumber);
    if (!episode) {
      this.notificationService.sendNotification("error", `This season has no episode ${episodeNumber}`);
      return;
    }
    this.episode = episode;
    this.slotContext = this.show ? {
      show: titleRef(this.show, this.show['external_ids']?.['imdb_id']), season: this.seasonNumber,
      episode: episode.episode_number, profile: profileContext(this.profiles.current.value),
    } : null;
    let crew = episode['crew'] || [];
    this.directors = crew.filter(c => c.job == 'Director').map(c => c.name);
    this.writers = Array.from(new Set<string>(crew
      .filter(c => c.department == 'Writing')
      .map(c => c.name)));
    this.guests = (episode['guest_stars'] || []).filter(g => g.profile_path);
    this.positions.clear('guests');
    document.querySelectorAll('.episodePageContainer .guestsRow').forEach(row => row.scrollLeft = 0);

    this.background.sendImage(episode['still_path'] || this.show['backdrop_path']);
    this.updateImdb();
    this.loadEpisodeState();
    this.watchDownload();

    if (focusPlay) {
      setTimeout(() => {
        (document.querySelector('.episodePageContainer [data-px-key="play"]') as HTMLElement)?.focus({ preventScroll: true });
        this.rememberCurrentCard();
      }, 0);
    }
  }

  // Down into the season's row lands on this episode's card, already in view
  private rememberCurrentCard() {
    let row = this.engine.find('row:seasonEpisodes');
    let index = this.episodes.indexOf(this.episode);
    let card = row?.host.querySelector(`.episodeBtn[data-index="${index}"]`) as HTMLElement;
    if (!card) return;
    row.remember(card, index);
    row.reveal(card, true);
  }

  // ── ratings ───────────────────────────────────────────────────────────────

  loadImdb() {
    let show = this.show;
    if (!this.imdbId) return;
    this.imdbService.episodes(this.imdbId).subscribe(series => {
      if (show !== this.show) return;
      this.imdb = series;
      this.updateImdb();
    });
  }

  updateImdb() {
    if (!this.episode) return;
    this.imdbEpisode = ImdbService.episode(this.imdb, this.seasonNumber, this.episode.episode_number);
    let season = this.seasonImdb;
    let best = Math.max(...(season?.episodes || []).map(e => e.rating || 0));
    this.topOfSeason = !!this.imdbEpisode?.rating && (season?.rated || 0) > 2 && this.imdbEpisode.rating === best;
  }

  get seasonImdb() {
    return ImdbService.season(this.imdb, this.seasonNumber);
  }

  episodeRating(ep):number | null {
    return ImdbService.episode(this.imdb, this.seasonNumber, ep.episode_number)?.rating || null;
  }

  votes(count:number):string {
    return ImdbService.votes(count);
  }

  // ── the profile's state ───────────────────────────────────────────────────

  private key():EpisodeKey {
    return { mediaType: 'tv', tmdbId: Number(this.show['id']), season: this.seasonNumber, episode: this.episode.episode_number };
  }

  loadSeasonProgress() {
    this.episodeProgress.clear();
    this.library.episodesProgress({ mediaType: 'tv', tmdbId: Number(this.show['id']) }).subscribe({
      next: list => list.forEach(p => this.episodeProgress.set(`${p.season}x${p.episode}`, p)),
      error: () => {},
    });
  }

  loadEpisodeState() {
    this.watched = false;
    this.resumeLabel = '';
    this.resumeRatio = 0;
    let episode = this.episode;
    this.library.state(this.key()).subscribe({
      next: (state:PlaybackState) => {
        if (episode !== this.episode) return;
        this.watched = state.finished;
        if (state.resume) {
          let minutes = Math.round((state.resume.durationS - state.resume.positionS) / 60);
          this.resumeLabel = `Resume (${Math.max(1, minutes)} min left)`;
          this.resumeRatio = state.resume.durationS ? state.resume.positionS / state.resume.durationS : 0;
        }
      },
      error: () => {},
    });
  }

  // Shown on the episode cards: a watched badge, or a bar once it's started
  progressOf(ep):EpisodeProgress | null {
    let progress = this.episodeProgress.get(`${this.seasonNumber}x${ep.episode_number}`);
    return progress && (progress.finished || progress.ratio >= 0.02) ? progress : null;
  }

  toggleWatched() {
    if (this.libraryBusy || !this.episode) return;
    this.libraryBusy = true;
    let marking = !this.watched;
    let key = this.key();
    this.watched = marking;
    let request:Observable<unknown> = marking
      ? this.library.markWatched(key, LibraryService.artworkOf(this.show))
      : this.library.markUnwatched(key);
    request.subscribe({
      next: () => {
        this.libraryBusy = false;
        this.toasts.show({ text: marking ? 'Marked as watched' : 'Marked as not watched', tone: 'success', key: 'library' });
        this.resumeLabel = '';
        this.resumeRatio = 0;
        this.episodeProgress.set(`${key.season}x${key.episode}`, { season: key.season, episode: key.episode, ratio: marking ? 1 : 0, finished: marking });
      },
      error: () => {
        this.libraryBusy = false;
        this.watched = !marking;
        this.toasts.show({ text: "Couldn't update what you've watched", detail: 'Is the Playpex server running?', tone: 'error', key: 'library' });
      }
    });
  }

  // ── actions ───────────────────────────────────────────────────────────────

  get code():string {
    return EpisodePlaybackService.code(this.seasonNumber, this.episode?.episode_number);
  }

  get resolving():boolean {
    return !!this.episode && this.episodePlayback.isResolving(this.show, this.seasonNumber, this.episode.episode_number);
  }

  play() {
    if (!this.episode) return;
    this.episodePlayback.play({ show: this.show, imdbId: this.imdbId, season: this.seasonNumber, episode: this.episode });
  }

  // Every source's releases of this episode ("<show> S02E05"); one played from
  // there counts as this show's (progress, subtitles)
  findReleases() {
    if (!this.episode) return;
    let title = this.show['name'];
    let query = `${title} ${this.code}`;
    this.releases.open('tv', query, {
      label: `${title} ${this.code}`,
      context: {
        mediaType: 'tv',
        tmdbId: Number(this.show['id']),
        imdbId: this.imdbId,
        title,
        year: (this.show['first_air_date'] || '').slice(0, 4),
        artwork: LibraryService.artworkOf(this.show),
      },
    }, this.imdbId || null);
  }

  // Another episode of the season, in place of this one (Back: the show)
  openEpisode(ep) {
    if (!ep || ep === this.episode) return;
    this.navigator.replace({ screen: 'core.episode', params: { id: this.show['id'], season: this.seasonNumber, episode: ep.episode_number } });
  }

  onFocus(node:HTMLElement) {
    if (!this.screen.active) return;
    this.focusedEpisode = node.dataset['episode'] !== undefined
      ? this.episodes[Number(node.dataset['index'])]?.episode_number ?? null
      : null;
  }
}
