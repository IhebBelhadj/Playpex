import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { FocusEngine, PositionStore } from '../../movement/movement';
import { NavigationService } from '../../navigation.service';
import { Navigator } from '../../nav/public-api';
import { formatBytes } from '../../torrent-picker.service';
import { PluginClient } from '../plugin-client.service';
import { PluginFilterGroup, PluginRelease, ReleasesData } from '../plugin-models';
import { PluginScreen } from './plugin-screen';

interface ReleasesState {
  query:string;
  filters:Record<string, string[]> | null;
  data:ReleasesData | null;
  releases:PluginRelease[];
  page:number;
  last:boolean;
  loaded:boolean;
}

// The `releases` template (docs/plugins/templates.md): a plugin's release
// list, laid out like the core's "Find releases" (releases-page, whose
// stylesheet it uses): a rail (back to where it was opened from, search, the
// plugin's filter groups as chips) beside the releases, most seeded first,
// paged as the list scrolls. Its handler gets { params, query, filters, page }.
// Enter plays the release with the core's player when the plugin may hand
// play requests to the core (an adults plugin's: nothing remembered); a direct
// link (a release with a `call`) asks the plugin, whose answer plays it.
// Torrents and direct links may share a list.
@Component({
  selector: 'plugin-releases',
  templateUrl: './plugin-releases.component.html',
  styleUrls: ['../../releases-page/releases-page.component.scss'],
})
export class PluginReleasesComponent extends PluginScreen implements OnInit, AfterViewInit, OnDestroy {

  state:ReleasesState;
  loading = false;
  loadError = '';
  keyboardOpen = false;
  readonly listId = `plugin:${this.scope.id}:${this.decl.name}`;
  readonly loadAhead = 8;
  private loadSub:Subscription;

  constructor(client:PluginClient, readonly navigator:Navigator, private engine:FocusEngine, private positions:PositionStore,
    private navigation:NavigationService) {
    super(client);
  }

