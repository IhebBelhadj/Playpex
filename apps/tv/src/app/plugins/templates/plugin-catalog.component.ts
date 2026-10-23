import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BackgroundService } from '../../background.service';
import { FocusEngine, PositionStore } from '../../movement/movement';
import { NavigationService } from '../../navigation.service';
import { CardModel, RowModel, TitleInfoModel } from '../../ui/public-api';
import { PluginClient } from '../plugin-client.service';
import { CatalogData, PluginFilterGroup } from '../plugin-models';
import { PluginScreen } from './plugin-screen';

interface RowState {
  model:RowModel;
  items:CardModel[];
  page:number;
  last:boolean;
  loading:boolean;
}

interface CatalogState {
  query:string;
  // chosen options per filter group; null = what the plugin marked `on`
  filters:Record<string, string[]> | null;
  data:CatalogData | null;
  rows:RowState[];
  loaded:boolean;
}

const LOAD_AHEAD = 6;

// The `catalog` template (docs/plugins/templates.md): a plugin's section or
// browse screen, laid out like the watch list (rows of posters under the focused title)
// (plugins/templates/catalog.scss): a toolbar (its title, search when the
// plugin offers it, a filters panel of its filter groups), the focused card's
// title info (the card's `info`, else its title), rows of cards (paged rows
// call the plugin as they scroll). Its handler gets
// { params, query, filters: { <group>: [values] } }.
// Back: cards → toolbar → menu. State (rows, search, filters) is the history
// entry's: Back from a title finds it as it was.
@Component({
  selector: 'plugin-catalog',
  templateUrl: './plugin-catalog.component.html',
  styleUrls: ['./catalog.scss', './plugin-catalog.component.scss'],
})
export class PluginCatalogComponent extends PluginScreen implements OnInit, AfterViewInit, OnDestroy {

  state:CatalogState;
  loading = false;
  loadError = '';
  panel:null | 'keyboard' | 'filters' = null;
  draft:Record<string, string[]> = {};
  spot:CardModel | null = null;

  readonly loadAhead = LOAD_AHEAD;
  readonly stackId = `plugin:${this.scope.id}:${this.decl.name}`;
  private loadSub:Subscription;
  private focusListener;

  constructor(
    client:PluginClient,
    private navigation:NavigationService,
    private background:BackgroundService,
    private engine:FocusEngine,
    private positions:PositionStore,
  ) {
    super(client);
  }

  get heading():string {
    return this.state.data?.title || this.decl.title || this.scope.name;
  }

  get groups():PluginFilterGroup[] {
    return this.state.data?.filters || [];
  }

  get toolbar():boolean {
    return !!(this.state.data?.search || this.groups.length || this.heading);
  }

  get filtered():boolean {
    return !!this.state.query || Object.values(this.chosen()).some(v => v.length);
  }

  get filterLabel():string {
    let chosen = this.chosen();
    let labels = this.groups.flatMap(g => g.options.filter(o => (chosen[g.key] || []).includes(o.value)).map(o => o.label));
    return labels.length ? labels.join(', ') : 'Filters';
  }

  get note():string {
    if (this.loadError) return this.loadError;
    if (!this.state.loaded || this.state.rows.some(r => r.items.length || r.loading)) return '';
    return this.state.data?.empty || (this.state.query ? `Nothing matches “${this.state.query}”.` : 'Nothing to show here yet.');
  }

  get info():TitleInfoModel | null {
    let card = this.spot;
    if (!card) return null;
    return card.info || { title: card.title, meta: card.subtitle ? [{ kind: 'text', text: card.subtitle }] : [] };
  }

