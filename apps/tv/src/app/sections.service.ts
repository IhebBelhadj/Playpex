import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, debounceTime, distinctUntilChanged, map, merge, Observable, of, switchMap, throwError } from 'rxjs';
import type { Schema } from '@playpex/protocol';
import { Catalog, CatalogQuery, CatalogRow, ContinueAt, episodeCode, MediaType, RowItem, SectionId, timeLeft } from './catalog';
import { matchesFilters } from './catalog-filters';
import { CatalogPage, CatalogTitle, MoviesService } from './movies.service';
import { PositionStore } from './movement/movement';
import { PluginCard, PluginScope } from './plugins/plugin-models';
import { PluginClient } from './plugins/plugin-client.service';
import { RemotePlugins } from './plugins/remote';
import { ProfilesService } from './profiles.service';
import { ServerEvents } from './server-events.service';
import { ServerService } from './server.service';
import { Badge, CardVariant, tmdbImageBase } from './ui/public-api';

export type SectionRows = Schema<'SectionRows'>;
export type ResolvedRow = Schema<'ResolvedRow'>;
export type RowPage = Schema<'RowPage'>;
export type SectionLayout = Schema<'SectionLayout'>;
export type RowEntry = Schema<'RowEntry'>;

// A row's continue-watching item (the profile's resume point, or the next episode)
interface ProgressItem {
  kind:'resume' | 'next';
  mediaType:MediaType;
  tmdbId:number;
  season:number;
  episode:number;
  title:string | null;
  posterPath:string | null;
  backdropPath:string | null;
  positionS:number;
  durationS:number;
  ratio:number;
}

// The rows of a server without layouts (an older Playpex Media Server): its catalog's lists
const TV_DISCOVER = { language: 'en', withoutGenres: '10763,10764,10767' };
const FALLBACK:{ [section in SectionId]:{ title:string, query:CatalogQuery }[] } = {
  home: [
    { title: 'Trending movies', query: { path: 'lists/movie/trending', params: {} } },
    { title: 'Trending shows', query: { path: 'lists/tv/trending', params: {} } },
    { title: 'New in cinemas', query: { path: 'lists/movie/now_playing', params: {} } },
    { title: 'Top rated shows', query: { path: 'discover/tv', params: { sort: 'rating', minVotes: 1500, ...TV_DISCOVER } } },
  ],
  movies: [
    { title: 'Trending', query: { path: 'lists/movie/popular', params: {} } },
    { title: 'Top rated', query: { path: 'lists/movie/top_rated', params: {} } },
    { title: 'New in cinemas', query: { path: 'lists/movie/now_playing', params: {} } },
    { title: 'Coming soon', query: { path: 'lists/movie/upcoming', params: {} } },
  ],
  shows: [
    { title: 'Popular', query: { path: 'discover/tv', params: { sort: 'popularity', minVotes: 200, ...TV_DISCOVER } } },
    { title: 'Top rated', query: { path: 'discover/tv', params: { sort: 'rating', minVotes: 1500, ...TV_DISCOVER } } },
    { title: 'On the air', query: { path: 'lists/tv/on_the_air', params: {} } },
    { title: 'Trending', query: { path: 'lists/tv/trending', params: {} } },
  ],
};

// A section's rows from the server (docs/rows-plan.md, docs/api/rows.md):
// GET /sections/{section}/rows?profile= gives them in order, each row's items
// come with it (personal rows, the library) or page by page from
// GET /sections/{section}/rows/{id}/items. The TV defines no rows of its own:
// the admin's default layout, or the profile's (edited with <rows-editor>).
//
// Asked again when the profile changes, on `rows.changed` (a layout edited:
// this profile's, or the default), `plugin.changed` and after something was
// watched (`session.ended`): at once when the section shows, else the next
// time it does (`stale`). A search / filters view (and a server without
// layouts) has `query` rows, paged through the catalog (/catalog/*).
@Injectable({
  providedIn: 'root'
})
export class SectionRowsService {

