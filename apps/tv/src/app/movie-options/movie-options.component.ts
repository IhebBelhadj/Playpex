import { ProfilesService } from '../profiles.service';
import { profileContext, titleRef } from '../slot-contexts';
import { MovieContext } from '../ui/public-api';
import { Toasts } from '../ui/public-api';
import { MediaKeys } from '../media-keys.service';
import { NotificationService } from './../notification.service';
import { Observable, Subscription } from 'rxjs';
import { MoviesService } from './../movies.service';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { gsap ,Power1} from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { PlaybackService } from '../playback.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { Download, DownloadTile, DownloadsService } from '../downloads.service';
import { TorrentService } from '../torrent.service';
import { LibraryService, MediaRef, PlaybackState } from '../library.service';
import { PlayChoiceService } from '../play-choice.service';
import { ReleasesService } from '../releases.service';
import { Navigator, useScreen } from '../nav/public-api';
import { tmdbImageBase } from '../ui/public-api';

@Component({
  selector: 'app-movie-options',
  templateUrl: './movie-options.component.html',
  styleUrls: ['./movie-options.component.scss']
})
export class MovieOptionsComponent implements AfterViewInit , OnDestroy {

  private toasts = inject(Toasts);

  private profiles = inject(ProfilesService);

  private downloads = inject(DownloadsService);
  // the server's download of this movie: the Download tile
  download:Download | null = null;
  downloadTile:DownloadTile = DownloadsService.tile(null);
  private downloadSub:Subscription | null = null;

  profileImgBase = tmdbImageBase('profile', 130);
  movieImgBase = tmdbImageBase('poster', 150);

  movieId;
  casts;
  similar;
  trailer;
  playingTrailer = false;
  canPlay = false;
  findingTorrents = false;    // 18+ movie: Play is looking up torrents
  selectedMovie;
  // what plugins' actions and rows on this page get (ui/slots)
  slotContext:MovieContext | null = null;

  // The current profile's state for this movie
  inWatchlist = false;
  watched = false;
  resumeLabel = '';
  private resume:PlaybackState['resume'] = null;
  private libraryBusy = false;

  // params { id } (TMDB id); payload: the TMDB movie it was opened from
  private screen = useScreen<{ id:string }, any>();
  // a remote's Play key = the Play button (§13.2)
  private mediaSub = inject(MediaKeys).for(this.screen).subscribe(a => (a == 'playPause' || a == 'play') && this.onPlay());
  private subscriptions:Subscription[] = [];

  constructor(
    private navigation:NavigationService,
    private navigator:Navigator,
    private moviesService:MoviesService,
    private notificationService:NotificationService,
    private menu:MenuServiceService,
    private playback:PlaybackService,
    private torrentPicker:TorrentPickerService,
    private torrentService:TorrentService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
    private releases:ReleasesService,
  ) {
  }

  ngAfterViewInit(): void {

    this.menu.sendInstruction('collapse' , this);

    // Section `options` is a pxSection in the template; the buttons and rows
    // are entries of the section page's scrolling pxStack (src/app/movement)
    this.navigation.updateNavigation('add',{
      id: 'menu',
      selector: '.menuContainer .element',
      restrict : "self-only",
      leaveFor: {
        right: '@options'
      }
    })

    // back from the player / another title: what was focused
    if (!this.screen.ready()) this.navigation.updateNavigation('focus' , {sectionId : 'options'})

    this.movieId = this.screen.params.id;
    this.getPageData(this.movieId)
    this.loadMovie(this.screen.payload);
  }

  // The server's download of this movie, live (18+ titles aren't downloaded from here)
  private watchDownload() {
    this.downloadSub?.unsubscribe();
    this.download = null;
    this.downloadTile = DownloadsService.tile(null);
    if (this.isAdult || !this.selectedMovie?.['id']) return;
    this.downloadSub = this.downloads.forTitle({ mediaType: 'movie', tmdbId: Number(this.selectedMovie['id']) }).subscribe(d => {
      this.download = d;
      this.downloadTile = DownloadsService.tile(d);
    });
  }

  // Download: a release to keep on the server (the same picker as Play);
  // one already there is started again, or just reported
  onDownload() {
    let d = this.download, movie = this.selectedMovie;
    if (d) {
      if (['paused', 'error'].includes(d.state)) {
        this.downloads.start(d.infoHash).subscribe({
          next: () => this.toasts.show({ text: 'Downloading again', detail: movie['original_title'], tone: 'success', key: 'download' }),
          error: () => this.toasts.show({ text: "Couldn't start the download", tone: 'error', key: 'download' }),
        });
      } else {
        this.toasts.show({ text: this.downloadTile.label, detail: movie['original_title'], tone: 'info', key: 'download' });
      }
      return;
    }
    if (!movie?.['torrents']?.length) {
      this.notificationService.sendNotification('error', "No release found for this movie");
      return;
    }
    let options = movie['torrents'].map(torrent => TorrentPickerService.fromYts(torrent));
    this.torrentPicker.choose(movie['original_title'], options).subscribe(choice => {
      let title = movie['original_title'] + (movie['release_date'] ? ` (${movie['release_date'].slice(0, 4)})` : '');
      this.downloads.add(PlaybackService.movieMagnet(movie, choice.torrent), { mediaType: 'movie', tmdbId: Number(movie['id']) }, title)
        .subscribe({
          next: added => this.toasts.show({
            text: added.state === 'queued' ? 'Queued on the server' : 'Downloading on the server',
            detail: title, tone: 'success', key: 'download',
          }),
          error: () => this.toasts.show({ text: "Couldn't start the download", detail: 'Is the Playpex server running?', tone: 'error', key: 'download' }),
        });
    });
  }

