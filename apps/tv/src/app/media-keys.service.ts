import { Injectable, NgZone } from '@angular/core';
import { filter, Observable, Subject } from 'rxjs';
import { actionForKey, isMediaAction, MediaAction } from './keymap';
import { LayerStack } from './nav/public-api';

// Media keys of remotes and keyboards (docs/ui-system-plan.md §13.2): turned
// into MediaActions for the screen shown. The player also registers a Media
// Session (hardware keys Chromium routes there, the OS media overlay) and
// sends its actions through `emit`, so a page handles one stream.
//
//   this.mediaKeys.for(this.screen).subscribe(action => …)   only while that screen owns the input
@Injectable({
  providedIn: 'root'
})
export class MediaKeys {

  private actions = new Subject<MediaAction>();
  private installed = false;

  constructor(private zone:NgZone, private layers:LayerStack) { }

  // AppComponent, once
  init() {
    if (this.installed) return;
    this.installed = true;
    document.addEventListener('keydown', e => {
      let action = actionForKey(e);
      if (!isMediaAction(action)) return;
      e.preventDefault();
      this.zone.run(() => this.actions.next(action as MediaAction));
    });
  }

  emit(action:MediaAction) {
    this.zone.run(() => this.actions.next(action));
  }

  /** The actions while `screen` is shown and no layer is open over it */
  for(screen:{ active:boolean }):Observable<MediaAction> {
    return this.actions.pipe(filter(() => screen.active && !this.layers.top));
  }
}
