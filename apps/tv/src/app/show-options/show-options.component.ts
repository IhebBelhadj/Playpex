import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { distinctUntilChanged, Observable, Subject, Subscription, switchMap, map } from 'rxjs';
import { gsap, Power1 } from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { MoviesService } from '../movies.service';
import { NavigationService } from '../navigation.service';
import { NotificationService } from '../notification.service';
import { EpisodeProgress, LibraryService } from '../library.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { ReleasesService } from '../releases.service';
import { EpisodePlaybackService } from '../episode-playback.service';
import { ImdbSeries, ImdbService } from '../imdb.service';

// The show and season last shown, so coming back from an episode page or the
// player lands on the same season and episode
let lastShown:{ showId:number , season:number } = null;

// TV show page (/shows/show/:id): Play / Trailer, a seasons row and the
// selected season's episodes, with IMDb ratings (the series', each season's
// mean, each episode's). Movement and scrolling are the movement system's:
// the buttons and rows are entries of the section page's pxStack. Enter on an
// episode opens its page (/shows/show/:id/season/:s/episode/:e); "Play" plays
// the season's first aired episode (EpisodePlaybackService).
@Component({
  selector: 'app-show-options',
  templateUrl: './show-options.component.html',
  styleUrls: ['./show-options.component.scss']
})
export class ShowOptionsComponent implements AfterViewInit , OnDestroy {

  stillBase = "https://image.tmdb.org/t/p/w300";

  show;
  imdbId:string;
  trailer:string;
  seasons = [];
  selectedSeason:number;
  seasonName = "";
  episodes = [];
  loadingEpisodes = false;
  focusedEpisode:number = null;      // lights its bar in the season curve

  // IMDb ratings of the show, its seasons and episodes (null until loaded / none)
  imdb:ImdbSeries = null;

  // The current profile's state for this show
  inWatchlist = false;
  private episodeProgress = new Map<string, EpisodeProgress>();
  private libraryBusy = false;

  private seasonRequests = new Subject<{ showId:number , season:number }>();
  private subscriptions:Subscription[] = [];
  private focusListener;
  private today = new Date().toISOString().slice(0, 10);
  private restoreEpisode = false;    // back on the show: focus the remembered episode

