import { HttpClient } from '@angular/common/http';
import { Injectable, Type } from '@angular/core';
import { Router } from '@angular/router';
import {
  BehaviorSubject, catchError, debounceTime, distinctUntilChanged, filter, map, merge, Observable, of, startWith, switchMap,
} from 'rxjs';
import { appRoutes } from '../app-routes';
import { Navigator, SCREENS } from '../nav/public-api';
import { ProfilesService } from '../profiles.service';
import { ServerEvents } from '../server-events.service';
import { ServerService } from '../server.service';
import { CONTRIBUTIONS, defineContribution, SlotKind, SlotName, SLOTS } from '../ui/public-api';
import { PluginClient } from './plugin-client.service';
import { PluginNotifications } from './plugin-notifications.service';
import { ClientPlugin, PLUGIN_SCOPE, PLUGIN_SCREEN, PluginAction, PluginMetaItem, PluginRow, PluginScope } from './plugin-models';
import { PluginCatalogComponent } from './templates/plugin-catalog.component';
import { PluginListComponent } from './templates/plugin-list.component';
import { PluginReleasesComponent } from './templates/plugin-releases.component';
import { PluginTitleComponent } from './templates/plugin-title.component';

// The remote plugin adapter (docs/plugins-plan.md §5.5, step P1): what the
// server's plugins contribute, defined with the core's own registries.
//
//   GET <api>/plugins?profile=   on a profile change and on `plugin.changed`
//   screens                      defineScreen: plugin.<id>.<name>, path p/<id>/<name>[/:param…],
//                                the template's component, `section` when a menu entry opens it
//   sections                     the screen's menu entry (icon: an asset of the package)
//   slots                        defineContribution: models from its data handler, asked with
//                                { slot, context } (the slot's context without the profile)
//
// A plugin that's gone (removed, disabled, another profile) is undefined: its
// contributions removed, its screens dropped from the registry and the
// router's table rebuilt; a history holding one of its screens starts over on
// Movies. Adults plugins: their screens need the `adults` requirement, their
// menu entries and contributions are never offered to kids profiles.
const TEMPLATES:Record<string, Type<unknown>> = {
  catalog: PluginCatalogComponent,
  title: PluginTitleComponent,
  releases: PluginReleasesComponent,
  list: PluginListComponent,
};

interface Defined {
  signature:string;
  screens:string[];
  contributions:string[];
}

@Injectable({
  providedIn: 'root'
})
export class RemotePlugins {

  /** The plugins shown to the current profile */
  readonly plugins$ = new BehaviorSubject<ClientPlugin[]>([]);
  private defined = new Map<string, Defined>();
  private started = false;

  constructor(
    private http:HttpClient,
    private server:ServerService,
    private profiles:ProfilesService,
    private events:ServerEvents,
    private router:Router,
    private navigator:Navigator,
    private client:PluginClient,
    private notifications:PluginNotifications,
  ) { }

  /** From AppComponent, once the server is known */
  start() {
    if (this.started || !this.server.connected) return;
    this.started = true;
    // what plugins tell the profile: toasts (notify.send)
    this.notifications.start();
    let changed = this.events.on('plugin.changed');
    // another value of a plugin's settings changes what its screens show: they ask again
    changed.subscribe(e => this.client.refresh$.next({ plugin: e.data?.id, target: '*' }));
    merge(
      this.profiles.current.pipe(map(p => p?.id || null), distinctUntilChanged()),
      changed.pipe(debounceTime(300)),
    ).pipe(
      switchMap(() => this.fetch()),
    ).subscribe(list => this.apply(list));
  }

  /** Again now (development tools) */
  reload():Observable<ClientPlugin[]> {
    return this.fetch().pipe(map(list => {
      this.apply(list);
      return list;
    }));
  }

  scope(plugin:ClientPlugin):PluginScope {
    return { id: plugin.id, name: plugin.name, adults: plugin.audience == 'adults', play: !!plugin.play };
  }

  private fetch():Observable<ClientPlugin[]> {
    let profile = this.profiles.current.value?.id;
    // plugins render for a profile only
    if (!profile) return of([]);
    return this.http.get<{ plugins:ClientPlugin[] }>(`${this.server.api}/plugins`, { params: { profile } }).pipe(
      map(answer => answer.plugins || []),
      // a server without plugins (older), or not reachable: keep what's shown
      catchError(() => of(null)),
      filter(Boolean),
    );
  }

