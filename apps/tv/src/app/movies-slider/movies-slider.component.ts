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
import { Catalog, CatalogRow, ContinueAt, RowItem } from '../catalog';
import { EpisodePlaybackService } from '../episode-playback.service';
import { actionForKey } from '../keymap';
import { SectionRowsService } from '../sections.service';
import { Dialogs, Toasts } from '../ui/public-api';
import { Subscription } from 'rxjs';
import { SplashService } from '../splash.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { Intent, Navigator, useScreen } from '../nav/public-api';
import { dp } from '../ui/public-api';

const LOAD_AHEAD = 10;         // next page this many cards before a row's end

// The rows of a section (Home, Movies or TV shows: the server's, in its
// layout's order, SectionRowsService). Movement and
// positioning are the movement system's (src/app/movement): a translated
// pxStack of pxRows, positions remembered in PositionStore under
// `catalog:<media>` (survives the player and the detail pages). This
// component only feeds the rows, pages them and describes the focused card.
// The section's screen (core.home / core.movies / core.shows, src/app/nav):
// Enter on a card opens its title (a plugin's card: its intent or call); the
// options key (keymap `options`) on a card: Move the row up / down, Hide it,
// Edit rows (the profile's layout); Back steps out to the menu, then the
// power menu (the section's back policy).
@Component({
  selector: 'movies-slider',
  templateUrl: './movies-slider.component.html',
  styleUrls: ['./movies-slider.component.scss'],
})
export class MoviesSliderComponent implements OnInit , AfterViewInit , OnDestroy {

  private profiles = inject(ProfilesService);
  // plugins' rows of this section (ui/slots)
  slotName:SlotName | null = 'core.movies.rows';
  slotContext:SectionContext | null = null;

