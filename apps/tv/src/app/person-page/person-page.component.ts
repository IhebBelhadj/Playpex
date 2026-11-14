import { BACK_TICKET, BackTicket } from '../back-button/back-button.component';
import { formatDate } from '@angular/common';
import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, catchError, of } from 'rxjs';
import { BackgroundService } from '../background.service';
import { CatalogPerson, CatalogPersonCredit, CatalogPersonDetails, MoviesService, displayTitle } from '../movies.service';
import { FocusEngine } from '../movement/movement';
import { NavigationService } from '../navigation.service';
import { Navigator, useScreen } from '../nav/public-api';
import { ServerLibraryService } from '../server-library.service';
import { Badge, tmdbImageBase } from '../ui/public-api';

// What opens a person's page: their id, and what the card that opened it
// already knows (name, picture), shown while the page loads
export interface PersonPayload {
  name?:string;
  profilePath?:string | null;
}

interface PersonCard {
  key:string;
  credit:CatalogPersonCredit;
  title:string;
  subtitle:string;
  upcoming:boolean;
  badges:Badge[] | null;
}

interface PersonRow {
  key:string;
  title:string;
  cards:PersonCard[];
}

// The order crew departments would have with as many titles each
const DEPARTMENTS = ['Directing', 'Writing', 'Creator', 'Production', 'Sound', 'Camera', 'Editing', 'Art', 'Costume & Make-Up', 'Visual Effects', 'Crew', 'Lighting'];

// A person's page (docs/people-plan.md §4): screen `core.person`, path
// people/:id, reached from every Cast / Guest stars card and from search.
// Their portrait, name, department, birth (and death), the biography (four
// lines; "Biography" shows all of it), then rows: Known for, Movies and TV
// shows as cast (newest first, upcoming ones first and dimmed), one row per
// crew department. Enter on a title opens its page over this one; Back comes
// back to the same card (the navigator's focus snapshot). Movement: the
// layout is a scrolling pxStack (`person`): the biography's tile, the rows.
@Component({
  selector: 'app-person-page',
  templateUrl: './person-page.component.html',
  styleUrls: ['./person-page.component.scss'],
})
export class PersonPageComponent implements OnInit, AfterViewInit, OnDestroy {

  profileBase = tmdbImageBase('profile', 260);
  posterBase = tmdbImageBase('poster', 150);

  name = '';
  profilePath:string | null = null;
  person:CatalogPersonDetails | null = null;
  rows:PersonRow[] = [];
  loading = false;
  error = '';
  biographyOpen = false;
  paragraphs:string[] = [];

  private screen = useScreen<{ id:string }, PersonPayload>();
  private onServer = new Set<string>();
  private subs:Subscription[] = [];
  private loadSub:Subscription | null = null;
  private today = new Date().toISOString().slice(0, 10);

  constructor(
    readonly navigator:Navigator,
    private movies:MoviesService,
    private background:BackgroundService,
    private serverLibrary:ServerLibraryService,
    private engine:FocusEngine,
    private navigation:NavigationService,
  ) { }

