import { Directive, OnDestroy } from '@angular/core';
import { filter, Subscription } from 'rxjs';
import { useScreen } from '../../nav/public-api';
import { PluginClient } from '../plugin-client.service';
import { PLUGIN_SCOPE, PLUGIN_SCREEN, PluginScope, PluginScreenDecl } from '../plugin-models';

// What every template screen shares: which plugin and which of its screens
// it shows (route data set by plugins/remote.ts), its params, the call to its
// data handler, and `refresh` effects (the plugin's or a settings change)
// loading it again while it's shown.
@Directive()
export abstract class PluginScreen implements OnDestroy {

  protected screen = useScreen<Record<string, string>>();
  readonly scope:PluginScope = this.screen.route.snapshot.data[PLUGIN_SCOPE];
  readonly decl:PluginScreenDecl = this.screen.route.snapshot.data[PLUGIN_SCREEN];
  protected subs:Subscription[] = [];

  constructor(protected client:PluginClient) {
    this.subs.push(this.client.refresh$.pipe(
      filter(r => r.plugin == this.scope.id && (r.target == 'screen' || r.target == '*')),
    ).subscribe(() => this.refresh()));
  }

  /** The screen's path params, as the manifest names them */
  get params():Record<string, string> {
    return { ...(this.screen.route.snapshot.params || {}), ...(this.screen.params || {}) };
  }

  /** Its own state in the history entry (kept while it's in the stack: Back finds it) */
  protected kept<T>(init:() => T):T {
    return this.screen.state('plugin', init);
  }

  /** Load again (refresh effects, a settings change) */
  protected abstract refresh():void;

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }
}
