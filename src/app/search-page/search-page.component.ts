import { Router } from '@angular/router';
import { EMPTY_SEARCH, MoviesService, SearchItem, SearchKind, SearchRow, SearchState } from './../movies.service';
import { catchError, debounceTime, first, forkJoin, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { MenuServiceService } from './../menu-service.service';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { Location } from '@angular/common';
import { isPointerFocus, pagedIndex } from '../pointer.service';
import { ProfilesService } from '../profiles.service';

interface Filter {
  id: string;
  label: string;
}

const MIN_QUERY = 3;
const ADULT_WINDOW = 4;     // 18+ filter: TMDB pages read from where adult results start
const TMDB_MAX_PAGES = 500;

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

  imgBase = "https://image.tmdb.org/t/p/w185";
  state:SearchState = EMPTY_SEARCH;
  loading = false;

  navSub:Subscription;
  searchSub:Subscription;
  focusListener;
  private searches = new Subject<{query:string , filter:string}>();

  constructor(
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private moviesService:MoviesService,
    private router:Router,
    private location:Location,
    private profiles:ProfilesService,
  ) { }

  get isKid():boolean {
    return !!this.profiles.current.value?.isKid;
  }

  get visibleFilters():Filter[] {
    return this.isKid ? this.filters.filter(f => f.id != 'adult') : this.filters;
  }

  ngOnInit(): void {
    setTimeout(()=>{
      this.menuService.sendInstruction('hide' , this);
    } , 0)

    this.state = this.moviesService.searchData.value;
    // left over from another profile
    if (this.isKid && this.state.filter == 'adult') this.state = EMPTY_SEARCH;

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
      this.update({ rows : (rows || []).filter(r => r.items.length) , searched : true });
      setTimeout(() => this.markDefaults());
    });

    this.navSub = this.navigation.executeCommand().subscribe(instruction=>{
      if(!(this.router.url == "/search")) return;
      let active = document.activeElement as HTMLElement;

      if (instruction == "click" && active.classList.contains('keyboardBtn')) {
        this.typeKey(active);
      }
      else if (instruction == "click" && active.classList.contains('filterChip')) {
        this.setFilter(active.dataset['filter']);
      }
      else if (instruction == "click" && active.classList.contains('result')) {
        this.open(this.itemFor(active));
      }

      if (instruction == 'back') {
        this.moviesService.searchData.next(EMPTY_SEARCH);
        this.location.back();
      }
    })

    this.focusListener = (e)=>{
      if(!(this.router.url == "/search")) return;
      this.onFocus(e.target as HTMLElement);
    }
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add' , {
      id: 'keyboard',
      selector: '.keyboardContainer .keyboardBtn',
      leaveFor : { down : "@searchFilters" },
      straightOnly: true,
    })
    this.navigation.updateNavigation('add' , {
      id: 'searchFilters',
      selector: '.searchContainer .filters .filterChip',
      leaveFor : {
        up : "@keyboard",
        down : ".searchContainer .resultRow:first-of-type .lastSelected",
      },
      straightOnly: true,
    })
    this.navigation.updateNavigation('add' , {
      id: 'searches',
      selector: '.searchContainer .results .result',
      leaveFor : { up : "@searchFilters" },
      straightOnly: true,
    })

    // Coming back from a title page: same results, same item focused
    setTimeout(()=>{
      this.markDefaults();
      let remembered = this.state.focusKey && document.querySelector(`.searchContainer .result[data-key="${this.state.focusKey}"]`) as HTMLElement;
      if (remembered) {
        this.instantly(() => remembered.focus({preventScroll : true}));
        this.onFocus(remembered);
      }
      else {
        this.navigation.updateNavigation('focus' , {sectionId : 'keyboard'});
      }
    } , 50)
  }

  ngOnDestroy(): void {
    this.menuService.sendInstruction('show' , this);
    this.navSub?.unsubscribe();
    this.searchSub?.unsubscribe();
    window.removeEventListener('sn:focused',this.focusListener);
    this.navigation.updateNavigation('remove' , {sectionId : 'keyboard'});
    this.navigation.updateNavigation('remove' , {sectionId : 'searchFilters'});
    this.navigation.updateNavigation('remove' , {sectionId : 'searches'});
  }

  // ── searching ───────────────────────────────────────────────────────────

  get note():string {
    if (this.state.query.trim().length < MIN_QUERY) return '';
    if (this.loading && !this.state.rows.length) return 'Searching…';
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
    if (query.length < MIN_QUERY) {
      this.loading = false;
      this.update({ rows : [] , searched : false });
      return;
    }
    this.loading = true;
    this.searches.next({ query : this.state.query , filter : this.state.filter });
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
    this.update({ focusKey : item.key });

    if (item.kind == 'person') {
      this.showCredits(item);
    }
    else if (item.kind == 'tv') {
      this.router.navigateByUrl(`/shows/show/${item.id}`);
    }
    else {
      this.moviesService.getTmdbMovieDetails(item.id).pipe(first()).subscribe(data=>{
        this.moviesService.addMovieToHistory(data);
        this.router.navigateByUrl(`/movies/movie/${data['id']}`);
      })
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
        this.markDefaults();
        let first = document.querySelector('.searchContainer .resultRow[data-row="credits"] .result') as HTMLElement;
        if (!first) return;
        first.focus({preventScroll : true});
        this.onFocus(first);
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

  // ── focus and scrolling ────────────────────────────────────────────────

  onFocus(node:HTMLElement){
    if (!node.closest('.searchContainer')) return;

    if (!node.classList.contains('result')) {
      this.setPageOffset(0);
      return;
    }

    let row = node.closest('.resultRow') as HTMLElement;
    row.querySelectorAll('.result').forEach(el => el.classList.remove('lastSelected'));
    node.classList.add('lastSelected');

    // Hovered with the mouse: nothing moves under the cursor
    if (isPointerFocus()) return;
    this.scrollRowTo(node);
    this.ensureRowVisible(row);
  }

  // Up/down between rows land on the row's last focused item
  // (skipping an empty "No titles found" row)
  neighbour(rowIndex:number , direction:number):string {
    for (let i = rowIndex + direction; i >= 0 && i < this.state.rows.length; i += direction) {
      let next = this.state.rows[i];
      if (next.items.length) return `.searchContainer .resultRow[data-row="${next.key}"] .lastSelected`;
    }
    return direction < 0 ? '@searchFilters' : null;
  }

  markDefaults(){
    document.querySelectorAll('.searchContainer .resultRow').forEach(row => {
      if (!row.querySelector('.lastSelected')) row.querySelector('.result')?.classList.add('lastSelected');
      this.updatePaddles(row.querySelector('.rowContent'));
    });
  }

  // Horizontal: just enough for the focused item to be fully shown
  scrollRowTo(node:HTMLElement){
    let content = node.closest('.rowContent') as HTMLElement;
    let width = (content.parentElement as HTMLElement).clientWidth;
    let current = this.rowOffset(content);
    let margin = 60;

    let target = current;
    if (node.offsetLeft + node.offsetWidth > current + width - margin) target = node.offsetLeft + node.offsetWidth - width + margin;
    if (node.offsetLeft < current + margin) target = node.offsetLeft - margin;
    this.setRowOffset(content , target);
  }

  // Row paddles (mouse only): a screenful further, that item first
  pageRow(rowKey:string , direction:number){
    let content = document.querySelector(`.searchContainer .resultRow[data-row="${rowKey}"] .rowContent`) as HTMLElement;
    if (!content) return;
    let items = Array.from(content.querySelectorAll('.result')) as HTMLElement[];
    let target = pagedIndex(content , items , content.parentElement.clientWidth , direction);
    if (target < 0) return;

    this.setRowOffset(content , items[target].offsetLeft);
    items[target].focus({preventScroll : true});
  }

  rowOffset(content:HTMLElement):number {
    return -new DOMMatrix(getComputedStyle(content).transform).m41;
  }

  setRowOffset(content:HTMLElement , offset:number){
    let max = Math.max(0 , content.scrollWidth - content.parentElement.clientWidth);
    offset = Math.min(max , Math.max(0 , offset));
    content.style.transform = `translateX(-${offset}px)`;
    this.updatePaddles(content , offset);
  }

  updatePaddles(content:HTMLElement , offset = content ? this.rowOffset(content) : 0){
    if (!content) return;
    let row = content.closest('.resultRow');
    row.classList.toggle('atStart' , offset <= 1);
    row.classList.toggle('atEnd' , offset >= content.scrollWidth - content.parentElement.clientWidth - 1);
  }

  // Vertical: slide the page so the focused row is fully on screen
  ensureRowVisible(row:HTMLElement){
    let page = document.querySelector('.searchContainer') as HTMLElement;
    let current = -new DOMMatrix(getComputedStyle(page).transform).m42;
    let rect = row.getBoundingClientRect();
    let margin = 40;

    let target = current;
    if (rect.bottom > window.innerHeight - margin) target += rect.bottom - (window.innerHeight - margin);
    else if (rect.top < margin) target -= margin - rect.top;
    this.setPageOffset(target);
  }

  setPageOffset(offset:number){
    let page = document.querySelector('.searchContainer') as HTMLElement;
    if (page) page.style.transform = `translateY(-${Math.max(0 , offset)}px)`;
  }

  // Restoring a position: no slide-in animation
  instantly(fn:() => void){
    let page = document.querySelector('.searchContainer') as HTMLElement;
    page?.classList.add('noTransition');
    fn();
    setTimeout(() => page?.classList.remove('noTransition') , 50);
  }

  // ── state ──────────────────────────────────────────────────────────────

  update(changes:Partial<SearchState>){
    this.state = { ...this.state , ...changes };
    this.moviesService.searchData.next(this.state);
  }

  trackRow(index:number , row:SearchRow){ return row.key; }
  trackItem(index:number , item:SearchItem){ return item.key; }
}