  readonly loadAhead = LOAD_AHEAD;
  movies = {};
  catalog:Catalog;
  stackId = '';
  moviesSub:Subscription;
  sliderEventSub:Subscription;
  focusListener;
  keyListener;
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
    private sections:SectionRowsService,
    private dialogs:Dialogs,
    private toasts:Toasts,
    private episodePlayback:EpisodePlaybackService,
  ) { }

  ngOnInit(): void {
    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];
    this.stackId = `catalog:${this.catalog.media}`;
    this.slotName = this.catalog.media == 'tv' ? 'core.shows.rows' : this.catalog.media == 'movie' ? 'core.movies.rows' : null;
    if (this.catalog.mediaType) this.slotContext = { section: this.catalog.mediaType, profile: profileContext(this.profiles.current.value), query: '', filters: {} };
    this.catalog.visible = true;
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

    // The options key on a card: its row's menu
    this.keyListener = (e:KeyboardEvent) => {
      if (actionForKey(e) != 'options' || !this.screen.active || this.dialogs.open$.value.length) return;
      if (this.catalog.typing || this.catalog.filtering || this.catalog.search) return;
      let node = (document.activeElement as HTMLElement)?.closest('.sliderContainer [data-section]') as HTMLElement;
      let row = node && this.catalog.findRow(node.dataset['section']);
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      this.rowMenu(row, node.dataset['id']);
    };
    window.addEventListener('keydown', this.keyListener, true);

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
    window.removeEventListener('keydown', this.keyListener, true);
    this.catalog.visible = false;
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

  // Enter on a card: a title → the rows slide out, then its page opens (the
  // card is remembered for the way back: movement system); a show's Continue
  // watching card → the episode to go back to (its page has Resume), or the
  // one after a finished episode; a plugin's card: its intent or call
  open(row:CatalogRow, card:RowItem){
    if (this.opening) return;
    let item = card.item;
    if (!item) {
      if (card.run) card.run();
      else if (card.intent) this.navigator.open(card.intent);
      return;
    }
    let at:ContinueAt | undefined = item.continue;
    if (at && item.mediaType == 'tv') {
      let episode = (season:number, number:number) => this.leaveTo({ screen: 'core.episode', params: { id: item.tmdbId, season, episode: number } });
      if (at.kind == 'resume') episode(at.season, at.episode);
      else if (at.nextEpisode) episode(at.nextSeason ?? at.season, at.nextEpisode);
      else {
        this.opening = true;
        this.episodePlayback.next(item.tmdbId, at.season, at.episode).subscribe({
          next: next => {
            this.opening = false;
            if (next) episode(next.season, next.episode.episodeNumber);
            else this.openTitle(item);
          },
          error: () => {
            this.opening = false;
            this.openTitle(item);
          },
        });
      }
      return;
    }
    this.openTitle(item);
  }

  private openTitle(item){
    // the focused one, enriched by movies-page (its page, IMDb rating)
    let selected = this.moviesService.selectedmovie.value;
    let payload = selected && selected.tmdbId == item.tmdbId && selected.mediaType == item.mediaType ? selected : item;
    this.leaveTo({ screen: item.mediaType == 'tv' ? 'core.show' : 'core.movie', params: { id: item.tmdbId }, payload });
  }

  // the rows slide out, then the screen opens
  private leaveTo(intent:Intent){
    if (this.opening) return;
    this.opening = true;
    this.navigation.updateNavigation('remove' , {sectionId : "menu"})
    this.navigation.updateNavigation('remove' , {sectionId : "slider"})
    gsap.timeline().to(".sliderContainer" , {opacity : 0 , y : dp(100) , duration : .2 , ease : Power2.easeOut , onComplete : () => {
      this.navigator.open(intent);
    }});
  }

  // A row's pxRow asks (focus or scroll near its end): SectionRowsService fetches each page once
  loadMore(row:string){
    this.catalog.requestPage(row);
  }

  // ── a row's menu (the options key) ───────────────────────────────────────

  private rowMenu(row:CatalogRow, cardKey:string) {
    if (!this.sections.canEdit(this.catalog) || !row.entry) return;
    let index = this.catalog.rows.indexOf(row);
    let choices = [
      index > 0 ? { key: 'up', label: 'Move row up', value: 'up' } : null,
      index < this.catalog.rows.length - 1 ? { key: 'down', label: 'Move row down', value: 'down' } : null,
      { key: 'hide', label: 'Hide row', detail: 'Settings › Rows brings it back', value: 'hide' },
      { key: 'edit', label: 'Edit rows…', value: 'edit' },
    ].filter(Boolean) as { key:string, label:string, detail?:string, value:'up' | 'down' | 'hide' | 'edit' }[];
    this.dialogs.choose({ title: row.title, choices }).subscribe(choice => {
      if (choice == 'edit') {
        this.navigator.open({ screen: 'core.settings', payload: { group: 'rows', section: this.catalog.section, row: row.entry } });
        return;
      }
      this.sections.editEntry(this.catalog.section, row.entry, choice).subscribe({
        next: () => {
          this.sections.load(this.catalog);
          if (choice == 'hide') this.toasts.show({ text: `“${row.title}” hidden`, detail: 'Settings › Rows shows it again', key: 'rows' });
          this.refocus(choice == 'hide' ? null : row.key, cardKey);
        },
        error: () => this.toasts.show({ text: 'Couldn\'t change the rows', tone: 'error', key: 'rows' }),
      });
    });
  }

  // after the rows changed: the same card (its row moved), else where the stack remembers
  private refocus(rowKey:string | null, cardKey:string, tries = 20) {
    setTimeout(() => {
      if (!this.screen.active) return;
      let el = rowKey && document.querySelector(`.sliderContainer [data-section="${CSS.escape(rowKey)}"][data-id="${CSS.escape(cardKey)}"]`) as HTMLElement;
      if (el) this.engine.focus(el, 'key');
      else if (!rowKey && !this.catalog.loading) this.engine.restore(`stack:${this.stackId}`);
      else if (tries > 0) this.refocus(rowKey, cardKey, tries - 1);
    }, 100);
  }

  trackByKey(index:number, card:RowItem) {
    return card.key;
  }

  trackByRow(index:number, row:CatalogRow){
    return row.key;
  }

  // nothing to show at all (every row hidden, or none answered)
  get sectionEmpty():boolean {
    // (rows still waiting for their first page aren't nothing yet)
    return !this.catalog.rows.some(r => (this.movies[r.key] || []).length) && this.catalog.rows.every(r => this.catalog.last[r.key]);
  }

  get emptyNote():string {
    return this.sections.canEdit(this.catalog) ? 'No rows to show here. Settings › Rows brings hidden ones back.' : 'Nothing to show here yet.';
  }

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
