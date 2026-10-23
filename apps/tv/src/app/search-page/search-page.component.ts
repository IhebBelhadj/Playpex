import { EMPTY_SEARCH, MoviesService, SearchItem, SearchKind, SearchRow, SearchState } from './../movies.service';
import { catchError, debounceTime, first, forkJoin, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { FocusEngine, PositionStore } from '../movement/movement';
import { ProfilesService } from '../profiles.service';
import { Navigator, useScreen } from '../nav/public-api';
import { RemotePlugins } from '../plugins/remote';
import { CardModel, ContributionDef, CONTRIBUTIONS, SearchFilterModel, tmdbImageBase } from '../ui/public-api';

interface Filter {
  id: string;
  label: string;
}

// A plugin's chip (slot core.search.filters): its contribution, and what it
// answered for the query (its label, its rows)
interface PluginFilter {
  id: string;                 // 'plugin:<chip key>'
  chip: Filter;               // one object: the chips' *ngFor keeps its element
  def: ContributionDef<'core.search.filters'>;
  model: SearchFilterModel;
}

interface PluginRow {
  key: string;
  title: string;
  variant?: CardModel['variant'];
  items: CardModel[];
}

const MIN_QUERY = 3;
const ADULT_WINDOW = 4;     // 18+ filter: TMDB pages read from where adult results start
const TMDB_MAX_PAGES = 500;
const STACK = 'search';       // the page's pxStack: positions are kept under this id

@Component({
  selector: 'app-search-page',
  templateUrl: './search-page.component.html',
  styleUrls: ['./search-page.component.scss']
})
export class SearchPageComponent implements OnInit , AfterViewInit , OnDestroy {

  filters:Filter[] = [
    { id : 'all' ,    label : 'All' },
    { id : 'movie' ,  label : 'Movies' },
    { id : 'tv' ,     label : 'TV shows' },
    { id : 'anime' ,  label : 'Anime' },
    { id : 'person' , label : 'People' },
    { id : 'adult' ,  label : '18+' },        // never offered to kids profiles
  ];

  imgBase = tmdbImageBase('poster', 150);
  state:SearchState = EMPTY_SEARCH;
  loading = false;
  // the plugins' chips after the core's, and the chosen one's rows
  pluginFilters:PluginFilter[] = [];
  pluginRows:PluginRow[] = [];
  private pluginSub:Subscription;
  private chipsSub:Subscription;

  searchSub:Subscription;
  private searches = new Subject<{query:string , filter:string}>();
  private screen = useScreen();

  constructor(
    private navigation:NavigationService,
    private moviesService:MoviesService,
    private navigator:Navigator,
    private profiles:ProfilesService,
    private engine:FocusEngine,
    private positions:PositionStore,
    private remotePlugins:RemotePlugins,
  ) { }

  get isKid():boolean {
    return !!this.profiles.current.value?.isKid;
  }

  get visibleFilters():Filter[] {
    let core = this.isKid ? this.filters.filter(f => f.id != 'adult') : this.filters;
    return [...core, ...this.pluginFilters.map(f => f.chip)];
  }

  get pluginFilter():PluginFilter | null {
    return this.pluginFilters.find(f => f.id == this.state.filter) || null;
  }

  ngOnInit(): void {
    this.state = this.moviesService.searchData.value;
    // left over from another profile
    if (this.isKid && this.state.filter == 'adult') this.state = EMPTY_SEARCH;
    this.loadPluginChips();

    // Latest query/filter wins; typing on the on-screen keyboard is debounced
    this.searchSub = this.searches.pipe(
      debounceTime(200),
      switchMap(({query , filter}) => this.fetchRows(query , filter).pipe(
        map(rows => ({query , filter , rows})),
        catchError(() => of({query , filter , rows : null})),
      )),
    ).subscribe(({query , filter , rows}) => {
      this.loading = false;
      if (query != this.state.query || filter != this.state.filter) return;
      // new results: no old position in them
      this.positions.clear(STACK);
      this.update({ rows : (rows || []).filter(r => r.items.length) , searched : true });
    });

    this.screen.onSelect(active => {
      if (active.classList.contains('keyboardBtn')) this.typeKey(active);
      else if (active.classList.contains('px-card')) this.open(this.itemFor(active));
    });

    // a section without the menu: out to the power menu at once (the
    // section's back policy), starting over next time
    let clear = () => {
      this.moviesService.searchData.next(EMPTY_SEARCH);
      this.positions.clear(STACK);
      return false;
    };
    this.screen.onBack(clear);
    this.screen.onLeave(clear);
  }

  // Sections `keyboard`, `searchFilters` and `searches` are pxSection
  // directives in the template; the page and its rows scroll natively
  ngAfterViewInit(): void {
    // Coming back from a title page: same results, same item focused
    setTimeout(()=>{
      let restored = this.state.rows.length && this.positions.get(STACK) && this.engine.restore(`stack:${STACK}`);
      if (!restored) this.navigation.updateNavigation('focus' , {sectionId : 'keyboard'});
    } , 50)
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.pluginSub?.unsubscribe();
    this.chipsSub?.unsubscribe();
  }

  // ── searching ───────────────────────────────────────────────────────────

  get note():string {
    if (this.state.query.trim().length < MIN_QUERY) return '';
    if (this.loading && !this.state.rows.length) return 'Searching…';
    if (this.state.filter.startsWith('plugin:')) {
      if (this.loading && !this.pluginRows.length) return 'Searching…';
      let label = this.pluginFilter?.model.label || 'this plugin';
      return this.state.searched && !this.pluginRows.length ? `${label} has nothing for “${this.state.query.trim()}”.` : '';
    }
    if (this.state.searched && !this.state.rows.length) {
      let what = this.filters.find(f => f.id == this.state.filter);
      return this.state.filter == 'all'
        ? `Nothing matches “${this.state.query.trim()}”. Check the spelling or try fewer words.`
        : this.state.filter == 'adult'
          ? `No 18+ titles match “${this.state.query.trim()}”. Very common words match too many regular titles: add another word.`
          : `No ${what.label.toLowerCase()} match “${this.state.query.trim()}”. Try All to search everything.`;
    }
    return '';
  }

  onInputChange(input:HTMLInputElement){
    this.update({ query : input.value });
    this.search();
  }

  setFilter(filter:string){
    if (filter == this.state.filter || !this.visibleFilters.some(f => f.id == filter)) return;
    this.update({ filter });
    this.search();
  }

  search(){
    let query = this.state.query.trim();
    this.pluginSub?.unsubscribe();
    this.pluginRows = [];
    if (query.length < MIN_QUERY) {
      this.loading = false;
      this.update({ rows : [] , searched : false });
      return;
    }
    this.loading = true;
    if (this.state.filter.startsWith('plugin:')) {
      this.update({ rows : [] , searched : false });
      this.searchPlugin(query);
      return;
    }
    this.searches.next({ query : this.state.query , filter : this.state.filter });
  }

  // ── plugins' chips (slot core.search.filters) ───────────────────────────

  private context(query:string) {
    let p = this.profiles.current.value;
    return { query , profile : { id : p?.id , name : p?.name , kids : !!p?.isKid } };
  }

  // Each plugin's chip: its label comes from its answer, asked once with the query shown
  // (again when the server's plugins change)
  private loadPluginChips(){
    this.chipsSub = this.remotePlugins.plugins$.pipe(
      switchMap(() => {
        let defs = CONTRIBUTIONS.for('core.search.filters' , this.context(this.state.query));
        if (!defs.length) return of([]);
        return forkJoin(defs.map(def => CONTRIBUTIONS.models(def , this.context(this.state.query.trim())).pipe(
          first(),
          map(models => models[0] ? {
            id : `plugin:${models[0].key}` , def , model : models[0] , chip : { id : `plugin:${models[0].key}` , label : models[0].label },
          } as PluginFilter : null),
          catchError(() => of(null)),
        )));
      }),
    ).subscribe(found => {
      this.pluginFilters = (found as PluginFilter[]).filter(Boolean);
      // a plugin chip left from before: its rows again, or All when it's gone
      if (this.state.filter.startsWith('plugin:')) {
        if (this.pluginFilter) this.search();
        else {
          this.update({ filter : 'all' });
          this.search();
        }
      }
    });
  }

  private searchPlugin(query:string){
    let chosen = this.pluginFilter;
    if (!chosen) return;
    this.pluginSub = CONTRIBUTIONS.models(chosen.def , this.context(query)).pipe(
      first(),
      map(models => models.find(m => m.key == chosen.model.key) || models[0] || null),
      switchMap((model:SearchFilterModel | null) => {
        if (!model?.rows.length) return of([] as PluginRow[]);
        return forkJoin(model.rows.map(row => 'items' in row.source
          ? of({ key : row.key , title : row.title , variant : row.variant , items : row.source.items })
          : row.source.page(1).pipe(
              map(page => ({ key : row.key , title : row.title , variant : row.variant , items : page.items })),
              catchError(() => of(null)),
            )));
      }),
      catchError(() => of([] as PluginRow[])),
    ).subscribe(rows => {
      this.loading = false;
      if (query != this.state.query.trim() || this.pluginFilter !== chosen) return;
      this.positions.clear(STACK);
      this.pluginRows = rows.filter(r => r && r.items.length);
      this.update({ searched : true });
    });
  }

  pickPlugin(card:CardModel){
    if (card.run) card.run();
    else if (card.intent) this.navigator.open(card.intent);
  }

  trackFilter(index:number , filter:Filter){
    return filter.id;
  }

  trackPluginRow(index:number , row:PluginRow){
    return row.key;
  }

  // One row per kind of result, in the order people expect them
  fetchRows(query:string , filter:string):Observable<SearchRow[]> {
    let q = query.trim();
    switch (filter) {
      case 'movie':
        return this.searchKind('movie' , q).pipe(map(r => [this.row('movies' , 'Movies' , r , 'movie')]));
      case 'tv':
        return this.searchKind('tv' , q).pipe(map(r => [this.row('shows' , 'TV shows' , r , 'tv')]));
      case 'person':
        return this.searchKind('person' , q).pipe(map(r => [this.row('people' , 'People' , r , 'person')]));
      case 'adult':
        // only what TMDB flags as adult (the other filters never include it)
        if (this.isKid) return of([]);
        return forkJoin([this.searchAdult('movie' , q) , this.searchAdult('tv' , q)]).pipe(map(([movies , tv]) => [
          this.row('adultMovies' , 'Adult movies' , movies , 'movie'),
          this.row('adultShows' , 'Adult TV shows' , tv , 'tv'),
        ]));
      case 'anime':
        // TMDB has no anime type: Japanese animation (genre 16)
        let isAnime = r => (r['genre_ids'] || []).includes(16) && r['original_language'] == 'ja';
        return forkJoin([this.searchKind('tv' , q) , this.searchKind('movie' , q)]).pipe(map(([tv , movies]) => [
          this.row('animeShows' , 'Anime series' , tv.filter(isAnime) , 'tv'),
          this.row('animeMovies' , 'Anime movies' , movies.filter(isAnime) , 'movie'),
        ]));
      default:
        return this.searchKind('multi' , q).pipe(map(results => [
          this.row('movies' , 'Movies' , results.filter(r => r['media_type'] == 'movie') , 'movie'),
          this.row('shows' , 'TV shows' , results.filter(r => r['media_type'] == 'tv') , 'tv'),
          this.row('people' , 'People' , results.filter(r => r['media_type'] == 'person') , 'person'),
        ]));
    }
  }

  private searchKind(kind:SearchKind , query:string , includeAdult = false):Observable<object[]> {
    return this.moviesService.search(kind , query , includeAdult).pipe(map(data => data['results'] || []));
  }

  // TMDB ranks every regular result before the adult ones, so with
  // include_adult the adult titles start around page (regular count / 20) + 1:
  // the first pages hold none of them for most queries. Read the page that
  // count points to and a few after it, plus the last pages (the rest of the
  // adult titles) and the first one (queries that mostly match adult titles).
  // TMDB serves 500 pages at most: past 10,000 regular matches they're out of reach.
  private searchAdult(kind:SearchKind , query:string):Observable<object[]> {
    let page = (n:number , adult:boolean) => this.moviesService.search(kind , query , adult , n).pipe(catchError(() => of({})));

    return forkJoin([page(1 , false) , page(1 , true)]).pipe(
      switchMap(([regular , withAdult]) => {
        let lastPage = Math.min(TMDB_MAX_PAGES , withAdult['total_pages'] || 1);
        let start = Math.floor((regular['total_results'] || 0) / 20) + 1;
        let pages = new Set<number>();
        for (let n = start - 1; n < start + ADULT_WINDOW; n++) pages.add(n);
        pages.add(lastPage - 1);
        pages.add(lastPage);
        let wanted = [...pages].filter(n => n > 1 && n <= lastPage).sort((a , b) => a - b);

        return forkJoin([of(withAdult) , ...wanted.map(n => page(n , true))]);
      }),
      map(responses => {
        let seen = new Set<number>();
        return [].concat(...responses.map(r => r['results'] || []))
          .filter(r => r['adult'] === true && !seen.has(r['id']) && seen.add(r['id']));
      }),
    );
  }

  private row(key:string , title:string , results:object[] , kind:SearchItem['kind']):SearchRow {
    return { key , title , items : results.map(r => this.toItem(r , kind)).filter(i => i.image) };
  }

  private toItem(r:object , kind:SearchItem['kind']):SearchItem {
    let date = r['release_date'] || r['first_air_date'] || '';
    return {
      key : `${kind}-${r['id']}`,
      kind,
      id : r['id'],
      title : r['title'] || r['name'],
      sub : kind == 'person' ? (r['known_for_department'] || '') : date.slice(0 , 4),
      image : kind == 'person' ? r['profile_path'] : r['poster_path'],
    };
  }

  // ── opening a result ────────────────────────────────────────────────────

  open(item:SearchItem){
    if (!item) return;

    if (item.kind == 'person') {
      this.showCredits(item);
    }
    // its page, over this one (the movie page loads the movie's details)
    else {
      this.navigator.open({ screen: item.kind == 'tv' ? 'core.show' : 'core.movie', params: { id: item.id } });
    }
  }

  // A person: their movies and shows, in a row right under theirs
  showCredits(person:SearchItem){
    this.moviesService.getPersonCredits(person.id).pipe(first()).subscribe(data=>{
      let seen = new Set<string>();
      let credits = [...(data['cast'] || []) , ...(data['crew'] || [])]
        .filter(c => c['media_type'] == 'movie' || c['media_type'] == 'tv')
        .sort((a , b) => (b['vote_count'] || 0) - (a['vote_count'] || 0))
        .map(c => ({ ...this.toItem(c , c['media_type']) , badge : c['media_type'] == 'tv' ? 'TV' : undefined }))
        .filter(item => item.image && !seen.has(item.key) && seen.add(item.key))
        .slice(0 , 40);

      let rows = this.state.rows.filter(r => r.key != 'credits');
      let at = rows.findIndex(r => r.items.some(i => i.key == person.key));
      rows.splice(at + 1 , 0 , {
        key : 'credits',
        title : credits.length ? `With ${person.title}` : `No titles found for ${person.title}`,
        items : credits,
      });
      this.update({ rows });

      setTimeout(()=>{
        let first = document.querySelector('.searchContainer .resultRow[data-row="credits"] .result') as HTMLElement;
        if (first) this.engine.focus(first);
      })
    })
  }

  itemFor(node:HTMLElement):SearchItem {
    for (let row of this.state.rows) {
      let item = row.items.find(i => i.key == node.dataset['key']);
      if (item) return item;
    }
    return undefined;
  }

  // ── on-screen keyboard ─────────────────────────────────────────────────

  typeKey(key:HTMLElement){
    let input = document.querySelector('.inputValue') as HTMLInputElement;

    switch (key.dataset["fct"]) {
      case "del":
        input.value = input.value.slice(0, -1);
        break;
      case "space":
        input.value += " ";
        break;
      case "num":
        this.switchKeyboard('num');
        return;
      case "char":
        this.switchKeyboard('char');
        return;
      default:
        input.value += key.textContent;
        break;
    }
    this.onInputChange(input);
  }

  switchKeyboard(to:'num' | 'char') {
    let numKeyboard = document.querySelector('.numKeyboard') as HTMLElement;
    let charKeyboard = document.querySelector('.charKeyboard') as HTMLElement;
    let switchNumKey = document.querySelector('.switchNumKey') as HTMLElement;
    let switchCharKey = document.querySelector('.switchCharKey') as HTMLElement;

    numKeyboard.style.display = to == 'num' ? "grid" : "none";
    charKeyboard.style.display = to == 'num' ? "none" : "grid";
    switchCharKey.style.display = to == 'num' ? "block" : "none";
    switchNumKey.style.display = to == 'num' ? "none" : "block";

    (to == 'num' ? switchCharKey : switchNumKey).focus({preventScroll : true});
  }

  // ── state ──────────────────────────────────────────────────────────────

  update(changes:Partial<SearchState>){
    this.state = { ...this.state , ...changes };
    this.moviesService.searchData.next(this.state);
  }

  trackRow(index:number , row:SearchRow){ return row.key; }
  trackItem(index:number , item:SearchItem){ return item.key; }
}
