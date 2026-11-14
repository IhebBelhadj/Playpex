import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { combineLatest, Subscription } from 'rxjs';
import { displayTitle } from '../movies.service';
import { Entry, InputDispatcher, LayerStack, Navigator } from '../nav/public-api';
import { DESIGN_PX_PER_REM, tmdbImageBase } from '../ui/public-api';

// the button's height in design pixels (its stylesheet's $size)
const BUTTON_DP = 44;

// Where Back lands: what the button shows (a picture of it and its name)
export interface BackDestination {
  // "Breaking Bad", "Search", "Close"
  name:string;
  // a TMDB poster / profile path, a full URL, or none
  image:string | null;
  // a core icon (assets/icons) when there's no picture
  icon:string | null;
  // "Back to" above the name; empty for Close and a bare Back
  lead:string;
}

// What a page leaves in its own history entry once loaded (ScreenRef.setState),
// so the Back button over the page above it can show it: `image` a TMDB path
export const BACK_TICKET = 'backTicket';
export interface BackTicket {
  name:string;
  image:string | null;
  kind:'poster' | 'profile';
}

const BARE:BackDestination = { name: 'Back', image: null, icon: null, lead: '' };

// "Back" for mouse users, top right of the shell, just left of the clock (an
// empty corner of backdrop on every page: it never covers the menu, a title or
// the rows). Shown only while the cursor
// is (`body.pointer-hidden` hides it), on pages there is a "back" from: titles,
// the player, search (it has no menu), the power menu. Not on the picker, the server picker (/connect) and
// the profile editor (full-screen layers with their own Cancel), nor on the
// sections the menu shows next to (movies / TV lists, watch list, plugins' sections): there
// the menu is the way around. A plain (click)
// element outside any nav section, like the row paddles: hovering it doesn't
// move the focus.
//
// A return ticket: a capsule that says where Back lands, "Back to Breaking
// Bad" beside a round picture of it (the title below in the history, a
// person's face) darkened under the chevron; dark glass at rest, white (the
// app's focus) hovered; "Close" while a layer is open. Placed from the clock's
// measured box (`place()`), so it follows the clock's width and the UI scale.
// Pages leave their ticket in their entry state (BACK_TICKET).
//
// It sends 'leave' instead of 'back': Escape steps back inside a page first
// (posters → menu → out), the button leaves the page at once: a title page →
// where it was opened from, search → the power menu, like the last Escape
// there. An open layer (modal, keyboard, PIN pad, filters, editor panels)
// closes first, as with Escape.
@Component({
  selector: 'back-button',
  templateUrl: './back-button.component.html',
  styleUrls: ['./back-button.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackButtonComponent implements AfterViewInit, OnDestroy {

  visible = false;
  // beside the clock: px from the window's right and top (measured)
  right:number | null = null;
  top:number | null = null;
  private clockObserver:ResizeObserver | null = null;
  private onResize = () => this.place();
  destination:BackDestination = BARE;
  private posterBase = tmdbImageBase('poster', 44);
  private profileBase = tmdbImageBase('profile', 44);
  private sub:Subscription;

  constructor(navigator:Navigator, layers:LayerStack, private dispatcher:InputDispatcher, private cd:ChangeDetectorRef) {
    // the screen's `chrome.backButton`; by default on everything but sections
    // and roots (src/app/nav/screens.ts)
    this.sub = combineLatest([navigator.stack$, layers.layers$]).subscribe(([stack, open]) => {
      let screen = stack[stack.length - 1]?.screen;
      this.visible = !!screen && (screen.chrome?.backButton ?? (screen.kind != 'section' && screen.kind != 'root'));
      this.destination = open.length ? { name: 'Close', image: null, icon: null, lead: '' } : backDestination(stack[stack.length - 2]);
      cd.markForCheck();
      if (this.visible) setTimeout(() => this.place());
    });
  }

  ngAfterViewInit(): void {
    let clock = document.querySelector('clock.clock');
    if (clock && 'ResizeObserver' in window) {
      this.clockObserver = new ResizeObserver(this.onResize);
      this.clockObserver.observe(clock);
    }
    window.addEventListener('resize', this.onResize);
    this.place();
  }

  // the clock's left edge, a gap, then the ticket, centred on the clock's line
  place() {
    let clock = document.querySelector('clock.clock') as HTMLElement | null;
    if (!clock) return;
    let box = clock.getBoundingClientRect();
    let rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || DESIGN_PX_PER_REM;
    let height = BUTTON_DP * rem / DESIGN_PX_PER_REM, gap = 16 * rem / DESIGN_PX_PER_REM;
    // the clock hidden (no box): the corner itself
    let right = Math.round(box.width ? window.innerWidth - box.left + gap : 2 * gap);
    let top = Math.round(box.height ? box.top + box.height / 2 - height / 2 : gap);
    if (right === this.right && top === this.top) return;
    this.right = right;
    this.top = top;
    this.cd.markForCheck();
  }

  get picture():string | null {
    let d = this.destination;
    if (d.image) return /^https?:|^assets\//.test(d.image) ? d.image : (d.icon == 'person' ? this.profileBase : this.posterBase) + d.image;
    return null;
  }

  // = the `leave` action: an open layer (modal, panel) closes first
  back() {
    this.dispatcher.dispatch('leave', 'button');
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.clockObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
  }
}

// What the entry below the current one is, in words and a picture
export function backDestination(below:Entry | undefined):BackDestination {
  if (!below) return BARE;
  let screen = below.screen;
  let payload = (below.payload || {}) as Record<string, any>;
  let params = below.params || {};
  let to = (name:string, image:string | null = null, icon:string | null = null):BackDestination =>
    name ? { name, image, icon, lead: 'Back to' } : BARE;
  // what the page said about itself once it had loaded
  let ticket = below.state?.[BACK_TICKET] as BackTicket | undefined;
  if (ticket?.name) return to(ticket.name, ticket.image, ticket.kind == 'profile' ? 'person' : null);
  switch (screen.id) {
    case 'core.movie':
    case 'core.show':
      return to(displayTitle(payload) || (screen.id == 'core.movie' ? 'the movie' : 'the show'), payload['posterPath'] || null, screen.id == 'core.movie' ? 'film' : 'tv');
    case 'core.episode':
      return to(`Season ${params['season']} · Episode ${params['episode']}`, null, 'tv');
    case 'core.person':
      return to(payload['name'] || 'their page', payload['profilePath'] || null, 'person');
    case 'core.library.folder':
      return to(payload['name'] || 'the folder', null, 'folder');
    case 'core.player':
      return to('the player', null, 'play');
    case 'core.releases.movies':
    case 'core.releases.shows':
      return to('the releases', null, 'search');
  }
  if (screen.menu) return to(screen.menu.label, null, screen.menu.icon || null);
  return BARE;
}
