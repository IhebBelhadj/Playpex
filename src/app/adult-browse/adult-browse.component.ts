import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, debounceTime, forkJoin, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { BackgroundService } from '../background.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import {
  AdultPage, AdultService, AdultSort, AdultStudio, AdultTitle, AdultTitleDetails, BrowseState, MetaProvider, PosterRow,
} from '../adult.service';

type Panel = null | 'keyboard' | 'filters';

const SORTS:AdultSort[] = ['popular', 'newest', 'rated'];
const LOAD_MORE_AHEAD = 6;          // next page this many posters before a row's end
const STACK = 'adult-browse';       // the rows' pxStack (positions are kept under this id)
const PERFORMERS_SHOWN = 4;

// /adult/browse — the 18+ section's poster layout, laid out like the movies
// page: the focused title described on top, category rows below. Titles come
// from the profile's metadata provider (AdultService.metaProvider(): TMDB by
// default, ThePornDB with a key). Toolbar: search (on-screen keyboard),
// filters (studio, release period) and the switch to the compact list.
@Component({
  selector: 'app-adult-browse',
  templateUrl: './adult-browse.component.html',
  styleUrls: ['./adult-browse.component.scss']
})
export class AdultBrowseComponent implements OnInit, AfterViewInit, OnDestroy {

  provider:MetaProvider | null = null;
  state:BrowseState;
  loading = false;
  loadError = '';
  panel:Panel = null;

  spot:AdultTitle | null = null;
  details:AdultTitleDetails | null = null;

  // filter panel
  studios:AdultStudio[] = [];
  draftStudio:AdultStudio | null = null;
  draftPeriod = '';

  readonly loadAhead = LOAD_MORE_AHEAD;

  private detailCache = new Map<string, AdultTitleDetails>();
  private detailRequests = new Subject<AdultTitle>();
  private rowLoading = new Set<string>();
  private loadSub:Subscription;
  private detailSub:Subscription;
  private navSub:Subscription;
  private focusListener;

