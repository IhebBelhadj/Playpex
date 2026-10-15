import { MenuServiceService } from './menu-service.service';
import { NavigationService } from './navigation.service';
import { BackgroundService } from './background.service';
import { MoviesService } from './movies.service';
import { AfterContentInit, AfterViewInit, Component, OnInit } from '@angular/core';
import * as spatialNavigation from '../plugins/spacialNavigation.js'
import { ActivatedRoute, Router } from '@angular/router';
import { gsap , Power2 } from 'gsap'
import { Location } from '@angular/common';
import { delay } from 'rxjs';
import { actionForKey, SPATIAL_NAVIGATION_KEYS } from './keymap';
import { TorrentPickerService } from './torrent-picker.service';
import { PlayChoiceService } from './play-choice.service';
import { PointerService } from './pointer.service';
import { FocusEngine } from './movement/movement';
@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})


export class AppComponent implements AfterViewInit , OnInit{
  title = 'Playpex';
  movies:any;
  previousImg;
  nextImg;
  previousImgElement;
  newImgElement;
  imgBaseUrl = "https://image.tmdb.org/t/p/w780";
  default_img = '../assets/imgs/wallpaper.jpg';
  imgStaticTl;

  bgSubscription;
  constructor(
    private backgroundService:BackgroundService ,
    private _router: Router ,
    private movieService:MoviesService,
    private location: Location,
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private moviesService:MoviesService,
    private torrentPicker:TorrentPickerService,
    private playChoice:PlayChoiceService,
    private pointer:PointerService,
    private focusEngine:FocusEngine,
    ){

  }


  ngAfterViewInit() {
    spatialNavigation.setKeyMap(SPATIAL_NAVIGATION_KEYS);
    spatialNavigation.init();
    // focus movement and scrolling of the migrated pages (src/app/movement)
    this.focusEngine.init();
    // mouse: hover focuses, click selects, right click goes back (pointer.service.ts)
    this.pointer.init();

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

      // Only one element has focus. An element that lost it while hidden (e.g. a
      // menu item when a page hides the menu) never gets sn:unfocused, so clear
      // any stale highlight here.
      document.querySelectorAll('.focused').forEach(node => {
        if (node !== e.target) node.classList.remove('focused');
      });
      e.target['classList'].add("focused");

    });

    window.addEventListener('sn:unfocused', (e)=>{

      e.target['classList'].remove("focused")
    });


    document.addEventListener('keydown' , (e)=>{
      let action = actionForKey(e);

      // An open modal (torrent picker, resume/start-over) takes select/back;
      // the page behind must not react
      let modal = this.torrentPicker.isOpen ? this.torrentPicker : this.playChoice.isOpen ? this.playChoice : null;
      if (modal) {
        if (action == 'select' || action == 'back') {
          e.preventDefault();
          modal.sendCommand(action);
        }
        return;
      }

      if (action == 'select') {
        // the select key would also "click" the focused <button> natively
        e.preventDefault();

        if (document.activeElement.classList.contains('menuItem')) {
          this.menuService.sendInstruction("navigate" , this);
        }

        switch (true) {
          // a section's poster rows (movies or TV shows)
          case !!this.moviesService.catalogForUrl(this._router.url):
            if (!document.activeElement.classList.contains('menuItem')) {
              this.moviesPageNavigation()
            }

            break;

          default:
            this.navigation.addCommand('click');
            break;
        }


      }
      if (action == 'back') {

        this.navigation.addCommand('back');

      }
    })
  }

  ngOnInit(){
    this.previousImgElement = document.querySelector('.previousBackground') as HTMLElement;
    this.newImgElement = document.querySelector('.newBackground') as HTMLElement;
    this.imgStaticTl = gsap.timeline();
    this.bgSubscription = this.backgroundService.getImage().subscribe(data => {
      gsap.set(this.newImgElement, { clearProps: true });
      gsap.set(this.previousImgElement, { clearProps: true });

      // a TMDB path, or a full URL (18+ catalog providers)
      let url = /^https?:/.test(data.img_url) ? data.img_url : this.imgBaseUrl + data.img_url;
      if(!this.previousImg) {
        this.previousImg = url;
        this.previousImgElement.src = this.previousImg;
        this.animateImgStatic('.previousBackground');

      }
      else if(!this.nextImg){
        this.nextImg = url;
        this.newImgElement.src = this.nextImg;
        this.imgChangeAnimation();
        this.animateImgStatic('.newBackground');


      }
      else {
        this.previousImg = this.nextImg;
        this.previousImgElement.src = this.previousImg;
        this.nextImg = url;
        this.newImgElement.src = this.nextImg;
        this.imgChangeAnimation();
        this.animateImgStatic('.newBackground');

      }

    })

  }

  animateImgStatic(ImgCssClass ){
    this.imgStaticTl.clear();
    this.imgStaticTl.fromTo(ImgCssClass , {scale : 1} , {scale : 1.13 , duration : 20  })
  }

  imgChangeAnimation(){

    let imgChangeTl = gsap.timeline();
    imgChangeTl.fromTo('.previousBackground' , {opacity : 1} , {opacity : 0 , duration : 1})


  }

  moviesPageNavigation(){

    let element = document.activeElement as HTMLElement;
    if (element.classList.contains('element')) {
      // opened with a mouse click: come back to this poster, not the row's old position
      let catalog = this.moviesService.catalogForUrl(this._router.url);
      if (catalog && element.dataset['section']) catalog.navigationData[element.dataset['section']]['reached'] = element.dataset['index'];

      this.navigation.updateNavigation('remove' , {sectionId : "menu"})
      this.navigation.updateNavigation('remove' , {sectionId : "slider"})

      let sliderTl = gsap.timeline();
      sliderTl.to(".sliderContainer" , {opacity : 0 , y : 100 , duration : .2 , ease : Power2.easeOut , onComplete : ()=>{
        let selected = this.movieService.selectedmovie.value;
        let catalog = this.moviesService.catalogForUrl(this._router.url);

        // the history stack holds movies only (TMDB movie and TV ids overlap)
        if (catalog.media == 'movie') this.moviesService.addMovieToHistory(selected);
        this._router.navigateByUrl(catalog.detailUrl(selected['id']))

      }})
    }
  }

}


