import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, AfterViewInit, OnDestroy } from '@angular/core';
import { MoviesService } from '../movies.service';
import { ActivatedRoute, Router } from '@angular/router';
import { Catalog } from '../catalog';
import { Subscription } from 'rxjs';
import { SplashService } from '../splash.service';
import { FocusEngine, PositionStore } from '../movement/movement';

const PAGE_SIZE = 20;          // TMDB results per page
const LOAD_AHEAD = 10;         // next page this many posters before a row's end

// The category rows of a section (movies or TV shows). Movement and
// positioning are the movement system's (src/app/movement): a translated
// pxStack of pxRows, positions remembered in PositionStore under
// `catalog:<media>` (survives the player and the detail pages). This
// component only feeds the rows, pages them and describes the focused poster.
@Component({
  selector: 'movies-slider',
  templateUrl: './movies-slider.component.html',
  styleUrls: ['./movies-slider.component.scss'],
})
export class MoviesSliderComponent implements OnInit , AfterViewInit , OnDestroy {

  readonly loadAhead = LOAD_AHEAD;
  movies = {};
  catalog:Catalog;
  stackId = '';
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
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  ngOnInit(): void {
    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];
    this.stackId = `catalog:${this.catalog.media}`;
    this.movies = this.catalog.items.getValue();

    this.moviesSub = this.catalog.items.subscribe(data => this.movies = data);

    // The description follows the focused poster
    this.focusListener = (e)=>{
      const node = e.target as HTMLElement;
      // a poster (menu items are `.element`s too)
      if (this.router.url != this.catalog.listUrl || !node.closest('.sliderContainer')) return;
      this.catalog.select(node.dataset['id'] , node.dataset['section'] , node.dataset['index']);
      this.menuService.sendInstruction("collapse" , this);
    }
    window.addEventListener('sn:focused', this.focusListener);

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      // (the search's keyboard handles its own keys)
      if (this.router.url != this.catalog.listUrl || this.catalog.typing) return;
      if (instruction == "leave") {
        // the shell's Back button: out to the power menu at once
        this.navSub.unsubscribe();
        this.navigation.openPowerMenu();
      }
      if (instruction != "back") return;
      let active = document.activeElement as HTMLElement;
      if (this.catalog.search && active.closest('.sliderContainer')) {
        // back on a search result: to the search bar, results kept
        (document.querySelector('.sectionToolbar .searchField') as HTMLElement)?.focus({ preventScroll: true });
      } else if (active.closest('.sectionToolbar')) {
        this.openMenu();
      } else if (this.menuService.menuState == "collapsed") {
        // back on a poster: its row returns to the start, the menu opens
        let row = this.engine.containerOf(active.closest('[data-px-container="row"]'));
        row?.home();
        this.openMenu();
      } else if (active.classList.contains("menuItem")) {
        this.navSub.unsubscribe();
        this.navigation.openPowerMenu();
      }
    })
  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'})
    window.removeEventListener('sn:focused', this.focusListener);
    this.navSub?.unsubscribe();
    this.moviesSub?.unsubscribe();
    this.sliderEventSub?.unsubscribe();
  }

  // Section `slider` is a pxSection in the template
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add',{
      id: 'menu',
      selector: '.menuContainer .element',
      restrict : "self-only",
      leaveFor: {
        right: this.engine.target([`stack:${this.stackId}`, '@slider'])
      }
    })

    // the splash is gone (movies-page): first poster
    this.sliderEventSub = this.navigation.getMovieSliderEvent().subscribe(() => this.focusFirstWhenReady(50));

    // Back from a title / the player: the same poster, rows where they were.
    // Opened after the splash (from "Who's watching?") with no row visited
    // yet: the first poster once the rows arrive
    if (this.positions.get(this.stackId)) setTimeout(() => this.engine.restore(`stack:${this.stackId}`));
    else if (this.splashService.cleared) this.focusFirstWhenReady(50);
  }

  // The menu, opened on this section's own item
  private openMenu(){
    this.menuService.sendInstruction('expand' , this)
    let menuElem = (document.querySelector('.menuItem.active') || document.querySelector('.menuItem')) as HTMLElement;
    setTimeout(() => menuElem?.focus({preventScroll : true}), 10)
  }

  focusFirstWhenReady(tries:number){
    setTimeout(()=>{
      if (this.router.url != this.catalog.listUrl) return;
      // the user already got somewhere (e.g. the menu)
      if (document.activeElement && document.activeElement !== document.body) return;
      if (!this.engine.restore(`stack:${this.stackId}`) && tries > 0) this.focusFirstWhenReady(tries - 1);
    } , 100)
  }

  // A row's pxRow asks (focus or scroll near its end); movies-page fetches
  // each page once
  loadMore(category:string){
    let count = (this.movies[category] || []).length;
    this.catalog.requestPage(category , Math.floor(count / PAGE_SIZE) + 1);
  }

  trackById(index:Number, movie: { id: any; }) {
    return movie?.id;
  }

  trackByCategory(index:Number , category: { key: any; }){
    return category.key
  }

  unsorted(){ return 0; }
}
