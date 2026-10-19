import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Category } from './categories';
import { CatalogFilters, NO_FILTERS } from './catalog-filters';

export type MediaType = 'movie' | 'tv';

// State of one browsable section (movies or TV shows): the category rows and
// paging. Lives in MoviesService (root) so it survives leaving the section,
// e.g. to watch something and come back. The slider position is the
// movement system's (PositionStore, `catalog:<media>`).
export class Catalog {

  // { [category name]: TMDB items[] } in category order
  items = new BehaviorSubject<{ [category: string]: any[] }>({});

  // Last TMDB page fetched per category
  reachedPages: { [category: string]: number } = {};

  // The section's search and filters (the toolbar above the rows): while set,
  // their rows stand in for the category rows (`categories`, `items` and
  // `reachedPages` are the view's; the section's wait in `browsing`). A query
  // gives one row of results (narrowed by the filters), filters alone give
  // popular / top rated / newest rows. `pending`: rows whose first page
  // hasn't arrived yet.
  search: { query: string, filters: CatalogFilters, rows: string[], pending: number } | null = null;
  // the search's on-screen keyboard or the filter panel is open (both are
  // layers of the nav system: the rows get no select / back meanwhile)
  typing = false;
  filtering = false;
  private browsing: { categories: Category[], items: { [category: string]: any[] }, reachedPages: { [category: string]: number } } | null = null;

  private pageRequests = new Subject<{ category: string, page: number }>();
  private selections = new Subject<{ id: string, category: string, index: string }>();

  constructor(
    public media: MediaType,
    public categories: Category[],
    public listScreen: string,       // src/app/nav/screens.ts
    public detailScreen: string,
  ) { }

  get query(): string {
    return this.search?.query || '';
  }

  get filters(): CatalogFilters {
    return this.search?.filters || NO_FILTERS;
  }

  // A search / filtered view of this section: `categories` fetch its rows
  // (TMDB search or discover, paged like the rows); the page fetches page 1
  startSearch(query: string, filters: CatalogFilters, categories: Category[]) {
    if (!this.browsing) {
      this.browsing = { categories: this.categories, items: this.items.value, reachedPages: this.reachedPages };
    }
    this.search = { query, filters, rows: categories.map(c => c.name), pending: categories.length };
    this.categories = categories;
    this.reachedPages = {};
    let items = {};
    categories.forEach(c => {
      this.reachedPages[c.name] = 1;
      items[c.name] = [];
    });
    this.items.next(items);
  }

  // Back to the section's rows, as they were
  endSearch() {
    if (!this.browsing) return;
    this.categories = this.browsing.categories;
    this.reachedPages = this.browsing.reachedPages;
    this.items.next(this.browsing.items);
    this.browsing = null;
    this.search = null;
  }

  findCategory(name: string): Category {
    return this.categories.find(c => c.name === name);
  }

  // Slider asks for the next TMDB page of a category
  requestPage(category: string, page: number) {
    this.pageRequests.next({ category, page });
  }

  onPageRequest(): Observable<{ category: string, page: number }> {
    return this.pageRequests.asObservable();
  }

  // Slider reports the focused poster
  select(id: string, category: string, index: string) {
    this.selections.next({ id, category, index });
  }

  onSelect(): Observable<{ id: string, category: string, index: string }> {
    return this.selections.asObservable();
  }
}