  // the menu's section, with Right back into this page: the title pages remove
  // theirs when they close, and without it neither Left nor the mouse reach the menu
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target(['stack:person', '@personPage']) },
    });
  }

  ngOnInit(): void {
    this.subs.push(this.screen.params$.subscribe(params => this.load(params.id)));
    // "On this server" marks: what the server's library holds, once
    this.subs.push(this.serverLibrary.home().pipe(catchError(() => of(null))).subscribe(library => {
      if (!library) return;
      this.onServer = new Set([...library.movies, ...library.shows].map(e => `${e.mediaType}:${e.tmdbId}`));
      if (this.person) this.build(this.person);
    }));
  }

  ngOnDestroy(): void {
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
    this.subs.forEach(s => s.unsubscribe());
    this.loadSub?.unsubscribe();
  }

  load(id = String(this.screen.params.id)) {
    let payload = this.screen.payload;
    if (!this.person || String(this.person.personId) != id) {
      this.person = null;
      this.rows = [];
      this.name = payload?.name || '';
      this.profilePath = payload?.profilePath || null;
    }
    this.error = '';
    this.loading = true;
    this.loadSub?.unsubscribe();
    this.loadSub = this.movies.getPerson(id).subscribe({
      next: person => {
        this.loading = false;
        this.person = person;
        this.name = person.name;
        this.profilePath = person.profilePath || this.profilePath;
        this.screen.setState(BACK_TICKET, { name: person.name, image: person.profilePath || null, kind: 'profile' } as BackTicket);
        this.paragraphs = person.biography.split(/\n+/).map(p => p.trim()).filter(Boolean);
        this.build(person);
        let best = person.knownFor.map(tmdbId => person.credits.find(c => c.tmdbId == tmdbId && c.backdropPath)).find(Boolean)
          || person.credits.find(c => c.backdropPath);
        if (best) this.background.sendImage(best.backdropPath);
        setTimeout(() => {
          if (!this.screen.ready()) this.focusFirst();
        }, 0);
      },
      error: () => {
        this.loading = false;
        this.error = `Couldn't load ${this.name ? this.name + '\'s' : 'this person\'s'} page`;
        setTimeout(() => this.focusKey('retry'), 0);
      },
    });
  }

  // ── the header ────────────────────────────────────────────────────────────

  get lifespan():string {
    let p = this.person;
    if (!p?.deathday) return '';
    return (p.birthday ? p.birthday.slice(0, 4) : '?') + ' – ' + p.deathday.slice(0, 4);
  }

  get line():string {
    let p = this.person;
    if (!p) return '';
    let parts:string[] = [];
    if (p.knownForDepartment) parts.push(p.knownForDepartment);
    if (p.birthday && !p.deathday) {
      parts.push('Born ' + this.day(p.birthday) + (p.placeOfBirth ? ' in ' + p.placeOfBirth : ''));
    } else if (p.birthday) {
      parts.push(this.day(p.birthday) + ' – ' + this.day(p.deathday) + (p.placeOfBirth ? ' · ' + p.placeOfBirth : ''));
    } else if (p.placeOfBirth) {
      parts.push('From ' + p.placeOfBirth);
    }
    return parts.join(' · ');
  }

  // the biography doesn't fit in its four lines: a tile shows all of it
  get longBiography():boolean {
    let bio = this.person?.biography || '';
    return bio.length > 420 || this.paragraphs.length > 2;
  }

  openBiography() {
    this.biographyOpen = true;
  }

  // ── the rows ──────────────────────────────────────────────────────────────

  private build(person:CatalogPersonDetails) {
    let credits = person.credits;
    let cast = credits.filter(c => c.roles.some(r => !r.job));
    let rows:PersonRow[] = [];
    let known = person.knownFor.map(id => credits.find(c => c.tmdbId == id)).filter(Boolean);
    if (known.length) {
      rows.push({ key: 'known', title: 'Known for', cards: known.map(c => this.card(c, 'known', true)) });
    }
    let movies = this.newestFirst(cast.filter(c => c.mediaType == 'movie'));
    if (movies.length) rows.push({ key: 'movies', title: 'Movies', cards: movies.map(c => this.card(c, 'cast')) });
    let shows = this.newestFirst(cast.filter(c => c.mediaType == 'tv'));
    if (shows.length) rows.push({ key: 'shows', title: 'TV shows', cards: shows.map(c => this.card(c, 'cast')) });

    // one row per crew department, the one with the most titles first
    let departments = new Map<string, CatalogPersonCredit[]>();
    credits.forEach(c => {
      let seen = new Set<string>();
      c.roles.filter(r => r.job).forEach(r => {
        let department = r.department || 'Crew';
        if (seen.has(department)) return;
        seen.add(department);
        departments.set(department, (departments.get(department) || []).concat(c));
      });
    });
    Array.from(departments.entries())
      .sort((a, b) => b[1].length - a[1].length || this.departmentOrder(a[0]) - this.departmentOrder(b[0]))
      .forEach(([department, list]) => rows.push({
        key: 'crew:' + department,
        title: department,
        cards: this.newestFirst(list).map(c => this.card(c, department, false)),
      }));
    this.rows = rows;
  }

  private departmentOrder(name:string):number {
    let i = DEPARTMENTS.indexOf(name);
    return i == -1 ? DEPARTMENTS.length : i;
  }

  // newest first; not out yet (or no date) before them; titles without a poster last
  private newestFirst(list:CatalogPersonCredit[]):CatalogPersonCredit[] {
    let pictured = list.filter(c => c.posterPath),
      upcoming = pictured.filter(c => this.upcoming(c)),
      out = pictured.filter(c => !this.upcoming(c));
    upcoming.sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999'));
    out.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
    return upcoming.concat(out, list.filter(c => !c.posterPath));
  }

  private upcoming(c:CatalogPersonCredit):boolean {
    return !c.releaseDate || c.releaseDate > this.today;
  }

  // role: 'known', 'cast' or a crew department (its jobs as the subtitle)
  private card(c:CatalogPersonCredit, role:string, mixed = false):PersonCard {
    let upcoming = this.upcoming(c);
    let subtitle = '';
    if (role == 'cast' || role == 'known') {
      let characters = c.roles.filter(r => !r.job && r.character).map(r => r.character);
      if (characters.length && role == 'cast') subtitle = 'as ' + characters.join(', ');
      if (role == 'cast' && c.mediaType == 'tv' && c.episodeCount) {
        subtitle += (subtitle ? ' · ' : '') + c.episodeCount + (c.episodeCount == 1 ? ' episode' : ' episodes');
      }
    } else {
      subtitle = c.roles.filter(r => r.job && (r.department || 'Crew') == role).map(r => r.job).join(', ');
    }
    if (upcoming) {
      let year = c.releaseDate?.slice(0, 4);
      subtitle = year ? 'Coming ' + year : 'Coming soon';
    } else if (!subtitle) {
      subtitle = c.year || '';
    }
    let badges:Badge[] = [];
    if (mixed && c.mediaType == 'tv') badges.push('tv');
    if (this.onServer.has(`${c.mediaType}:${c.tmdbId}`)) badges.push('server');
    return {
      key: `${c.mediaType}:${c.tmdbId}`,
      credit: c,
      title: displayTitle(c),
      subtitle,
      upcoming,
      badges: badges.length ? badges : null,
    };
  }

  open(card:PersonCard) {
    let c = card.credit;
    this.navigator.open({ screen: c.mediaType == 'movie' ? 'core.movie' : 'core.show', params: { id: String(c.tmdbId) }, payload: c });
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  private focusFirst() {
    // their titles first (Up: the Biography tile)
    let first = (document.querySelector('.personPage .row [data-px-item]') || document.querySelector('.personPage [data-px-item]')) as HTMLElement;
    first?.focus({ preventScroll: true });
  }

  private focusKey(key:string) {
    (document.querySelector(`.personPage [data-px-key="${key}"] [data-px-item], .personPage [data-px-key="${key}"][data-px-item]`) as HTMLElement)
      ?.focus({ preventScroll: true });
  }

  private day(value:string):string {
    try {
      return formatDate(value, 'd MMMM y', 'en-US');
    } catch {
      return value;
    }
  }

  byRow = (i:number, row:PersonRow) => row.key;
  byCard = (i:number, card:PersonCard) => card.key;
}

// a person result or a cast / guest-star card → the payload the page shows while it loads
export function personPayload(p:Pick<CatalogPerson, 'name' | 'profilePath'>):PersonPayload {
  return { name: p.name, profilePath: p.profilePath };
}