  ngOnDestroy(): void {
    this.downloadSub?.unsubscribe();
    this.mediaSub.unsubscribe();
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    this.subscriptions.forEach(s => s.unsubscribe());

    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
  }

  // The movie it was opened with, completed from TMDB when it lacks the
  // details (a similar title, a search result, opened by id)
  loadMovie(movie){
    let ready = (data) => {
      this.selectedMovie = data;
      this.moviesService.assignSelection(this.selectedMovie);
      this.slotContext = { movie: titleRef(data), profile: profileContext(this.profiles.current.value) };
      this.getPlayData();
      this.loadLibraryState();
      this.watchDownload();
    };
    if (movie?.['imdb_id'] || movie?.['adult']) {
      ready(movie);
      return;
    }
    this.subscriptions.push(this.moviesService.getTmdbMovieDetails(this.movieId).subscribe({
      next: details => ready(movie ? Object.assign(movie, details) : details),
      error: () => this.notificationService.sendNotification('error', "Couldn't load this movie"),
    }));
  }

  byCredit = (i:number, c:any) => c.credit_id;
  byId = (i:number, m:any) => m.id;

  getPageData(id){

    this.moviesService.getCredits(id)
    .subscribe(data =>{
      // people with a photo only
      this.casts = (data['cast'] || []).filter(c => c.profile_path);
      this.restoreInRows();
    })

    this.moviesService.getSimilarMovies(id)
    .subscribe(data =>{
      // titles with a poster, in English
      this.similar = (data['results'] || []).filter(m => m.poster_path && m.original_language == 'en');
      this.restoreInRows();
    })

    this.moviesService.getMovieVideos(id)
    .subscribe(data=>{
      let trailer;
      for(let video of data['results']){
        if (video['name'].includes('Official Trailer')) {
          trailer = video['key'];
          break;
        }
      }

      this.trailer = trailer || data['results'][0]['key'];

    })
  }

  // Every source's releases of this movie (title + year), most seeded first;
  // one played from there still counts as this movie (progress, subtitles)
  findReleases(){
    let movie = this.selectedMovie;
    if (!movie) return;
    let title = movie['original_title'] || movie['title'];
    let year = (movie['release_date'] || '').slice(0, 4);
    this.releases.open(this.isAdult ? 'adult' : 'movie', [title, year].filter(Boolean).join(' '), {
      label: movie['title'] || title,
      context: this.isAdult ? undefined : {
        mediaType: 'movie',
        tmdbId: movie['id'],
        imdbId: movie['imdb_id'],
        title,
        year,
        artwork: LibraryService.artworkOf(movie),
      },
    });
  }

  // 18+ title (TMDB `adult`): torrents come from the server's adult providers
  // when Play is pressed, and the title never enters the profile's library
  get isAdult():boolean {
    return !!this.selectedMovie?.['adult'];
  }

  // back to a cast member / similar title: once its row is there
  private restoreInRows(){
    if (!this.screen.returning || !this.casts || !this.similar) return;
    setTimeout(() => this.screen.ready(), 0);
  }

  getPlayData(){

    // YTS has no 18+ movies
    if (this.isAdult) {
      this.canPlay = true;
      return;
    }

    this.moviesService
      .getYTSMovieDetails(this.selectedMovie['imdb_id'])
      .subscribe(yts_data=>{
        if(!yts_data) return;
        this.selectedMovie['torrents'] = yts_data['data']['movie']['torrents']
        this.selectedMovie['mpa_rating'] = yts_data['data']['movie']['mpa_rating']
        this.selectedMovie['rating'] = yts_data['data']['movie']['rating']
        this.selectedMovie['runtime'] = yts_data['data']['movie']['runtime']


        this.moviesService.assignSelection(this.selectedMovie)
        this.canPlay = true;

    })
  }

  private movieRef():MediaRef {
    return { mediaType: 'movie', tmdbId: Number(this.selectedMovie['id']) };
  }

  loadLibraryState(){
    this.inWatchlist = false;
    this.watched = false;
    this.resumeLabel = '';
    this.resume = null;
    if (!this.selectedMovie || this.isAdult) return;
    let ref = this.movieRef();
    this.library.inWatchlist(ref).subscribe({ next: r => this.inWatchlist = r.inWatchlist, error: () => {} });
    this.library.state(ref).subscribe({
      next: state => {
        this.watched = state.finished;
        this.resume = state.resume;
        if (state.resume) {
          let minutes = Math.round((state.resume.durationS - state.resume.positionS) / 60);
          this.resumeLabel = `Resume (${Math.max(1, minutes)} min left)`;
        }
      },
      error: () => {},
    });
  }