  private apply(list:ClientPlugin[]) {
    let changed:string[] = [];
    let seen = new Set<string>();
    for (let plugin of list) {
      seen.add(plugin.id);
      let signature = JSON.stringify(plugin);
      if (this.defined.get(plugin.id)?.signature == signature) continue;
      this.undefine(plugin.id);
      try {
        this.define(plugin, signature);
      } catch (e) {
        console.error(`Plugin ${plugin.id} not shown`, e);
        this.undefine(plugin.id);
      }
      changed.push(plugin.id);
    }
    for (let id of Array.from(this.defined.keys())) {
      if (!seen.has(id)) {
        this.undefine(id);
        changed.push(id);
      }
    }
    this.plugins$.next(list);
    if (!changed.length) return;
    this.router.resetConfig(appRoutes());
    // a screen of a plugin that changed or left: start over where it was
    let gone = (id:string) => !this.navigator.registry.has(id);
    if (this.navigator.stack.some(e => e.screen.id.startsWith('plugin.') && gone(e.screen.id))) {
      this.navigator.reset({ screen: 'core.movies' });
    }
  }

  private define(plugin:ClientPlugin, signature:string) {
    let scope = this.scope(plugin);
    let defined:Defined = { signature, screens: [], contributions: [] };
    this.defined.set(plugin.id, defined);
    let sectionOf = (name:string) => plugin.sections.find(s => s.screen == name);
    let home = plugin.sections[0] ? `plugin.${plugin.id}.${plugin.sections[0].screen}` : undefined;

    for (let screen of plugin.screens) {
      let component = TEMPLATES[screen.template];
      if (!component) continue;
      let id = `plugin.${plugin.id}.${screen.name}`;
      let section = sectionOf(screen.name);
      SCREENS.define({
        id,
        path: `p/${plugin.id}/${screen.name}` + (screen.params || []).map(p => `/:${p}`).join(''),
        component,
        kind: section ? 'section' : 'detail',
        // its other screens keep the plugin's menu entry highlighted
        section: section ? undefined : home,
        requires: scope.adults ? ['adults'] : ['profile'],
        chrome: plugin.chrome?.accent ? { accent: plugin.chrome.accent } : undefined,
        data: { [PLUGIN_SCOPE]: scope, [PLUGIN_SCREEN]: screen },
        menu: section ? {
          label: section.menu.label,
          icon: this.client.asset(plugin.id, section.menu.icon) || 'opts',
          order: section.menu.order ?? 80,
          visible: scope.adults ? ({ profile }) => !!profile && !profile.isKid : undefined,
        } : undefined,
        title: () => screen.title || plugin.name,
      });
      defined.screens.push(id);
    }

    plugin.slots.forEach((slot, i) => {
      let def = SLOTS[slot.slot as SlotName];
      if (!def) return;
      let id = `plugin.${plugin.id}.${slot.slot.replace(/\./g, '-')}-${i}`;
      let kind = def.kind;
      defineContribution({
        id,
        slot: slot.slot as SlotName,
        order: slot.order ?? 100,
        adults: scope.adults,
        [kind]: (ctx:any) => this.slotModels(scope, slot.slot, slot.data, kind, ctx),
      });
      defined.contributions.push(id);
    });
  }

  private undefine(id:string) {
    let defined = this.defined.get(id);
    if (!defined) return;
    this.defined.delete(id);
    defined.contributions.forEach(c => CONTRIBUTIONS.remove(c));
    defined.screens.forEach(s => SCREENS.undefine(s));
  }

  // A slot's models from the plugin, asked again on a `refresh` of the slot
  private slotModels(scope:PluginScope, slot:string, name:string, kind:SlotKind, ctx:any):Observable<any[]> {
    let { profile, ...context } = ctx || {};
    return this.client.refresh$.pipe(
      filter(r => r.plugin == scope.id && (r.target == slot || r.target == '*')),
      startWith(null),
      switchMap(() => this.client.data<any>(scope.id, name, { slot, context }).pipe(
        map(answer => {
          this.client.perform(scope, answer.effects);
          return this.models(scope, kind, answer.data);
        }),
        catchError(() => of([])),
      )),
    );
  }

  private models(scope:PluginScope, kind:SlotKind, data:any):any[] {
    if (!data) return [];
    switch (kind) {
      case 'actions': return (data as PluginAction[]).map(a => this.client.action(scope, a));
      case 'rows': return (data as PluginRow[]).map(r => this.client.row(scope, r));
      case 'meta': return (data as PluginMetaItem[]).map(m => this.client.meta(scope, m)).filter(Boolean);
      case 'searchFilter': return data.chip ? [{
        key: data.chip.key,
        label: data.chip.label,
        rows: (data.rows || []).map((r:PluginRow) => this.client.row(scope, r)),
      }] : [];
    }
  }
}
