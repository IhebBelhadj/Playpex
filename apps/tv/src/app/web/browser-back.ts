import { Location } from '@angular/common';
import { Injector, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { InputDispatcher } from '../nav/input-dispatcher.service';
import { LayerStack } from '../nav/layer-stack.service';
import { Navigator } from '../nav/navigator.service';
import { isWeb } from './web-client';

// The browser's own Back (its arrow, Alt+Left, a mouse's back button) is the
// app's Back, like YouTube's TV app in a browser (docs/web-client-plan.md
// §5.4). The navigator never grows the browser's history (every screen
// replaces the entry), so that Back used to leave the page for whatever was
// loaded before in the tab: a fresh load, "Who's watching?".
//
// So the app lives on two entries of the tab's history: a base one and a
// spare one above it, the one shown. The browser's Back lands on the base
// entry: it's taken here, before the router sees it, the spare one is put
// back and the app goes back (a panel closes, an in-page step, the previous
// screen). At the bottom of the history the browser's Back leaves the app.

const BASE = 'pxBase';

let onBack:((e:PopStateEvent) => void) | null = null;

// main.ts, before Angular starts: first in line for `popstate`, so the
// router (Angular's Location listens from when it's created) never sees one
export function listenBrowserBack() {
  if (!isWeb) return;
  window.addEventListener('popstate', e => {
    if (!onBack) return;
    e.stopImmediatePropagation();
    onBack(e);
  });
}

export function browserBack(injector:Injector):() => void {
  return () => {
    if (!isWeb) return;
    let navigator = injector.get(Navigator);
    let layers = injector.get(LayerStack);
    let dispatcher = injector.get(InputDispatcher);
    let router = injector.get(Router);
    let location = injector.get(Location);
    let zone = injector.get(NgZone);

    let here = () => location.prepareExternalUrl(router.url || location.path());
    // a reload happens on the spare entry (the router's state is on it): the
    // base entry is still below, one per reload would pile up
    let reloaded = history.state?.navigationId !== undefined;
    try {
      if (!reloaded) {
        history.replaceState({ [BASE]: true }, '', location.prepareExternalUrl(location.path()));
        history.pushState(null, '', location.prepareExternalUrl(location.path()));
      }
    } catch (e) {
      return;
    }

    // (listened to before Angular: brought into its zone to update the screen)
    // Every `popstate` here is a Back: the spare entry is pushed again after
    // each one, which drops any Forward. Not only onto the base entry: a tab
    // may hold the app's older entries below (other builds, before a
    // reload), and one of those becomes the base now. (Ignoring them showed
    // their address with the screen unchanged)
    onBack = () => zone.run(() => {
      // the bottom of the app's history: out of the app, as a browser does
      if (!layers.top && !navigator.canGoBack()) {
        history.back();
        return;
      }
      // the spare entry again, at the screen shown now, then the app's Back
      history.replaceState({ [BASE]: true }, '', here());
      history.pushState(null, '', here());
      dispatcher.dispatch('back', 'key');
    });
  };
}
