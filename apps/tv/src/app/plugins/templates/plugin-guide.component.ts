import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { LiveChannel, LiveChannels, LiveProgramme, LiveService } from '../../live/live.service';
import { FocusEngine, PositionStore } from '../../movement/movement';
import { NavigationService } from '../../navigation.service';
import { Dialogs } from '../../ui/public-api';
import { PluginClient } from '../plugin-client.service';
import { PluginScreen } from './plugin-screen';

// What the guide shows at once, and how it pages in time
const WINDOW_H = 3;
const SLOT_MS = 30 * 60000;
// Lines drawn at first, and added when the focus nears the last ones
const LINES = 40;
const LINES_AHEAD = 8;

interface GuideState {
  group:string | null;
  // hours after the current half hour the window starts at (no catch-up: never before it)
  offset:number;
  shown:number;
}

/** A programme as drawn: its place in the window */
interface Cell {
  key:string;
  channel:LiveChannel;
  programme:LiveProgramme | null;
  left:number;      // % of the window
  width:number;
}

interface Line {
  channel:LiveChannel;
  cells:Cell[];
}

// The `guide` template (docs/providers-plan.md §8.3, §10.4): a live plugin's
// channels (GET <api>/live/{plugin}/channels) and their programmes
// (…/guide), drawn by the core. Lines are channels, each its programmes sized
// by their length over a 3 h window starting at the current half hour (no
// catch-up: nothing before it); an amber rule is now. One pxGrid: ←/→ along a
// channel's programmes, ↑/↓ to the programme of the next channel nearest
// in time. The toolbar: its groups (a panel), Later / Earlier / Now. The
// focused programme's details on top. Enter: what is on now (or a channel
// without a guide) plays full screen, ↑ / ↓ in the player flip through this
// list; a later programme shows its details. Its data handler (optional)
// names the screen and says what to show without channels.
// Back: programmes → toolbar → menu.
@Component({
  selector: 'plugin-guide',
  templateUrl: './plugin-guide.component.html',
  styleUrls: ['./plugin-guide.component.scss'],
})
export class PluginGuideComponent extends PluginScreen implements OnInit, AfterViewInit, OnDestroy {

  state:GuideState;
  answer:LiveChannels | null = null;
  lines:Line[] = [];
  loading = false;
  loadError = '';
  emptyText = '';
  title = '';
  panel:null | 'groups' = null;
  spot:Cell | null = null;
  start = new Date();
  ticks:{ label:string, left:number }[] = [];
  nowLeft:number | null = null;

  readonly gridId = `guide:${this.scope.id}:${this.decl.name}`;
  private programmes = new Map<string, LiveProgramme[]>();
  private subs2:Subscription[] = [];
  private guideSub:Subscription;
  private clock;
  private focusListener;

  constructor(
    client:PluginClient,
    private live:LiveService,
    private navigation:NavigationService,
    private engine:FocusEngine,
    private positions:PositionStore,
    private dialogs:Dialogs,
  ) {
    super(client);
  }

  get heading():string {
    return this.title || this.decl.title || this.scope.name;
  }

  get guide():boolean {
    return !!this.answer?.guide;
  }

  get filtered():LiveChannel[] {
    let all = this.answer?.channels || [];
    return this.state.group ? all.filter(c => c.group == this.state.group) : all;
  }

  get groupLabel():string {
    return this.state.group || 'All channels';
  }

  get end():Date {
    return new Date(this.start.getTime() + WINDOW_H * 3600000);
  }