  ngOnInit(): void {
    this.state = this.kept<CatalogState>(() => ({ query: '', filters: null, data: null, rows: [], loaded: false }));
    if (this.state.loaded && !this.loadError) {
      this.spot = this.state.rows.find(r => r.items.length)?.items[0] || null;
      setTimeout(() => this.restoreFocus(), 0);
    } else {
      this.positions.clear(this.stackId);
      this.load();
    }
  }

  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target([`stack:${this.stackId}`, '@pluginRows', '@pluginToolbar']) },
    });
    this.screen.onBack(() => this.back(document.activeElement as HTMLElement));
    this.focusListener = (e:Event) => {
      if (this.screen.active) this.onFocus(e.target as HTMLElement);
    };
    window.addEventListener('sn:focused', this.focusListener);
  }

  override ngOnDestroy(): void {
    super.ngOnDestroy();
    this.loadSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  protected refresh() {
    this.load(true);
  }

  // ── data ────────────────────────────────────────────────────────────────

  load(keepPositions = false) {
    this.loadError = '';
    this.loading = true;
    let state = this.state;
    this.loadSub?.unsubscribe();
    this.loadSub = this.client.data<CatalogData>(this.scope.id, this.decl.data, {
      params: this.params, query: state.query, filters: this.chosen(),
    }).subscribe({
      next: answer => {
        if (state != this.state) return;
        this.loading = false;
        this.client.perform(this.scope, answer.effects);
        let data = answer.data || { rows: [] };
        let rows = (data.rows || []).map(r => this.client.row(this.scope, r)).map(model => this.rowState(model));
        if (!keepPositions) this.positions.clear(this.stackId);
        this.set({ data, rows, loaded: true });
        rows.filter(r => !r.last).forEach(r => this.more(r));
        setTimeout(() => {
          let active = document.activeElement as HTMLElement;
          let kept = active && document.contains(active) && (active.closest('.pluginCatalog .toolbar') || active.classList.contains('menuItem'));
          if (!kept) this.restoreFocus();
          if (!this.spot) this.spot = this.state.rows.find(r => r.items.length)?.items[0] || null;
        }, 0);
      },
      error: err => {
        this.loading = false;
        this.loadError = err?.status == 429
          ? `${this.scope.name} is busy. Try again in a moment.`
          : `${this.scope.name} didn't answer. Try again, or check the plugin on the server's dashboard.`;
        this.set({ loaded: true });
        setTimeout(() => this.focusSelector('.pluginCatalog [data-px-key="retry"]'), 0);
      },
    });
  }

  private rowState(model:RowModel):RowState {
    return 'items' in model.source
      ? { model, items: model.source.items, page: 1, last: true, loading: false }
      : { model, items: [], page: 0, last: false, loading: false };
  }

  // A paged row: its next page (on load, and when the focus nears its end)
  more(row:RowState) {
    let source = row.model.source;
    if (!('page' in source) || row.last || row.loading) return;
    row.loading = true;
    let state = this.state;
    source.page(row.page + 1).subscribe({
      next: page => {
        row.loading = false;
        if (state != this.state) return;
        let known = new Set(row.items.map(i => i.key));
        row.items = row.items.concat(page.items.filter(i => !known.has(i.key)));
        row.page++;
        row.last = page.last || !page.items.length;
        if (!this.spot && row.items.length) this.spot = row.items[0];
      },
      error: () => {
        row.loading = false;
        row.last = true;
      },
    });
  }

  // ── input ───────────────────────────────────────────────────────────────

  pick(card:CardModel) {
    card.run?.();
  }

  openKeyboard() {
    this.panel = 'keyboard';
  }

  onSearchDone(query:string) {
    this.panel = null;
    if (query != this.state.query) this.change({ query });
    this.focusSelector('.pluginCatalog [data-px-key="search"]');
  }

  onSearchCancelled() {
    this.panel = null;
    this.focusSelector('.pluginCatalog [data-px-key="search"]');
  }

  openFilters() {
    this.draft = JSON.parse(JSON.stringify(this.chosen()));
    this.panel = 'filters';
  }

  isOn(group:PluginFilterGroup, value:string | null):boolean {
    let chosen = this.draft[group.key] || [];
    return value === null ? !chosen.length : chosen.includes(value);
  }

  toggle(group:PluginFilterGroup, value:string | null) {
    let chosen = this.draft[group.key] || [];
    if (value === null) chosen = [];
    else if (group.multiple) chosen = chosen.includes(value) ? chosen.filter(v => v != value) : [...chosen, value];
    else chosen = [value];
    this.draft = { ...this.draft, [group.key]: chosen };
  }

  applyFilters() {
    let filters = this.draft;
    this.panel = null;
    this.change({ filters });
    this.focusSelector('.pluginCatalog [data-px-key="filters"]');
  }

  resetFilters() {
    this.draft = {};
  }

  clearAll() {
    this.change({ query: '', filters: {} });
    this.focusSelector('.pluginCatalog [data-px-key="search"], .pluginCatalog [data-px-key="filters"]');
  }

  // cards → toolbar → menu; on the menu Back leaves (the power menu)
  private back(active:HTMLElement):boolean {
    if (!active || active.classList.contains('menuItem')) return false;
    let toolbar = document.querySelector('.pluginCatalog .toolbar .focusable, .pluginCatalog .toolbar [data-px-item]') as HTMLElement;
    if (active.closest('.toolbar') || !toolbar) this.focusSelector('.menuItem.active');
    else toolbar.focus({ preventScroll: true });
    return true;
  }

  private change(patch:Partial<CatalogState>) {
    this.set({ ...patch, rows: [], loaded: false });
    this.spot = null;
    this.load();
  }

  /** The filters in use: the user's, else what the plugin marked `on` */
  private chosen():Record<string, string[]> {
    if (this.state.filters) return this.state.filters;
    let out:Record<string, string[]> = {};
    this.groups.forEach(g => {
      let on = g.options.filter(o => o.on).map(o => o.value);
      if (on.length) out[g.key] = on;
    });
    return out;
  }

  // ── focus ───────────────────────────────────────────────────────────────

  private restoreFocus() {
    if (this.panel || this.engine.restore(`stack:${this.stackId}`)) return;
    let target = document.querySelector('.pluginCatalog .titleInfo .focusable') as HTMLElement
      || document.querySelector('.pluginCatalog .toolbar [data-px-item], .pluginCatalog .toolbar .focusable') as HTMLElement;
    target?.focus({ preventScroll: true });
  }

  // the title info and the backdrop follow the focused card
  private onFocus(node:HTMLElement) {
    if (!node.closest('.pluginCatalog .rows')) return;
    let key = node.dataset['pxKey'];
    let card = this.state.rows.flatMap(r => r.items).find(c => String(c.key) == key);
    if (!card) return;
    this.spot = card;
    if (card.info?.backdrop) this.background.sendImage(card.info.backdrop);
  }

  trackRow(index:number, row:RowState) { return row.model.key; }

  private set(patch:Partial<CatalogState>) {
    this.state = { ...this.state, ...patch };
    this.screen.setState('plugin', this.state);
  }

  private focusSelector(selector:string) {
    setTimeout(() => (document.querySelector(selector) as HTMLElement)?.focus({ preventScroll: true }), 0);
  }
}
