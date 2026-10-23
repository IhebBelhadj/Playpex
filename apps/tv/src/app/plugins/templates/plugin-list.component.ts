import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { FocusEngine } from '../../movement/movement';
import { NavigationService } from '../../navigation.service';
import { iconUrl } from '../../ui/public-api';
import { PluginClient } from '../plugin-client.service';
import { ListData, PluginListItem } from '../plugin-models';
import { PluginScreen } from './plugin-screen';

// The `list` template (docs/plugins/templates.md): a plugin's simple menu or
// folder, one row per item (icon, label, meta), laid out like the library's
// folder list (whose stylesheet it uses). Its handler gets { params }; Enter
// opens an item's intent or calls the plugin. Back: the navigator's (a
// section: the menu first).
@Component({
  selector: 'plugin-list',
  templateUrl: './plugin-list.component.html',
  styleUrls: ['../../library-folder/library-folder.component.scss'],
})
export class PluginListComponent extends PluginScreen implements OnInit, AfterViewInit, OnDestroy {

  data:ListData | null = null;
  loading = false;
  loadError = '';
  readonly gridId = `plugin:${this.scope.id}:${this.decl.name}`;
  private loadSub:Subscription;

  constructor(client:PluginClient, private navigation:NavigationService, private engine:FocusEngine) {
    super(client);
  }

  get heading():string {
    return this.data?.title || this.decl.title || this.scope.name;
  }

  get section():boolean {
    return this.screen.entry?.screen.kind == 'section';
  }

  ngOnInit(): void {
    this.load();
  }

  ngAfterViewInit(): void {
    if (!this.section) return;
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target([`grid:${this.gridId}`, '@pluginList']) },
    });
    this.screen.onBack(() => {
      let active = document.activeElement as HTMLElement;
      if (!active || active.classList.contains('menuItem')) return false;
      (document.querySelector('.menuItem.active') as HTMLElement)?.focus({ preventScroll: true });
      return true;
    });
  }

  override ngOnDestroy(): void {
    super.ngOnDestroy();
    this.loadSub?.unsubscribe();
    if (this.section) this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  protected refresh() {
    this.load();
  }

  load() {
    this.loading = true;
    this.loadError = '';
    this.loadSub?.unsubscribe();
    this.loadSub = this.client.data<ListData>(this.scope.id, this.decl.data, { params: this.params }).subscribe({
      next: answer => {
        this.loading = false;
        this.client.perform(this.scope, answer.effects);
        this.data = answer.data || { items: [] };
        setTimeout(() => {
          let active = document.activeElement as HTMLElement;
          if (active?.classList.contains('menuItem')) return;
          if (!this.screen.ready() && !this.engine.restore(`grid:${this.gridId}`)) {
            (document.querySelector('.pluginList .row') as HTMLElement)?.focus({ preventScroll: true });
          }
        }, 0);
      },
      error: () => {
        this.loading = false;
        this.loadError = `${this.scope.name} didn't answer.`;
      },
    });
  }

  select(item:PluginListItem) {
    if (item.call) this.client.run(this.scope, item.call);
    else if (item.intent) this.client.open(this.scope, item.intent);
  }

  icon(item:PluginListItem):string | null {
    if (!item.icon) return null;
    let resolved = this.client.icon(this.scope.id, item.icon);
    return iconUrl(resolved);
  }

  byKey(index:number, item:PluginListItem) { return item.key; }
}