  toggleWatchlist(){
    if (this.libraryBusy || !this.selectedMovie) return;
    this.libraryBusy = true;
    let adding = !this.inWatchlist;
    this.inWatchlist = adding;
    let request:Observable<unknown> = adding
      ? this.library.addToWatchlist(this.movieRef(), LibraryService.artworkOf(this.selectedMovie))
      : this.library.removeFromWatchlist(this.movieRef());
    request.subscribe({
      next: () => {
        this.libraryBusy = false;
        this.toasts.show({ text: adding ? 'Added to your watch list' : 'Removed from your watch list', tone: 'success', key: 'library' });
      },
      error: () => {
        this.libraryBusy = false;
        this.inWatchlist = !adding;
        this.toasts.show({ text: "Couldn't update your watch list", detail: 'Is the Playpex server running?', tone: 'error', key: 'library' });
      }
    });
  }

  toggleWatched(){
    if (this.libraryBusy || !this.selectedMovie) return;
    this.libraryBusy = true;
    let marking = !this.watched;
    this.watched = marking;
    let request:Observable<unknown> = marking
      ? this.library.markWatched(this.movieRef(), LibraryService.artworkOf(this.selectedMovie))
      : this.library.markUnwatched(this.movieRef());
    request.subscribe({
      next: () => {
        this.libraryBusy = false;
        this.toasts.show({ text: marking ? 'Marked as watched' : 'Marked as not watched', tone: 'success', key: 'library' });
        this.resumeLabel = '';
        this.resume = null;
      },
      error: () => {
        this.libraryBusy = false;
        this.watched = !marking;
        this.toasts.show({ text: "Couldn't update what you've watched", detail: 'Is the Playpex server running?', tone: 'error', key: 'library' });
      }
    });
  }

  // Play: with a saved position, ask Resume / Play from the beginning first
  play(){
    let resume = this.resume;
    if (!resume) {
      this.chooseTorrentAndPlay();
      return;
    }
    this.playChoice.choose(this.selectedMovie['original_title'] , resume).subscribe(choice => {
      if (choice == 'restart') this.chooseTorrentAndPlay(0);
      // same release as last time, so the saved position matches
      else if (resume.infoHash) this.startPlayer({ hash : resume.infoHash , quality : '' } , resume.positionS);
      else this.chooseTorrentAndPlay(resume.positionS);
    })
  }

  chooseTorrentAndPlay(startAt?:number){
    let movie = this.selectedMovie;
    if (this.isAdult) {
      this.chooseAdultTorrentAndPlay();
      return;
    }
    if (!movie['torrents']?.length) {
      this.notificationService.sendNotification('error',"No streaming service found for the movie");
      return;
    }
    let options = movie['torrents'].map(torrent => TorrentPickerService.fromYts(torrent));

    this.torrentPicker.choose(movie['original_title'] , options).subscribe(choice => this.startPlayer(choice.torrent , startAt));
  }

  chooseAdultTorrentAndPlay(){
    if (this.findingTorrents) return;
    let movie = this.selectedMovie;
    let title = movie['title'] || movie['original_title'];
    this.findingTorrents = true;
    this.torrentService.findAdultTorrents(title , (movie['release_date'] || '').slice(0, 4))
      .subscribe({
        next: result => {
          this.findingTorrents = false;
          if (!result.torrents.length) {
            let reason = result.providerErrors ? " (some providers are unreachable)" : "";
            this.notificationService.sendNotification('error' , `No torrents found for ${title}${reason}`);
            return;
          }
          let options = result.torrents.map((torrent, i) => TorrentPickerService.fromEpisode(torrent , i));
          this.torrentPicker.choose(title , options).subscribe(choice => this.startPlayer(choice.torrent));
        },
        error: () => {
          this.findingTorrents = false;
          this.notificationService.sendNotification('error' , "Couldn't reach the torrent providers. Try again later");
        },
      });
  }

  startPlayer(torrent , startAt?:number){
    this.playback.playMovie(this.selectedMovie , torrent , startAt);
  }

  // Its own page, over this one (Back comes here)
  openSimilar(movie){
    this.navigator.open({ screen: 'core.movie', params: { id: movie.id }, payload: movie });
  }

  showYtVid(vidId){

    let transitionTl = gsap.timeline();
    transitionTl.to('.masterContainer' ,
    {
      scale : 1.2 ,
      opacity : 0 ,
      duration : .25 ,

      ease:Power1.easeOut ,
      onComplete : ()=>{
        let masterDiv = document.querySelector('.masterContainer') as HTMLElement;
        gsap.set(masterDiv, { clearProps: true });
        this.navigator.open({ screen: 'core.trailer', params: { id: vidId } });
      }
    })

  }

  onPlay(){
    // resuming the saved release doesn't need the YTS data
    if (!this.selectedMovie || (!this.canPlay && !this.resume?.infoHash)) return;
    this.play();
  }

  onTrailer(){
    if (!this.trailer) {
      this.notificationService.sendNotification("error","No trailer found")
      return;
    }
    this.showYtVid(this.trailer);
  }

}
