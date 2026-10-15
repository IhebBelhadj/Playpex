import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Category } from './categories';

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

  // The section's search (the search bar above the rows): while set, one row
  // of results stands in for the category rows (`categories`, `items` and
  // `reachedPages` are the search's; the section's wait in `browsing`)
  search: { query: string, row: string, loaded: boolean } | null = null;
  // the search's on-screen keyboard is open: the rows ignore click / back
  typing = false;
  private browsing: { categories: Category[], items: { [category: string]: any[] }, reachedPages: { [category: string]: number } } | null = null;

  private pageRequests = new Subject<{ category: string, page: number }>();
  private selections = new Subject<{ id: string, category: string, index: string }>();

  constructor(
    public media: MediaType,
    public categories: Category[],
    public listUrl: string,
    private detailBaseUrl: string,
  ) { }

  // A search of this section: `category` fetches its results (TMDB search
  // endpoint, paged like the rows); the page fetches page 1
  startSearch(query: string, category: Category) {
    if (!this.browsing) {
      this.browsing = { categories: this.categories, items: this.items.value, reachedPages: this.reachedPages };
    }
    this.search = { query, row: category.name, loaded: false };
    this.categories = [category];
    this.reachedPages = { [category.name]: 1 };
    this.items.next({ [category.name]: [] });
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

  detailUrl(id): string {
    return `${this.detailBaseUrl}/${id}`;
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
