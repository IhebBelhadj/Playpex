import { CatalogPerson, CatalogTitle, EMPTY_SEARCH, MoviesService, SearchItem, SearchKind, SearchRow, SearchState } from './../movies.service';
import { catchError, debounceTime, first, forkJoin, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { FocusEngine, PositionStore } from '../movement/movement';
import { ProfilesService } from '../profiles.service';
import { Navigator, useScreen } from '../nav/public-api';
import { RemotePlugins } from '../plugins/remote';
import { CardModel, ContributionDef, CONTRIBUTIONS, dp, SearchFilterModel, tmdbImageBase } from '../ui/public-api';
import { Found, isLink, LinkInspection, LinkItem, ProviderResults, SearchSourcesService } from '../search-sources.service';
import { CODECS, NO_REFINE, QUALITIES, Refine, refine, refineCount, SIZES, SORTS, toggle, WHATS } from '../search-refine';

interface Filter {
  id: string;
  label: string;
}

// A plugin's chip (slot core.search.filters): its contribution, and what it
// answered for the query (its label, its rows)
interface PluginFilter {
  id: string;                 // 'plugin:<chip key>'
  chip: Filter;               // one object: the chips' *ngFor keeps its element
  def: ContributionDef<'core.search.filters'>;
  model: SearchFilterModel;
}

interface PluginRow {
  key: string;
  title: string;
  variant?: CardModel['variant'];
  items: CardModel[];
}

type Noun = 'videos' | 'torrents';

// What the page found beyond the catalog, kept across trips to the player
// and to a title (the catalog's rows are MoviesService.searchData's)
interface Kept {
  query: string;
  videos: ProviderResults[] | null;
  torrents: ProviderResults[] | null;
  link: { answer: LinkInspection | null, error: string | null } | null;
  refines: Record<Noun, Refine>;
}

const MIN_QUERY = 3;
const STACK = 'search';       // the page's pxStack: positions are kept under this id
const FIRST_CARDS = 30;       // All: the best videos / torrents in their rows
const PAGE = 60;              // the torrent list draws this many at a time
const FIRST_TORRENTS = 5;     // All: the best torrents, before "Show all"

const NOTHING_KEPT = (): Kept => ({ query: '', videos: null, torrents: null, link: null, refines: { videos: NO_REFINE, torrents: NO_REFINE } });
let kept: Kept = NOTHING_KEPT();

@Component({
  selector: 'app-search-page',
  templateUrl: './search-page.component.html',
  styleUrls: ['./search-page.component.scss']
})
export class SearchPageComponent implements OnInit , AfterViewInit , OnDestroy {

  // the catalog's kinds; Videos and Torrents join them when the server has providers
  filters:Filter[] = [
    { id : 'all' ,    label : 'All' },
    { id : 'movie' ,  label : 'Movies' },
    { id : 'tv' ,     label : 'TV shows' },
    { id : 'anime' ,  label : 'Anime' },
    { id : 'person' , label : 'People' },
  ];
  private readonly videosFilter:Filter = { id: 'videos', label: 'Videos' };
  private readonly torrentsFilter:Filter = { id: 'torrents', label: 'Torrents' };
  hasVideos = false;
  hasTorrents = false;

  imgBase = tmdbImageBase('poster', 150);
  readonly fieldWidth = dp(760);
  // typing a link on the remote: the characters addresses need
  readonly linkSymbols = [':', '/', '.', '-', '_', '?', '=', '&', '%', '#'];
  state:SearchState = EMPTY_SEARCH;
  loading = false;
  typing = false;
  refining:Noun | null = null;
  // the plugins' chips after the core's, and the chosen one's rows
  pluginFilters:PluginFilter[] = [];
  pluginRows:PluginRow[] = [];
  private pluginSub:Subscription;
  private chipsSub:Subscription;
  private providersSub:Subscription;
  private sourcesSubs:Subscription[] = [];

  // beyond the catalog (see Kept); the lists below are rebuilt from it on every change
  kept = kept;
  videoItems:Found[] = [];
  torrentItems:Found[] = [];
  shownVideos:Found[] = [];
  shownTorrents:Found[] = [];
  videoCards:CardModel[] = [];
  /** All: the five best torrents */
  bestTorrents:Found[] = [];
  videoRows:PluginRow[] = [];
  sources = new Map<string, string>();
  torrentLimit = PAGE;
  private topSeeds = 1;
  private searchingSources = 0;

  searchSub:Subscription;
  private searches = new Subject<{query:string , filter:string}>();
  private screen = useScreen();

  constructor(
    private navigation:NavigationService,
    private moviesService:MoviesService,
    private navigator:Navigator,
    private profiles:ProfilesService,
    private engine:FocusEngine,
    private positions:PositionStore,
    private remotePlugins:RemotePlugins,
    private searchSources:SearchSourcesService,
  ) { }

  get visibleFilters():Filter[] {
    return [
      ...this.filters,
      ...(this.hasVideos ? [this.videosFilter] : []),
      ...(this.hasTorrents ? [this.torrentsFilter] : []),
      ...this.pluginFilters.map(f => f.chip),
    ];
  }

  get pluginFilter():PluginFilter | null {
    return this.pluginFilters.find(f => f.id == this.state.filter) || null;
  }

  get link() {
    return this.kept.link;
  }

  ngOnInit(): void {
    this.state = this.moviesService.searchData.value;
    // what was found for this query before the player / a title page
    if (kept.query != this.state.query.trim()) kept = this.kept = NOTHING_KEPT();
    this.rebuild();
    this.loadPluginChips();
    this.providersSub = forkJoin([this.searchSources.streamProviders(), this.searchSources.torrentProviders()]).subscribe(([streams, torrents]) => {
      this.hasVideos = streams.length > 0;
      // stream plugins find torrents too
      this.hasTorrents = torrents.length > 0 || streams.length > 0;
    });

    // Latest query/filter wins
    this.searchSub = this.searches.pipe(
      debounceTime(200),
      switchMap(({query , filter}) => this.fetchRows(query , filter).pipe(
        map(rows => ({query , filter , rows})),
        catchError(() => of({query , filter , rows : null})),
      )),
    ).subscribe(({query , filter , rows}) => {
      this.loading = false;
      if (query != this.state.query || filter != this.state.filter) return;
      // new results: no old position in them
      this.positions.clear(STACK);
      this.update({ rows : (rows || []).filter(r => r.items.length) , searched : true });
    });

    this.screen.onSelect(active => {
      if (active.classList.contains('px-card')) this.open(this.itemFor(active));
      else if (active.dataset['found']) this.playFound(active.dataset['found']);
      else if (active.dataset['link']) this.playLink(Number(active.dataset['link']));
      else if (active.dataset['more'] == 'all-torrents') this.setFilter('torrents');
      else if (active.dataset['more']) this.torrentLimit += PAGE;
    });

    // a section without the menu: out to the power menu at once (the
    // section's back policy), starting over next time
    let clear = () => {
      this.moviesService.searchData.next(EMPTY_SEARCH);
      kept = NOTHING_KEPT();
      this.positions.clear(STACK);
      return false;
    };
    this.screen.onBack(clear);
    this.screen.onLeave(clear);
  }

  // Sections `searchHead`, `searchFilters` and `searches` are pxSection
  // directives in the template; the page and its rows scroll natively
  ngAfterViewInit(): void {
    setTimeout(()=>{
      // Coming back from a title page or the player: same results, same item focused
      let restored = this.state.query && this.positions.get(STACK) && this.engine.restore(`stack:${STACK}`);
      if (restored) return;
      this.navigation.updateNavigation('focus' , {sectionId : 'searchHead'});
      // a fresh page: straight to typing
      if (!this.state.query) this.typing = true;
    } , 50)
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.pluginSub?.unsubscribe();
    this.chipsSub?.unsubscribe();
    this.providersSub?.unsubscribe();
    this.sourcesSubs.forEach(s => s.unsubscribe());
  }

  // ── typing ──────────────────────────────────────────────────────────────

  onSearchDone(text:string) {
    this.typing = false;
    if (text == this.state.query) return;
    this.update({ query : text });
    this.search();
  }

  clear() {
    this.update({ query : '' , rows : [] , searched : false });
    this.search();
  }

  // ── searching ───────────────────────────────────────────────────────────

  get note():string {
    let query = this.state.query.trim();
    if (this.link) {
      if (this.link.error) return this.link.error;
      if (!this.link.answer) return `Reading ${this.hostOf(query)}…`;
      return this.link.answer.items.length ? '' : 'Nothing on this page plays: no video, stream, magnet or torrent link.';
    }
    if (query.length < MIN_QUERY) return query ? 'Type at least three letters.' : '';
    if (this.state.filter.startsWith('plugin:')) {
      if (this.loading && !this.pluginRows.length) return 'Searching…';
      let label = this.pluginFilter?.model.label || 'this plugin';
      return this.state.searched && !this.pluginRows.length ? `${label} has nothing for “${query}”.` : '';
    }
    if (this.state.filter == 'videos' || this.state.filter == 'torrents') {
      let noun = this.state.filter, items = noun == 'videos' ? this.videoItems : this.torrentItems,
        shown = noun == 'videos' ? this.shownVideos : this.shownTorrents;
      if (!items.length) return this.searchingSources ? 'Searching…' : `No ${noun} for “${query}”.`;
      return shown.length ? '' : `None of the ${items.length} ${noun} fits these filters.`;
    }
    if ((this.loading || this.searchingSources) && !this.state.rows.length && !this.videoCards.length && !this.bestTorrents.length) return 'Searching…';
    if (this.state.searched && !this.state.rows.length && !this.searchingSources && !this.videoCards.length && !this.bestTorrents.length) {
      let what = this.filters.find(f => f.id == this.state.filter);
      return this.state.filter == 'all'
        ? `Nothing matches “${query}”. Check the spelling or try fewer words.`
        : `No ${what.label.toLowerCase()} match “${query}”. Try All to search everything.`;
    }
    return '';
  }

  setFilter(filter:string){
    if (filter == this.state.filter || !this.visibleFilters.some(f => f.id == filter)) return;
    this.update({ filter });
    this.search();
  }

  search(){
    let query = this.state.query.trim(), filter = this.state.filter;
    this.pluginSub?.unsubscribe();
    this.pluginRows = [];
    this.positions.clear(STACK);
    this.torrentLimit = PAGE;

    // A link: the server reads it; what it holds is the result
    if (isLink(query)) {
      this.dropSources();
      this.kept.link = { answer: null, error: null };
      this.loading = false;
      this.update({ rows : [] , searched : false });
      let link = this.kept.link;
      this.track(this.searchSources.inspect(query).subscribe({
        next: answer => link.answer = answer,
        error: e => link.error = e?.error?.error || 'The link couldn’t be read.',
      }));
      return;
    }
    if (this.kept.link || this.kept.query != query) this.dropSources();

    if (query.length < MIN_QUERY) {
      this.loading = false;
      this.update({ rows : [] , searched : false });
      return;
    }
    if (filter.startsWith('plugin:')) {
      this.loading = true;
      this.update({ rows : [] , searched : false });
      this.searchPlugin(query);
      return;
    }

    // the catalog (its own kinds and All)
    if (this.filters.some(f => f.id == filter)) {
      this.loading = true;
      this.searches.next({ query : this.state.query , filter });
    } else {
      this.update({ rows : [] , searched : true });
    }
    // the plugins' videos (their torrents count among the torrents), and the release providers' torrents
    if ((filter == 'all' || filter == 'videos' || filter == 'torrents') && !this.kept.videos) {
      this.searchingSources++;
      this.track(this.searchSources.streams(query).subscribe(results => {
        this.searchingSources--;
        if (query != this.state.query.trim()) return;
        this.kept.videos = results;
        this.rebuild();
      }));
    }
    if ((filter == 'all' || filter == 'torrents') && !this.kept.torrents) {
      this.searchingSources++;
      this.track(this.searchSources.torrents(query).subscribe(results => {
        this.searchingSources--;
        if (query != this.state.query.trim()) return;
        this.kept.torrents = results;
        this.rebuild();
      }));
    }
  }

  /** What was found beyond the catalog goes with the query it was found for */
  private dropSources() {
    this.sourcesSubs.forEach(s => s.unsubscribe());
    this.sourcesSubs = [];
    this.searchingSources = 0;
    kept = this.kept = { ...NOTHING_KEPT(), query: this.state.query.trim(), refines: this.kept.refines };
    this.rebuild();
  }

  private track(sub:Subscription) {
    this.sourcesSubs.push(sub);
  }

  // ── videos and torrents ─────────────────────────────────────────────────

  /** The lists, rows and cards again from what was found and the panel's choices */
  private rebuild() {
    let videos = this.kept.videos || [], torrents = this.kept.torrents || [];
    this.sources = new Map([...videos, ...torrents].map(r => [r.provider.id, r.provider.name] as [string, string]));
    this.videoItems = videos.flatMap(r => r.items).filter(f => f.kind != 'torrent');
    let seen = new Set<string>();
    // one row per torrent, whoever found it
    this.torrentItems = [...torrents.flatMap(r => r.items), ...videos.flatMap(r => r.items.filter(f => f.kind == 'torrent'))]
      .filter(f => !f.infoHash || (!seen.has(f.infoHash.toLowerCase()) && !!seen.add(f.infoHash.toLowerCase())));
    this.shownVideos = refine(this.videoItems, this.kept.refines.videos);
    this.shownTorrents = refine(this.torrentItems, this.kept.refines.torrents);
    this.topSeeds = Math.max(1, ...this.torrentItems.map(f => f.seeds || 0));
    this.videoCards = refine(this.videoItems, NO_REFINE).slice(0, FIRST_CARDS).map(f => this.videoCard(f));
    this.bestTorrents = refine(this.torrentItems, NO_REFINE).slice(0, FIRST_TORRENTS);
    // Videos: a row per plugin, each as the panel ranks and narrows them
    let byFinder = new Map<string, Found[]>();
    this.shownVideos.forEach(f => byFinder.set(f.finder, [...(byFinder.get(f.finder) || []), f]));
    this.videoRows = [...byFinder].map(([finder, items]) => ({
      key: 'videos:' + finder, title: `${this.sourceName(finder)} (${items.length})`, variant: 'still' as const,
      items: items.slice(0, 100).map(f => this.videoCard(f)),
    }));
  }

  private videoCard(f:Found):CardModel {
    let what = [f.kind == 'hls' ? 'Stream' : 'Video', f.year ? String(f.year) : '', f.quality || '', this.size(f.size)].filter(Boolean).join(', ');
    return { key: 'v:' + f.finder + f.key, title: f.title, variant: 'still', image: f.poster || null,
      subtitle: `${what} from ${this.sourceName(f.finder)}`, run: () => this.searchSources.play(f) };
  }

  run(card:CardModel) {
    card.run?.();
  }

  playFound(id:string) {
    let found = this.torrentItems.find(f => f.finder + '|' + f.key == id);
    if (found) this.searchSources.play(found);
  }

  playLink(index:number) {
    let item = this.link?.answer?.items[index];
    if (item) this.searchSources.playLink(item);
  }

  get refines() {
    return this.kept.refines;
  }

  setRefine(noun:Noun, value:Refine) {
    this.kept.refines = { ...this.kept.refines, [noun]: value };
    this.positions.clear(STACK);
    this.torrentLimit = PAGE;
    this.rebuild();
  }

  refineOn(noun:Noun):number {
    return refineCount(this.kept.refines[noun]);
  }

  sortLabel(noun:Noun):string {
    return SORTS.find(s => s.value == this.kept.refines[noun].sort)?.label || '';
  }

  /** The filters on, each a chip that takes it off */
  activeChips(noun:Noun):{ key:string, label:string, off:Refine }[] {
    let r = this.kept.refines[noun];
    let label = (list:{ value:string, label:string }[], v:string) => list.find(o => o.value == v)?.label || v;
    return [
      ...(r.exact ? [{ key: 'exact', label: 'Every word', off: { ...r, exact: false } }] : []),
      ...r.qualities.map(v => ({ key: 'q' + v, label: label(QUALITIES, v), off: { ...r, qualities: toggle(r.qualities, v) } })),
      ...r.what.map(v => ({ key: 'w' + v, label: label(WHATS, v), off: { ...r, what: toggle(r.what, v) } })),
      ...r.sizes.map(v => ({ key: 's' + v, label: label(SIZES, v), off: { ...r, sizes: toggle(r.sizes, v) } })),
      ...r.codecs.map(v => ({ key: 'c' + v, label: label(CODECS, v), off: { ...r, codecs: toggle(r.codecs, v) } })),
      ...r.sources.map(v => ({ key: 'f' + v, label: this.sourceName(v), off: { ...r, sources: toggle(r.sources, v) } })),
    ];
  }

  sourceName(id:string):string {
    return this.sources.get(id) || id.replace(/^plugin:/, '');
  }

  episodeLabel(f:Found):string {
    let pad = (n:number) => String(n).padStart(2, '0');
    if (f.season != null && f.episode != null) return `S${pad(f.season)}E${pad(f.episode)}`;
    if (f.pack) return f.season != null ? `Season ${f.season}` : 'Several seasons';
    return '';
  }

  seedShare(seeds:number | null):number {
    return Math.sqrt((seeds || 0) / this.topSeeds);
  }

  compact(n:number):string {
    if (n < 10000) return n.toLocaleString();
    return n < 1e6 ? `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
  }

  size(bytes:number | null | undefined):string {
    if (!bytes) return '';
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }

  min(a:number, b:number) {
    return Math.min(a, b);
  }

  // ── a link ──────────────────────────────────────────────────────────────

  linkKind(item:LinkItem):string {
    return { video: 'Video', hls: 'Stream', magnet: 'Magnet', torrent: 'Torrent' }[item.kind];
  }

  linkSummary(a:LinkInspection):string {
    if (a.kind != 'page') return `${this.linkKind({ kind: a.kind } as LinkItem)}, ready to play`;
    let count = (kind:LinkItem['kind'], one:string, many:string) => {
      let n = a.items.filter(i => i.kind == kind).length;
      return n ? `${n} ${n == 1 ? one : many}` : '';
    };
    let parts = [count('video', 'video', 'videos'), count('hls', 'stream', 'streams'), count('magnet', 'magnet', 'magnets'), count('torrent', 'torrent', 'torrents')].filter(Boolean);
    return parts.length ? `A page with ${parts.join(', ')}` : 'A page';
  }

  hostOf(url:string):string {
    if (/^magnet:/i.test(url) || /^[a-f0-9]{40}$/i.test(url)) return 'the magnet';
    try {
      return new URL(/^www\./i.test(url) ? 'https://' + url : url).host;
    } catch {
      return 'the link';
    }
  }

  // ── plugins' chips (slot core.search.filters) ───────────────────────────

  private context(query:string) {
    let p = this.profiles.current.value;
    return { query , profile : { id : p?.id , name : p?.name , kids : !!p?.isKid } };
  }

  // Each plugin's chip: its label comes from its answer, asked once with the query shown
  // (again when the server's plugins change)
  private loadPluginChips(){
    this.chipsSub = this.remotePlugins.plugins$.pipe(
      switchMap(() => {
        let defs = CONTRIBUTIONS.for('core.search.filters' , this.context(this.state.query));
        if (!defs.length) return of([]);
        return forkJoin(defs.map(def => CONTRIBUTIONS.models(def , this.context(this.state.query.trim())).pipe(
          first(),
          map(models => models[0] ? {
            id : `plugin:${models[0].key}` , def , model : models[0] , chip : { id : `plugin:${models[0].key}` , label : models[0].label },
          } as PluginFilter : null),
          catchError(() => of(null)),
        )));
      }),
    ).subscribe(found => {
      this.pluginFilters = (found as PluginFilter[]).filter(Boolean);
      // a plugin chip left from before: its rows again, or All when it's gone
      if (this.state.filter.startsWith('plugin:')) {
        if (this.pluginFilter) this.search();
        else {
          this.update({ filter : 'all' });
          this.search();
        }
      }
    });
  }

  private searchPlugin(query:string){
    let chosen = this.pluginFilter;
    if (!chosen) return;
    this.pluginSub = CONTRIBUTIONS.models(chosen.def , this.context(query)).pipe(
      first(),
      map(models => models.find(m => m.key == chosen.model.key) || models[0] || null),
      switchMap((model:SearchFilterModel | null) => {
        if (!model?.rows.length) return of([] as PluginRow[]);
        return forkJoin(model.rows.map(row => 'items' in row.source
          ? of({ key : row.key , title : row.title , variant : row.variant , items : row.source.items })
          : row.source.page(1).pipe(
              map(page => ({ key : row.key , title : row.title , variant : row.variant , items : page.items })),
              catchError(() => of(null)),
            )));
      }),
      catchError(() => of([] as PluginRow[])),
    ).subscribe(rows => {
      this.loading = false;
      if (query != this.state.query.trim() || this.pluginFilter !== chosen) return;
      this.positions.clear(STACK);
      this.pluginRows = rows.filter(r => r && r.items.length);
      this.update({ searched : true });
    });
  }

  pickPlugin(card:CardModel){
    if (card.run) card.run();
    else if (card.intent) this.navigator.open(card.intent);
  }

  trackFilter(index:number , filter:Filter){
    return filter.id;
  }

  trackPluginRow(index:number , row:PluginRow){
    return row.key;
  }

  trackFound(index:number , f:Found){
    return f.finder + f.key;
  }

  // One row per kind of result, in the order people expect them
  fetchRows(query:string , filter:string):Observable<SearchRow[]> {
    let q = query.trim();
    switch (filter) {
      case 'movie':
        return this.searchKind('movie' , q).pipe(map(r => [this.row('movies' , 'Movies' , r , 'movie')]));
      case 'tv':
        return this.searchKind('tv' , q).pipe(map(r => [this.row('shows' , 'TV shows' , r , 'tv')]));
      case 'person':
        return this.searchKind('person' , q).pipe(map(r => [this.row('people' , 'People' , r , 'person')]));
      case 'anime':
        // no anime type: Japanese animation (genre 16)
        let isAnime = (r:CatalogTitle) => (r.genreIds || []).includes(16) && r.originalLanguage == 'ja';
        return forkJoin([this.searchKind('tv' , q) , this.searchKind('movie' , q)]).pipe(map(([tv , movies]) => [
          this.row('animeShows' , 'Anime series' , tv.filter(isAnime) , 'tv'),
          this.row('animeMovies' , 'Anime movies' , movies.filter(isAnime) , 'movie'),
        ]));
      default:
        return this.searchKind('multi' , q).pipe(map(results => [
          this.row('movies' , 'Movies' , results.filter(r => r.mediaType == 'movie') , 'movie'),
          this.row('shows' , 'TV shows' , results.filter(r => r.mediaType == 'tv') , 'tv'),
          this.row('people' , 'People' , results.filter(r => r.mediaType == 'person') , 'person'),
        ]));
    }
  }

  private searchKind(kind:SearchKind , query:string):Observable<any[]> {
    return this.moviesService.search(kind , query).pipe(map(data => data.results || []));
  }

  private row(key:string , title:string , results:(CatalogTitle | CatalogPerson)[] , kind:SearchItem['kind']):SearchRow {
    return { key , title , items : results.map(r => this.toItem(r)).filter(i => i.image) };
  }

  private toItem(r:CatalogTitle | CatalogPerson):SearchItem {
    if (r.mediaType == 'person') {
      return { key : `person-${r.personId}`, kind : 'person', id : r.personId, title : r.name,
        sub : r.knownForDepartment || '', image : r.profilePath };
    }
    return { key : `${r.mediaType}-${r.tmdbId}`, kind : r.mediaType, id : r.tmdbId, title : r.title,
      sub : r.year || '', image : r.posterPath };
  }

  // ── opening a result ────────────────────────────────────────────────────

  open(item:SearchItem){
    if (!item) return;

    if (item.kind == 'person') {
      this.showCredits(item);
    }
    // its page, over this one (the movie page loads the movie's details)
    else {
      this.navigator.open({ screen: item.kind == 'tv' ? 'core.show' : 'core.movie', params: { id: item.id } });
    }
  }

  // A person: their movies and shows, in a row right under theirs
  showCredits(person:SearchItem){
    this.moviesService.getPersonCredits(person.id).pipe(first()).subscribe(data=>{
      let seen = new Set<string>();
      let credits = [...(data.cast || []) , ...(data.crew || [])]
        .sort((a , b) => (b.voteCount || 0) - (a.voteCount || 0))
        .map(c => ({ ...this.toItem(c) , badge : c.mediaType == 'tv' ? 'TV' : undefined }))
        .filter(item => item.image && !seen.has(item.key) && seen.add(item.key))
        .slice(0 , 40);

      let rows = this.state.rows.filter(r => r.key != 'credits');
      let at = rows.findIndex(r => r.items.some(i => i.key == person.key));
      rows.splice(at + 1 , 0 , {
        key : 'credits',
        title : credits.length ? `With ${person.title}` : `No titles found for ${person.title}`,
        items : credits,
      });
      this.update({ rows });

      setTimeout(()=>{
        let first = document.querySelector('.searchContainer .resultRow[data-row="credits"] .result') as HTMLElement;
        if (first) this.engine.focus(first);
      })
    })
  }

  itemFor(node:HTMLElement):SearchItem {
    for (let row of this.state.rows) {
      let item = row.items.find(i => i.key == node.dataset['key']);
      if (item) return item;
    }
    return undefined;
  }

  // ── state ──────────────────────────────────────────────────────────────

  update(changes:Partial<SearchState>){
    this.state = { ...this.state , ...changes };
    this.moviesService.searchData.next(this.state);
  }

  trackRow(index:number , row:SearchRow){ return row.key; }
  trackItem(index:number , item:SearchItem){ return item.key; }
}
