import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { catchError, debounceTime, map, Observable, of, Subject, Subscription, switchMap } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { FocusEngine } from '../movement/movement';
import { BackgroundService } from '../background.service';
import { MoviesService } from '../movies.service';
import { ContinueItem, Library, LibraryService, MediaType, WatchedItem, WatchlistItem } from '../library.service';
import { Navigator, useScreen } from '../nav/public-api';

interface Card {
  key: string;                   // unique on the page: <row>:<mediaType>:<tmdbId>
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  meta: string;                  // the line next to the kind tag in the description area
  progress?: number;             // 0..1 — Continue watching rows only
}

// One row, like a category on the movies page
interface Row {
  key: string;                   // data-row, used for up/down between rows
  title: string;
  cards: Card[];
}

// What the description shows from TMDB for the focused title
interface Details {
  year: string | null;
  length: string | null;         // "2h 46m" for movies, "3 seasons" for shows
  score: number | null;          // TMDB vote average
  genres: string[];
  overview: string;
}

const DAY = 24 * 60 * 60 * 1000;
const OVERVIEW_MAX = 230;
const STACK = 'watchlist';      // the rows' pxStack: the focused card is remembered under this id

// /watchlist — the current profile's library, laid out like the movies page:
// a description of the focused title on top, category-style rows below.
//   Continue watching series / movies (most recently watched kind first)
//   My list
//   Watched this week / this month / earlier
// Empty rows are left out. Enter opens the title's page; Back goes to the menu, then home.
// Rows scroll natively (pxStack / pxRow, src/app/movement): the focused row
// at the top, the focused poster at its row's start; the card is remembered
// for the way back.
@Component({
  selector: 'app-watchlist-page',
  templateUrl: './watchlist-page.component.html',
  styleUrls: ['./watchlist-page.component.scss']
})
export class WatchlistPageComponent implements OnInit, AfterViewInit, OnDestroy {

  readonly posterBase = 'https://image.tmdb.org/t/p/w342';

  rows:Row[] = [];
  loaded = false;
  loadError = '';
  spot:Card | null = null;
  details:Details | null = null;      // TMDB details of `spot`, once loaded

  private detailCache = new Map<string, Details>();
  private detailRequests = new Subject<Card>();
  private detailSub:Subscription;

  private cards = new Map<string, Card>();
  private focusListener;
  private screen = useScreen();

  constructor(
    private library:LibraryService,
    private navigation:NavigationService,
    private background:BackgroundService,
    private moviesService:MoviesService,
    private navigator:Navigator,
    private engine:FocusEngine,
  ) { }

  get isEmpty():boolean {
    return this.loaded && !this.loadError && !this.rows.length;
  }

  ngOnInit(): void {
    this.load();

    // Details of the focused title; moving along a row only fetches where focus rests
    this.detailSub = this.detailRequests.pipe(
      debounceTime(150),
      switchMap(card => this.fetchDetails(card).pipe(map(details => ({ card, details })))),
    ).subscribe(({ card, details }) => {
      if (details) this.detailCache.set(this.titleKey(card), details);
      if (this.spot && this.titleKey(this.spot) == this.titleKey(card)) this.details = details;
    });
  }

