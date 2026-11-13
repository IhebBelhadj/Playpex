import { SplashService } from './../splash.service';
import { NavigationService } from './../navigation.service';
import { MoviesService, TitleItem } from './../movies.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { switchMap, Subscription, map, merge, Observable, of, catchError } from 'rxjs';
import { Catalog, CatalogRow, ContinueAt } from '../catalog';
import { FocusEngine, PositionStore } from '../movement/movement';
import { CatalogFilters, Genre, filterRows, filtersLabel, hasFilters, sameFilters } from '../catalog-filters';
import { ImdbService } from '../imdb.service';
import { useFrame } from '../nav/public-api';
import { SectionRowsService } from '../sections.service';

// The frame of a section (Home, Movies or TV shows, from route data `media`):
// shows its rows (the server's, SectionRowsService) through the slider and
// enriches the focused title for <movie-description>. On the list page, a
// toolbar above searches (the catalog's search: one row of results) and
// filters (genre, period, score, language: popular / top rated / newest
// discover rows, or a narrowed search) the section; their rows stand in for
// the section's (Catalog.startSearch / endSearch) until Clear. "Rows" opens
// <rows-editor> (the profile's own layout of the section). Home has no
// search or filters. A frame of the nav system (src/app/nav): it hosts the
// section's list and title screens.
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
  splashSub:Subscription;
  onList = false;
  onEpisode = false;
  toolbarExits = {};
  genres:Genre[] = [];
  private frame = useFrame();

  constructor(
    private moviesService:MoviesService,
    private navigation:NavigationService,
    private splashService:SplashService,
    private route:ActivatedRoute,
    private engine:FocusEngine,
    private imdb:ImdbService,
    private positions:PositionStore,
    private sections:SectionRowsService,
  ) { }

  get home():boolean {
    return this.catalog.media == 'home';
  }

  get filtered():boolean {
    return hasFilters(this.catalog.filters);
  }

  get canEditRows():boolean {
    return this.sections.canEdit(this.catalog) && !this.catalog.search;
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

    // the toolbar: list page only; down → the rows (remembered card)
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

    let media = this.catalog.mediaType;
    if (media) this.moviesService.getGenres(media).subscribe(genres => this.genres = genres);

    // Coming from another section: don't describe its last title here
    if (this.moviesService.selectedIn !== this.catalog.media) {
      this.moviesService.assignSelection({});
      this.moviesService.selectedIn = this.catalog.media;
    }

    let first = !this.catalog.rows.length;
    this.sections.show(this.catalog);
    if (first) {
      this.splashSub = this.splashService.splashExecuteCommand().subscribe(instruction=>{
        if (instruction == "clearSplash") {
          setTimeout(()=>{
            this.navigation.sendMovieSliderEvent('focusFirst');
          },300)
        }
      })
    }

    this.subscribeToSelections();

    // Slider reached the end of a row: its next page
    this.pageRequestSub = this.catalog.onPageRequest().subscribe(request => this.sections.more(this.catalog, request.row));
  }

  ngOnDestroy(): void {
    this.selectedMovieSub.unsubscribe();
    this.pageRequestSub.unsubscribe();
    this.routeSub?.unsubscribe();
    this.splashSub?.unsubscribe();
    this.catalog.typing = false;
    this.catalog.filtering = false;
    this.catalog.editing = null;
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
    let media = this.catalog.mediaType;
    if (!media || !query && !hasFilters(filters)) {
      this.endSearch();
      return;
    }
    let rows:CatalogRow[] = query
      ? [{ key: `Results for “${query}”`, title: `Results for “${query}”`, kind: 'query', variant: 'poster', query: { path: `search/${media}`, params: { q: query } } }]
      : filterRows(media, filters, this.genres);
    // rows of an earlier view with the same name start over
    rows.forEach(r => this.positions.clear(`catalog:${this.catalog.media}/${r.key}`));
    this.catalog.startSearch(query, filters, rows);
    rows.forEach(r => this.sections.fetchPage(this.catalog, r, 1));
  }

  clearSearch() {
    this.endSearch();
    this.focusToolbar('[data-px-key="search"]');
  }

  // the section's rows again, asked for when they changed meanwhile
  private endSearch() {
    this.catalog.endSearch();
    if (this.catalog.stale) this.sections.load(this.catalog);
  }

  // ── rows editor ─────────────────────────────────────────────────────────────

  editRows() {
    this.catalog.editing = { row: null };
  }

  onRowsEdited(changed:boolean) {
    this.catalog.editing = null;
    if (changed) this.sections.load(this.catalog);
    this.focusToolbar('[data-px-key="rows"]');
  }

  private focusToolbar(selector:string) {
    setTimeout(() => (document.querySelector(`.sectionToolbar ${selector}`) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }

  // ── the focused title ───────────────────────────────────────────────────────

  subscribeToSelections(){
    this.selectedMovieSub = this.catalog.onSelect()
    .pipe(
      switchMap(data => {
        let card = this.catalog.items.value[data.row]?.[Number(data.index)];
        let item = card?.item;
        if (!item) {
          // a plugin's card: its own info (movie-description shows it as it is)
          this.selectedMovie = null;
          if (card?.info) this.moviesService.assignSelection({ title: card.info.title, info: card.info } as any);
          return of(null);
        }
        this.selectedMovie = item;
        this.moviesService.selectedIn = this.catalog.media;
        this.moviesService.assignSelection(this.selectedMovie);
        return item.mediaType == 'tv' ? this.enrichShow(item.tmdbId) : this.enrichMovie(item.tmdbId);
      }))
      .subscribe(() => {
        if (this.selectedMovie) this.moviesService.assignSelection(this.selectedMovie);
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
      switchMap(imdbId => merge(this.imdb.title(imdbId).pipe(map(rating => {
        if (rating?.rating) item.rating = rating.rating;
      })), this.episodeName(item))),
    )
  }

  // A show's Continue watching card: the name of the episode to go back to
  // (resume: that one; next: the one after it, maybe the next season's first)
  private episodeName(item:TitleItem):Observable<void> {
    let at = (item as TitleItem & { continue?:ContinueAt }).continue;
    if (!at || item.mediaType != 'tv' || at.episodeName) return of(undefined);
    let id = item.tmdbId;
    let wanted = at.kind == 'next' ? at.episode + 1 : at.episode;
    return this.moviesService.getTvSeason(id, at.season).pipe(
      switchMap(season => {
        let ep = (season.episodes || []).find(e => e.episodeNumber == wanted);
        if (ep || at.kind != 'next') return of({ ep, season: at.season });
        return this.moviesService.getTvSeason(id, at.season + 1).pipe(
          map(next => ({ ep: (next.episodes || []).find(e => e.episodeNumber == 1), season: at.season + 1 })),
          catchError(() => of({ ep: undefined, season: at.season })),
        );
      }),
      map(found => {
        if (!found.ep) return;
        at.episodeName = found.ep.name;
        if (at.kind == 'next') {
          at.nextSeason = found.season;
          at.nextEpisode = found.ep.episodeNumber;
        }
        if (this.selectedMovie === item) this.moviesService.assignSelection(item);
      }),
      catchError(() => of(undefined)),
    );
  }
}