  private started = false;
  private inFlight = new Set<string>();
  private lastPage:{ [key:string]:number } = {};
  private posterBase = '';
  private stillBase = '';

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private movies:MoviesService,
    private profiles:ProfilesService,
    private events:ServerEvents,
    private remote:RemotePlugins,
    private client:PluginClient,
    private positions:PositionStore,
  ) { }

  private get catalogs():Catalog[] {
    return Object.values(this.movies.catalogs);
  }

  /** From AppComponent, once the server is known */
  start() {
    if (this.started || !this.server.connected) return;
    this.started = true;
    // another profile: its own rows, from the start
    this.profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()).subscribe(id => {
      for (let catalog of this.catalogs) {
        if (catalog.profileId && catalog.profileId !== id) {
          catalog.clear();
          this.positions.clear(`catalog:${catalog.media}`);
        }
      }
    });
    this.events.on<{ section:SectionId, profileId:string | null }>('rows.changed').subscribe(e => {
      let profile = this.profiles.current.value?.id;
      if (e.data?.profileId && e.data.profileId !== profile) return;
      this.catalogs.filter(c => c.section == e.data?.section).forEach(c => this.invalidate(c));
    });
    merge(this.events.on('plugin.changed'), this.events.on('session.ended')).pipe(debounceTime(1500))
      .subscribe(() => this.catalogs.forEach(c => this.invalidate(c)));
  }

  /** Whether the current profile may change its rows here (not a kids profile's: the admin's, on the dashboard) */
  canEdit(catalog:Catalog):boolean {
    let profile = this.profiles.current.value;
    return !!profile && !profile.isKid && catalog.serverRows && this.remote.capabilities$.value.rows === true;
  }

  /** The section shows: its rows, asked for when it has none, they're for another profile or stale */
  show(catalog:Catalog) {
    let profile = this.profiles.current.value;
    if (!catalog.rows.length && !catalog.loading || catalog.profileId !== (profile?.id || null)) this.load(catalog);
    else if (catalog.stale && !catalog.search) this.load(catalog);
  }

  private invalidate(catalog:Catalog) {
    if (!catalog.rows.length && !catalog.search) return;
    catalog.stale = true;
    if (catalog.visible && !catalog.search && !catalog.typing && !catalog.filtering && !catalog.editing) this.load(catalog);
  }

  /** The section's rows again: rows it still has keep their items (and their place), personal ones are filled again */
  load(catalog:Catalog) {
    let profile = this.profiles.current.value?.id || null;
    let fresh = catalog.profileId !== profile;
    catalog.profileId = profile;
    catalog.stale = false;
    catalog.loading = true;
    this.fetchRows(catalog, profile).subscribe({
      next: answer => {
        catalog.loading = false;
        if (catalog.profileId !== profile) return;
        if (!answer) {
          this.fallback(catalog);
          return;
        }
        catalog.serverRows = true;
        let before = fresh ? {} : catalog.items.value;
        let items:{ [key:string]:RowItem[] } = {};
        let rows:CatalogRow[] = [];
        let fetch:CatalogRow[] = [];
        for (let r of answer.rows) {
          let row:CatalogRow = {
            key: r.id,
            title: r.title,
            kind: r.kind,
            variant: r.variant,
            plugin: r.plugin,
            entry: r.id.split('~')[0],
            personal: r.personal,
          };
          rows.push(row);
          if (r.items) {
            items[row.key] = this.toItems(catalog, row, r.items, 0);
            catalog.reachedPages[row.key] = 1;
            catalog.last[row.key] = r.last !== false;
          } else if (before[row.key]?.length && !r.personal) {
            items[row.key] = before[row.key];
          } else {
            items[row.key] = [];
            catalog.reachedPages[row.key] = 1;
            catalog.last[row.key] = false;
            fetch.push(row);
          }
        }
        catalog.rows = rows;
        catalog.items.next(items);
        fetch.forEach(row => this.fetchPage(catalog, row, 1));
      },
      error: () => {
        // asked again the next time the section shows
        catalog.loading = false;
        catalog.stale = true;
      },
    });
  }

  private fetchRows(catalog:Catalog, profile:string | null):Observable<SectionRows | null> {
    if (this.remote.capabilities$.value.rows === false) return of(null);
    let params:any = profile ? { profile } : {};
    return this.http.get<SectionRows>(`${this.server.api}/sections/${catalog.section}/rows`, { params }).pipe(
      // an older server (no /sections): rows of its catalog; other failures keep what shows
      catchError(err => err?.status == 404 ? of(null) : throwError(() => err)),
    );
  }

  private fallback(catalog:Catalog) {
    catalog.serverRows = false;
    let rows = FALLBACK[catalog.section].map(f => ({ key: f.title, title: f.title, kind: 'query' as const, variant: 'poster', query: { path: f.query.path, params: { ...f.query.params } } }));
    let items = {};
    rows.forEach(r => {
      items[r.key] = [];
      catalog.reachedPages[r.key] = 1;
      catalog.last[r.key] = false;
    });
    catalog.rows = rows;
    catalog.items.next(items);
    rows.forEach(r => this.fetchPage(catalog, r, 1));
    this.fallbackContinue(catalog, items);
  }

  // An older server's Continue watching, first: the profile's library (GET /profiles/{id}/library)
  private fallbackContinue(catalog:Catalog, items:{ [key:string]:RowItem[] }) {
    let profile = catalog.profileId;
    if (!profile) return;
    this.http.get<{ continueWatching?:ProgressItem[] }>(`${this.server.api}/profiles/${profile}/library`).subscribe({
      next: library => {
        if (items !== catalog.items.value || catalog.profileId !== profile) return;
        let media = catalog.mediaType;
        let list = (library.continueWatching || []).filter(p => !media || p.mediaType == media);
        if (!list.length) return;
        let row:CatalogRow = { key: 'continue', title: 'Continue watching', kind: 'progress', variant: 'poster', personal: true };
        items[row.key] = this.toItems(catalog, row, list, 0);
        catalog.last[row.key] = true;
        catalog.rows = [row, ...catalog.rows];
        catalog.items.next(items);
      },
      error: () => { },
    });
  }

  /** The slider nears a row's end */
  more(catalog:Catalog, key:string) {
    let row = catalog.findRow(key);
    if (!row || catalog.last[key] || this.inFlight.has(this.flightKey(catalog, key))) return;
    let next = (catalog.reachedPages[key] || 0) + 1;
    if (row.kind == 'query' && next > (this.lastPage[this.flightKey(catalog, key)] || 500)) return;
    catalog.reachedPages[key] = next;
    this.fetchPage(catalog, row, next);
  }

  private flightKey(catalog:Catalog, key:string) {
    return `${catalog.media}/${key}`;
  }

  /** One page of a row, appended to the rows object it was asked for (a late page never lands in another view) */
  fetchPage(catalog:Catalog, row:CatalogRow, page:number) {
    let items = catalog.items.value;
    let search = catalog.search;
    let flight = this.flightKey(catalog, row.key);
    this.inFlight.add(flight);
    let answer$:Observable<{ items:RowItem[], last:boolean, title?:string, total?:number }> = row.kind == 'query'
      ? this.queryPage(catalog, row, page)
      : this.http.get<RowPage>(`${this.server.api}/sections/${catalog.section}/rows/${encodeURIComponent(row.key)}/items`, {
        params: { page, ...(catalog.profileId ? { profile: catalog.profileId } : {}) },
      }).pipe(map(p => ({ items: this.toItems(catalog, row, p.items, (items[row.key] || []).length), last: p.last, title: p.title })));
    answer$.subscribe({
      next: res => {
        this.inFlight.delete(flight);
        if (res.total) this.lastPage[flight] = res.total;
        let had = items[row.key] || [];
        let first = !had.length;
        let seen = new Set(had.map(i => i.key));
        items[row.key] = had.concat(res.items.filter(i => !seen.has(i.key) && seen.add(i.key)));
        if (items !== catalog.items.value) return;
        catalog.last[row.key] = res.last;
        if (res.title) row.title = res.title;
        // a filtered search can keep nothing of a page: read on (a few pages) rather than leave the row empty
        if (search && first && !res.items.length && !res.last && page < 6) {
          catalog.reachedPages[row.key] = page + 1;
          this.fetchPage(catalog, row, page + 1);
          return;
        }
        if (search && first) search.pending = Math.max(0, search.pending - 1);
        catalog.items.next(items);
        // new results: the first one is described until a card is focused
        if (search && first && res.items.length && search.rows[0] == row.key) catalog.select(res.items[0].key, row.key, '0');
      },
      error: () => {
        this.inFlight.delete(flight);
        if (items === catalog.items.value) catalog.last[row.key] = true;
        if (search && !(items[row.key] || []).length) search.pending = Math.max(0, search.pending - 1);
      },
    });
  }

  // A catalog query's page: posterless results can't be cards; a search's are narrowed by the filters (TMDB search can't filter)
  private queryPage(catalog:Catalog, row:CatalogRow, page:number) {
    let search = catalog.search;
    return this.movies.getMovies({ path: row.query.path, params: { ...row.query.params, page } }).pipe(
      map((res:CatalogPage) => {
        let results = (res.results || []) as CatalogTitle[];
        if (search) results = results.filter(r => r.posterPath && (!search.query || matchesFilters(r, search.filters)));
        return {
          items: this.toItems(catalog, row, results, 0),
          last: page >= (res.totalPages || 1),
          total: res.totalPages || 1,
        };
      }),
    );
  }

  // ── items → cards ───────────────────────────────────────────────────────

  private variantOf(row:CatalogRow):CardVariant {
    return row.variant == 'landscape' ? 'still' : (['poster', 'still', 'portrait', 'compact'].includes(row.variant) ? row.variant : 'poster') as CardVariant;
  }

  toItems(catalog:Catalog, row:CatalogRow, list:any[], offset:number):RowItem[] {
    if (!this.posterBase) {
      this.posterBase = tmdbImageBase('poster', 180);
      this.stillBase = tmdbImageBase('backdrop', 320);
    }
    let variant = this.variantOf(row);
    return (list || []).map((raw, i) => {
      let item = row.kind == 'cards' ? this.card(row, raw, variant) : row.kind == 'progress' ? this.progress(raw, variant) : this.title(catalog, raw, variant);
      if (item && row.variant == 'top10') item.number = offset + i + 1;
      return item;
    }).filter(Boolean);
  }

  private image(variant:CardVariant, poster:string | null, backdrop:string | null):string | null {
    if (variant == 'still') return backdrop ? this.stillBase + backdrop : poster ? this.posterBase + poster : null;
    return poster ? this.posterBase + poster : null;
  }

  private title(catalog:Catalog, t:any, variant:CardVariant):RowItem | null {
    if (!t || !t.tmdbId || (t.mediaType != 'movie' && t.mediaType != 'tv')) return null;
    let badges:Badge[] = catalog.section == 'home' && t.mediaType == 'tv' ? ['tv'] : null;
    return {
      key: `${t.mediaType}:${t.tmdbId}`,
      title: t.title || t.originalTitle || '',
      image: this.image(variant, t.posterPath, t.backdropPath),
      variant,
      badges,
      item: t,
    };
  }

  // A Continue watching card: where it is on the artwork ("S2 E5 · 20 min left", "Next: S2 E6"), the amber
  // line; the title carries `continue` (the description's resume line, Enter's episode)
  private progress(p:ProgressItem, variant:CardVariant):RowItem | null {
    if (!p || !p.tmdbId) return null;
    let tv = p.mediaType == 'tv';
    let next = p.kind == 'next';
    let overlay = next
      ? (tv ? `Next: ${episodeCode(p.season, p.episode + 1)}` : 'Watch again')
      : (tv ? `${episodeCode(p.season, p.episode)} · ${timeLeft(p.positionS, p.durationS)}` : timeLeft(p.positionS, p.durationS));
    let at:ContinueAt = { kind: p.kind, season: p.season, episode: p.episode, positionS: p.positionS, durationS: p.durationS, ratio: p.ratio };
    return {
      key: `${p.mediaType}:${p.tmdbId}`,
      title: p.title || 'Untitled',
      image: this.image(variant, p.posterPath, p.backdropPath),
      variant,
      overlay,
      progress: next ? null : p.ratio,
      item: { mediaType: p.mediaType, tmdbId: p.tmdbId, title: p.title, posterPath: p.posterPath, backdropPath: p.backdropPath, continue: at },
    };
  }

  // A plugin's card: drawn as its slot rows are; one that opens a TMDB title is described like the core's
  private card(row:CatalogRow, c:PluginCard, variant:CardVariant):RowItem | null {
    if (!c || c.key === undefined) return null;
    let plugin = this.remote.plugins$.value.find(p => p.id == row.plugin);
    let scope:PluginScope = plugin ? this.remote.scope(plugin) : { id: row.plugin, name: row.plugin, adults: false, play: false };
    let model = this.client.card(scope, c);
    let screen = c.intent?.screen;
    let id = Number(c.intent?.params?.['id']);
    let titled = (screen == 'core.movie' || screen == 'core.show') && id > 0;
    return {
      key: String(model.key),
      title: model.title,
      image: model.image || null,
      variant: (model.variant || variant) as CardVariant,
      subtitle: model.subtitle,
      badges: model.badges || null,
      progress: model.progress ?? null,
      item: titled ? { mediaType: screen == 'core.movie' ? 'movie' : 'tv', tmdbId: id, title: model.title } : undefined,
      info: titled ? undefined : model.info || { title: model.title, meta: model.subtitle ? [{ kind: 'text', text: model.subtitle }] : [] },
      intent: titled ? undefined : model.intent,
      run: titled ? undefined : model.run,
    };
  }

  // ── editing ─────────────────────────────────────────────────────────────

  layout(section:SectionId):Observable<SectionLayout> {
    let profile = this.profiles.current.value?.id;
    if (!profile) return throwError(() => new Error('No profile'));
    return this.http.get<SectionLayout>(`${this.server.api}/sections/${section}/layout`, { params: { profile } });
  }

  saveLayout(section:SectionId, rows:RowEntry[], known:string[]):Observable<SectionLayout> {
    let profile = this.profiles.current.value?.id;
    return this.http.put<SectionLayout>(`${this.server.api}/sections/${section}/layout`, { rows, known }, { params: { profile } });
  }

  /** One entry of the profile's layout moved past its visible neighbour, or hidden (from a row's menu) */
  editEntry(section:SectionId, entryId:string, change:'up' | 'down' | 'hide'):Observable<SectionLayout> {
    return this.layout(section).pipe(
      switchMap(layout => {
        let rows = layout.rows.slice();
        let at = rows.findIndex(e => e.id == entryId);
        if (at < 0) return of(layout);
        if (change == 'hide') {
          rows[at] = { ...rows[at], hidden: true };
        } else {
          let step = change == 'up' ? -1 : 1;
          let to = at + step;
          while (to >= 0 && to < rows.length && rows[to].hidden) to += step;
          if (to < 0 || to >= rows.length) return of(layout);
          let [entry] = rows.splice(at, 1);
          rows.splice(to, 0, entry);
        }
        return this.saveLayout(section, rows, layout.known);
      }),
    );
  }

  resetLayout(section:SectionId):Observable<SectionLayout> {
    let profile = this.profiles.current.value?.id;
    return this.http.delete<SectionLayout>(`${this.server.api}/sections/${section}/layout`, { params: { profile } });
  }
}
