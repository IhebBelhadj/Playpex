import { Component, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { InputDispatcher, Navigator } from '../nav/public-api';

// "Back" for mouse users, top left of the shell under the menu's logo. Shown only while the cursor
// is (`body.pointer-hidden` hides it), on pages there is a "back" from: titles,
// the player, search (it has no menu), the power menu. Not on the picker, the server picker (/connect) and
// the profile editor (full-screen layers with their own Cancel), nor on the
// sections the menu shows next to (movies / TV lists, watch list, 18+): there
// the menu is the way around. A plain (click)
// element outside any nav section, like the row paddles: hovering it doesn't
// move the focus.
//
// It sends 'leave' instead of 'back': Escape steps back inside a page first
// (posters → menu → out), the button leaves the page at once: a title page →
// where it was opened from, search → the power menu, like the last Escape
// there. An open layer (modal, keyboard, PIN pad, filters, editor panels)
// closes first, as with Escape.
@Component({
  selector: 'back-button',
  templateUrl: './back-button.component.html',
  styleUrls: ['./back-button.component.scss']
})
export class BackButtonComponent implements OnDestroy {

  visible = false;
  private sub:Subscription;

  constructor(navigator:Navigator, private dispatcher:InputDispatcher) {
    // the screen's `chrome.backButton`; by default on everything but sections
    // and roots (src/app/nav/screens.ts)
    this.sub = navigator.current$.subscribe(entry => {
      let screen = entry?.screen;
      this.visible = !!screen && (screen.chrome?.backButton ?? (screen.kind != 'section' && screen.kind != 'root'));
    });
  }

  // = the `leave` action: an open layer (modal, panel) closes first
  back() {
    this.dispatcher.dispatch('leave', 'button');
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