  ngOnInit(): void {
    this.state = this.kept<GuideState>(() => ({ group: null, offset: 0, shown: LINES }));
    this.setWindow();
    this.loadName();
    this.load();
    // the now rule moves; at a new half hour the window follows (when it shows now)
    this.clock = setInterval(() => {
      let before = this.start.getTime();
      this.setWindow();
      if (this.start.getTime() != before) this.loadGuide();
      else this.layout();
    }, 30000);
  }

  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'menu',
      selector: '.menuContainer .element',
      restrict: 'self-only',
      leaveFor: { right: this.engine.target([`grid:${this.gridId}`, '@pluginGuide', '@guideToolbar']) },
    });
    this.screen.onBack(() => this.back(document.activeElement as HTMLElement));
    this.focusListener = (e:Event) => {
      if (this.screen.active) this.onFocus(e.target as HTMLElement);
    };
    window.addEventListener('sn:focused', this.focusListener);
  }

  override ngOnDestroy(): void {
    super.ngOnDestroy();
    clearInterval(this.clock);
    this.subs2.forEach(s => s.unsubscribe());
    this.guideSub?.unsubscribe();
    window.removeEventListener('sn:focused', this.focusListener);
    this.navigation.updateNavigation('remove', { sectionId: 'menu' });
  }

  protected refresh() {
    this.load();
  }

  // ── data ────────────────────────────────────────────────────────────────

  private loadName() {
    if (!this.decl.data) return;
    this.subs2.push(this.client.data<{ title?:string, empty?:string }>(this.scope.id, this.decl.data, { params: this.params }).subscribe({
      next: answer => {
        this.client.perform(this.scope, answer.effects);
        this.title = answer.data?.title || '';
        this.emptyText = answer.data?.empty || '';
      },
      error: () => { },
    }));
  }

  load() {
    this.loading = true;
    this.loadError = '';
    this.subs2.push(this.live.channels(this.scope.id).subscribe({
      next: answer => {
        this.loading = false;
        this.answer = answer;
        if (this.state.group && !answer.groups.some(g => g.name == this.state.group)) this.set({ group: null });
        this.layout();
        this.loadGuide();
        setTimeout(() => this.restoreFocus(), 0);
      },
      error: err => {
        this.loading = false;
        this.loadError = err?.error?.error || `${this.scope.name} didn't answer. Try again, or check the plugin on the server's dashboard.`;
        setTimeout(() => (document.querySelector('.pluginGuide [data-px-key="retry"]') as HTMLElement)?.focus({ preventScroll: true }), 0);
      },
    }));
  }

  private setWindow() {
    let base = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    this.start = new Date(base + this.state.offset * 3600000);
    let span = WINDOW_H * 3600000;
    this.ticks = [];
    for (let t = this.start.getTime(); t < this.start.getTime() + span; t += SLOT_MS) {
      this.ticks.push({ label: time(new Date(t)), left: (t - this.start.getTime()) * 100 / span });
    }
    let now = (Date.now() - this.start.getTime()) * 100 / span;
    this.nowLeft = now >= 0 && now <= 100 ? now : null;
  }

  // The programmes of the lines shown, for the window
  private loadGuide() {
    this.guideSub?.unsubscribe();
    if (!this.guide) return this.layout();
    let ids = this.filtered.slice(0, this.state.shown).map(c => c.id);
    let start = this.start;
    this.guideSub = this.live.guide(this.scope.id, ids, this.start, this.end).subscribe(list => {
      if (start != this.start) return;
      this.programmes.clear();
      list.forEach(p => {
        let mine = this.programmes.get(p.channel);
        if (!mine) this.programmes.set(p.channel, mine = []);
        mine.push(p);
      });
      this.layout();
    });
  }

  private layout() {
    // the focused cell may go (its channel's programmes arrived, the window moved): its channel keeps the focus
    let active = document.activeElement as HTMLElement;
    let focusedChannel = active?.closest('.pluginGuide .lines') ? this.cellOf(active)?.channel.id : null;
    let from = this.start.getTime(), span = WINDOW_H * 3600000, to = from + span;
    let shown = this.filtered.slice(0, this.state.shown);
    this.lines = shown.map(channel => {
      let cells:Cell[] = (this.programmes.get(channel.id) || [])
        .map(p => ({ p, a: Math.max(from, Date.parse(p.start)), b: Math.min(to, Date.parse(p.end)) }))
        .filter(x => x.b > x.a)
        .map(x => ({
          key: `${channel.id}@${x.p.start}`,
          channel,
          programme: x.p,
          left: (x.a - from) * 100 / span,
          width: (x.b - x.a) * 100 / span,
        }));
      // nothing known: one block over the window (plays the channel)
      if (!cells.length) cells = [{ key: `${channel.id}@-`, channel, programme: null, left: 0, width: 100 }];
      return { channel, cells };
    });
    if (this.spot) this.spot = this.lines.flatMap(l => l.cells).find(c => c.key == this.spot.key) || this.spot;
    if (focusedChannel) setTimeout(() => this.keepFocus(focusedChannel), 0);
    else if (!active || active == document.body) setTimeout(() => this.restoreFocus(), 0);
  }

  private cellOf(node:HTMLElement):Cell | null {
    let key = node?.dataset['pxKey'];
    return key ? this.lines.flatMap(l => l.cells).find(c => c.key == key) || null : null;
  }

  // the channel's programme on air (else its first) when the focused cell went
  private keepFocus(channelId:string) {
    let active = document.activeElement as HTMLElement;
    if (active && active != document.body && document.contains(active)) return;
    let line = this.lines.find(l => l.channel.id == channelId);
    let cell = line?.cells.find(c => this.onAir(c.programme)) || line?.cells[0];
    let node = cell && document.querySelector(`.pluginGuide .lines [data-px-key="${CSS.escape(cell.key)}"]`) as HTMLElement;
    if (!node) return;
    this.engine.focus(node, 'restore');
  }

  /** Near the end of the lines drawn: the next ones */
  more() {
    if (this.state.shown >= this.filtered.length) return;
    this.set({ shown: this.state.shown + LINES });
    this.layout();
    this.loadGuide();
  }

  // ── input ───────────────────────────────────────────────────────────────

  pick(cell:Cell) {
    let p = cell.programme, now = Date.now();
    if (!p || (Date.parse(p.start) <= now && Date.parse(p.end) > now)) {
      this.play(cell.channel);
      return;
    }
    if (Date.parse(p.end) <= now) return this.play(cell.channel);
    this.dialogs.alert({
      id: 'guideProgramme',
      title: p.title,
      text: [`${cell.channel.number} ${cell.channel.name} · ${day(p.start)} ${time(new Date(p.start))}–${time(new Date(p.end))}`,
        [p.episode, p.subtitle].filter(Boolean).join(' · '), p.description].filter(Boolean).join('\n'),
      ok: 'Close',
    }).subscribe();
  }

  private play(channel:LiveChannel) {
    let lineup = { plugin: this.scope.id, name: this.scope.name, guide: this.guide, channels: this.filtered };
    this.live.play(this.scope.id, channel, { lineup }).subscribe();
  }

  later() {
    this.shift(this.state.offset + WINDOW_H - 1);
  }

  earlier() {
    this.shift(Math.max(0, this.state.offset - (WINDOW_H - 1)));
  }

  now() {
    this.shift(0);
  }

  private shift(offset:number) {
    if (offset == this.state.offset) return;
    this.set({ offset });
    this.setWindow();
    this.programmes.clear();
    this.layout();
    this.loadGuide();
  }

  openGroups() {
    this.panel = 'groups';
  }

  chooseGroup(group:string | null) {
    this.panel = null;
    if (group != this.state.group) {
      this.positions.clear(this.gridId);
      this.set({ group, shown: LINES });
      this.spot = null;
      this.layout();
      this.loadGuide();
    }
    setTimeout(() => (document.querySelector('.pluginGuide [data-px-key="groups"]') as HTMLElement)?.focus({ preventScroll: true }), 0);
  }

  // programmes → toolbar → menu; on the menu Back leaves (the power menu)
  private back(active:HTMLElement):boolean {
    if (!active || active.classList.contains('menuItem')) return false;
    let toolbar = document.querySelector('.pluginGuide .toolbar [data-px-item]') as HTMLElement;
    if (active.closest('.toolbar') || !toolbar) (document.querySelector('.menuItem.active') as HTMLElement)?.focus({ preventScroll: true });
    else toolbar.focus({ preventScroll: true });
    return true;
  }

  // ── focus and the details on top ────────────────────────────────────────

  private restoreFocus() {
    if (this.panel) return;
    let active = document.activeElement as HTMLElement;
    if (active && document.contains(active) && (active.closest('.pluginGuide .toolbar') || active.classList.contains('menuItem'))) return;
    if (this.engine.restore(`grid:${this.gridId}`)) return;
    let first = document.querySelector('.pluginGuide .lines [data-px-item]') as HTMLElement
      || document.querySelector('.pluginGuide .toolbar [data-px-item]') as HTMLElement;
    first?.focus({ preventScroll: true });
  }

  private onFocus(node:HTMLElement) {
    if (!node.closest('.pluginGuide .lines')) return;
    this.spot = this.cellOf(node);
    // near the last lines drawn: the next ones
    let index = this.lines.findIndex(l => l.channel.id == this.spot?.channel.id);
    if (index >= 0 && index >= this.lines.length - LINES_AHEAD) this.more();
  }

  logo(channel:LiveChannel):string | null {
    return this.live.logo(channel);
  }

  onAir(p:LiveProgramme | null):boolean {
    let now = Date.now();
    return !!p && Date.parse(p.start) <= now && Date.parse(p.end) > now;
  }

  progress(p:LiveProgramme | null):number {
    if (!p) return 0;
    let a = Date.parse(p.start), b = Date.parse(p.end);
    return Math.max(0, Math.min(1, (Date.now() - a) / Math.max(1, b - a)));
  }

  span(p:LiveProgramme):string {
    return `${time(new Date(p.start))}–${time(new Date(p.end))}`;
  }

  get nowText():string {
    return 'now ' + time(new Date());
  }

  get windowText():string {
    return this.state.offset ? `${day(this.start.toISOString())} ${time(this.start)}–${time(this.end)}` : '';
  }

  trackLine(index:number, line:Line) { return line.channel.id; }
  trackCell(index:number, cell:Cell) { return cell.key; }

  private set(patch:Partial<GuideState>) {
    this.state = { ...this.state, ...patch };
    this.screen.setState('plugin', this.state);
  }
}

function time(d:Date):string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function day(iso:string):string {
  let d = new Date(iso), today = new Date();
  if (d.toDateString() == today.toDateString()) return 'Today';
  let tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() == tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long' });
}
