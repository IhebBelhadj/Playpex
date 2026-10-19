import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { gsap ,Power1} from 'gsap'
import { combineLatest, Subscription } from 'rxjs';
import { Profile, ProfilesService } from '../profiles.service';
import { ServerService } from '../server.service';
import { Navigator, ScreenDef } from '../nav/public-api';

// The left menu: the sections declared with a menu entry (src/app/nav/screens.ts),
// the server in use and who's watching. Enter on a section → that section
// alone in the history (Navigator.switchSection); the active item is the
// section at the bottom of the history. Hidden on screens whose chrome says
// so (`chrome.menu: 'hidden'`); pages expand / collapse it as focus moves.
@Component({
  selector: 'menu',
  templateUrl: './menu.component.html',
  styleUrls: ['./menu.component.scss']
})
export class MenuComponent implements OnInit , OnDestroy {
  subscriptions:Subscription[] = [];
  profile:Profile | null = null;
  serverName:string;
  sections:ScreenDef[] = [];
  activeSection = '';
  private focusListener = (e:Event) => {
    const node = e.target as HTMLElement;
    if (node.classList.contains('menuItem')) this.expendMenu();
    else this.collapseMenu();
  };

  constructor(
    private menuService:MenuServiceService,
    private navigator:Navigator,
    private profiles:ProfilesService,
    server:ServerService,
  ) {
    this.serverName = server.name;
  }

  ngOnInit(): void {
    this.subscriptions.push(
      // Who's watching: shown at the bottom of the menu; some sections depend on it (18+)
      this.profiles.current.subscribe(profile => {
        this.profile = profile;
        this.sections = this.navigator.registry.sections().filter(s => !s.menu.visible || s.menu.visible({ profile }));
      }),

      this.navigator.current$.subscribe(entry => {
        let root = this.navigator.root;
        if (root) this.activeSection = root.screen.section || root.screen.id;
        if (entry) entry.screen.chrome?.menu == 'hidden' ? this.hideMenu() : this.showMenu();
      }),

      this.menuService.getInstruction().subscribe(data => {
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
          case "expand":
            this.expendMenu();
            break;
          default:
            break;
        }
      }),
    );

    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
  }

  openSection(section:ScreenDef){
    this.navigator.switchSection(section.id);
  }

  openConnect(){
    this.navigator.open({ screen: 'core.connect' });
  }

  // Another profile: "Who's watching?" starts the history over
  openProfiles(){
    this.navigator.reset({ screen: 'core.profiles' });
  }

  trackById(index:number, section:ScreenDef){
    return section.id;
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

  avatarUrl(avatar:string | null){
    return ProfilesService.avatarUrl(avatar);
  }

  hideMenu(){
    document.querySelector('.menu')?.classList.add('hide')
  }

  showMenu(){
    document.querySelector('.menu')?.classList.remove('hide')
  }

}
