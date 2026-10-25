import { profileContext } from '../slot-contexts';
import { SectionContext, SlotName } from '../ui/public-api';
import { ProfilesService } from '../profiles.service';
import { NavigationService } from './../navigation.service';
import { MenuServiceService } from './../menu-service.service';
import { Component, OnInit, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { MoviesService } from '../movies.service';
import { hasFilters } from '../catalog-filters';
import { ActivatedRoute } from '@angular/router';
import { gsap , Power2 } from 'gsap'
import { Catalog } from '../catalog';
import { Subscription } from 'rxjs';
import { SplashService } from '../splash.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { Navigator, useScreen } from '../nav/public-api';
import { dp } from '../ui/public-api';
import { tmdbImageBase } from '../ui/public-api';

const PAGE_SIZE = 20;          // TMDB results per page
const LOAD_AHEAD = 10;         // next page this many posters before a row's end

// The category rows of a section (movies or TV shows). Movement and
// positioning are the movement system's (src/app/movement): a translated
// pxStack of pxRows, positions remembered in PositionStore under
// `catalog:<media>` (survives the player and the detail pages). This
// component only feeds the rows, pages them and describes the focused poster.
// The section's screen (core.movies / core.shows, src/app/nav): Enter on a
// poster opens its title; Back steps out to the menu, then the power menu
// (the section's back policy).
@Component({
  selector: 'movies-slider',
  templateUrl: './movies-slider.component.html',
  styleUrls: ['./movies-slider.component.scss'],
})
export class MoviesSliderComponent implements OnInit , AfterViewInit , OnDestroy {

  private profiles = inject(ProfilesService);
  // plugins' rows of this section (ui/slots)
  slotName:SlotName = 'core.movies.rows';
  slotContext:SectionContext | null = null;

  readonly loadAhead = LOAD_AHEAD;
  movies = {};
  catalog:Catalog;
  stackId = '';
  moviesSub:Subscription;
  sliderEventSub:Subscription;
  focusListener;
  imgBaseUrl = tmdbImageBase('poster', 180);
  private screen = useScreen();
  private opening = false;

  constructor(
    private menuService:MenuServiceService ,
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private navigator:Navigator,
    private route:ActivatedRoute,
    private splashService:SplashService,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  ngOnInit(): void {
    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];
    this.stackId = `catalog:${this.catalog.media}`;
    this.slotName = this.catalog.media == 'tv' ? 'core.shows.rows' : 'core.movies.rows';
    this.slotContext = { section: this.catalog.media, profile: profileContext(this.profiles.current.value), query: '', filters: {} };
    this.movies = this.catalog.items.getValue();

    this.moviesSub = this.catalog.items.subscribe(data => this.movies = data);

    // The description follows the focused poster
    this.focusListener = (e)=>{
      const node = e.target as HTMLElement;
      // a poster (menu items are `.element`s too)
      if (!this.screen.active || !node.closest('.sliderContainer')) return;
      this.catalog.select(node.dataset['id'] , node.dataset['section'] , node.dataset['index']);
      this.menuService.sendInstruction("collapse" , this);
    }
    window.addEventListener('sn:focused', this.focusListener);

    // In-page steps; on the menu, Back leaves (the power menu)
    this.screen.onBack(() => {
      let active = document.activeElement as HTMLElement;
      if (!active || active.classList.contains('menuItem')) return false;
      if (this.catalog.search && active.closest('.sliderContainer')) {
        // back on a search result: to the search bar, results kept
        (document.querySelector('.sectionToolbar [data-px-key="search"]') as HTMLElement)?.focus({ preventScroll: true });
      } else if (active.closest('.sliderContainer')) {
        // back on a poster: its row returns to the start, the menu opens
        let row = this.engine.containerOf(active.closest('[data-px-container="row"]'));
        row?.home();
        this.openMenu();
      } else {
        this.openMenu();
      }
      return true;
    });
  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove' , {sectionId : 'menu'})
    window.removeEventListener('sn:focused', this.focusListener);
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
      if (!this.screen.active) return;
      // the user already got somewhere (e.g. the menu)
      if (document.activeElement && document.activeElement !== document.body) return;
      if (!this.engine.restore(`stack:${this.stackId}`) && tries > 0) this.focusFirstWhenReady(tries - 1);
    } , 100)
  }

  // Enter on a poster: the rows slide out, then its title opens (the poster
  // is remembered for the way back: movement system)
  open(item){
    if (this.opening) return;
    this.opening = true;
    this.navigation.updateNavigation('remove' , {sectionId : "menu"})
    this.navigation.updateNavigation('remove' , {sectionId : "slider"})
    // the focused one, enriched by movies-page (its page, IMDb rating)
    let selected = this.moviesService.selectedmovie.value;
    let payload = selected && selected.tmdbId == item.tmdbId ? selected : item;
    gsap.timeline().to(".sliderContainer" , {opacity : 0 , y : dp(100) , duration : .2 , ease : Power2.easeOut , onComplete : () => {
      this.navigator.open({ screen: this.catalog.detailScreen, params: { id: item.tmdbId }, payload });
    }});
  }

  // A row's pxRow asks (focus or scroll near its end); movies-page fetches
  // each page once
  loadMore(category:string){
    let count = (this.movies[category] || []).length;
    this.catalog.requestPage(category , Math.floor(count / PAGE_SIZE) + 1);
  }

  trackById(index:Number, movie: { tmdbId: number; }) {
    return movie?.tmdbId;
  }

  trackByCategory(index:Number , category: { key: any; }){
    return category.key
  }

  unsorted(){ return 0; }

  // every row of the search / filters is empty (still loading, or nothing found)
  get searchEmpty():boolean {
    return this.catalog.search.rows.every(row => !(this.movies[row] || []).length);
  }

  get searchNote():string {
    let search = this.catalog.search;
    let noun = this.catalog.media == 'tv' ? 'TV shows' : 'movies';
    if (search.pending) return search.query ? 'Searching…' : `Finding ${noun}…`;
    if (!search.query) return `No ${noun} match these filters. Try a wider period or a lower score.`;
    if (hasFilters(search.filters)) return `No ${noun} match “${search.query}” with these filters. Try other words or fewer filters.`;
    return `No ${noun} match “${search.query}”. Try other words.`;
  }
}
