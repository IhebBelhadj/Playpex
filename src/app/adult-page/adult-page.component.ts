import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, map, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { PlaybackService } from '../playback.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import { AdultProvider, AdultQuality, AdultRelease, AdultService, AdultState } from '../adult.service';

interface QualityChoice {
  id: AdultQuality;
  label: string;
}

interface Request {
  state: AdultState;
  page: number;
}

const LOAD_MORE_AHEAD = 8;        // ask for the next page this many rows before the end
const LIST = 'adult-releases';    // the list's pxGrid (its position is kept under this id)

// /adult/releases — the 18+ section's compact layout (never for kids profiles, see AdultGuard).
// Left: search (on-screen keyboard), source and filters. Right: that source's
// releases, most seeded first. Enter on a release plays it; nothing about it
// is saved to the profile (PlaybackRequest.adult).
@Component({
  selector: 'app-adult-page',
  templateUrl: './adult-page.component.html',
  styleUrls: ['./adult-page.component.scss']
})
export class AdultPageComponent implements OnInit, AfterViewInit, OnDestroy {

  qualities:QualityChoice[] = [
    { id: '', label: 'Any' },
    { id: '2160p', label: '4K' },
    { id: '1080p', label: '1080p' },
    { id: '720p', label: '720p' },
    { id: 'SD', label: 'SD' },
  ];

  providers:AdultProvider[] = [];
  state:AdultState;
  loading = false;
  loadError = '';
  keyboardOpen = false;
  maxSeeds = 1;

  readonly loadAhead = LOAD_MORE_AHEAD;

  private requests = new Subject<Request>();
  private requestSub:Subscription;
  private navSub:Subscription;

