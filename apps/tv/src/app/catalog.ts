import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { CatalogFilters, NO_FILTERS } from './catalog-filters';
import type { Intent } from './nav/public-api';
import type { Badge, CardVariant, TitleInfoModel } from './ui/public-api';

export type MediaType = 'movie' | 'tv';

// The server's sections (docs/rows-plan.md): Home, Movies, TV shows
export type SectionId = 'home' | 'movies' | 'shows';

export const SECTION_OF: { [media: string]: SectionId } = { home: 'home', movie: 'movies', tv: 'shows' };

// A query of the server's catalog (`path` under /catalog/, e.g. 'discover/tv',
// its `params`; `page` set while paging): a search / filter row, or a row of a
// server without layouts
export interface CatalogQuery {
  path: string;
  params: { [param: string]: string | number };
}

// A row of a section. Its rows come from the server (GET /sections/{section}/rows,
// sections.service.ts): `key` is the server's row id, `kind` what its items are.
// A search / filters view (and a server without layouts) has `query` rows
// instead, paged through the catalog.
export interface CatalogRow {
  key: string;
  title: string;
  kind: 'titles' | 'progress' | 'library' | 'cards' | 'query';
  // the server's variant: poster | landscape | top10, or a plugin card variant
  variant: string;
  // `cards`: the plugin whose cards these are
  plugin?: string;
  // `query` rows
  query?: CatalogQuery;
  // the layout entry it comes from (the row editor's), `<entry>[~<part>]`
  entry?: string;
  personal?: boolean;
}

// Where a Continue watching card is: the episode (or film) to go back to.
// `next`: the episode `season` / `episode` is finished, the one after is up
export interface ContinueAt {
  kind: 'resume' | 'next';
  season: number;
  episode: number;
  positionS: number;
  durationS: number;
  ratio: number;
  // the episode's name, once the enrichment read its season (resume: this
  // episode's; next: the following one's, with `nextSeason` / `nextEpisode`)
  episodeName?: string;
  nextSeason?: number;
  nextEpisode?: number;
}

/** "20 min left", "1 h 12 min left" */
export function timeLeft(positionS: number, durationS: number): string {
  let left = Math.max(1, Math.round((durationS - positionS) / 60));
  return left < 60 ? `${left} min left` : `${Math.floor(left / 60)} h${left % 60 ? ` ${left % 60} min` : ''} left`;
}

/** S2 E5 */
export function episodeCode(season: number, episode: number): string {
  return `S${season} E${episode}`;
}

// One card of a row, as the slider draws it
export interface RowItem {
  key: string;
  title: string;
  image: string | null;
  variant: CardVariant;
  number?: number | null;
  subtitle?: string;
  badges?: Badge[] | null;
  progress?: number | null;
  // a line on the artwork's foot (Continue watching: "S2 E5 · 20 min left")
  overlay?: string;
  // a catalog title: described while focused (<movie-description>), its page opened on Enter
  item?: any;
  // a plugin's card that isn't a catalog title: what it says of itself while focused
  info?: TitleInfoModel;
  // else what Enter opens, or does (a plugin card's call)
  intent?: Intent;
  run?: () => void;
}

// State of one section (Home, Movies or TV shows): its rows and their items,
// paging. Lives in MoviesService (root) so it survives leaving the section,
// e.g. to watch something and come back; SectionRows (sections.service.ts)
// fills it. The slider position is the movement system's (PositionStore,
// `catalog:<media>`).
export class Catalog {

  rows: CatalogRow[] = [];

  // { [row key]: items } (rows draw in `rows` order)
  items = new BehaviorSubject<{ [row: string]: RowItem[] }>({});

  // Last page fetched per row, and rows with nothing more
  reachedPages: { [row: string]: number } = {};
  last: { [row: string]: boolean } = {};

  // the profile the rows are for, and whether they should be asked again
  // (a layout edited, a plugin changed, something watched) the next time the
  // section shows; `loading`: the first answer hasn't come
  profileId: string | null = null;
  stale = false;
  loading = false;
  // the section's screen is up (rows asked again at once when they change)
  visible = false;
  // the rows are the server's layout (else an older server's fallback rows:
  // plugins' rows then come through the section's slot)
  serverRows = true;

  // The section's search and filters (the toolbar above the rows): while set,
  // their rows stand in for the section's (`rows`, `items`, `reachedPages`
  // and `last` are the view's; the section's wait in `browsing`). A query
  // gives one row of results (narrowed by the filters), filters alone give
  // popular / top rated / newest rows. `pending`: rows whose first page
  // hasn't arrived yet.
  search: { query: string, filters: CatalogFilters, rows: string[], pending: number } | null = null;
  // the search's on-screen keyboard, the filter panel or the rows editor is open
  // (layers of the nav system: the rows get no select / back meanwhile)
  typing = false;
  filtering = false;
  editing: { row: string | null } | null = null;
  private browsing: { rows: CatalogRow[], items: { [row: string]: RowItem[] }, reachedPages: { [row: string]: number }, last: { [row: string]: boolean } } | null = null;

  private pageRequests = new Subject<{ row: string }>();
  private selections = new Subject<{ id: string, row: string, index: string }>();

  constructor(
    // route data `media`: 'home' | 'movie' | 'tv'
    public media: 'home' | MediaType,
    public listScreen: string,       // src/app/nav/screens.ts
    // a title's screen (Home: by the title's own media type)
    public detailScreen: string | null,
  ) { }

  get section(): SectionId {
    return SECTION_OF[this.media];
  }

  // movie | tv, null for Home (both)
  get mediaType(): MediaType | null {
    return this.media == 'home' ? null : this.media;
  }

  get query(): string {
    return this.search?.query || '';
  }

  get filters(): CatalogFilters {
    return this.search?.filters || NO_FILTERS;
  }

  // A search / filtered view of this section: its `query` rows (search or
  // discover, paged like the rows); SectionRows fetches page 1
  startSearch(query: string, filters: CatalogFilters, rows: CatalogRow[]) {
    if (!this.browsing) {
      this.browsing = { rows: this.rows, items: this.items.value, reachedPages: this.reachedPages, last: this.last };
    }
    this.search = { query, filters, rows: rows.map(r => r.key), pending: rows.length };
    this.rows = rows;
    this.reachedPages = {};
    this.last = {};
    let items = {};
    rows.forEach(r => items[r.key] = []);
    this.items.next(items);
  }

  // Back to the section's rows, as they were
  endSearch() {
    if (!this.browsing) return;
    this.rows = this.browsing.rows;
    this.reachedPages = this.browsing.reachedPages;
    this.last = this.browsing.last;
    this.items.next(this.browsing.items);
    this.browsing = null;
    this.search = null;
  }

  // Forget everything (another profile)
  clear() {
    this.endSearch();
    this.rows = [];
    this.reachedPages = {};
    this.last = {};
    this.items.next({});
    this.profileId = null;
    this.stale = false;
  }

  findRow(key: string): CatalogRow | undefined {
    return this.rows.find(r => r.key === key);
  }

  // Slider asks for the next page of a row
  requestPage(row: string) {
    this.pageRequests.next({ row });
  }

  onPageRequest(): Observable<{ row: string }> {
    return this.pageRequests.asObservable();
  }

  // Slider reports the focused card
  select(id: string, row: string, index: string) {
    this.selections.next({ id, row, index });
  }

  onSelect(): Observable<{ id: string, row: string, index: string }> {
    return this.selections.asObservable();
  }
}
