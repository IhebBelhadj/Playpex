import { profileContext, titleRef } from '../slot-contexts';
import { ProfilesService } from '../profiles.service';
import { formatDate } from '@angular/common';
import { MediaKeys } from '../media-keys.service';
import { Component, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { forkJoin, map, Observable, Subject, Subscription, switchMap } from 'rxjs';
import { MenuServiceService } from '../menu-service.service';
import { CatalogCredits, CatalogDetails, CatalogEpisode, CatalogTitle, EpisodeItem, MoviesService } from '../movies.service';
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
// (or Resume) / Download / Find releases (this episode's releases) / Mark as
// watched, then the show's seasons (as on the show page: a
// focused season shows its episodes in the row below), a season's episodes
// (with its IMDb curve; Enter shows that episode here, replacing this one in
// the history: Navigator.replace, the component stays), the show's cast, the
// episode's guest stars and similar shows (Enter: that show's page, over this
// one). Movement: the buttons (`pxGrid`) and the rows are entries of
// movies-page's scrolling `.pageContainer` stack. Back → the page below (the
// show page when it came from there); the show's name above the title (a
// focusable trail, Up from the buttons) → the show page, on this season.
@Component({
  selector: 'app-episode-page',
  templateUrl: './episode-page.component.html',
  styleUrls: ['./episode-page.component.scss']
})
export class EpisodePageComponent implements AfterViewInit, OnDestroy {

  // Find releases: only with a plugin that lists releases
  releasesShown$ = inject(ReleasesService).available$;

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
  posterBase = tmdbImageBase('poster', 150);
  thumbBase = tmdbImageBase('poster', 92);

  show:CatalogDetails;
  imdbId:string;
  seasonNumber:number;
  seasonName = '';
  episodes:EpisodeItem[] = [];
  episode:EpisodeItem;
  directors:string[] = [];
  writers:string[] = [];
  guests:CatalogEpisode['guestStars'] = [];
  // the show's regular cast (with a photo), similar shows (with a poster)
  cast:CatalogCredits['cast'] = [];
  similar:CatalogTitle[] = [];

  // The seasons row and the season the episodes row shows (this page's own,
  // else the one focused in the seasons row)
  seasons:CatalogDetails['seasons'] = [];
  rowSeason:number;
  rowSeasonName = '';
  rowEpisodes:EpisodeItem[] = [];
  loadingRow = false;
  private rowRequests = new Subject<number>();

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

      // the season focused in the seasons row: its episodes in the row below
      // (the latest one wins); this page's own season is already there
      this.rowRequests.pipe(
        switchMap(season => {
          this.loadingRow = true;
          let show = this.show;
          return this.moviesService.getTvSeason(show.tmdbId, season).pipe(map(data => ({ show, season, data })));
        }),
      ).subscribe({
        next: ({ show, season, data }) => {
          this.loadingRow = false;
          if (show !== this.show) return;
          this.showRowSeason(season, data.name, season === this.seasonNumber ? this.episodes : this.withUpcoming(data.episodes));
        },
        error: () => {
          this.loadingRow = false;
          this.notificationService.sendNotification("error", "Couldn't load this season's episodes");
        },
      }),
    );

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  // the title block (<px-title-info>): IMDb (+ votes), else TMDB, air date, runtime,
  // best of the season, watched; overview; director / writers
  get titleInfo():TitleInfoModel {
    let ep = this.episode;
    let meta:MetaItem[] = [];
    if (this.imdbEpisode?.rating) {
      meta.push({ kind: 'score', source: 'imdb', value: this.imdbEpisode.rating,
        votes: this.imdbEpisode.votes ? this.votes(this.imdbEpisode.votes) + ' votes' : null });
    } else if (ep.voteAverage) {
      // TMDB's score only when IMDb has none
      meta.push({ kind: 'score', source: 'tmdb', value: ep.voteAverage });
    }
    if (ep.airDate) meta.push({ kind: 'text', small: true, text: (ep.upcoming ? 'Airs ' : 'Aired ') + formatDate(ep.airDate, 'd MMMM y', 'en-US') });
    if (ep.runtime) meta.push({ kind: 'chip', text: ep.runtime + ' min' });
    if (this.topOfSeason) meta.push({ kind: 'chip', text: 'Best rated of season ' + this.seasonNumber });
    if (this.watched) meta.push({ kind: 'chip', text: 'Watched', icon: 'tick' });
    if (this.onServer.has(`${this.seasonNumber}x${ep.episodeNumber}`)) meta.push({ kind: 'chip', text: 'On this server', icon: 'server' });
    let credits = [];
    if (this.directors.length) credits.push({ label: 'Directed by', names: this.directors });
    if (this.writers.length) credits.push({ label: 'Written by', names: this.writers.slice(0, 3) });
    return {
      // the show and the episode's place: the page's own trail above
      eyebrow: '',
      title: ep.name,
      meta,
      overview: ep.overview || '',
      overviewFallback: 'No description for this episode yet.',
      credits,
    };
  }

  // what plugins' actions on this page get (ui/slots)
  slotContext:EpisodeContext | null = null;

  byEpisode = (i:number, ep:EpisodeItem) => ep.episodeNumber;
  byCredit = (i:number, g:{ creditId:string }) => g.creditId;
  bySeason = (i:number, s:{ seasonNumber:number }) => s.seasonNumber;
  byTitle = (i:number, t:CatalogTitle) => t.tmdbId;

  // an episode card's runtime and air date
  episodeMeta(ep):string[] {
    let meta = [];
    if (ep.runtime) meta.push(ep.runtime + ' min');
    if (ep.airDate) meta.push(formatDate(ep.airDate, 'd MMM y', 'en-US'));
    return meta;
  }

  // this page's own episode is marked; others: upcoming, watched
  episodeBadges(ep):Badge[] | null {
    if (ep === this.episode) return ['current'];
    if (ep.upcoming) return ['upcoming'];
    let badges:Badge[] = [];
    if (this.progressOf(ep)?.finished) badges.push('watched');
    if (this.onServer.has(`${this.rowSeason}x${ep.episodeNumber}`)) badges.push('server');
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
    return { mediaType: 'tv' as const, tmdbId: Number(this.show.tmdbId), season: this.seasonNumber, episode: this.episode.episodeNumber };
  }

  // Download: a release of this episode kept on the server (the same lookup and
  // picker as Play); one already there is started again, or just reported
  onDownload() {
    let d = this.download, title = `${this.show.title} · ${this.code}`;
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
    this.positions.clear('cast');
    this.positions.clear('seasons');
    this.imdb = null;
    this.loadingRow = false;
    // the show's rows: asked again only for another show
    if (this.show && String(this.show.tmdbId) !== String(showId)) {
      this.cast = [];
      this.similar = [];
      this.seasons = [];
    }
    if (!this.cast.length) this.subscriptions.push(this.moviesService.getTvCredits(showId).subscribe({
      next: data => this.cast = (data.cast || []).filter(c => c.profilePath),
      error: () => {},
    }));
    if (!this.similar.length) this.subscriptions.push(this.moviesService.getSimilarShows(showId).subscribe({
      next: data => this.similar = ((data.results || []) as CatalogTitle[]).filter(t => t.posterPath && String(t.tmdbId) != String(showId)),
      error: () => {},
    }));
    forkJoin([this.moviesService.getTvDetails(showId), this.moviesService.getTvSeason(showId, season)])
      .subscribe(([show, seasonData]) => {
        this.show = show;
        this.imdbId = show.imdbId;
        this.seasonNumber = season;
        this.seasonName = seasonData.name;
        this.episodes = this.withUpcoming(seasonData.episodes);
        // regular seasons first, "Specials" (season 0) last
        this.seasons = (show.seasons || [])
          .filter(s => s.episodeCount > 0)
          .sort((a, b) => (a.seasonNumber || 1000) - (b.seasonNumber || 1000));
        this.rowSeason = season;
        this.rowSeasonName = seasonData.name;
        this.rowEpisodes = this.episodes;
        this.showEpisode(episodeNumber, true);
        this.onServerSub?.unsubscribe();
        this.onServerSub = this.serverLibrary.live('tv', Number(show.tmdbId)).subscribe(title => {
          this.onServer = ServerLibraryService.episodesOf(title);
        });
        this.loadImdb();
        this.loadSeasonProgress();
      }, () => {
        this.notificationService.sendNotification("error", "Couldn't load this episode");
      });
  }

  showEpisode(episodeNumber:number, focusPlay = false) {
    let episode = this.episodes.find(ep => ep.episodeNumber === episodeNumber);
    if (!episode) {
      this.notificationService.sendNotification("error", `This season has no episode ${episodeNumber}`);
      return;
    }
    this.episode = episode;
    this.slotContext = this.show ? {
      show: titleRef(this.show, this.show.imdbId), season: this.seasonNumber,
      episode: episode.episodeNumber, profile: profileContext(this.profiles.current.value),
    } : null;
    let crew = episode.crew || [];
    this.directors = crew.filter(c => c.job == 'Director').map(c => c.name);
    this.writers = Array.from(new Set<string>(crew
      .filter(c => c.department == 'Writing')
      .map(c => c.name)));
    this.guests = (episode.guestStars || []).filter(g => g.profilePath);
    this.positions.clear('guests');
    document.querySelectorAll('.episodePageContainer .guestsRow').forEach(row => row.scrollLeft = 0);

    this.background.sendImage(episode.stillPath || this.show.backdropPath);
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
    let card = row?.host.querySelector(`[data-px-key="${this.episode.episodeNumber}"]`) as HTMLElement;
    if (!card) return;
    row.remember(card, index);
    row.reveal(card, true);
  }

  private withUpcoming(episodes:CatalogEpisode[] | undefined):EpisodeItem[] {
    return (episodes || []).map(ep => ({ ...ep, upcoming: !ep.airDate || ep.airDate > this.today }));
  }

  // The episodes row shows another season: from its first episode (this
  // page's own season: from this episode)
  private showRowSeason(season:number, name:string, episodes:EpisodeItem[]) {
    this.rowSeason = season;
    this.rowSeasonName = name;
    this.rowEpisodes = episodes;
    this.focusedEpisode = null;
    this.positions.clear('seasonEpisodes');
    setTimeout(() => {
      if (season === this.seasonNumber) this.rememberCurrentCard();
      else this.engine.find('row:seasonEpisodes')?.home();
    }, 0);
  }

  // Enter on a season: into its episodes
  enterEpisodes() {
    this.engine.find('row:seasonEpisodes')?.focusRemembered('key');
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
    this.imdbEpisode = ImdbService.episode(this.imdb, this.seasonNumber, this.episode.episodeNumber);
    let season = this.seasonImdb;
    let best = Math.max(...(season?.episodes || []).map(e => e.rating || 0));
    this.topOfSeason = !!this.imdbEpisode?.rating && (season?.rated || 0) > 2 && this.imdbEpisode.rating === best;
  }

  get seasonImdb() {
    return ImdbService.season(this.imdb, this.seasonNumber);
  }

  get rowSeasonImdb() {
    return ImdbService.season(this.imdb, this.rowSeason);
  }

  seasonRating(season:number):number | null {
    return ImdbService.season(this.imdb, season)?.rating || null;
  }

  // How many of the season's episodes are on the Playpex server (0: none)
  seasonOnServer(season:number):number {
    let n = 0;
    this.onServer.forEach(key => key.startsWith(`${season}x`) && n++);
    return n;
  }

  // the episodes row's cards: of the season it shows
  episodeRating(ep):number | null {
    return ImdbService.episode(this.imdb, this.rowSeason, ep.episodeNumber)?.rating || null;
  }

  votes(count:number):string {
    return ImdbService.votes(count);
  }

  // ── the profile's state ───────────────────────────────────────────────────

  private key():EpisodeKey {
    return { mediaType: 'tv', tmdbId: Number(this.show.tmdbId), season: this.seasonNumber, episode: this.episode.episodeNumber };
  }

  loadSeasonProgress() {
    this.episodeProgress.clear();
    this.library.episodesProgress({ mediaType: 'tv', tmdbId: Number(this.show.tmdbId) }).subscribe({
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
    let progress = this.episodeProgress.get(`${this.rowSeason}x${ep.episodeNumber}`);
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
    return EpisodePlaybackService.code(this.seasonNumber, this.episode?.episodeNumber);
  }

  get resolving():boolean {
    return !!this.episode && this.episodePlayback.isResolving(this.show, this.seasonNumber, this.episode.episodeNumber);
  }

  play() {
    if (!this.episode) return;
    this.episodePlayback.play({ show: this.show, imdbId: this.imdbId, season: this.seasonNumber, episode: this.episode });
  }

  // Every source's releases of this episode ("<show> S02E05"); one played from
  // there counts as this show's (progress, subtitles)
  findReleases() {
    if (!this.episode) return;
    let title = this.show.title;
    let query = `${title} ${this.code}`;
    this.releases.open('tv', query, {
      label: `${title} ${this.code}`,
      context: {
        mediaType: 'tv',
        tmdbId: Number(this.show.tmdbId),
        imdbId: this.imdbId,
        title,
        year: this.show.year || '',
        artwork: LibraryService.artworkOf(this.show),
      },
    }, this.imdbId || null);
  }

  // Another episode (of the season the row shows), in place of this one
  openEpisode(ep) {
    if (!ep || ep === this.episode) return;
    this.navigator.replace({ screen: 'core.episode', params: { id: this.show.tmdbId, season: this.rowSeason, episode: ep.episodeNumber } });
  }

  // The show's page, on this episode's season: the page below when it came
  // from there (Back), else opened over this one
  openShow() {
    if (!this.show) return;
    let id = String(this.show.tmdbId);
    let stack = this.navigator.stack;
    let below = stack[stack.length - 2];
    if (below?.screen.id == 'core.show' && String(below.params['id']) == id) {
      below.state['season'] = this.seasonNumber;
      this.navigator.back();
    } else {
      this.navigator.open({ screen: 'core.show', params: { id } });
    }
  }

  // Its own page, over this one (Back comes here)
  openSimilar(title:CatalogTitle) {
    this.navigator.open({ screen: 'core.show', params: { id: String(title.tmdbId) }, payload: title });
  }

  onFocus(node:HTMLElement) {
    if (!this.screen.active) return;
    this.focusedEpisode = node.dataset['episode'] !== undefined
      ? this.rowEpisodes[Number(node.dataset['index'])]?.episodeNumber ?? null
      : null;
    if (node.classList.contains('season') && this.show) {
      let season = Number(node.dataset['season']);
      if (season !== this.rowSeason) this.rowRequests.next(season);
    }
  }
}
