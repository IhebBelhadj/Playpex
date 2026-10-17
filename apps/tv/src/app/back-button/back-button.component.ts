import { Component, OnDestroy } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { MoviesService } from '../movies.service';
import { TorrentPickerService } from '../torrent-picker.service';
import { PlayChoiceService } from '../play-choice.service';
import { ConnectionService } from '../connection.service';

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
// where it was opened from, a section page (movies, TV shows, search, watch
// list, 18+) → the power menu, like the last Escape there. An open panel
// (keyboard, PIN pad, filters, editor panels) closes first, as with Escape.
@Component({
  selector: 'back-button',
  templateUrl: './back-button.component.html',
  styleUrls: ['./back-button.component.scss']
})
export class BackButtonComponent implements OnDestroy {

  visible = false;
  private routeSub:Subscription;

  constructor(
    private router:Router,
    private navigation:NavigationService,
    private moviesService:MoviesService,
    private torrentPicker:TorrentPickerService,
    private playChoice:PlayChoiceService,
    private connection:ConnectionService,
  ) {
    this.routeSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(e => this.visible = this.showsOn(e.urlAfterRedirects));
  }

  private showsOn(url:string) {
    let path = url.split('?')[0];
    return path != '/' && !path.startsWith('/profiles') && path != '/connect'
      && !['/watchlist', '/adult', '/adult/browse', '/adult/releases'].includes(path)
      // release lists: their own "Back to <title>" in the rail
      && !path.startsWith('/releases/')
      && !this.moviesService.catalogForUrl(path);
  }

  back() {
    // the modals take Escape too (AppComponent); same here
    let modal = this.connection.isOpen ? this.connection
      : this.torrentPicker.isOpen ? this.torrentPicker : this.playChoice.isOpen ? this.playChoice : null;
    if (modal) modal.sendCommand('back');
    else this.navigation.addCommand('leave');
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
  }
}
