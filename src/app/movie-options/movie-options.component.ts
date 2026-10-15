import { NotificationService } from './../notification.service';
import { filter, first, map, Observable, Subscription } from 'rxjs';
import { MoviesService } from './../movies.service';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, AfterViewInit, OnDestroy } from '@angular/core';
import { gsap ,Power1} from 'gsap'
import { MenuServiceService } from '../menu-service.service';
import { PlaybackService } from '../playback.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { TorrentService } from '../torrent.service';
import { LibraryService, MediaRef, PlaybackState } from '../library.service';
import { PlayChoiceService } from '../play-choice.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { ReleasesService } from '../releases.service';

@Component({
  selector: 'app-movie-options',
  templateUrl: './movie-options.component.html',
  styleUrls: ['./movie-options.component.scss']
})
export class MovieOptionsComponent implements AfterViewInit , OnDestroy {

  profileImgBase = "https://image.tmdb.org/t/p/w154";
  movieImgBase = "https://image.tmdb.org/t/p/w342";

  movieId;
  casts;
  similar;
  trailer;
  navigationSub:Subscription;
  playingTrailer = false;
  canPlay = false;
  findingTorrents = false;    // 18+ movie: Play is looking up torrents
  selectedMovie;

  // The current profile's state for this movie
  inWatchlist = false;
  watched = false;
  resumeLabel = '';
  private resume:PlaybackState['resume'] = null;
  private libraryBusy = false;

  constructor(
    private navigation:NavigationService,
    private activatedRoute:ActivatedRoute,
    private moviesService:MoviesService,
    private router:Router,
    private notificationService:NotificationService,
    private menu:MenuServiceService,
    private playback:PlaybackService,
    private torrentPicker:TorrentPickerService,
    private torrentService:TorrentService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
    private engine:FocusEngine,
    private positions:PositionStore,
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

    this.navigation.updateNavigation('focus' , {sectionId : 'options'})

    this.navigation.routerCurrentMovieId = this.activatedRoute.snapshot.params['id'];
    this.menu
    // get page data


    this.movieId = this.activatedRoute.snapshot.params['id'];
    this.getPageData(this.movieId)
    this.selectedMovie = this.moviesService.getMovieFromStack(this.movieId);

    this.getPlayData();
    this.loadLibraryState();
    this.handleNavEvents();

    this.activatedRoute.params.subscribe(params => {

      this.navigation.routerCurrentMovieId = params['id'];
      this.selectedMovie = this.moviesService.getMovieFromStack(params['id']);

      //console.log(this.moviesService.movieAppHistory);

      //console.log(this.selectedMovie);

      this.getPageData(params['id'])
      this.resetScroll();
      this.getPlayData();
      this.loadLibraryState();
      this.navigation.descriptionUpdateQuery(this.selectedMovie);

    })




  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    this.navigationSub.unsubscribe();

    this.navigation.routerCurrentMovieId = undefined;

    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
  }

  getPageData(id){

    this.moviesService.getCredits(id)
    .subscribe(data =>{
      this.casts = data['cast'];
    })

    this.moviesService.getSimilarMovies(id)
    .subscribe(data =>{
      this.similar = data['results'];
    })

    this.moviesService.getMovieVideos(id)
    .subscribe(data=>{
      let trailer;
      for(let video of data['results']){
        if (video['name'].includes('Official Trailer')) {
          console.log(video);
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
      url: this.router.url,
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

  // Another movie on the same page: top of the page, rows at their start
  resetScroll(){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
    this.positions.clear('cast');
    this.positions.clear('similar');
    document.querySelectorAll('.optionsMasterContainer .castSlider, .optionsMasterContainer .movieSlider')
      .forEach(row => row.scrollLeft = 0);
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
    if (this.libraryBusy) return;
    this.libraryBusy = true;
    let adding = !this.inWatchlist;
    this.inWatchlist = adding;
    let request:Observable<unknown> = adding
      ? this.library.addToWatchlist(this.movieRef(), LibraryService.artworkOf(this.selectedMovie))
      : this.library.removeFromWatchlist(this.movieRef());
    request.subscribe({
      next: () => this.libraryBusy = false,
      error: () => {
        this.libraryBusy = false;
        this.inWatchlist = !adding;
        this.notificationService.sendNotification("error", "Couldn't update your watch list. Is the Playpex server running?");
      }
    });
  }

  toggleWatched(){
    if (this.libraryBusy) return;
    this.libraryBusy = true;
    let marking = !this.watched;
    this.watched = marking;
    let request:Observable<unknown> = marking
      ? this.library.markWatched(this.movieRef(), LibraryService.artworkOf(this.selectedMovie))
      : this.library.markUnwatched(this.movieRef());
    request.subscribe({
      next: () => {
        this.libraryBusy = false;
        this.resumeLabel = '';
        this.resume = null;
      },
      error: () => {
        this.libraryBusy = false;
        this.watched = !marking;
        this.notificationService.sendNotification("error", "Couldn't update what you've watched. Is the Playpex server running?");
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
    this.router.navigateByUrl("/player");
  }

  openSimilar(element:HTMLElement){
    let tempSub = this.moviesService.getTmdbMovieDetails(element.dataset['id'])
      .subscribe(data=>{
        this.moviesService.addMovieToHistory(data);
        this.trailer = undefined;
        this.router.navigateByUrl(`/movies/movie/${data['id']}`);
        tempSub.unsubscribe();
      })
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
        this.router.navigateByUrl('/ytplayer/'+vidId);
      }
    })

  }


  handleNavEvents(){
    this.navigationSub = this.navigation.executeCommand().subscribe(instruction =>{
      if (instruction == "click" && this.router.url.includes('/movies/movie')) {
        switch (true) {
          case document.activeElement.classList.contains('play'):
            // resuming the saved release doesn't need the YTS data
            if (!this.canPlay && !this.resume?.infoHash) return;
            this.play();
            break;
          case document.activeElement.classList.contains('trailer'):
            if (!this.trailer) {
              this.notificationService.sendNotification("error","No trailer found")
              return;
            }

            this.showYtVid(this.trailer);

            break;
          case document.activeElement.classList.contains('findReleases'):
            this.findReleases();
          break;
          case document.activeElement.classList.contains('addWatchlist'):
            this.toggleWatchlist();
          break;
          case document.activeElement.classList.contains('addWatched'):
            this.toggleWatched();
          break;
          case document.activeElement.parentElement.classList.contains('movie'):
            this.openSimilar(document.activeElement as HTMLElement);
          break;
          default:
            break;
        }




      }

      if((instruction == "back" || instruction == "leave") && this.router.url.includes('/movies/movie')){
        this.moviesService.popFromHistoryStack(this.navigation.routerCurrentMovieId)
        this.navigation.goBack();
      }
    })
  }

}
