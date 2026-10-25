import { SplashService } from './../splash.service';
import { NavigationService } from './../navigation.service';
import { CatalogPage, CatalogTitle, MoviesService, TitleItem } from './../movies.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { switchMap, Subscription, map, Observable } from 'rxjs';
import { Catalog } from '../catalog';
import { Category } from '../categories';
import { FocusEngine, PositionStore } from '../movement/movement';
import { CatalogFilters, Genre, filterCategories, filtersLabel, hasFilters, matchesFilters, sameFilters } from '../catalog-filters';
import { ImdbService } from '../imdb.service';
import { useFrame } from '../nav/public-api';

// Home page of a section (movies or TV shows, from route data `media`):
// loads the category rows into the section's Catalog and enriches the
// focused item for <movie-description>. On the list page, a toolbar above
// searches (the catalog's search: one row of results) and filters (genre, period,
// score, language: popular / top rated / newest discover rows, or a
// narrowed search) the section; their rows stand in for the section's
// (Catalog.startSearch / endSearch) until Clear. A frame of the nav system
// (src/app/nav): it hosts the section's list and title screens.
@Component({
  selector: 'movies-page',
  templateUrl: './movies-page.component.html',
  styleUrls: ['./movies-page.component.scss']
})
export class MoviesPageComponent implements OnInit , OnDestroy {

  catalog:Catalog;
  selectedMovie:TitleItem;
  selectedMovieSub:Subscription;
  pageRequestSub:Subscription;
  routeSub:Subscription;
  onList = false;
  onEpisode = false;
  toolbarExits = {};
  genres:Genre[] = [];
  private inFlight = new Set<string>();     // rows with a page on the way
  private lastPage:{ [category:string]:number } = {};
  private frame = useFrame();

  constructor(
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private splashService:SplashService,
    private route:ActivatedRoute,
    private engine:FocusEngine,
    private imdb:ImdbService,
    private positions:PositionStore,
  ) { }

  get filtered():boolean {
    return hasFilters(this.catalog.filters);
  }

  // the search / filters have no rows to show (loading, or nothing found)
  get viewEmpty():boolean {
    let search = this.catalog.search;
    let items = this.catalog.items.value;
    return !!search && search.rows.every(row => !(items[row] || []).length);
  }

  get filterLabel():string {
    return filtersLabel(this.catalog.filters, this.genres);
  }

  get searchHint():string {
    return this.catalog.media == 'tv' ? 'Search TV shows' : 'Search movies';
  }

  ngOnInit(): void {
    this.catalog = this.moviesService.catalogs[this.route.snapshot.data['media'] || 'movie'];

    // the search bar: list page only; down → the rows (remembered poster)
    this.toolbarExits = {
      left: '@menu',
      down: this.engine.target([`stack:catalog:${this.catalog.media}`, '@slider']),
    };
    // which of its screens is shown
    this.routeSub = this.frame.entry$.subscribe(entry => {
      if (!entry) return;
      this.onList = entry.screen.id == this.catalog.listScreen;
      this.onEpisode = entry.screen.id == 'core.episode';
    });

    this.moviesService.getGenres(this.catalog.media).subscribe(genres => this.genres = genres);

    // Coming from the other section: don't describe its last item here
    let selected = this.moviesService.selectedmovie.value;
    if (selected.mediaType && selected.mediaType !== this.catalog.media) {
      this.moviesService.assignSelection({});
    }

    if (Object.keys(this.catalog.items.value).length === 0) {

      // Rows keep category order whatever order the requests finish in
      let items = {};
      this.catalog.categories.forEach(c => items[c.name] = []);
      this.catalog.items.next(items);

      this.catalog.categories.forEach(c => {
        this.getMovies(c.name , c.query);
        this.catalog.reachedPages[c.name] = 1;
      })

      this.splashService.splashExecuteCommand().subscribe(instruction=>{
        if (instruction == "clearSplash") {
          setTimeout(()=>{
            this.navigation.sendMovieSliderEvent('focusFirst');
          },300)
        }
      })
    }

    this.subscribeToSelections();

    // Slider reached the end of a row: append the next page. A search /
    // filter row isn't 20 posters per page (results are dropped), so it just
    // reads its next page when none is on the way
    this.pageRequestSub = this.catalog.onPageRequest().subscribe(request => {
      let category = this.catalog.findCategory(request.category);
      if (!category) return;
      let query = category.query;
      let reached = this.catalog.reachedPages[request.category];
      let next = this.catalog.search ? reached + 1 : request.page;

      if (next > reached && next <= (this.lastPage[request.category] || 500) && !this.inFlight.has(request.category)) {
        query.params['page'] = next;
        this.catalog.reachedPages[request.category] = next;
        this.getMovies(request.category , query);
      }
    })
  }

  ngOnDestroy(): void {
    this.selectedMovieSub.unsubscribe();
    this.pageRequestSub.unsubscribe();
    this.routeSub?.unsubscribe();
    this.catalog.typing = false;
    this.catalog.filtering = false;
  }