  constructor(
    private adult:AdultService,
    private navigation:NavigationService,
    private background:BackgroundService,
    private router:Router,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  get filtered():boolean {
    return !!(this.state.query || this.state.studio || this.state.period);
  }

  get periods() {
    return this.provider?.periods || [];
  }

  get filterLabel():string {
    let period = this.periods.find(p => p.id && p.id == this.state.period);
    let studio = this.state.studio?.name || 'All studios';
    return period ? `${studio}, ${period.label.toLowerCase()}` : studio;
  }

  get note():string {
    if (this.loadError) return this.loadError;
    if (!this.state.loaded) return '';
    if (!this.state.rows.length) {
      return this.state.query
        ? `No 18+ titles match “${this.state.query}”. Check the spelling, try fewer words or another release period.`
        : `${this.provider?.name || 'This catalog'} has no titles for ${this.filterLabel}. Try another studio or Any time.`;
    }
    return '';
  }

  get performers():string {
    let names = (this.details?.performers || []).map(p => p.name);
    if (!names.length) return '';
    let shown = names.slice(0, PERFORMERS_SHOWN).join(', ');
    return names.length > PERFORMERS_SHOWN ? `With ${shown} and ${names.length - PERFORMERS_SHOWN} more` : `With ${shown}`;
  }

  ngOnInit(): void {
    this.state = this.adult.browseState;

    this.adult.metaProvider().subscribe(provider => {
      this.provider = provider;
      if (!provider) {
        this.loadError = "Couldn't load the 18+ catalog. Check that the Playpex server is running and has a TMDB key, then try again.";
        return;
      }
      // another provider than the one these rows came from (changed in Settings)
      if (this.state.provider != provider.id) {
        this.setState({ provider: provider.id, rows: [], loaded: false, studio: null });
      }
      if (!this.state.loaded) this.positions.clear(STACK);
      if (this.state.loaded) setTimeout(() => this.restoreFocus(), 0);
      else this.load();
    });

    // Details of the focused title (runtime, performers); only where focus rests
    this.detailSub = this.detailRequests.pipe(
      debounceTime(150),
      switchMap(item => this.adult.title(this.state.provider, item.id).pipe(
        map(details => ({ item, details })),
        catchError(() => of({ item, details: null })),
      )),
    ).subscribe(({ item, details }) => {
      if (details) this.detailCache.set(item.id, details);
      if (this.spot?.id == item.id) this.details = details;
    });
  }

  // Sections `adultToolbar`, `adultPosters` and `adultFilterPanel` are pxSection
  // directives in the template; rows scroll natively (src/app/movement)
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      // the remembered poster; without rows the empty state's Clear / Try
      // again button, else the toolbar
      leaveFor: { right: this.engine.target([`stack:${STACK}`, '@adultPosters', '@adultToolbar']) },
    });

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (this.router.url != '/adult/browse' || this.panel == 'keyboard') return;
      let active = document.activeElement as HTMLElement;
      if (instruction == 'leave') this.panel == 'filters' ? this.closeFilters() : this.navigation.openPowerMenu();
      else if (instruction == 'back') this.back(active);
      else if (instruction == 'click') this.select(active);
    });

    this.focusListener = (e) => {
      if (this.router.url == '/adult/browse') this.onFocus(e.target as HTMLElement);
    };
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.loadSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.navSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  // ── input ───────────────────────────────────────────────────────────────

  private select(active:HTMLElement) {
    if (active.classList.contains('menuItem')) return;
    let data = active.dataset;

    if (this.panel == 'filters') {
      if (data['studio'] !== undefined) this.draftStudio = this.studios.find(s => s.id == data['studio']) || null;
      else if (data['period'] !== undefined) this.draftPeriod = data['period'];
      else if (data['panel'] == 'apply') this.applyFilters();
      else if (data['panel'] == 'reset') { this.draftStudio = null; this.draftPeriod = ''; }
      return;
    }

    if (active.classList.contains('searchField')) this.panel = 'keyboard';
    else if (active.classList.contains('filterBtn')) this.openFilters();
    else if (active.classList.contains('clearAll')) this.change({ query: '', studio: null, period: '' }, '.adultBrowse .searchField');
    else if (active.classList.contains('layoutSwitch')) this.switchLayout();
    else if (active.classList.contains('retryBtn')) this.load();
    else if (active.classList.contains('card')) this.open(active);
  }

  private back(active:HTMLElement) {
    if (this.panel == 'filters') {
      this.closeFilters();
    } else if (active.classList.contains('menuItem')) {
      this.navigation.openPowerMenu();
    } else if (active.closest('.toolbar')) {
      this.focusSelector('[data-destination="adultPage"]');
    } else {
      this.focusSelector('.adultBrowse .searchField');
    }
  }

  onSearchDone(query:string) {
    this.panel = null;
    if (query != this.state.query) this.change({ query });
    this.focusSelector('.adultBrowse .searchField');
  }

  onSearchCancelled() {
    this.panel = null;
    this.focusSelector('.adultBrowse .searchField');
  }

  private openFilters() {
    this.draftStudio = this.state.studio;
    this.draftPeriod = this.state.period;
    this.panel = 'filters';
    let show = () => this.focusSelector('.filterPanel .studioChip.selected');
    if (this.studios.length) show();
    else this.adult.studios(this.state.provider).pipe(catchError(() => of([]))).subscribe(list => {
      this.studios = list;
      show();
    });
  }

  private closeFilters() {
    this.panel = null;
    this.focusSelector('.adultBrowse .filterBtn');
  }

  private applyFilters() {
    let studio = this.draftStudio, period = this.draftPeriod;
    this.closeFilters();
    this.change({ studio, period });
  }

  // Compact list of releases (saved to the profile; Settings will offer it too)
  private switchLayout() {
    let go = () => this.router.navigateByUrl(this.adult.layoutUrl('compact'));
    this.adult.setPreferences({ layout: 'compact' }).subscribe({ next: go, error: go });
  }

  // ── rows ────────────────────────────────────────────────────────────────

  private change(patch:Partial<BrowseState>, focusAfter?:string) {
    let changed = Object.keys(patch).some(k => (patch[k]?.id ?? patch[k]) != (this.state[k]?.id ?? this.state[k]));
    if (!changed) return;
    this.setState({ ...patch, rows: [], loaded: false });
    this.positions.clear(STACK);
    this.spot = null;
    this.details = null;
    this.load();
    if (focusAfter) this.focusSelector(focusAfter);
  }

  load() {
    if (!this.provider) {
      this.loadError = '';
      this.adult.metaProvider().subscribe(p => {
        this.provider = p;
        if (p) {
          this.setState({ provider: p.id });
          this.load();
        } else {
          this.loadError = "Couldn't load the 18+ catalog. Check that the Playpex server is running and has a TMDB key, then try again.";
        }
      });
      return;
    }
    this.loadError = '';
    this.loading = true;
    let state = this.state;

    this.loadSub?.unsubscribe();
    this.loadSub = this.rowSpecs().pipe(
      switchMap(specs => specs.length
        ? forkJoin(specs.map(spec => this.fetchRow(spec.key, 1).pipe(
            map(page => ({ ...spec, items: page.items, page: page.page, totalPages: page.totalPages } as PosterRow)),
            catchError(() => of(null)),
          )))
        : of([])),
    ).subscribe({
      next: rows => {
        if (state != this.state) return;
        this.loading = false;
        let failed = rows.filter(r => r === null).length;
        if (failed && failed == rows.length) {
          this.loadError = `Couldn't reach ${this.provider.name}. Check your connection, then try again.`;
          this.setState({ loaded: true });
          setTimeout(() => this.focusSelector('.adultBrowse .retryBtn'), 0);
          return;
        }
        this.setState({ rows: rows.filter(r => r && r.items.length), loaded: true });
        // a search / filter change leaves focus in the toolbar; otherwise
        // (first load, focus lost with the old rows) restore it
        setTimeout(() => {
          let active = document.activeElement as HTMLElement;
          let kept = active && document.contains(active) && (active.closest('.adultBrowse .toolbar') || active.classList.contains('menuItem'));
          if (!kept) this.restoreFocus();
          // focus stayed on the menu / toolbar: the first title fills the info
          if (!this.spot) this.showSpot(this.state.rows[0]?.items[0]);
        }, 0);
      },
      error: () => {
        this.loading = false;
        this.loadError = `Couldn't reach ${this.provider.name}. Check your connection, then try again.`;
        this.setState({ loaded: true });
      },
    });
  }

  // Search → one row of results; studio/period → popular, newest and top rated
  // within them (the orders the provider has); nothing → the provider's home rows
  private rowSpecs():Observable<{ key:string, title:string }[]> {
    let s = this.state;
    if (s.query) return of([{ key: 'search', title: `Results for “${s.query}”` }]);
    if (s.studio || s.period) {
      let sorts = SORTS.filter(sort => (this.provider?.sorts || SORTS).includes(sort));
      return of(sorts.map(sort => ({ key: sort, title: this.sortTitle(sort) })));
    }
    return this.adult.home(s.provider).pipe(map(home => home.rows));
  }

  private sortTitle(sort:AdultSort):string {
    let period = this.periods.find(p => p.id && p.id == this.state.period)?.label.toLowerCase();
    let studio = this.state.studio?.name;
    let base = sort == 'popular' ? 'Popular' : sort == 'newest' ? 'Newest' : 'Top rated';
    let where = studio ? (sort == 'newest' ? ` from ${studio}` : ` at ${studio}`) : '';
    let when = period ? (period.startsWith('before') || period.startsWith('this') ? ` ${period}` : ` in the ${period}`) : '';
    return base + where + when;
  }

  private fetchRow(key:string, page:number):Observable<AdultPage> {
    let s = this.state;
    if (s.query) return this.adult.searchTitles(s.provider, s.query, s.period, page);
    if (s.studio || s.period) return this.adult.discover(s.provider, { studio: s.studio?.id, period: s.period, sort: key as AdultSort, page });
    return this.adult.row(s.provider, key, page);
  }

  // A row's pxRow asks (focus or scroll near its end)
  loadMore(row:PosterRow) {
    if (this.rowLoading.has(row.key) || row.page >= row.totalPages) return;
    this.rowLoading.add(row.key);
    let state = this.state;
    this.fetchRow(row.key, row.page + 1).subscribe({
      next: page => {
        this.rowLoading.delete(row.key);
        if (state != this.state) return;
        let known = new Set(row.items.map(i => i.id));
        row.items = row.items.concat(page.items.filter(i => !known.has(i.id)));
        row.page = page.page;
        row.totalPages = page.items.length ? page.totalPages : row.page;   // an empty page ends the row
      },
      error: () => this.rowLoading.delete(row.key),
    });
  }

  // ── focus ───────────────────────────────────────────────────────────────

  // Back on the page: the remembered poster, rows where they were (pxStack);
  // no posters (no results, error): the empty state's button, else the search field
  private restoreFocus() {
    if (this.panel || this.engine.restore(`stack:${STACK}`)) return;
    let target = document.querySelector('.adultBrowse .titleInfo .focusable') as HTMLElement
      || document.querySelector('.adultBrowse .searchField') as HTMLElement;
    target?.focus({ preventScroll: true });
  }

  // The title info follows the focused poster (scrolling is the rows' job)
  private onFocus(node:HTMLElement) {
    if (!node.classList.contains('card')) return;
    let row = this.state.rows.find(r => r.key == node.dataset['row']);
    let item = row?.items[Number(node.dataset['index'])];
    if (!row || !item) return;
    this.showSpot(item);
  }

  private showSpot(item:AdultTitle | undefined) {
    if (!item) return;
    this.spot = item;
    this.details = this.detailCache.get(item.id) || null;
    if (!this.details) this.detailRequests.next(item);
    if (item.backdrop) this.background.sendImage(item.backdrop);
  }

  // ── opening a title ─────────────────────────────────────────────────────

  private open(node:HTMLElement) {
    let row = this.state.rows.find(r => r.key == node.dataset['row']);
    let item = row?.items[Number(node.dataset['index'])];
    if (!item) return;
    this.adult.openedTitle = this.detailCache.get(item.id) || item;
    this.router.navigateByUrl(`/adult/title/${this.state.provider}/${encodeURIComponent(item.id)}`);
  }

  // ── view helpers ────────────────────────────────────────────────────────

  runtime(minutes:number | null):string {
    if (!minutes) return '';
    let h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  trackRow(index:number, row:PosterRow) { return row.key; }
  trackItem(index:number, item:AdultTitle) { return item.id; }

  private setState(patch:Partial<BrowseState>) {
    this.state = { ...this.state, ...patch };
    this.adult.browseState = this.state;
  }

  private focusSelector(selector:string) {
    setTimeout(() => (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