  constructor(
    private adult:AdultService,
    private navigation:NavigationService,
    private playback:PlaybackService,
    private router:Router,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  get provider():AdultProvider | undefined {
    return this.providers.find(p => p.id == this.state.provider);
  }

  get heading():string {
    let source = this.provider?.name || 'your source';
    return this.state.query ? `“${this.state.query}” on ${source}` : `Most seeded on ${source}`;
  }

  get note():string {
    if (this.loadError) return this.loadError;
    if (this.loading && !this.state.releases.length) return `Asking ${this.provider?.name || 'the source'} for its most seeded releases…`;
    if (this.state.loaded && !this.state.releases.length) {
      let hints = [
        this.state.quality ? 'Any quality' : '',
        this.state.playableOnly ? 'showing every release' : '',
        this.state.query ? 'fewer words' : '',
      ].filter(Boolean);
      return hints.length
        ? `No releases match. Try ${hints.join(', or ')}.`
        : `${this.provider?.name || 'This source'} has nothing to list right now. Try another source.`;
    }
    return '';
  }

  ngOnInit(): void {
    this.state = this.adult.state;
    this.updateMaxSeeds();
    // a new list (another search, from a title's "Find releases"): no old position
    if (!this.state.loaded) this.positions.clear(LIST);

    // Latest request wins; page 1 replaces the list, later pages extend it
    this.requestSub = this.requests.pipe(
      switchMap(({ state, page }) => this.adult.browse(state.provider, state.query, state.quality, state.playableOnly, page).pipe(
        map(result => ({ state, page, result, error: null })),
        catchError(err => of({ state, page, result: null, error: err })),
      )),
    ).subscribe(({ state, page, result, error }) => {
      if (state != this.state) return;     // filters changed meanwhile
      this.loading = false;
      if (error) {
        this.loadError = `Couldn't reach ${this.provider?.name || 'the source'}. Try again, or pick another source.`;
        if (page == 1) setTimeout(() => this.focusSelector('.adultPage .retryBtn'), 0);
        return;
      }
      let known = new Set(page == 1 ? [] : state.releases.map(r => r.hash));
      let fresh = result.torrents.filter(t => !known.has(t.hash));
      this.setState({
        releases: page == 1 ? fresh : state.releases.concat(fresh),
        page: result.page,
        hasMore: result.hasMore,
        loaded: true,
      });
      this.updateMaxSeeds();
    });

    this.adult.providers().subscribe(providers => {
      this.providers = providers;
      if (!providers.length) {
        this.loadError = "Couldn't load the sources. Check that the Playpex server is running, then try again.";
        return;
      }
      if (!providers.some(p => p.id == this.state.provider)) {
        this.setState({ provider: (providers.find(p => p.default) || providers[0]).id, loaded: false });
      }
      if (!this.state.loaded) this.load();
    });
  }

  // Sections `adultFilters` (rail) and `adultReleases` are pxSection directives
  // in the template; the list scrolls natively (pxGrid, src/app/movement)
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: '@adultFilters' },
    });

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (this.router.url != '/adult/releases' || this.keyboardOpen) return;
      let active = document.activeElement as HTMLElement;
      if (instruction == 'back') this.back(active);
      else if (instruction == 'click') this.select(active);
    });

    // Back from the player: the same release in focus, the list where it was
    setTimeout(() => {
      if (!this.positions.get(LIST)?.key || !this.engine.restore(`grid:${LIST}`)) this.focusSelector('.adultPage .searchField');
    }, 0);
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
    this.requestSub?.unsubscribe();
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  // ── input ───────────────────────────────────────────────────────────────

  private select(active:HTMLElement) {
    let data = active.dataset;
    if (active.classList.contains('menuItem')) return;      // the menu navigates itself
    if (active.classList.contains('searchField')) this.keyboardOpen = true;
    else if (active.classList.contains('clearSearch')) this.change({ query: '' }, '.adultPage .searchField');
    else if (data['provider']) this.change({ provider: data['provider'] });
    else if (data['quality'] !== undefined) this.change({ quality: data['quality'] as AdultQuality });
    else if (active.classList.contains('playableToggle')) this.change({ playableOnly: !this.state.playableOnly });
    else if (active.classList.contains('retryBtn')) this.load();
    else if (active.classList.contains('layoutSwitch')) this.switchLayout();
    else if (data['hash']) this.play(this.state.releases.find(r => r.hash == data['hash']));
  }

  private back(active:HTMLElement) {
    if (active.classList.contains('menuItem')) {
      this.router.navigateByUrl('/movies/list');
    } else if (active.closest('.releases')) {
      this.navigation.updateNavigation('focus', { sectionId: 'adultFilters' });
    } else {
      this.focusSelector('[data-destination="adultPage"]');
    }
  }

  // Poster layout (saved to the profile; Settings will offer it too)
  private switchLayout() {
    let go = () => this.router.navigateByUrl(this.adult.layoutUrl('posters'));
    this.adult.setPreferences({ layout: 'posters' }).subscribe({ next: go, error: go });
  }

  onSearchDone(query:string) {
    this.keyboardOpen = false;
    if (query != this.state.query) this.change({ query });
    this.focusSelector('.adultPage .searchField');
  }

  onSearchCancelled() {
    this.keyboardOpen = false;
    this.focusSelector('.adultPage .searchField');
  }

  // ── list ────────────────────────────────────────────────────────────────

  private change(patch:Partial<AdultState>, focusAfter?:string) {
    let changed = Object.keys(patch).some(k => patch[k] != this.state[k]);
    if (!changed) return;
    this.setState({ ...patch, releases: [], page: 0, hasMore: false, loaded: false });
    this.positions.clear(LIST);
    this.load();
    if (focusAfter) this.focusSelector(focusAfter);
  }

  load() {
    this.loadError = '';
    if (!this.providers.length) {
      // the sources failed to load: try them again first
      this.adult.providers().subscribe(providers => {
        this.providers = providers;
        if (providers.length) {
          this.setState({ provider: (providers.find(p => p.default) || providers[0]).id });
          this.load();
        } else {
          this.loadError = "Couldn't load the sources. Check that the Playpex server is running, then try again.";
        }
      });
      return;
    }
    this.loading = true;
    this.requests.next({ state: this.state, page: 1 });
  }

  // The list's pxGrid asks (focus or scroll near its end)
  loadMore() {
    if (this.loading || !this.state.hasMore || this.loadError) return;
    this.loading = true;
    this.requests.next({ state: this.state, page: this.state.page + 1 });
  }

  private play(release:AdultRelease | undefined) {
    if (!release) return;
    this.playback.play({
      title: release.title,
      subtitle: [release.studio, release.year, release.quality, this.size(release.size)].filter(Boolean).join('  ·  '),
      magnet: release.magnet,
      adult: true,
    });
    this.router.navigateByUrl('/player');
  }

  // ── view helpers ────────────────────────────────────────────────────────

  qualityLabel(quality:string):string {
    return quality == '2160p' ? '4K' : quality == '480p' ? 'SD' : quality;
  }

  // Seed meter against the best seeded release listed (square root: the
  // differences at the top stay visible, small counts don't vanish)
  seedShare(seeds:number):number {
    if (seeds <= 0) return 0;
    return Math.max(.04, Math.sqrt(seeds / this.maxSeeds));
  }

  size(bytes:number):string {
    if (!bytes) return '';
    let gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  age(seconds:number):string {
    if (!seconds) return '';
    let days = Math.floor((Date.now() / 1000 - seconds) / 86400);
    if (days < 1) return 'Added today';
    if (days < 2) return 'Added yesterday';
    if (days < 31) return `Added ${days} days ago`;
    if (days < 365) return `Added ${Math.floor(days / 30)} mo ago`;
    return `Added ${Math.floor(days / 365)} yr ago`;
  }

  trackRelease(index:number, release:AdultRelease) {
    return release.hash;
  }

  private setState(patch:Partial<AdultState>) {
    this.state = { ...this.state, ...patch };
    this.adult.state = this.state;
  }

  private updateMaxSeeds() {
    this.maxSeeds = Math.max(1, ...this.state.releases.map(r => r.seeds));
  }

  private focusSelector(selector:string) {
    setTimeout(() => (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
