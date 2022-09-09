import { Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, AfterViewInit, AfterContentInit } from '@angular/core';
import { gsap ,Power1} from 'gsap'
import { filter, map, Subscription } from 'rxjs';


@Component({
  selector: 'menu',
  templateUrl: './menu.component.html',
  styleUrls: ['./menu.component.scss']
})
export class MenuComponent implements OnInit , AfterViewInit{
  subscription: Subscription;
  currentUrl:string = "";
  constructor(
    private menuService:MenuServiceService,
    private navigation:NavigationService,
    private router:Router,
  ) {

    this.subscription = this.menuService.getInstruction().subscribe(data => {

      switch (data.instruction) {
        case "collapse":
          this.collapseMenu();
          break;
        case "hide":
          this.hideMenu();
          break;
        case "show":
          this.showMenu();
          break;
        case "navigate":
          this.navigate()
          break;
        case "expand":
          this.expendMenu();
          break;
        default:
          break;
      }


    })
  }

  ngAfterViewInit(): void {
    console.log("init menu");

  }

  ngOnInit(): void {
    window.addEventListener('sn:focused', (e)=>{
      const node = e.target as HTMLElement;

      if (node.classList.contains('menuItem')) {
        this.expendMenu();
      }
      else {
        this.collapseMenu();
      }
    })

    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => {

        console.log(e);
        this.currentUrl = e.url;

      })
    ).subscribe()

  }

  collapseMenu(){
    let menu = document.querySelector('.menuContainer');
    this.menuService.menuState = "collapsed";

    if(menu.classList.contains("expended")){
      let menuTl = gsap.timeline();
      menuTl.to('.menuContainer .menuItem' , {opacity : .6 , duration : .1 })
      menuTl.to(".menuContainer .description" , {opacity : 0 , duration : .2 , delay : -.1})
      menuTl.to('.menuContainer .logo' , {width : 30 , duration : .2 , delay : -.2})
      menuTl.to('.menuContainer .tabs' , {width : 50 , duration : .15 , delay : -.1 ,ease : Power1.easeOut , onComplete(){
        document.querySelectorAll('.description').forEach(element => {
          element['style']['display'] = "none";
        });

        menu.classList.remove("expended")
      }} )
    }
  }

  expendMenu(){
    let menu = document.querySelector('.menuContainer');
    this.menuService.menuState = "expanded";
    if(!menu.classList.contains("expended")){
      let menuTl = gsap.timeline();
      document.querySelectorAll('.description').forEach(element => {
        element['style']['display'] = "block";

      });

      menu.classList.add("expended")
      menuTl.to('.menuContainer .menuItem' , {opacity : 1 , duration : .1 })
      menuTl.to('.menuContainer .tabs' , {width : 220 , duration : .2 , delay:-.1})
      menuTl.to(".menuContainer .description" , {opacity : 1 , duration : .2 , delay : -.1})
      menuTl.to('.menuContainer .logo' , {width : 40 , duration : .2 ,  delay : -.2})


    }

  }

  hideMenu(){
    document.querySelector('.menu').classList.add('hide')
  }

  showMenu(){
    document.querySelector('.menu').classList.remove('hide')

  }


  navigate(){
    let active = document.activeElement as HTMLElement;
    let destination = active.dataset['destination'];

    switch (destination) {
      case "searchPage":
        this.router.navigateByUrl("/search")
        break;
      case "moviesPage":
        this.router.navigateByUrl("/movies/list")
        break;
      case "showsPage":
        this.router.navigateByUrl("/")
        break;
      default:
        break;
    }

  }

}
