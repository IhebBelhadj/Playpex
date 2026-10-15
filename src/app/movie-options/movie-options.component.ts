import { Location } from '@angular/common';
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
import { LibraryService, MediaRef, PlaybackState } from '../library.service';
import { PlayChoiceService } from '../play-choice.service';

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
  selectedMovie;
  focusListener;

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
    private location:Location,
    private menu:MenuServiceService,
    private playback:PlaybackService,
    private torrentPicker:TorrentPickerService,
    private library:LibraryService,
    private playChoice:PlayChoiceService,
  ) {
  }

  ngAfterViewInit(): void {

    this.menu.sendInstruction('collapse' , this);

    // the page scrolls natively (vertically) while this component is shown
    document.querySelector('.pageContainer').classList.add('nativeScroll');

    //spacial navigation setup

    this.navigation.updateNavigation('add' , {
      id: 'options',
      selector: '.optionsMasterContainer .focusable',
      restrict : "self-only",
      leaveFor: {
        left: '@menu',
      },
      enterTo: 'default-element',
      straightOnly: true,

    })
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




    // Focus moves: remember position per row and scroll it into view

    this.focusListener = (e)=>{
      if (!this.router.url.includes('/movies/movie')) return;
      const node = e.target as HTMLElement;
      if (!node.closest('.optionsMasterContainer')) return;

      if (node.closest('.optionPannel')) {
        this.updateLastSelected('.optionPannel' , node)
        this.scrollPageTo(0);
      }
      else if (node.closest('.casts')) {
        this.updateLastSelected('.casts' , node)
        this.scrollRowTo(node);
        this.ensureSectionVisible('.casts');
      }
      else if (node.closest('.similar')) {
        this.updateLastSelected('.similar' , node)
        this.scrollRowTo(node);
        this.ensureSectionVisible('.similar');
      }
    }
    window.addEventListener('sn:focused', this.focusListener)


  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    this.navigation.updateNavigation('remove' , {sectionId : 'options'});
    this.navigationSub.unsubscribe();

    this.navigation.routerCurrentMovieId = undefined;
    window.removeEventListener('sn:focused', this.focusListener);

    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) {
      pageContainer.scrollTop = 0;
      pageContainer.classList.remove('nativeScroll');
    }
  }

  // Horizontal: smooth-scroll the row so the focused item sits about a third in
  scrollRowTo(node:HTMLElement){
    let row = node.closest('.castSlider, .movieSlider') as HTMLElement;
    let offset = node.getBoundingClientRect().left - row.getBoundingClientRect().left;
    row.scrollTo({ left : row.scrollLeft + offset - row.clientWidth / 3 , behavior : 'smooth' });
  }

  // Vertical: scroll the page just enough for the whole section to be visible
  ensureSectionVisible(sectionSelector:string){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    let section = document.querySelector('.optionsMasterContainer ' + sectionSelector) as HTMLElement;
    if (!pageContainer || !section) return;

    let margin = 40;
    let viewport = pageContainer.getBoundingClientRect();
    let rect = section.getBoundingClientRect();
    let top = pageContainer.scrollTop;

    if (rect.top < viewport.top + margin) top -= viewport.top + margin - rect.top;
    else if (rect.bottom > viewport.bottom - margin) top += rect.bottom - (viewport.bottom - margin);

    this.scrollPageTo(top);
  }

  scrollPageTo(top:number){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTo({ top , behavior : 'smooth' });
  }

  getPageData(id){

    this.moviesService.getCredits(id)
    .subscribe(data =>{
      this.casts = data['cast'];
      setTimeout(()=>{
        document.querySelectorAll('.casts .focusable')[0].classList.add('lastSelected')
      } , 100)
    })

    this.moviesService.getSimilarMovies(id)
    .subscribe(data =>{
      this.similar = data['results'];
      console.log(this.similar);

      setTimeout(()=>{
        document.querySelectorAll('.similar .focusable')[0].classList.add('lastSelected')
      } , 100)

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

  getPlayData(){

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

  updateLastSelected(parentClass:string , currentNode:HTMLElement){
    document.querySelectorAll(parentClass + ' .focusable').forEach(node=>{
      node.classList.remove('lastSelected')
    })
    currentNode.classList.add('lastSelected');
  }

  // Instant reset when a new movie is shown on the same page
  resetScroll(){
    let pageContainer = document.querySelector('.pageContainer') as HTMLElement;
    if (pageContainer) pageContainer.scrollTop = 0;
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
    if (!this.selectedMovie) return;
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
    if (!movie['torrents']?.length) {
      this.notificationService.sendNotification('error',"No streaming service found for the movie");
      return;
    }
    let options = movie['torrents'].map(torrent => TorrentPickerService.fromYts(torrent));

    this.torrentPicker.choose(movie['original_title'] , options).subscribe(choice => this.startPlayer(choice.torrent , startAt));
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

      if(instruction == "back" && this.router.url.includes('/movies/movie')){
        this.moviesService.popFromHistoryStack(this.navigation.routerCurrentMovieId)
        this.location.back();
      }
    })
  }

}
