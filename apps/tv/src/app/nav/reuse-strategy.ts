import { Inject, Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';
import { SCREEN_KEY, SCREEN_REGISTRY, ScreenRegistry } from './screen-registry';

// One component per history entry: Angular would keep a screen's component
// when only its params change (similar movie → similar movie), so a Back to
// the previous movie would find the second one's rows and positions. A screen
// is re-created for other params unless it declares `reuse` (the episode
// page: another episode of the season only swaps the episode, its ScreenRef's
// `entry$` emits). Frames stay (same params).
@Injectable()
export class NavReuseStrategy extends BaseRouteReuseStrategy {

  constructor(@Inject(SCREEN_REGISTRY) private registry:ScreenRegistry) {
    super();
  }

  override shouldReuseRoute(future:ActivatedRouteSnapshot, curr:ActivatedRouteSnapshot):boolean {
    if (future.routeConfig !== curr.routeConfig) return false;
    let id = future.data?.[SCREEN_KEY];
    if (!id || !this.registry.has(id) || this.registry.get(id).reuse) return true;
    return sameParams(future.params, curr.params);
  }
}

function sameParams(a:Record<string, any>, b:Record<string, any>):boolean {
  let keys = Array.from(new Set([...Object.keys(a || {}), ...Object.keys(b || {})]));
  return keys.every(key => a?.[key] === b?.[key]);
}
