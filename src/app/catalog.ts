import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Category } from './categories';

export type MediaType = 'movie' | 'tv';

// State of one browsable section (movies or TV shows): the category rows,
// paging and the slider position. Lives in MoviesService (root) so it
// survives leaving the section, e.g. to watch something and come back.
export class Catalog {

  // { [category name]: TMDB items[] } in category order
  items = new BehaviorSubject<{ [category: string]: any[] }>({});

  // Slider position per category: last focused index and which row was active
  navigationData: { [category: string]: { reached: string | number, selected: boolean } } = {};

  // Last TMDB page fetched per category
  reachedPages: { [category: string]: number } = {};

  private pageRequests = new Subject<{ category: string, page: number }>();
  private selections = new Subject<{ id: string, category: string, index: string }>();

  constructor(
    public media: MediaType,
    public categories: Category[],
    public listUrl: string,
    private detailBaseUrl: string,
  ) { }

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
