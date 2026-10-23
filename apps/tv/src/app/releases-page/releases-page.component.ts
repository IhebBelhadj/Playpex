import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { catchError, map, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { PlaybackRequest, PlaybackService } from '../playback.service';
import { FocusEngine, PositionStore } from '../movement/movement';
import {
  Release, ReleaseProvider, ReleaseQuality, ReleasesKind, ReleasesOrigin, ReleasesService, ReleasesState,
} from '../releases.service';
import { Navigator, useScreen } from '../nav/public-api';

interface QualityChoice {
  id: ReleaseQuality;
  label: string;
}

interface Request {
  state: ReleasesState;
  page: number;
}

const LOAD_MORE_AHEAD = 8;        // ask for the next page this many rows before the end

// Per kind: what the search asks for
const SEARCH_HINT: Record<ReleasesKind, string> = {
  movie: 'Movie title, year, quality…',
  tv: 'Show title, SxxEyy, quality…',
};

// A release list (route data `kind`): /releases/movies and /releases/shows
// ("Find releases" on a movie / show page).
// Left: search (on-screen keyboard), source and filters. Right: that source's
// releases, most seeded first. Enter on a release plays it: as the title the
// list was opened for when there is one (ReleasesOrigin.context: subtitles,
// saved progress), else as the release, saved nowhere.
// Screens core.releases.movies / .shows
// (src/app/nav): the payload is the ReleasesOrigin of a "Find releases".
const SEARCH_FIELD = '.releasesPage [data-px-key="search"]';

@Component({
  selector: 'app-releases-page',
  templateUrl: './releases-page.component.html',
  styleUrls: ['./releases-page.component.scss']
})
export class ReleasesPageComponent implements OnInit, AfterViewInit, OnDestroy {

  readonly SEARCH_FIELD = SEARCH_FIELD;

  qualities:QualityChoice[] = [
    { id: '', label: 'Any' },
    { id: '2160p', label: '4K' },
    { id: '1080p', label: '1080p' },
    { id: '720p', label: '720p' },
    { id: 'SD', label: 'SD' },
  ];

  kind:ReleasesKind = 'movie';
  listId = '';                      // the list's pxGrid (its position is kept under this id)
  providers:ReleaseProvider[] = [];
  state:ReleasesState;
  // opened from a title's "Find releases": Back returns there
  origin:ReleasesOrigin | null = null;
  loading = false;
  loadError = '';
  keyboardOpen = false;
  maxSeeds = 1;

  readonly loadAhead = LOAD_MORE_AHEAD;

  private requests = new Subject<Request>();
  private requestSub:Subscription;
  private screen = useScreen<{}, ReleasesOrigin>();

  constructor(
    private releases:ReleasesService,
    private navigation:NavigationService,
    public navigator:Navigator,
    private playback:PlaybackService,
    private route:ActivatedRoute,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) { }

  get provider():ReleaseProvider | undefined {
    return this.providers.find(p => p.id == this.state.provider);
  }

  get searchHint():string {
    return SEARCH_HINT[this.kind];
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
        this.providers.length > 1 ? 'another source' : '',
      ].filter(Boolean);
      return hints.length
        ? `No releases match. Try ${hints.join(', or ')}.`
        : `${this.provider?.name || 'This source'} has nothing to list right now.`;
    }
    return '';
  }

  ngOnInit(): void {
    this.kind = this.route.snapshot.data['kind'] || 'movie';
    this.listId = `releases:${this.kind}`;
    this.state = this.releases.states[this.kind];
    // the title it was opened from (kept in the history entry: also there
    // when coming back from the player)
    this.origin = this.screen.payload || null;
    this.updateMaxSeeds();
    // a new list (another search, from a title's "Find releases"): no old position
    if (!this.state.loaded) this.positions.clear(this.listId);

    // Latest request wins; page 1 replaces the list, later pages extend it
    this.requestSub = this.requests.pipe(
      switchMap(({ state, page }) => this.releases.browse(this.kind, state, page).pipe(
        map(result => ({ state, page, result, error: null })),
        catchError(err => of({ state, page, result: null, error: err })),
      )),
    ).subscribe(({ state, page, result, error }) => {
      if (state != this.state) return;     // filters changed meanwhile
      this.loading = false;
      if (error) {
        this.loadError = `Couldn't reach ${this.provider?.name || 'the source'}. Try again, or pick another source.`;
        if (page == 1) setTimeout(() => this.focusSelector('.releasesPage [data-px-key="retry"]'), 0);
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

    this.releases.providers(this.kind).subscribe(providers => {
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

  // Sections `releasesFilters` (rail) and `releasesList` are pxSection
  // directives in the template; the list scrolls natively (pxGrid, src/app/movement)
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: '@releasesFilters' },
    });

    this.screen.onSelect(el => this.select(el));
    this.screen.onBack(() => this.back(document.activeElement as HTMLElement));

    // Back from the player: the same release in focus, the list where it was
    setTimeout(() => {
      if (!this.positions.get(this.listId)?.key || !this.engine.restore(`grid:${this.listId}`)) this.focusSelector(SEARCH_FIELD);
    }, 0);
  }

  ngOnDestroy(): void {
    this.requestSub?.unsubscribe();
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  // ── input ───────────────────────────────────────────────────────────────

  private select(active:HTMLElement) {
    let data = active.dataset;
    if (data['hash']) this.play(this.state.releases.find(r => r.hash == data['hash']));
  }

  // In-page steps: list → rail; then out: the title it was opened from (the nav system)
  private back(active:HTMLElement):boolean {
    if (!active || active.classList.contains('menuItem')) return false;
    if (active.closest('.releases')) {
      this.navigation.updateNavigation('focus', { sectionId: 'releasesFilters' });
      return true;
    }
    return false;
  }

  onSearchDone(query:string) {
    this.keyboardOpen = false;
    if (query != this.state.query) this.change({ query });
    this.focusSelector(SEARCH_FIELD);
  }

  onSearchCancelled() {
    this.keyboardOpen = false;
    this.focusSelector(SEARCH_FIELD);
  }

  // ── list ────────────────────────────────────────────────────────────────

  change(patch:Partial<ReleasesState>, focusAfter?:string) {
    let changed = Object.keys(patch).some(k => patch[k] != this.state[k]);
    if (!changed) return;
    this.setState({ ...patch, releases: [], page: 0, hasMore: false, loaded: false });
    this.positions.clear(this.listId);
    this.load();
    if (focusAfter) this.focusSelector(focusAfter);
  }

  load() {
    this.loadError = '';
    if (!this.providers.length) {
      // the sources failed to load: try them again first
      this.releases.providers(this.kind).subscribe(providers => {
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

  private play(release:Release | undefined) {
    if (!release) return;
    this.playback.play(this.playbackRequest(release));
  }

  // As the title the list was opened for (subtitles, saved progress): a
  // movie, or a show's episode (a season pack plays its first episode);
  // otherwise as the release itself, saved nowhere
  private playbackRequest(r:Release):PlaybackRequest {
    let details = [this.qualityLabel(r.quality), this.size(r.size), r.provider].filter(Boolean).join('  ·  ');
    let context = this.origin?.context;
    let plain:PlaybackRequest = {
      title: r.title,
      subtitle: [r.year, details].filter(Boolean).join('  ·  '),
      magnet: r.magnet,
    };
    if (!context) return plain;

    let title = { title: context.title, magnet: r.magnet, imdbId: context.imdbId, tmdbId: context.tmdbId, artwork: context.artwork };
    if (this.kind == 'movie') {
      return { ...title, year: context.year, subtitle: [context.year, details].filter(Boolean).join('  ·  '), mediaType: 'movie' };
    }
    let season = r.season || null;
    let episode = r.episode || (season ? 1 : null);
    if (!season || !episode) return plain;
    return { ...title, season, episode, subtitle: [this.episodeCode(season, episode), details].join('  ·  '), mediaType: 'tv' };
  }

  // ── view helpers ────────────────────────────────────────────────────────

  // TV: what a release holds ("S02E05", "Season 2", "Complete")
  episodeLabel(r:Release):string {
    if (this.kind != 'tv') return '';
    if (r.season && r.episode) return this.episodeCode(r.season, r.episode);
    if (r.season) return `Season ${r.season}`;
    return r.pack ? 'Complete' : '';
  }

  private episodeCode(season:number, episode:number):string {
    let pad = (n:number) => (n < 10 ? '0' : '') + n;
    return `S${pad(season)}E${pad(episode)}`;
  }

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

  trackRelease(index:number, release:Release) {
    return release.hash;
  }

  private setState(patch:Partial<ReleasesState>) {
    this.state = { ...this.state, ...patch };
    this.releases.states[this.kind] = this.state;
  }

  private updateMaxSeeds() {
    this.maxSeeds = Math.max(1, ...this.state.releases.map(r => r.seeds));
  }

  private focusSelector(selector:string) {
    setTimeout(() => (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
