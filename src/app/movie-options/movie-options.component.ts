import { Location } from '@angular/common';
import { NotificationService } from './../notification.service';
import { filter, first, map, Subscription } from 'rxjs';
import { MoviesService } from './../movies.service';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, AfterViewInit, OnDestroy } from '@angular/core';
import { gsap ,Power1} from 'gsap'
import { MenuServiceService } from '../menu-service.service';

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
  castScrollAmount = {value : 0};

  similarScrollAmount = {value : 0};
  selectedMovie;

  selectedCast = {index : undefined};

  selectedSimilar = {index : undefined};

  focusCastDistance;
  focusSimilarDistance;
  focusListener;

  constructor(
    private navigation:NavigationService,
    private activatedRoute:ActivatedRoute,
    private moviesService:MoviesService,
    private router:Router,
    private notificationService:NotificationService,
    private location:Location,
    private menu:MenuServiceService,
  ) {
  }

  ngAfterViewInit(): void {

    this.menu.sendInstruction('collapse' , this);

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
    this.handleNavEvents();

    document.addEventListener('keydown' , (e)=>{

      if (
        document.activeElement.parentElement.classList.contains('movie') &&
        e.key == " " &&
        this.router.url.includes('/movies/movie')
        ) {

        let currentlySelected = document.activeElement as HTMLElement
        let tempSub = this.moviesService.getTmdbMovieDetails(currentlySelected.dataset['id'])
          .subscribe(data=>{
            console.log(data);
            this.moviesService.addMovieToHistory(data);
            this.resetScroll();
            this.trailer = undefined;
            this.router.navigateByUrl(`/movies/movie/${data['id']}`);
            tempSub.unsubscribe();
          })
      }
    })

    this.activatedRoute.params.subscribe(params => {

      this.navigation.routerCurrentMovieId = params['id'];
      this.selectedMovie = this.moviesService.getMovieFromStack(params['id']);

      //console.log(this.moviesService.movieAppHistory);

      //console.log(this.selectedMovie);

      this.getPageData(params['id'])
      this.resetScroll();

      document.querySelector('.pageContainer')['style']['transform'] = `translateY(0px)`;
      document.querySelector('.castSlider .content')['style']['transform'] = `translateX(0px)`;
      document.querySelector('.movieSlider .content')['style']['transform'] = `translateX(0px)`;
      this.getPlayData();
      this.navigation.descriptionUpdateQuery(this.selectedMovie);

    })




    //ON focus navigation update

    this.focusListener = window.addEventListener('sn:focused', (e)=>{
      if (!this.router.url.includes('/movies/movie')) return;
      const node = e.target as HTMLElement;
      let pageContainer = node.closest('.pageContainer') as HTMLElement;

      //no overflow of section on menu opening

      if (node['classList'].contains('menuItem')) {
        document.querySelector('.similar .movieSlider').classList.add('noOverflow');
        document.querySelector('.casts .castSlider').classList.add('noOverflow');

      }
      else {
        document.querySelector('.similar .movieSlider').classList.remove('noOverflow');
        document.querySelector('.casts .castSlider').classList.remove('noOverflow');
      }


      // options section navigation setup
      if (node['parentElement']['classList'].contains('optionPannel')){
        pageContainer.style.transform = `translateY(0px)`

        this.updateLastSelected('.optionPannel' , node)

      }


      //Cast section navigation setup
      if (node['parentElement']['classList'].contains('cast')) {

        this.sectionNavigationSetup(
          node ,
          '.casts' ,
          pageContainer ,
          this.castScrollAmount,
          this.selectedCast
        )

        this.updateLastSelected('.casts' , node)

      }

      //similar movies navigation setup

      if (node['parentElement']['classList'].contains('movie')) {


        this.sectionNavigationSetup(node ,
          '.similar' ,
          pageContainer ,
          this.similarScrollAmount,
          this.selectedSimilar
        )

        this.updateLastSelected('.similar' , node)


      }

    })


  }

  ngOnDestroy(): void {
    console.log("reset scroll amount");

    this.resetScroll();

    /*if (this.navigationSub) {
      this.navigationSub.unsubscribe();
    }*/

    this.navigation.updateNavigation('remove' , {sectionId : 'menu'});
    this.navigation.updateNavigation('remove' , {sectionId : 'options'});
    this.navigationSub.unsubscribe();

    this.navigation.routerCurrentMovieId = undefined;
    document.removeEventListener('sn:focused', this.focusListener);
    document.querySelector('.pageContainer')['style']['transform'] = `translateY(0px)`
  }

  isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)

    );
  }

  sectionNavigationSetup(
    node:HTMLElement ,
    parentClass:string ,
    pageContainer:HTMLElement,
    horizontalScrollAmount:{
      value:number
    },
    selectedItem
  ){

    let nodes = document.querySelectorAll(parentClass + ' .displayedElem');

    if (!selectedItem['index']) {
      selectedItem['index'] = node.dataset['index'];
    }

    let container = node.closest('.content') as HTMLElement;


    //vertical scroll


    if (parentClass == ".casts") {
      if(!this.focusCastDistance){
        this.focusCastDistance = -container.getBoundingClientRect().y / 2;

      }

      pageContainer.style.transform = `translateY(${this.focusCastDistance}px)`
    }

    if (parentClass == ".similar") {
    console.log(this.similarScrollAmount);

      if(!this.focusSimilarDistance){
        let castsSection = document.querySelector(".casts") as HTMLElement;
        let descriptionSection = document.querySelector(".movieDesciption") as HTMLElement;

        this.focusSimilarDistance = -descriptionSection.getBoundingClientRect().height - castsSection.getBoundingClientRect().height -20;

      }

      pageContainer.style.transform = `translateY(${this.focusSimilarDistance}px)`
    }






    //Horizontal scroll


    if (Number(node.dataset['index']) > Number(selectedItem['index'])) {


      let rightDiff = node.getBoundingClientRect().right - screen.width;


      if (Math.abs(rightDiff) < (3*screen.width/4) && !this.isInViewport(nodes[nodes.length -1])) {

        horizontalScrollAmount.value +=  node.offsetWidth;

        container.style.transform = `translateX(-${horizontalScrollAmount.value}px)`

      }

    }

    else if(Number(node.dataset['index']) < Number(selectedItem['index'])){

      let leftDiff = node.getBoundingClientRect().left;

      if (Math.abs(leftDiff) < (screen.width/4)) {

        horizontalScrollAmount.value -=  node.clientWidth;
        if (horizontalScrollAmount.value < 0) horizontalScrollAmount.value = 0;

        container.style.transform = `translateX(-${horizontalScrollAmount.value}px)`
      }


    }

    if(Number(node.dataset['index']) == 0) {
      horizontalScrollAmount.value = 0;
      container.style.transform = `translateX(-${horizontalScrollAmount.value}px)`

    }

    selectedItem['index'] = node.dataset['index'];
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

  resetScroll(){
    this.castScrollAmount = {
      value : 0
    };

    this.similarScrollAmount = {
      value : 0
    };

    this.selectedCast = {
      index : undefined
    };

    this.selectedSimilar = {
      index : undefined
    };
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
            if (!this.canPlay) return;
            if (this.selectedMovie['torrents']) {
              this.router.navigateByUrl("/player");
            }else {
              this.notificationService.sendNotification('error',"No streaming service found for the movie")
            }
            break;
          case document.activeElement.classList.contains('trailer'):
            if (!this.trailer) {
              this.notificationService.sendNotification("error","No trailer found")
              return;
            }

            this.showYtVid(this.trailer);

            break;
          case document.activeElement.classList.contains('addWatchlist'):
            this.notificationService.sendNotification("error","Feature not available yet")
          break;
          case document.activeElement.classList.contains('addWatched'):
            this.notificationService.sendNotification("error","Feature not available yet")
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