  // ── search and filters ──────────────────────────────────────────────────────────────

  onSearchDone(query:string) {
    this.catalog.typing = false;
    query = query.trim();
    if (query != this.catalog.query) this.show(query, this.catalog.filters);
    this.focusToolbar('[data-px-key="search"]');
  }

  onSearchCancelled() {
    this.catalog.typing = false;
    this.focusToolbar('[data-px-key="search"]');
  }

  onFiltersApplied(filters:CatalogFilters) {
    this.catalog.filtering = false;
    if (!sameFilters(filters, this.catalog.filters)) this.show(this.catalog.query, filters);
    this.focusToolbar('[data-px-key="filters"]');
  }

  closeFilters() {
    this.catalog.filtering = false;
    this.focusToolbar('[data-px-key="filters"]');
  }

  // The rows for a search and / or filters: a query → one row of search
  // results (kept by the filters); filters alone → popular / top rated /
  // newest discover rows; neither → the section's own rows
  private show(query:string, filters:CatalogFilters) {
    if (!query && !hasFilters(filters)) {
      this.catalog.endSearch();
      return;
    }
    let kind = this.catalog.media == 'tv' ? 'tv' : 'movie';
    let categories = query
      ? [new Category(`Results for “${query}”`, { path: `search/${kind}`, params: { q: query, page: 1 } })]
      : filterCategories(this.catalog.media, filters, this.genres);
    // rows of an earlier view with the same name start over
    categories.forEach(c => this.positions.clear(`catalog:${this.catalog.media}/${c.name}`));
    this.catalog.startSearch(query, filters, categories);
    categories.forEach(c => this.getMovies(c.name, c.query));
  }

  clearSearch() {
    this.catalog.endSearch();
    this.focusToolbar('[data-px-key="search"]');
  }

  private focusToolbar(selector:string) {
    setTimeout(() => (document.querySelector(`.sectionToolbar ${selector}`) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }

  subscribeToSelections(){
    this.selectedMovieSub = this.catalog.onSelect()
    .pipe(
      switchMap(data => {
        let item = this.catalog.items.value[data.category]?.[Number(data.index)];
        if (item) {
          this.selectedMovie = item;
          this.moviesService.assignSelection(this.selectedMovie);
        }
        return this.catalog.media == 'tv' ? this.enrichShow(data.id) : this.enrichMovie(data.id);
      }))
      .subscribe(() => {
        this.moviesService.assignSelection(this.selectedMovie);
      } , error => {
        console.log(error);
        this.subscribeToSelections();
      })
  }

  // The movie's page (genres, runtime, IMDb id), then the IMDb rating
  enrichMovie(id):Observable<any> {
    return this.enrich(this.moviesService.getTmdbMovieDetails(id));
  }

  // The show's page (genres, season count, IMDb id), then the IMDb rating
  // (episodes are loaded on the show page)
  enrichShow(id):Observable<any> {
    return this.enrich(this.moviesService.getTvDetails(id));
  }

  private enrich(details:Observable<TitleItem>):Observable<any> {
    let item = this.selectedMovie;
    return details.pipe(
      map(data => {
        Object.assign(item, data);
        this.moviesService.assignSelection(item);
        return item.imdbId;
      }),
      switchMap(imdbId => this.imdb.title(imdbId)),
      map(rating => {
        if (rating?.rating) item.rating = rating.rating;
      })
    )
  }

  getMovies(category:string , query){
    // the rows asked for: a page arriving after a search started (or ended)
    // still lands in its own rows
    let items = this.catalog.items.value;
    let search = this.catalog.search;
    let page = query['params']?.['page'] || 1;
    this.inFlight.add(category);
    this.moviesService.getMovies(query).subscribe((res:CatalogPage) => {
      this.inFlight.delete(category);
      this.lastPage[category] = res.totalPages || 500;
      // append the new page to the row (or start it); results without a
      // poster can't be shown in a row of posters; a search's results are
      // narrowed by the filters here (TMDB search can't filter)
      let results = (res.results || []) as CatalogTitle[];
      if (search) results = results.filter(r => r.posterPath && (!search.query || matchesFilters(r, search.filters)));
      let first = !(items[category] || []).length;
      items[category] = (items[category] || []).concat(results);
      if (items !== this.catalog.items.value) return;

      // a filtered search can keep nothing of a page: read on (a few pages)
      // rather than leave the row empty
      if (search && first && !results.length && page < (res.totalPages || 0) && page < 6) {
        this.catalog.reachedPages[category] = page + 1;
        this.getMovies(category, { ...query, params: { ...query['params'], page: page + 1 } });
        return;
      }
      if (search && first) search.pending = Math.max(0, search.pending - 1);
      this.catalog.items.next(items);
      // new results: the first one is described until a poster is focused
      if (search && first && results.length && search.rows[0] == category) this.catalog.select(String(results[0].tmdbId), category, '0');
    }, () => {
      this.inFlight.delete(category);
      if (search && !(items[category] || []).length) search.pending = Math.max(0, search.pending - 1);
    })
  }


}
