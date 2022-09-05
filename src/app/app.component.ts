import { MenuServiceService } from './menu-service.service';
import { NavigationService } from './navigation.service';
import { BackgroundService } from './background.service';
import { MoviesService } from './movies.service';
import { AfterContentInit, AfterViewInit, Component, OnInit } from '@angular/core';
import * as spatialNavigation from 'spatial-navigation-js'
import { ActivatedRoute, Router } from '@angular/router';
import { gsap , Power2 } from 'gsap'
import { Location } from '@angular/common';
@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})


export class AppComponent implements AfterViewInit , OnInit{
  title = 'Playpex';
  movies:any;
  img_url;
  imgBaseUrl = "https://image.tmdb.org/t/p/w780";
  default_img = '../assets/imgs/wallpaper.jpg';

  bgSubscription;
  constructor(
    private backgroundService:BackgroundService ,
    private _router: Router ,
    private movieService:MoviesService,
    private location: Location,
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private moviesService:MoviesService
    ){

  }


  ngAfterViewInit() {
    spatialNavigation.init();

    this.navigation.updatedNavigation().subscribe(instruction => {

      switch (instruction['type']) {
        case 'add':
          spatialNavigation.add(instruction['query']);
          break;
        case 'remove':
            spatialNavigation.remove(instruction['query']['sectionId']);
          break;
        case 'makeFocusable':
            spatialNavigation.makeFocusable();
          break;
        case 'focus':
          spatialNavigation.makeFocusable();
          if (instruction['query']) {

            spatialNavigation.focus(instruction['query']['sectionId']);
          }
          else {
            spatialNavigation.focus();

          }
          break;
        default:
          break;
      }
    })

    window.addEventListener('sn:focused', (e)=>{

      e.target['classList'].add("focused");

    });

    window.addEventListener('sn:unfocused', (e)=>{

      e.target['classList'].remove("focused")
    });


    document.addEventListener('keydown' , (e)=>{

      if (e.key == " ") {
        console.log('space pressed');

        if (document.activeElement.classList.contains('menuItem')) {
          this.menuService.sendInstruction("navigate");
        }

        switch (true) {
          case this._router.url == '/movies/list':
            if (!document.activeElement.classList.contains('menuItem')) {
              this.moviesPageNavigation()
            }

            break;

          default:
            this.navigation.addCommand('click');
            break;
        }


      }
      if (e.key == "Escape") {
        if (this._router.url == '/search') {
          this.location.back();
        }

        if (this._router.url == '/player') {
          this.navigation.addCommand('back');
        }

        if (this.navigation.routerCurrentMovieId) {

          this.movieService.popFromHistoryStack(this.navigation.routerCurrentMovieId)
          this.location.back();
        }
      }
    })
  }

  ngOnInit(){

    this.bgSubscription = this.backgroundService.getImage().subscribe(data => {
      this.img_url = this.imgBaseUrl + data.img_url;
    })
  }

  moviesPageNavigation(){

    let element = document.activeElement as HTMLElement;
    if (element.classList.contains('element')) {

      this.navigation.updateNavigation('remove' , {sectionId : "menu"})
      this.navigation.updateNavigation('remove' , {sectionId : "slider"})

      let sliderTl = gsap.timeline();
      sliderTl.to(".sliderContainer" , {opacity : 0 , y : 100 , duration : .2 , ease : Power2.easeOut , onComplete : ()=>{
        let selected = this.movieService.selectedmovie.value;

        this.moviesService.addMovieToHistory(selected);
        this._router.navigateByUrl(`/movies/movie/${selected['id']}`)

      }})
    }
  }

}