  // Section `library` is a pxSection in the template
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target([`stack:${STACK}`, '@library']) },
    });

    // Back: the menu, then out (the power menu: the section's back policy)
    this.screen.onBack(() => {
      if (document.activeElement?.classList.contains('menuItem')) return false;
      (document.querySelector('.menuItem.active') as HTMLElement)?.focus({ preventScroll: true });
      return true;
    });
    this.screen.onSelect(active => {
      if (active.classList.contains('card')) this.open(this.cards.get(active.dataset['key']));
      else if (active.classList.contains('browseBtn')) this.navigator.switchSection('core.movies');
      else if (active.classList.contains('retryBtn')) this.load();
    });

    this.focusListener = (e) => this.onFocus(e.target as HTMLElement);
    window.addEventListener('sn:focused', this.focusListener);
  }

  ngOnDestroy(): void {
    this.detailSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  load() {
    this.loadError = '';
    this.library.library().subscribe({
      next: lib => {
        this.build(lib);
        this.loaded = true;
        setTimeout(() => this.focusInitial(), 0);
      },
      error: () => {
        this.loaded = true;
        this.rows = [];
        this.loadError = "Couldn't load your watch list. Check that the Playpex server is running, then try again.";
        setTimeout(() => this.focusSelector('.libraryPage .retryBtn'), 0);
      }
    });
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  private build(lib:Library) {
    let continueCards = lib.continueWatching.map(item => this.continueCard(item));
    // the kind watched most recently comes first (the list is newest first)
    let kinds = Array.from(new Set(continueCards.map(c => c.mediaType)));
    let watchedCards = lib.watched.map(item => this.watchedCard(item));

    let rows:Row[] = [
      ...kinds.map(kind => ({
        key: `continue-${kind}`,
        title: kind == 'tv' ? 'Continue watching series' : 'Continue watching movies',
        cards: continueCards.filter(c => c.mediaType == kind),
      })),
      { key: 'saved', title: 'My list', cards: lib.watchlist.map(item => this.savedCard(item)) },
      ...['this week', 'this month', 'earlier'].map(period => ({
        key: `watched-${period.replace(' ', '-')}`,
        title: `Watched ${period}`,
        cards: watchedCards.filter((c, i) => this.period(lib.watched[i].watchedAt) == period),
      })),
    ];
    this.rows = rows.filter(r => r.cards.length);
    this.cards.clear();
    this.rows.forEach(r => r.cards.forEach(c => this.cards.set(c.key, c)));
  }

  private continueCard(item:ContinueItem):Card {
    let left = Math.max(1, Math.round((item.durationS - item.positionS) / 60));
    let episode = `S${item.season} E${item.episode}`;
    return {
      key: `continue:${item.mediaType}:${item.tmdbId}`,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title || 'Untitled',
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      meta: item.kind == 'next'
        ? `Up next after ${episode}`
        : item.mediaType == 'tv' ? `${episode}, ${left} min left` : `${left} min left`,
      progress: item.kind == 'resume' ? item.ratio : 0,
    };
  }

  private savedCard(item:WatchlistItem):Card {
    return {
      key: `saved:${item.mediaType}:${item.tmdbId}`,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title || 'Untitled',
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      meta: `Added ${this.relative(item.addedAt)}`,
    };
  }

  private watchedCard(item:WatchedItem):Card {
    let when = this.relative(item.watchedAt);
    let count = item.episodesWatched || 0;
    return {
      key: `watched:${item.mediaType}:${item.tmdbId}`,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title || 'Untitled',
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      meta: item.mediaType == 'tv'
        ? `${count} ${count == 1 ? 'episode' : 'episodes'} watched, last S${item.season} E${item.episode} ${when}`
        : `Watched ${when}`,
    };
  }

  private period(date:string):string {
    let age = Date.now() - new Date(date).getTime();
    if (age < 7 * DAY) return 'this week';
    if (age < 31 * DAY) return 'this month';
    return 'earlier';
  }

  private relative(date:string):string {
    let then = new Date(date), now = new Date();
    let days = Math.floor((new Date(now.toDateString()).getTime() - new Date(then.toDateString()).getTime()) / DAY);
    if (days <= 0) return 'today';
    if (days == 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 14) return 'last week';
    if (days < 31) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 60) return 'last month';
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return days < 730 ? 'last year' : `${Math.floor(days / 365)} years ago`;
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  // The remembered card (back from a title page), else the first one
  private focusInitial() {
    if (this.isEmpty) {
      this.focusSelector('.libraryPage .browseBtn');
      return;
    }
    this.engine.restore(`stack:${STACK}`);
  }

  // The description follows the focused card (scrolling is the rows' job)
  private onFocus(node:HTMLElement) {
    if (!this.screen.active || !node.classList.contains('card')) return;
    let card = this.cards.get(node.dataset['key']);
    if (!card) return;

    this.spot = card;
    this.details = this.detailCache.get(this.titleKey(card)) || null;
    if (!this.details) this.detailRequests.next(card);
    if (card.backdropPath) this.background.sendImage(card.backdropPath);
  }

  private focusSelector(selector:string) {
    (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true });
  }

  // ── TMDB details ──────────────────────────────────────────────────────────

  private titleKey(card:Card):string {
    return `${card.mediaType}:${card.tmdbId}`;
  }

  private fetchDetails(card:Card):Observable<Details | null> {
    let request = card.mediaType == 'tv'
      ? this.moviesService.getTvDetails(card.tmdbId)
      : this.moviesService.getTmdbMovieDetails(card.tmdbId);
    return request.pipe(
      map(data => this.toDetails(card, data)),
      catchError(() => of(null)),      // offline: the header keeps title and progress
    );
  }

  private toDetails(card:Card, data:any):Details {
    let date:string = data['release_date'] || data['first_air_date'] || '';
    let length:string | null = null;
    if (card.mediaType == 'tv' && data['number_of_seasons']) {
      let n = data['number_of_seasons'];
      length = `${n} ${n == 1 ? 'season' : 'seasons'}`;
    } else if (data['runtime']) {
      let h = Math.floor(data['runtime'] / 60), m = data['runtime'] % 60;
      length = h ? `${h}h ${m}m` : `${m}m`;
    }
    let overview:string = data['overview'] || '';
    if (overview.length > OVERVIEW_MAX) overview = overview.slice(0, OVERVIEW_MAX).replace(/\s+\S*$/, '') + '…';
    return {
      year: date ? date.slice(0, 4) : null,
      length,
      score: data['vote_average'] || null,
      genres: (data['genres'] || []).map(g => g['name']),
      overview,
    };
  }

  posterUrl(card:Card):string | null {
    return card.posterPath ? this.posterBase + card.posterPath : null;
  }

  // ── opening a title ───────────────────────────────────────────────────────

  // Its page, over this one (the movie page loads the movie's details)
  private open(card:Card | undefined) {
    if (!card) return;
    this.navigator.open({ screen: card.mediaType == 'tv' ? 'core.show' : 'core.movie', params: { id: card.tmdbId } });
  }
}
