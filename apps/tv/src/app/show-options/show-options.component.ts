import { profileContext, titleRef } from '../slot-contexts';
import { ProfilesService } from '../profiles.service';
import { MediaKeys } from '../media-keys.service';
import { Component, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { distinctUntilChanged, Observable, Subject, Subscription, switchMap, map } from 'rxjs';
import { gsap, Power1 } from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { MoviesService } from '../movies.service';
import { NavigationService } from '../navigation.service';
import { NotificationService } from '../notification.service';
import { EpisodeProgress, LibraryService } from '../library.service';
import { FocusEngine } from '../movement/movement';
import { Navigator, useScreen } from '../nav/public-api';
import { ReleasesService } from '../releases.service';
import { EpisodePlaybackService } from '../episode-playback.service';
import { ImdbSeries, ImdbService } from '../imdb.service';
import { ServerLibraryService } from '../server-library.service';
import { Badge, ShowContext, Toasts, tmdbImageBase } from '../ui/public-api';
import { formatDate } from '@angular/common';

// TV show page (/shows/show/:id): Play / Trailer, a seasons row and the
// selected season's episodes, with IMDb ratings (the series', each season's
// mean, each episode's). Movement and scrolling are the movement system's:
// the buttons and rows are entries of the section page's pxStack. Enter on an
// episode opens its page (core.episode); "Play" plays the season's first
// aired episode (EpisodePlaybackService). The season shown is kept in the
// history entry (`state`), so coming back from an episode page or the player
// lands on the same season and episode.
@Component({
  selector: 'app-show-options',
  templateUrl: './show-options.component.html',
  styleUrls: ['./show-options.component.scss']
})
export class ShowOptionsComponent implements AfterViewInit , OnDestroy {

  private toasts = inject(Toasts);
  private serverLibrary = inject(ServerLibraryService);

  private profiles = inject(ProfilesService);

  stillBase = tmdbImageBase('still', 270);

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
  // episodes with a file on the Playpex server ("<season>x<episode>"), live
  private onServer = new Set<string>();
  private onServerSub:Subscription;

  private seasonRequests = new Subject<{ showId:number , season:number }>();
  private subscriptions:Subscription[] = [];
  private focusListener;
  private today = new Date().toISOString().slice(0, 10);
  private restoreEpisode = false;    // back on the show: focus the remembered episode
  // params { id } (TMDB TV id); state: the season shown
  private screen = useScreen<{ id:string }>();
  // a remote's Play key = the Play button (§13.2)
  private mediaSub = inject(MediaKeys).for(this.screen).subscribe(a => (a == 'playPause' || a == 'play') && this.play());

  constructor(
    private navigator:Navigator,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private menu:MenuServiceService,
    private notificationService:NotificationService,
    private library:LibraryService,
    private releases:ReleasesService,
    public episodePlayback:EpisodePlaybackService,
    private imdbService:ImdbService,
    private engine:FocusEngine,
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

    this.loadShow(this.screen.params.id);
    this.subscriptions.push(

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
        this.updateSlotContext();
        this.screen.setState('season', request.season);
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
          // back from an episode, the player, a release list: what was
          // focused (else the remembered episode); another season: its first episode
          if (!restore) row?.home();
          else if (!this.screen.ready() && !row?.focusRemembered('restore')) this.focusPlay();
        }, 0);
      } , () => {
        this.loadingEpisodes = false;
        this.notificationService.sendNotification("error" , "Couldn't load this season's episodes");
      }),

    );

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.mediaSub.unsubscribe();
    this.onServerSub?.unsubscribe();
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
  }

  loadShow(id){
    let lastSeason = this.screen.returning ? this.screen.entry?.state['season'] : undefined;
    this.imdb = null;
    this.moviesService.getTvDetails(id).subscribe(show => {
      this.show = show;
      this.imdbId = show['external_ids']?.['imdb_id'];
      this.updateSlotContext();
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
      if (lastSeason !== undefined && this.seasons.some(s => s.season_number === lastSeason)) {
        season = lastSeason;
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
    (document.querySelector('.showOptionsContainer [data-px-key="play"]') as HTMLElement)?.focus({preventScroll : true});
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

  loadLibraryState(){
    this.inWatchlist = false;
    this.episodeProgress.clear();
    this.onServerSub?.unsubscribe();
    this.onServerSub = this.serverLibrary.live('tv' , Number(this.show['id'])).subscribe(title => {
      this.onServer = ServerLibraryService.episodesOf(title);
    });
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
      next : () => {
        this.libraryBusy = false;
        this.toasts.show({ text: adding ? 'Added to your watch list' : 'Removed from your watch list', tone: 'success', key: 'library' });
      },
      error : () => {
        this.libraryBusy = false;
        this.inWatchlist = !adding;
        this.toasts.show({ text: "Couldn't update your watch list", detail: 'Is the Playpex server running?', tone: 'error', key: 'library' });
      }
    });
  }

  pickTrailer(videos){
    let youtube = videos.filter(v => v.site == 'YouTube');
    let trailer = youtube.find(v => v.type == 'Trailer') || youtube[0];
    return trailer?.key;
  }

  // Play: the season's first aired episode
  play(){
    if (!this.show) return;
    let next = this.episodes.find(ep => !ep.upcoming);
    if (next) this.episodePlayback.play({ show : this.show , imdbId : this.imdbId , season : this.selectedSeason , episode : next });
    else this.notificationService.sendNotification("error" , "No aired episodes in this season yet");
  }

  playTrailer(){
    if (this.trailer) this.showYtVid(this.trailer);
    else this.notificationService.sendNotification("error" , "No trailer found");
  }

  // Enter on a season: into its episodes
  enterEpisodes(){
    this.engine.find('row:episodes')?.focusRemembered('key');
  }

  // Every source's releases of this show (EZTV by its IMDb id, the others by
  // name), most seeded first; an episode played from there still counts as
  // this show's (progress, subtitles)
  findReleases(){
    if (!this.show) return;
    let title = this.show['name'];
    this.releases.open('tv', title, {
      label: title,
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

  // what plugins' actions and rows on this page get (ui/slots)
  slotContext:ShowContext | null = null;

  private updateSlotContext() {
    if (!this.show) return;
    this.slotContext = { show: titleRef(this.show, this.imdbId), season: this.selectedSeason ?? null, profile: profileContext(this.profiles.current.value) };
  }

  bySeason = (i:number, s:any) => s.season_number;
  byEpisode = (i:number, ep:any) => ep.episode_number;

  // an episode card's runtime and air date
  episodeMeta(ep):string[] {
    let meta = [];
    if (ep.runtime) meta.push(ep.runtime + ' min');
    if (ep.air_date) meta.push(formatDate(ep.air_date, 'd MMM y', 'en-US'));
    return meta;
  }

  episodeBadges(ep):Badge[] | null {
    if (ep.upcoming) return ['upcoming'];
    let badges:Badge[] = [];
    if (this.progressOf(ep)?.finished) badges.push('watched');
    if (this.onServer.has(`${this.selectedSeason}x${ep.episode_number}`)) badges.push('server');
    return badges.length ? badges : null;
  }

  // How many of the season's episodes are on the Playpex server (0: none)
  seasonOnServer(season:number):number {
    let n = 0;
    this.onServer.forEach(key => key.startsWith(`${season}x`) && n++);
    return n;
  }

  // The episode's own page: its details, ratings, Play and Find releases
  openEpisode(ep){
    if (!ep) return;
    this.navigator.open({ screen: 'core.episode', params: { id: this.show['id'], season: this.selectedSeason, episode: ep.episode_number } });
  }

  // A focused season loads its episodes (scrolling is the movement system's)
  onFocus(node:HTMLElement){
    if (!this.screen.active) return;
    this.focusedEpisode = node.dataset['episode'] !== undefined
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
        this.navigator.open({ screen: 'core.trailer', params: { id: vidId } });
      }
    })
  }

}
