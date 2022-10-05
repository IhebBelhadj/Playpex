import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, AfterViewInit, OnDestroy } from '@angular/core';
import { MoviesService } from '../movies.service';
import { Router } from '@angular/router';

@Component({
  selector: 'movies-slider',
  templateUrl: './movies-slider.component.html',
  styleUrls: ['./movies-slider.component.scss'],
})
export class MoviesSliderComponent implements OnInit , AfterViewInit , OnDestroy {

  scrolledAmount = 0;
  limit = 20;
  movies = {};
  imgBaseUrl = "https://image.tmdb.org/t/p/w342";

  constructor(
    private menuService:MenuServiceService ,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private router:Router,
  ) { }



  ngOnInit(): void {


    this.movies = this.moviesService.movies.getValue();

    setTimeout(()=>{
      this.updateNavigation();
    } , 100)

    this.moviesService.checkMovies().subscribe(data =>{
      this.movies = data;

    })

    window.addEventListener('sn:focused', (e)=>{

      const node = e.target as HTMLElement;


      if (e.target['parentElement']['classList'].contains('sliderSection')) {


        let currentSection = node.dataset['section'];
        let currentMovies = this.movies[currentSection] as Array<Object>


        //Get more movies
        if (currentMovies.length - Number(node.dataset['index']) == Math.floor(this.limit/2)) {
          let pageNumber = Math.floor(currentMovies.length / this.limit) + 1
          console.log(pageNumber);

          this.moviesService.requestMovies({
            category : currentSection,
            page : pageNumber
          });

        }

        //update navigation data

        this.moviesService.navigationData[currentSection]['reached'] = node.dataset['index'];
        for (const section in this.moviesService.navigationData) {
          this.moviesService.navigationData[section]['selected'] = false
        }
        this.moviesService.navigationData[currentSection]['selected'] = true;



        this.selectMovie(node.dataset['id'] , node.dataset['section'] , node.dataset['index']);
        this.sendMenuInstruction("collapse");



        this.updateNavigation()

      }

    });

    this.navigation.executeCommand().subscribe(instruction => {
      if (this.router.url == "/movies/list" && instruction == "back") {
        if (this.menuService.menuState == "collapsed") {
          let currentlyActive = document.activeElement as HTMLElement;
          this.moviesService.navigationData[currentlyActive.dataset['section']]['reached'] = 0;
          this.updateNavigation();
          this.menuService.sendInstruction('expand')

          let menuElem = document.querySelector('.menuItem') as HTMLElement;
          console.log(menuElem);
          setTimeout(()=>{
            menuElem.focus({preventScroll : true})
          } , 10)
        }
      }

    })

  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'})
    this.navigation.updateNavigation('remove' , {sectionId : 'slider'})
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
    console.log(this.moviesService.navigationData);

    this.navigation.getMovieSliderEvent().subscribe(e=>{

      (document.querySelector('.sliderContainer .element') as HTMLElement).focus({preventScroll : true})

    })

  }

  updateNavigation(){

    let sliderParent = document.querySelector('.sliderContainer .content') as HTMLElement;

    for (const category in this.moviesService.navigationData) {

      if (!document.querySelector(`[data-section="${category}"]`)) return

      //Handle horizontal Navigation

      let index = this.moviesService.navigationData[category]['reached'];
      let section = document.querySelector(`[data-section="${category}"]`).closest('.section');

      let node = section.querySelector(`[data-index='${index}']`) as HTMLElement;

      let sliderSection = node.closest('.sliderSection') as HTMLElement;
      let leftDiff = sliderSection.getBoundingClientRect().left - node.getBoundingClientRect().left;

      sliderSection.style.transform = `translateX(${leftDiff}px)`


      if(this.moviesService.navigationData[category]['selected']){


        node.focus({preventScroll:true});
        //Handle vertical navigation

        let topDiff = sliderParent.getBoundingClientRect().top - section.getBoundingClientRect().top;

        sliderParent.style.transform = `translateY(${topDiff}px)`

      }

    }


  }

  sendMenuInstruction(instruction: string){

    this.menuService.sendInstruction(instruction);
  }

  selectMovie(id: string , category: string , index: string){
    this.moviesService.selectMovie({
      id : id,
      category : category,
      index : index
    })

  }

  trackById(index:Number, movie: { id: any; }) {
    return movie.id;
  }

  trackByCategory(index:Number , category: { key: any; }){
    return category.key
  }

  unsorted(){}


}