  // the menu's section, with Right back into the rail: the title pages remove
  // theirs when they close, and without it neither Left nor the mouse reach the menu
  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target(['@pluginReleasesRail']) },
    });
  }

  override ngOnDestroy(): void {
    super.ngOnDestroy();
    // a page answering after it closed would perform its effects over another screen
    this.loadSub?.unsubscribe();
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  get heading():string {
    return this.state.data?.title || this.decl.title || this.scope.name;
  }

  get groups():PluginFilterGroup[] {
    return this.state.data?.filters || [];
  }

  // opened from another screen (not its section): the way back
  get canGoBack():boolean {
    return this.navigator.stack.length > 1 && this.navigator.root !== this.screen.entry;
  }

  get note():string {
    if (this.loadError) return this.loadError;
    if (!this.state.loaded || this.loading || this.state.releases.length) return '';
    return this.state.data?.empty || 'No releases.';
  }

  private reloaded = false;

  ngOnInit(): void {
    this.state = this.kept<ReleasesState>(() => ({ ...this.keptChoices(), data: null, releases: [], page: 0, last: false, loaded: false }));
    if (this.state.loaded && this.state.releases.length) {
      setTimeout(() => this.engine.restore(`grid:${this.listId}`) || this.focusFirst(), 0);
    } else {
      // shown again without what it had loaded (the page reloaded,
      // session-restore.ts): back to the release it was on once it's there
      this.reloaded = this.screen.returning;
      this.load();
    }
  }

  protected refresh() {
    this.change({});
  }

  load() {
    this.loadError = '';
    this.loading = true;
    let state = this.state, page = state.page + 1;
    this.loadSub?.unsubscribe();
    this.loadSub = this.client.data<ReleasesData>(this.scope.id, this.decl.data, {
      params: this.params, query: state.query, filters: this.chosen(), page,
    }).subscribe({
      next: answer => {
        this.loading = false;
        if (state != this.state) return;
        this.client.perform(this.scope, answer.effects);
        let data = answer.data || { releases: [], last: true };
        let first = page == 1;
        this.set({
          data: first ? data : { ...this.state.data, ...data, releases: [] },
          releases: (first ? [] : this.state.releases).concat(data.releases.map(r => 'image' in r && r.image ? { ...r, image: this.client.asset(this.scope.id, r.image) } : r)),
          page, last: !!data.last || !data.releases.length, loaded: true,
        });
        if (first) {
          let reloaded = this.reloaded;
          this.reloaded = false;
          if (!reloaded) this.positions.clear(`grid:${this.listId}`);
          setTimeout(() => {
            let active = document.activeElement as HTMLElement;
            if (active?.closest('.pluginReleases .rail')) return;
            if (!(reloaded && this.engine.restore(`grid:${this.listId}`))) this.focusFirst();
          }, 0);
        }
      },
      error: () => {
        this.loading = false;
        this.loadError = `${this.scope.name} didn't answer. Try again.`;
        this.set({ loaded: true });
      },
    });
  }

  loadMore() {
    if (!this.loading && !this.state.last && this.state.loaded) this.load();
  }

  play(release:PluginRelease) {
    if (release.call) this.client.run(this.scope, release.call);
    else this.client.playRelease(this.scope, release, this.state.data?.title);
  }

  /** "24 releases, most seeded first", "12 direct links", or both kinds: "30 releases" */
  get countLabel():string {
    let all = this.state.releases, direct = all.filter(r => r.call).length, more = this.state.last ? '' : '+';
    if (!direct) return `${all.length}${more} releases, most seeded first`;
    if (direct == all.length) return `${all.length}${more} direct link${all.length == 1 && !more ? '' : 's'}`;
    return `${all.length}${more} releases`;
  }

  // ── rail ────────────────────────────────────────────────────────────────

  isOn(group:PluginFilterGroup, value:string | null):boolean {
    let chosen = this.chosen()[group.key] || [];
    return value === null ? !chosen.length : chosen.includes(value);
  }

  toggle(group:PluginFilterGroup, value:string | null) {
    let filters = { ...this.chosen() };
    let chosen = filters[group.key] || [];
    if (value === null) chosen = [];
    else if (group.multiple) chosen = chosen.includes(value) ? chosen.filter(v => v != value) : [...chosen, value];
    else chosen = chosen.includes(value) ? [] : [value];
    filters[group.key] = chosen;
    this.change({ filters });
  }

  onSearchDone(query:string) {
    this.keyboardOpen = false;
    if (query != this.state.query) this.change({ query });
    this.focusSearch();
  }

  onSearchCancelled() {
    this.keyboardOpen = false;
    this.focusSearch();
  }

  clearSearch() {
    this.change({ query: '' });
    this.focusSearch();
  }

  private change(patch:Partial<ReleasesState>) {
    this.set({ ...patch, releases: [], page: 0, last: false, loaded: false });
    this.load();
  }

  private chosen():Record<string, string[]> {
    if (this.state.filters) return this.state.filters;
    let out:Record<string, string[]> = {};
    this.groups.forEach(g => {
      let on = g.options.filter(o => o.on).map(o => o.value);
      if (on.length) out[g.key] = on;
    });
    return out;
  }

  // ── view helpers ────────────────────────────────────────────────────────

  seedShare(seeds:number):number {
    let top = Math.max(1, ...this.state.releases.map(r => r.call ? 0 : r.seeds || 0));
    return Math.sqrt(Math.max(0, seeds)) / Math.sqrt(top);
  }

  size(bytes:number):string {
    return formatBytes(bytes);
  }

  age(iso:string):string {
    let days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (!isFinite(days) || days < 0) return '';
    if (days < 1) return 'Today';
    if (days < 31) return `${days} day${days == 1 ? '' : 's'} ago`;
    if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`;
    return `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`;
  }

  keyOf(r:PluginRelease):string {
    return r.infoHash || r.magnet || (r.call ? `call:${r.call.data}:${JSON.stringify(r.call.args || {})}` : r.title);
  }

  trackRelease = (index:number, r:PluginRelease) => this.keyOf(r);

  private focusFirst() {
    (document.querySelector('.pluginReleases .release') as HTMLElement)?.focus({ preventScroll: true });
  }

  private focusSearch() {
    setTimeout(() => (document.querySelector('.pluginReleases [data-px-key="search"] [data-px-item], .pluginReleases [data-px-key="search"]') as HTMLElement)?.focus({ preventScroll: true }), 0);
  }

  private set(patch:Partial<ReleasesState>) {
    this.state = { ...this.state, ...patch };
    this.screen.setState('plugin', this.state);
    this.keepChoices(this.state);
  }
}
