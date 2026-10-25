import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { catchError, debounceTime, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { BackgroundService } from '../background.service';
import { FocusEngine } from '../movement/movement';
import { MoviesService } from '../movies.service';
import { Navigator, useScreen } from '../nav/public-api';
import { NavigationService } from '../navigation.service';
import { ServerLibrary, ServerLibraryEntry, ServerLibraryService } from '../server-library.service';
import { ServerService } from '../server.service';
import { MetaItem, TitleInfoModel, tmdbImageBase } from '../ui/public-api';

interface Card {
  key:string;                    // unique on the page: <row>:<mediaType>:<tmdbId> | folder:<id>
  title:string;
  posterPath:string | null;
  backdropPath:string | null;
  entry?:ServerLibraryEntry;     // a movie / a show
  folder?:{ id:string, name:string, count:number };
}

interface Row {
  key:string;
  title:string;
  cards:Card[];
}

// What the description shows from the catalog for the focused title
interface Details {
  length:string | null;          // "2h 46m" for movies, "3 seasons" for shows
  score:number | null;
  genres:string[];
  overview:string;
}

const OVERVIEW_MAX = 230;
const STACK = 'server-library';

// /library — what is on the Playpex server (docs/media-server-plan.md §5.5),
// laid out like the watch list: the focused title described on top,
// category-style rows below:
//   Recently added · Movies on this server · Shows on this server · Other videos (folders)
// Empty rows are left out; a kids profile gets no adults-only folder (the
// server's rule). Enter: a movie / show → its page (Play prefers the file on
// the server), a folder → its videos (core.library.folder). The rows follow
// the server (`library.changed`) while the page is open. Back: the menu, then
// the power menu.
@Component({
  selector: 'app-library-page',
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss']
})
export class LibraryPageComponent implements OnInit, AfterViewInit, OnDestroy {

  readonly posterBase = tmdbImageBase('poster', 180);

  rows:Row[] = [];
  loaded = false;
  loadError = '';
  spot:Card | null = null;
  details:Details | null = null;

  private cards = new Map<string, Card>();
  private detailCache = new Map<string, Details>();
  private detailRequests = new Subject<Card>();
  private subscriptions:Subscription[] = [];
  private focusListener;
  private screen = useScreen();

  constructor(
    private serverLibrary:ServerLibraryService,
    private navigation:NavigationService,
    private background:BackgroundService,
    private moviesService:MoviesService,
    private server:ServerService,
    public navigator:Navigator,
    private engine:FocusEngine,
  ) { }

  get isEmpty():boolean {
    return this.loaded && !this.loadError && !this.rows.length;
  }

  // where the admin adds folders (the dashboard of this server)
  get dashboardUrl():string {
    return this.server.absolute('/library').replace(/^https?:\/\//, '');
  }

  ngOnInit():void {
    this.load();
    this.subscriptions.push(
      // the server found, lost or re-matched files: the rows again (focus stays on a card still there)
      this.serverLibrary.changes.subscribe(() => this.load(false)),
      this.detailRequests.pipe(
        debounceTime(150),
        switchMap(card => this.fetchDetails(card).pipe(map(details => ({ card, details })))),
      ).subscribe(({ card, details }) => {
        if (details) this.detailCache.set(this.titleKey(card), details);
        if (this.spot && this.titleKey(this.spot) == this.titleKey(card)) this.details = details;
      }),
    );
  }

  // Section `serverLibrary` is a pxSection in the template
  ngAfterViewInit():void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target([`stack:${STACK}`, '@serverLibrary']) },
    });
    // Back: the menu, then out (the power menu: the section's back policy)
    this.screen.onBack(() => {
      if (document.activeElement?.classList.contains('menuItem')) return false;
      (document.querySelector('.menuItem.active') as HTMLElement)?.focus({ preventScroll: true });
      return true;
    });
    this.screen.onSelect(active => {
      if (active.classList.contains('px-card')) this.open(this.cards.get(active.dataset['key']));
    });
    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy():void {
    this.subscriptions.forEach(s => s.unsubscribe());
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  load(focus = true) {
    this.loadError = '';
    this.serverLibrary.home().subscribe({
      next: library => {
        this.build(library);
        this.loaded = true;
        if (focus) setTimeout(() => this.focusInitial(), 0);
        else if (this.spot && !this.cards.has(this.spot.key)) this.spot = null;
      },
      error: () => {
        if (!focus && this.rows.length) return;      // a refresh that failed: keep what shows
        this.loaded = true;
        this.rows = [];
        this.loadError = "Couldn't load what's on the server. Check that the Playpex server is running, then try again.";
        setTimeout(() => this.focusSelector('.serverLibraryPage [data-px-key="retry"]'), 0);
      }
    });
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  private build(library:ServerLibrary) {
    let rows:Row[] = [
      { key: 'recent', title: 'Recently added', cards: library.recent.map(e => this.titleCard('recent', e)) },
      { key: 'movies', title: 'Movies on this server', cards: library.movies.map(e => this.titleCard('movies', e)) },
      { key: 'shows', title: 'Shows on this server', cards: library.shows.map(e => this.titleCard('shows', e)) },
      { key: 'other', title: 'Other videos', cards: library.other.folders.map(f => this.folderCard(f)) },
    ];
    this.rows = rows.filter(r => r.cards.length);
    this.cards.clear();
    this.rows.forEach(r => r.cards.forEach(c => this.cards.set(c.key, c)));
  }

  private titleCard(row:string, entry:ServerLibraryEntry):Card {
    return {
      key: `${row}:${entry.mediaType}:${entry.tmdbId}`,
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: entry.backdropPath,
      entry,
    };
  }

  private folderCard(folder:{ id:string, name:string, count:number }):Card {
    return { key: `folder:${folder.id}`, title: folder.name, posterPath: null, backdropPath: null, folder };
  }

  byRow = (i:number, row:Row) => row.key;
  byCard = (i:number, card:Card) => card.key;

  posterUrl(card:Card):string | null {
    return card.posterPath ? this.posterBase + card.posterPath : null;
  }

  // a folder's poster: how many videos it holds
  badges(card:Card) {
    return card.folder ? [{ text: card.folder.count == 1 ? '1 video' : `${card.folder.count} videos` }] : null;
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  private focusInitial() {
    if (this.isEmpty) {
      this.focusSelector('.serverLibraryPage [data-px-key="browse"]');
      return;
    }
    this.engine.restore(`stack:${STACK}`);
  }

  // The description follows the focused card (scrolling is the rows' job)
  private onFocus(node:HTMLElement) {
    if (!this.screen.active || !node.classList.contains('px-card')) return;
    let card = this.cards.get(node.dataset['key']);
    if (!card) return;
    this.spot = card;
    this.details = card.entry ? this.detailCache.get(this.titleKey(card)) || null : null;
    if (card.entry && !this.details) this.detailRequests.next(card);
    if (card.backdropPath) this.background.sendImage(card.backdropPath);
  }

  private focusSelector(selector:string) {
    (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true });
  }

  // ── the focused card's description ────────────────────────────────────────

  get titleInfo():TitleInfoModel {
    let spot = this.spot;
    if (spot.folder) {
      let n = spot.folder.count;
      return {
        title: spot.folder.name,
        meta: [{ kind: 'chip', text: 'Folder' }, { kind: 'text', text: n == 1 ? '1 video' : `${n} videos`, small: true }],
        overview: 'Videos on this server that aren’t matched to a movie or a show: home videos, clips, files the server couldn’t name.',
      };
    }
    let entry = spot.entry, details = this.details;
    let meta:MetaItem[] = [];
    if (entry.year) meta.push({ kind: 'text', text: String(entry.year) });
    meta.push({ kind: 'chip', text: entry.mediaType == 'tv' ? 'Series' : 'Movie' });
    if (entry.quality) meta.push({ kind: 'chip', text: entry.quality == '2160p' ? '4K' : entry.quality });
    if (details?.length) meta.push({ kind: 'chip', text: details.length });
    if (details?.score) meta.push({ kind: 'score', source: 'tmdb', value: details.score });
    return {
      title: entry.title,
      meta,
      genres: details?.genres || [],
      notes: [this.onServerLine(entry)],
      overview: details?.overview || '',
    };
  }

  // "8 episodes in 2 seasons on this server · newest S02E05 “Title”" / "2 files on this server"
  private onServerLine(entry:ServerLibraryEntry):string {
    let added = `added ${this.relative(entry.addedAt)}`;
    if (entry.mediaType == 'movie') {
      return `${entry.fileCount == 1 ? 'On this server' : `${entry.fileCount} files on this server`}, ${added}`;
    }
    let episodes = entry.episodeCount == 1 ? '1 episode' : `${entry.episodeCount} episodes`;
    let seasons = entry.seasonCount > 1 ? ` in ${entry.seasonCount} seasons` : '';
    let latest = entry.latest ? `; newest S${pad(entry.latest.season)}E${pad(entry.latest.episode)}` +
      (entry.latest.episodeTitle ? ` “${entry.latest.episodeTitle}”` : '') + `, ${added}` : '';
    return `${episodes}${seasons} on this server${latest}`;
  }

  private relative(date:string):string {
    let days = Math.floor((Date.now() - new Date(date).getTime()) / (24 * 3600 * 1000));
    if (days <= 0) return 'today';
    if (days == 1) return 'yesterday';
    if (days < 31) return `${days} days ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return days < 730 ? 'last year' : `${Math.floor(days / 365)} years ago`;
  }

  private titleKey(card:Card):string {
    return `${card.entry?.mediaType}:${card.entry?.tmdbId}`;
  }

  private fetchDetails(card:Card):Observable<Details | null> {
    let entry = card.entry;
    let request = entry.mediaType == 'tv'
      ? this.moviesService.getTvDetails(entry.tmdbId)
      : this.moviesService.getTmdbMovieDetails(entry.tmdbId);
    return request.pipe(
      map(data => {
        let length:string | null = null;
        if (entry.mediaType == 'tv' && data.seasonCount) {
          let n = data.seasonCount;
          length = `${n} ${n == 1 ? 'season' : 'seasons'}`;
        } else if (data.runtime) {
          let h = Math.floor(data.runtime / 60), m = data.runtime % 60;
          length = h ? `${h}h ${m}m` : `${m}m`;
        }
        let overview:string = data.overview || '';
        if (overview.length > OVERVIEW_MAX) overview = overview.slice(0, OVERVIEW_MAX).replace(/\s+\S*$/, '') + '…';
        return { length, score: data.voteAverage || null, genres: (data.genres || []).map(g => g.name), overview };
      }),
      catchError(() => of(null)),      // offline: the header keeps what the server knows
    );
  }

  // ── opening ───────────────────────────────────────────────────────────────

  private open(card:Card | undefined) {
    if (!card) return;
    if (card.folder) {
      this.navigator.open({ screen: 'core.library.folder', params: { id: card.folder.id }, payload: { name: card.folder.name } });
      return;
    }
    this.navigator.open({ screen: card.entry.mediaType == 'tv' ? 'core.show' : 'core.movie', params: { id: card.entry.tmdbId } });
  }
}

function pad(n:number):string {
  return n < 10 ? '0' + n : String(n);
}
