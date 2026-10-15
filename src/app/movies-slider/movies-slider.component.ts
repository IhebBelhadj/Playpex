import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, AfterViewInit, OnDestroy } from '@angular/core';
import { MoviesService } from '../movies.service';
import { ActivatedRoute, Router } from '@angular/router';
import { Catalog } from '../catalog';
import { Subscription } from 'rxjs';
import { SplashService } from '../splash.service';

@Component({
  selector: 'movies-slider',
  templateUrl: './movies-slider.component.html',
  styleUrls: ['./movies-slider.component.scss'],
})
export class MoviesSliderComponent implements OnInit , AfterViewInit , OnDestroy {

  scrolledAmount = 0;
  limit = 20;
  movies = {};
  catalog:Catalog;
  navSub:Subscription;
  moviesSub:Subscription;
  sliderEventSub:Subscription;
  focusListener;
  imgBaseUrl = "https://image.tmdb.org/t/p/w342";

  constructor(
    private menuService:MenuServiceService ,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private router:Router,
    private route:ActivatedRoute,
    private splashService:SplashService,
  ) { }



  ngOnInit(): void {


    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];
    this.movies = this.catalog.items.getValue();

    setTimeout(()=>{
      this.updateNavigation();
    } , 100)

    this.moviesSub = this.catalog.items.subscribe(data =>{
      this.movies = data;

    })

    this.focusListener = (e)=>{

      const node = e.target as HTMLElement;


      if (e.target['parentElement']['classList'].contains('sliderSection')) {


        let currentSection = node.dataset['section'];
        let currentMovies = this.movies[currentSection] as Array<Object>


        //Get more movies
        if (currentMovies.length - Number(node.dataset['index']) == Math.floor(this.limit/2)) {
          let pageNumber = Math.floor(currentMovies.length / this.limit) + 1
          console.log(pageNumber);

          this.catalog.requestPage(currentSection , pageNumber);

        }

        //update navigation data

        this.catalog.navigationData[currentSection]['reached'] = node.dataset['index'];
        for (const section in this.catalog.navigationData) {
          this.catalog.navigationData[section]['selected'] = false
        }
        this.catalog.navigationData[currentSection]['selected'] = true;



        this.selectMovie(node.dataset['id'] , node.dataset['section'] , node.dataset['index']);
        this.sendMenuInstruction("collapse");



        this.updateNavigation()

      }

    }
    window.addEventListener('sn:focused', this.focusListener);

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (this.router.url == this.catalog.listUrl && instruction == "back") {
        if (this.menuService.menuState == "collapsed") {
          let currentlyActive = document.activeElement as HTMLElement;
          this.catalog.navigationData[currentlyActive.dataset['section']]['reached'] = 0;
          this.updateNavigation();
          this.menuService.sendInstruction('expand' , this)

          let menuElem = document.querySelector('.menuItem') as HTMLElement;
          console.log(menuElem);
          setTimeout(()=>{
            menuElem.focus({preventScroll : true})
          } , 10)
        }else if (
          this.menuService.menuState == "expanded" &&
          document.activeElement.classList.contains("menuItem"))
        {
          this.navSub.unsubscribe();
          this.router.navigateByUrl('/power');
        }
      }

    })

  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'})
    this.navigation.updateNavigation('remove' , {sectionId : 'slider'})
    window.removeEventListener('sn:focused', this.focusListener);
    this.navSub?.unsubscribe();
    this.moviesSub?.unsubscribe();
    this.sliderEventSub?.unsubscribe();
  }

  ngAfterViewInit(): void {

    this.navigation.updateNavigation('add' , {
      id: 'slider',
      selector: '.slider .sliderSection .element',
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
        right: '@slider'
      }
    })

    this.navigation.updateNavigation('makeFocusable' , {})
    console.log(this.catalog.navigationData);

    this.sliderEventSub = this.navigation.getMovieSliderEvent().subscribe(e=>{

      (document.querySelector('.sliderContainer .element') as HTMLElement)?.focus({preventScroll : true})

    })

    // Opened after the splash (from "Who's watching?") with no row visited yet:
    // focus the first poster once the rows arrive
    let visited = Object.values(this.catalog.navigationData).some(d => d['selected']);
    if (this.splashService.cleared && !visited) {
      this.focusFirstWhenReady(50);
    }

  }

  focusFirstWhenReady(tries:number){
    setTimeout(()=>{
      if (this.router.url != this.catalog.listUrl) return;
      // the user already got somewhere (e.g. the menu)
      if (document.activeElement && document.activeElement !== document.body) return;

      let first = document.querySelector('.sliderContainer .element') as HTMLElement;
      if (first) first.focus({preventScroll : true});
      else if (tries > 0) this.focusFirstWhenReady(tries - 1);
    } , 100)
  }

  updateNavigation(){

    let sliderParent = document.querySelector('.sliderContainer .content') as HTMLElement;

    for (const category in this.catalog.navigationData) {

      // row not rendered yet (still loading)
      if (!document.querySelector(`[data-section="${category}"]`)) continue

      //Handle horizontal Navigation

      let index = this.catalog.navigationData[category]['reached'];
      let section = document.querySelector(`[data-section="${category}"]`).closest('.section');

      let node = section.querySelector(`[data-index='${index}']`) as HTMLElement;
      if (!node) continue;

      let sliderSection = node.closest('.sliderSection') as HTMLElement;
      let leftDiff = sliderSection.getBoundingClientRect().left - node.getBoundingClientRect().left;

      sliderSection.style.transform = `translateX(${leftDiff}px)`


      if(this.catalog.navigationData[category]['selected']){


        node.focus({preventScroll:true});
        //Handle vertical navigation

        let topDiff = sliderParent.getBoundingClientRect().top - section.getBoundingClientRect().top;

        sliderParent.style.transform = `translateY(${topDiff}px)`

      }

    }


  }

  sendMenuInstruction(instruction: string){

    this.menuService.sendInstruction(instruction , this);
  }

  selectMovie(id: string , category: string , index: string){
    this.catalog.select(id , category , index)

  }

  trackById(index:Number, movie: { id: any; }) {
    return movie.id;
  }

  trackByCategory(index:Number , category: { key: any; }){
    return category.key
  }

  unsorted(){}


}