  constructor(
    private route:ActivatedRoute,
    private router:Router,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private menu:MenuServiceService,
    private notificationService:NotificationService,
    private library:LibraryService,
    private releases:ReleasesService,
    public episodePlayback:EpisodePlaybackService,
    private imdbService:ImdbService,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  ngAfterViewInit(): void {
    this.menu.sendInstruction('collapse' , this);

    // section `showOptions` is a pxSection in the template
    this.navigation.updateNavigation('add',{
      id: 'menu',
      selector: '.menuContainer .element',
      restrict : "self-only",
      leaveFor: {
        right: '@showOptions'
      }
    })
    this.navigation.updateNavigation('focus' , {sectionId : 'showOptions'})

    this.subscriptions.push(
      this.route.params.subscribe(params => this.loadShow(params['id'])),

      // Latest focused season wins; earlier requests are cancelled
      this.seasonRequests.pipe(
        distinctUntilChanged((a, b) => a.showId === b.showId && a.season === b.season),
        switchMap(request => {
          this.loadingEpisodes = true;
          return this.moviesService.getTvSeason(request.showId , request.season).pipe(map(data => ({ request, data })));
        })
      ).subscribe(({ request, data }) => {
        this.loadingEpisodes = false;
        this.selectedSeason = request.season;
        lastShown = { showId : request.showId , season : request.season };
        this.seasonName = data['name'];
        this.focusedEpisode = null;
        this.episodes = (data['episodes'] || []).map(ep => ({
          ...ep,
          upcoming: !ep.air_date || ep.air_date > this.today
        }));
        let restore = this.restoreEpisode;
        this.restoreEpisode = false;
        setTimeout(() => {
          let row = this.engine.find('row:episodes');
          // back from an episode: on it again; another season: its first episode
          if (!restore) row?.home();
          else if (!row?.focusRemembered('restore')) this.focusPlay();
        }, 0);
      } , () => {
        this.loadingEpisodes = false;
        this.notificationService.sendNotification("error" , "Couldn't load this season's episodes");
      }),

      this.navigation.executeCommand().subscribe(instruction => this.onCommand(instruction)),
    );

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
  }

  loadShow(id){
    let returning = lastShown?.showId === Number(id);
    if (!returning) {
      // another show: no remembered season / episode
      this.positions.clear('seasons');
      this.positions.clear('episodes');
    }
    this.imdb = null;
    this.moviesService.getTvDetails(id).subscribe(show => {
      this.show = show;
      this.imdbId = show['external_ids']?.['imdb_id'];
      this.loadImdb();
      this.trailer = this.pickTrailer(show['videos']?.['results'] || []);

      // Regular seasons first, "Specials" (season 0) last
      this.seasons = (show['seasons'] || [])
        .filter(s => s.episode_count > 0)
        .sort((a, b) => (a.season_number || 1000) - (b.season_number || 1000));

      // Describe the show above the page
      this.moviesService.assignSelection({ ...show, media_type : 'tv' });
      this.loadLibraryState();

      let season = this.seasons[0]?.season_number;
      if (returning && this.seasons.some(s => s.season_number === lastShown.season)) {
        season = lastShown.season;
        this.restoreEpisode = true;
      }
      if (season !== undefined) {
        this.seasonRequests.next({ showId : show['id'] , season });
      }

      if (!this.restoreEpisode) setTimeout(() => this.focusPlay(), 0);
    } , () => {
      this.notificationService.sendNotification("error" , "Couldn't load this show");
    })
  }

  focusPlay(){
    (document.querySelector('.showOptionsContainer .play') as HTMLElement)?.focus({preventScroll : true});
  }

  // The series' IMDb rating goes in the description (as a movie's does)
  loadImdb(){
    let show = this.show;
    if (!this.imdbId) return;
    this.imdbService.episodes(this.imdbId).subscribe(series => {
      if (!series || show !== this.show) return;
      this.imdb = series;
      if (series.rating) {
        show['rating'] = series.rating;
        this.moviesService.assignSelection({ ...show, media_type : 'tv' });
      }
    });
  }

  seasonRating(season:number):number | null {
    return ImdbService.season(this.imdb , season)?.rating || null;
  }

  get selectedSeasonImdb() {
    return ImdbService.season(this.imdb , this.selectedSeason);
  }

  episodeRating(ep):number | null {
    return ImdbService.episode(this.imdb , this.selectedSeason , ep.episode_number)?.rating || null;
  }

  isResolving(ep):boolean {
    return this.episodePlayback.isResolving(this.show , this.selectedSeason , ep.episode_number);
  }

  // 18+ show (TMDB `adult`): never enters the profile's library
  get isAdult():boolean {
    return !!this.show?.['adult'];
  }

  loadLibraryState(){
    this.inWatchlist = false;
    this.episodeProgress.clear();
    if (this.isAdult) return;
    let ref = { mediaType : 'tv' as const , tmdbId : Number(this.show['id']) };
    this.library.inWatchlist(ref).subscribe({ next : r => this.inWatchlist = r.inWatchlist , error : () => {} });
    this.library.episodesProgress(ref).subscribe({
      next : list => list.forEach(p => this.episodeProgress.set(`${p.season}x${p.episode}` , p)),
      error : () => {},
    });
  }

  // Shown on the episode thumbnail: a watched badge, or a bar once it's started
  progressOf(ep):EpisodeProgress | null {
    let progress = this.episodeProgress.get(`${this.selectedSeason}x${ep.episode_number}`);
    return progress && (progress.finished || progress.ratio >= 0.02) ? progress : null;
  }

  toggleWatchlist(){
    if (this.libraryBusy || !this.show) return;
    this.libraryBusy = true;
    let ref = { mediaType : 'tv' as const , tmdbId : Number(this.show['id']) };
    let adding = !this.inWatchlist;
    this.inWatchlist = adding;
    let request:Observable<unknown> = adding
      ? this.library.addToWatchlist(ref , LibraryService.artworkOf(this.show))
      : this.library.removeFromWatchlist(ref);
    request.subscribe({
      next : () => this.libraryBusy = false,
      error : () => {
        this.libraryBusy = false;
        this.inWatchlist = !adding;
        this.notificationService.sendNotification("error" , "Couldn't update your watch list. Is the Playpex server running?");
      }
    });
  }

  pickTrailer(videos){
    let youtube = videos.filter(v => v.site == 'YouTube');
    let trailer = youtube.find(v => v.type == 'Trailer') || youtube[0];
    return trailer?.key;
  }

  onCommand(instruction){
    if (!this.router.url.includes('/shows/show')) return;
    let active = document.activeElement as HTMLElement;

    if (instruction == 'back' || instruction == 'leave') {
      this.navigation.goBack();
      return;
    }
    if (instruction != 'click') return;

    switch (true) {
      case active.classList.contains('play'):
        let next = this.episodes.find(ep => !ep.upcoming);
        if (next) this.episodePlayback.play({ show : this.show , imdbId : this.imdbId , season : this.selectedSeason , episode : next });
        else this.notificationService.sendNotification("error" , "No aired episodes in this season yet");
        break;
      case active.classList.contains('addWatchlist'):
        this.toggleWatchlist();
        break;
      case active.classList.contains('findReleases'):
        this.findReleases();
        break;
      case active.classList.contains('trailer'):
        if (this.trailer) this.showYtVid(this.trailer);
        else this.notificationService.sendNotification("error" , "No trailer found");
        break;
      case active.classList.contains('season'):
        this.engine.find('row:episodes')?.focusRemembered('key');
        break;
      case active.classList.contains('episodeBtn'):
        this.openEpisode(this.episodes[Number(active.dataset['index'])]);
        break;
      default:
        break;
    }
  }

  // Every source's releases of this show (EZTV by its IMDb id, the others by
  // name), most seeded first; an episode played from there still counts as
  // this show's (progress, subtitles)
  findReleases(){
    if (!this.show) return;
    let title = this.show['name'];
    this.releases.open(this.isAdult ? 'adult' : 'tv', title, {
      label: title,
      url: this.router.url,
      context: this.isAdult ? undefined : {
        mediaType: 'tv',
        tmdbId: Number(this.show['id']),
        imdbId: this.imdbId,
        title,
        year: (this.show['first_air_date'] || '').slice(0, 4),
        artwork: LibraryService.artworkOf(this.show),
      },
    }, this.isAdult ? null : this.imdbId || null);
  }

  // The episode's own page: its details, ratings, Play and Find releases
  openEpisode(ep){
    if (!ep) return;
    this.router.navigateByUrl(`/shows/show/${this.show['id']}/season/${this.selectedSeason}/episode/${ep.episode_number}`);
  }

  // A focused season loads its episodes (scrolling is the movement system's)
  onFocus(node:HTMLElement){
    if (!this.router.url.includes('/shows/show')) return;
    this.focusedEpisode = node.classList.contains('episodeBtn')
      ? this.episodes[Number(node.dataset['index'])]?.episode_number ?? null
      : null;
    if (!node.classList.contains('season')) return;
    this.seasonRequests.next({ showId : this.show['id'] , season : Number(node.dataset['season']) });
  }

  showYtVid(vidId){
    gsap.timeline().to('.masterContainer' , {
      scale : 1.2 ,
      opacity : 0 ,
      duration : .25 ,
      ease : Power1.easeOut ,
      onComplete : ()=>{
        gsap.set(document.querySelector('.masterContainer'), { clearProps: true });
        this.router.navigateByUrl('/ytplayer/' + vidId);
      }
    })
  }

}
