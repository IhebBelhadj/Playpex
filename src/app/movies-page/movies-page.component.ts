import { SplashService } from './../splash.service';
import { NavigationService } from './../navigation.service';
import { MoviesService } from './../movies.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { switchMap, Subscription, map, Observable, filter } from 'rxjs';
import { Catalog } from '../catalog';
import { Category } from '../categories';
import { FocusEngine } from '../movement/movement';
import { ImdbService } from '../imdb.service';

// Home page of a section (movies or TV shows, from route data `media`):
// loads the category rows into the section's Catalog and enriches the
// focused item for <movie-description>. On the list page, a search bar above
// searches the section (TMDB): one row of results stands in for the rows
// (Catalog.startSearch / endSearch) until Clear.
@Component({
  selector: 'movies-page',
  templateUrl: './movies-page.component.html',
  styleUrls: ['./movies-page.component.scss']
})
export class MoviesPageComponent implements OnInit , OnDestroy {

  catalog:Catalog;
  selectedMovie;
  selectedMovieSub:Subscription;
  pageRequestSub:Subscription;
  routeSub:Subscription;
  navSub:Subscription;
  onList = false;
  onEpisode = false;
  toolbarExits = {};

  constructor(
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private splashService:SplashService,
    private route:ActivatedRoute,
    private router:Router,
    private engine:FocusEngine,
    private imdb:ImdbService,
  ) { }

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
    this.onList = this.router.url == this.catalog.listUrl;
    this.onEpisode = this.router.url.includes('/episode/');
    this.routeSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.onList = this.router.url == this.catalog.listUrl;
        this.onEpisode = this.router.url.includes('/episode/');
      });

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (instruction != 'click' || this.router.url != this.catalog.listUrl || this.catalog.typing) return;
      let active = document.activeElement as HTMLElement;
      if (active.classList.contains('searchField')) this.catalog.typing = true;
      else if (active.classList.contains('clearSearch')) this.clearSearch();
    });

    // Coming from the other section: don't describe its last item here
    let selected = this.moviesService.selectedmovie.value;
    if ((selected['media_type'] == 'tv') !== (this.catalog.media == 'tv')) {
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

    // Slider reached the end of a row: append the next TMDB page
    this.pageRequestSub = this.catalog.onPageRequest().subscribe(request => {
      let query = this.catalog.findCategory(request.category).query;
      query['params']['page'] = request.page;

      if (request.page > this.catalog.reachedPages[request.category]) {
        this.catalog.reachedPages[request.category] += 1;
        this.getMovies(request.category , query);
      }
    })
  }

  ngOnDestroy(): void {
    this.selectedMovieSub.unsubscribe();
    this.pageRequestSub.unsubscribe();
    this.routeSub?.unsubscribe();
    this.navSub?.unsubscribe();
    this.catalog.typing = false;
  }

  // ── search ──────────────────────────────────────────────────────────────

  onSearchDone(query:string) {
    this.catalog.typing = false;
    query = query.trim();
    if (!query) this.clearSearch();
    else if (query != this.catalog.search?.query) this.search(query);
    this.focusSearchField();
  }

  onSearchCancelled() {
    this.catalog.typing = false;
    this.focusSearchField();
  }

  // One row of TMDB search results (paged like the rows, by the slider)
  private search(query:string) {
    let kind = this.catalog.media == 'tv' ? 'tv' : 'movie';
    let category = new Category(`Results for “${query}”`, {
      url: `https://api.themoviedb.org/3/search/${kind}?api_key=<<api_key>>&language=en-US&include_adult=false`,
      params: { query, page: 1 },
    });
    this.catalog.startSearch(query, category);
    this.getMovies(category.name, category.query);
  }

  private clearSearch() {
    this.catalog.endSearch();
    this.focusSearchField();
  }

  private focusSearchField() {
    setTimeout(() => (document.querySelector('.sectionToolbar .searchField') as HTMLElement)?.focus({ preventScroll: true }), 0);
  }

  subscribeToSelections(){
    this.selectedMovieSub = this.catalog.onSelect()
    .pipe(
      switchMap(data => {
        let item = this.catalog.items.value[data.category]?.[Number(data.index)];
        if (item) {
          if (this.catalog.media == 'tv') item.media_type = 'tv';
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

  // TMDB genres + YTS torrents/rating/runtime/trailer
  enrichMovie(id):Observable<any> {
    return this.moviesService.getTmdbMovieDetails(id).pipe(
      map(data => {
        this.selectedMovie.genres = data['genres'];
        this.moviesService.assignSelection(this.selectedMovie);
        return data;
      }),
      switchMap(tmdbData => this.moviesService.getYTSMovieDetails(tmdbData['imdb_id']).pipe(
        map(ytsData => {
          this.selectedMovie['torrents'] = ytsData['data']['movie']['torrents']
          this.selectedMovie['mpa_rating'] = ytsData['data']['movie']['mpa_rating']
          this.selectedMovie['rating'] = ytsData['data']['movie']['rating']
          this.selectedMovie['runtime'] = ytsData['data']['movie']['runtime']
          this.selectedMovie['trailer'] = ytsData['data']['movie']['yt_trailer_code']
          this.selectedMovie.imdb_id = tmdbData['imdb_id'];
        })
      ))
    )
  }

  // TMDB genres, season count and score, then the IMDb rating (episodes are
  // loaded on the show page)
  enrichShow(id):Observable<any> {
    let show = this.selectedMovie;
    return this.moviesService.getTvDetails(id).pipe(
      map(data => {
        show.genres = data['genres'];
        show.number_of_seasons = data['number_of_seasons'];
        show.imdb_id = data['external_ids']?.['imdb_id'];
        this.moviesService.assignSelection(show);
        return show.imdb_id;
      }),
      switchMap(imdbId => this.imdb.title(imdbId)),
      map(rating => {
        if (rating?.rating) show.rating = rating.rating;
      })
    )
  }

  getMovies(category:string , query){
    // the rows asked for: a page arriving after a search started (or ended)
    // still lands in its own rows
    let items = this.catalog.items.value;
    let search = this.catalog.search;
    this.moviesService.getMovies(query).subscribe(res => {
      // append the new page to the row (or start it); search results without
      // a poster can't be shown in a row of posters
      let results = search ? (res['results'] || []).filter(r => r['poster_path']) : res['results'];
      let first = !(items[category] || []).length;
      items[category] = (items[category] || []).concat(results);
      if (search) search.loaded = true;
      if (items !== this.catalog.items.value) return;
      this.catalog.items.next(items);
      // new results: the first one is described until a poster is focused
      if (search && first && results.length) this.catalog.select(results[0]['id'], category, '0');
    })
  }

}
