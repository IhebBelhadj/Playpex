import { NavigationService } from './navigation.service';
import { BackgroundService } from './background.service';
import { AfterViewInit, Component, OnInit } from '@angular/core';
import * as spatialNavigation from '../plugins/spacialNavigation.js'
import { gsap } from 'gsap'
import { actionForKey, SPATIAL_NAVIGATION_KEYS } from './keymap';
import { PointerService } from './pointer.service';
import { FocusEngine } from './movement/movement';
import { InputDispatcher, Navigator } from './nav/public-api';
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
    private navigation:NavigationService,
    private pointer:PointerService,
    private focusEngine:FocusEngine,
    private dispatcher:InputDispatcher,
    // created before the first navigation, so it sees it
    private navigator:Navigator,
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


    // select / back go to whoever owns the input now: the top layer, else the
    // shown screen (src/app/nav). The pointer's clicks and right clicks come
    // through here too, as synthetic keys
    document.addEventListener('keydown' , (e)=>{
      let action = actionForKey(e);
      if (action == 'select') {
        // the select key would also "click" the focused <button> natively
        e.preventDefault();
        this.dispatcher.dispatch('select', e.isTrusted ? 'key' : 'pointer');
      }
      if (action == 'back') this.dispatcher.dispatch('back', e.isTrusted ? 'key' : 'pointer');
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

}
