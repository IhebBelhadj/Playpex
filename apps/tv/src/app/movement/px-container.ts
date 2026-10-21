import {
  AfterContentInit, ContentChildren, Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output, QueryList,
} from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import * as spatialNavigation from '../../plugins/spacialNavigation.js';
import { FocusCause, FocusEngine } from './focus-engine.service';
import { Direction, nearestOnAxis, Slot, visibleFraction } from './moves';
import { PositionStore, rememberedIndex } from './position-store.service';
import { Align, alignedScroll, Axis, boxOf, maxScroll, offsetWithin } from './scroller';
import { Motion, MotionKind, ScrollMotion, TransformMotion } from './motion';
import { PxItemDirective } from './px-item.directive';

export type ContainerKind = 'row' | 'grid' | 'stack';
export type EnterMode = 'remembered' | 'nearest';

const NEAR_END_THROTTLE = 300;   // ms between two nearEnd emissions
const SAVE_DELAY = 150;          // ms after the last scroll event before saving the offsets

// What pxRow, pxGrid and pxStack share: their entries (items, or nested
// containers) in DOM order, the remembered entry, alignment, paging
// (`nearEnd`) and the offsets kept in PositionStore. How the content moves is
// the container's Motion (motion.ts): real scrolling, or a translated track.
@Directive()
export abstract class PxContainer implements OnInit, AfterContentInit, OnDestroy {

  abstract readonly kind:ContainerKind;
  abstract id:string;
  abstract align:string;

  // Entering the container: its remembered entry, or the visible entry
  // nearest to where focus comes from (keyboards, chip grids)
  @Input() enter:EnterMode = 'remembered';
  // nearEnd when the focused entry is this close to the end (entries)…
  @Input() loadAhead = 0;
  // …or the scroll this close to it (px; default: one viewport)
  @Input() loadAheadPx:number | null = null;
  @Input() wrap = false;
  // 'scroll' (default) or 'transform'; nested containers take their parent's
  @Input() motion:MotionKind | null = null;
  @Output() nearEnd = new EventEmitter<void>();
  // Where the content is cut off along the main axis (both true: it all fits);
  // read by the rowArrows chevrons
  readonly edges = new BehaviorSubject<{ start:boolean, end:boolean }>({ start: true, end: true });

  @ContentChildren(PxItemDirective, { descendants: true }) items:QueryList<PxItemDirective>;

  private restored = false;
  private lastNearEnd = 0;
  private saveTimer:any;
  private itemsSub:Subscription;
  private resizeObserver:ResizeObserver;
  protected mover:Motion;

  constructor(
    protected elRef:ElementRef<HTMLElement>,
    protected engine:FocusEngine,
    protected positions:PositionStore,
    private scrollMotion:ScrollMotion,
    private transformMotion:TransformMotion,
    protected zone:NgZone,
  ) { }

  get motionKind():MotionKind {
    return this.mover?.kind || 'scroll';
  }

  get host():HTMLElement {
    return this.elRef.nativeElement;
  }

  // PositionStore key: `<parent container key>/<id>`
  get storeKey():string | null {
    if (!this.id) return null;
    let parentKey = this.engine.parentContainer(this.host)?.storeKey;
    return parentKey ? `${parentKey}/${this.id}` : this.id;
  }

  ngOnInit(): void {
    let host = this.host;
    host.setAttribute('data-px-container', this.kind);
    if (this.id) host.setAttribute('data-px-id', this.id);
    let kind = this.motion || this.engine.parentContainer(host)?.motionKind || 'scroll';
    this.mover = kind == 'transform' ? this.transformMotion : this.scrollMotion;
    host.setAttribute('data-px-motion', kind);
    this.mover.attach(host, this.styledAxes());
    // offsets are measured against the container (offsetParent)
    if (getComputedStyle(host).position == 'static') host.style.position = 'relative';
    this.engine.register(this);
    this.zone.runOutsideAngular(() => {
      host.addEventListener('scroll', this.onScroll, { passive: true });
      // a resized container changes what is cut off (translated ones fire no scroll events)
      this.resizeObserver = new ResizeObserver(() => this.updateEdges());
      this.resizeObserver.observe(host);
    });
  }

  ngAfterContentInit(): void {
    this.contentChanged();
    this.itemsSub = this.items.changes.subscribe(() => this.contentChanged());
  }

  ngOnDestroy(): void {
    this.itemsSub?.unsubscribe();
    // offsets are saved as they change: a leaving page's are already gone (0)
    clearTimeout(this.saveTimer);
    this.host.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.engine.unregister(this);
  }

  // ── structure ─────────────────────────────────────────────────────────────

  // Items and nested containers whose nearest container is this one
  entries():HTMLElement[] {
    let host = this.host;
    return (Array.from(host.querySelectorAll('[data-px-item], [data-px-container]')) as HTMLElement[])
      .filter(el => el.parentElement?.closest('[data-px-container]') === host);
  }

  navigableEntries():HTMLElement[] {
    return this.entries().filter(entry => this.isNavigable(entry));
  }

  private isNavigable(entry:HTMLElement):boolean {
    let nested = this.engine.containerOf(entry);
    if (nested) return nested.navigableEntries().length > 0;
    return !!spatialNavigation.sectionOf(entry);
  }

  entryKey(entry:HTMLElement):string | null {
    return entry.getAttribute('data-px-key') ?? entry.getAttribute('data-px-id');
  }

  // The axes this container scrolls along
  protected abstract scrollAxes():Axis[];

  // The axes given the scrolling utility class (overflow, hidden scrollbar)
  protected styledAxes():Axis[] {
    return this.scrollAxes();
  }

  // What gets aligned for an entry (pxStack: its pxStackItem block)
  protected blockOf(entry:HTMLElement):HTMLElement {
    return entry;
  }

  protected alignFor(axis:Axis):Align {
    return this.align as Align;
  }

  slotOf(entry:HTMLElement):Slot {
    let block = this.blockOf(entry);
    return {
      x: offsetWithin(block, this.host, 'left'),
      y: offsetWithin(block, this.host, 'top'),
      w: block.offsetWidth,
      h: block.offsetHeight,
    };
  }

  // ── movement ──────────────────────────────────────────────────────────────

  // The item to focus for `direction` from `from` (an entry of this
  // container), or null to let the parent container / the library handle it
  abstract move(from:HTMLElement, direction:Direction, origin:HTMLElement):HTMLElement | null;

  // The item to focus when focus enters this container from `origin`
  enterFrom(origin?:HTMLElement | null):HTMLElement | null {
    let entries = this.navigableEntries();
    if (!entries.length) return null;
    let pick = this.enter == 'remembered'
      ? rememberedIndex(this.positions.get(this.storeKey), entries.map(e => this.entryKey(e)))
      : -1;
    if (pick < 0) pick = this.nearestVisible(entries, origin);
    return this.resolve(entries[pick], origin);
  }

  // An entry → the item it stands for (a nested container → its entry item)
  protected resolve(entry:HTMLElement | undefined, origin?:HTMLElement | null):HTMLElement | null {
    if (!entry) return null;
    let nested = this.engine.containerOf(entry);
    return nested ? nested.enterFrom(origin) : entry;
  }

  // Index of the entry (mostly) on screen nearest to `origin`, else the first
  // one on screen, else the first
  nearestVisible(entries:HTMLElement[], origin?:HTMLElement | null):number {
    let slots = entries.map(e => this.slotOf(e));
    let visible = slots.map((s, i) => i).filter(i => this.visible(slots[i], .5));
    let candidates = visible.length ? visible : slots.map((s, i) => i);
    if (!origin) return candidates[0];

    let o = origin.getBoundingClientRect();
    let point = this.mover.toContent(this.host, o.left + o.width / 2, o.top + o.height / 2);
    let axis = this.crossAxis();
    if (axis) return nearestOnAxis(slots, candidates, point[axis], axis);
    let best = candidates[0], bestDistance = Infinity;
    candidates.forEach(i => {
      let s = slots[i];
      let d = Math.hypot(s.x + s.w / 2 - point.x, s.y + s.h / 2 - point.y);
      if (d < bestDistance) { best = i; bestDistance = d; }
    });
    return best;
  }

  // The axis entries are laid out along (null: both, a grid)
  protected crossAxis():'x' | 'y' | null {
    return null;
  }

  // Share of the slot inside the viewport along every scrolled axis ≥ `fraction`
  visible(slot:Slot, fraction:number):boolean {
    return this.scrollAxes().every(axis => {
      let view = this.mover.viewport(this.host, axis);
      return axis == 'left'
        ? visibleFraction(slot.x, slot.w, view.scroll, view.size) >= fraction
        : visibleFraction(slot.y, slot.h, view.scroll, view.size) >= fraction;
    });
  }

  // Where key navigation picks up after mouse scrolling (§6.3 of the plan):
  // the on-screen entry nearest to the alignment point
  alignedVisibleEntry():HTMLElement | null {
    let entries = this.navigableEntries();
    let slots = entries.map(e => this.slotOf(e));
    let visible = slots.map((s, i) => i).filter(i => this.visible(slots[i], .5));
    if (!visible.length) return null;
    let axis = this.crossAxis() || 'y';
    let view = this.mover.viewport(this.host, axis == 'x' ? 'left' : 'top');
    let size = view.size, scroll = view.scroll;
    let align = this.alignFor(axis == 'x' ? 'left' : 'top');
    let point = scroll + (align == 'start' ? 0 : align == 'third' ? size / 3 : size / 2);
    let start = (i:number) => axis == 'x' ? slots[i].x : slots[i].y;
    let best = visible[0], bestDistance = Infinity;
    visible.forEach(i => {
      let s = slots[i];
      let d = align == 'start' ? Math.abs(start(i) - point) : Math.abs(start(i) + (axis == 'x' ? s.w : s.h) / 2 - point);
      if (d < bestDistance) { best = i; bestDistance = d; }
    });
    return entries[best];
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  // `entry` (this container's entry holding the focused `item`) got focus
  focused(entry:HTMLElement, cause:FocusCause, previous:HTMLElement | null) {
    let entries = this.navigableEntries();
    let index = entries.indexOf(entry);
    // (an element that isn't an entry, e.g. a keyboard key inside a page
    // stack, is only revealed)
    if (cause != 'pointer' && index >= 0) this.remember(entry, index);
    if (this.loadAhead > 0 && index >= 0 && index >= entries.length - this.loadAhead) this.emitNearEnd();
    if (cause == 'pointer' || cause == 'select') return;
    // a row entered from elsewhere lines up at once; moves along it glide
    let instant = cause == 'restore' || (this.kind != 'stack' && !(previous && this.host.contains(previous)));
    this.reveal(entry, instant);
  }

  remember(entry:HTMLElement, index:number) {
    let key = this.storeKey;
    if (key) this.positions.save(key, { key: this.entryKey(entry) ?? undefined, index });
  }

  reveal(entry:HTMLElement, instant = false) {
    this.beforeReveal();
    let block = this.blockOf(entry);
    let target:{ left?:number, top?:number } = {};
    this.scrollAxes().forEach(axis => {
      target[axis] = alignedScroll(this.mover.viewport(this.host, axis), boxOf(block, this.host, axis), this.alignFor(axis));
    });
    this.moveTo(target, instant);
  }

  // The wheel on a 'transform' container (the browser can't scroll it): one
  // entry further (a row of a stack, a poster of a row), focus unchanged
  wheelStep(step:number) {
    let axis = this.scrollAxes()[0];
    let view = this.mover.viewport(this.host, axis);
    let stops = Array.from(new Set(this.navigableEntries().map(entry =>
      alignedScroll(view, boxOf(this.blockOf(entry), this.host, axis), this.alignFor(axis))))).sort((a, b) => a - b);
    if (!stops.length) return;
    let current = stops.reduce((best, stop, i) => Math.abs(stop - view.scroll) < Math.abs(stops[best] - view.scroll) ? i : best, 0);
    let next = Math.max(0, Math.min(stops.length - 1, current + step));
    if (stops[next] != view.scroll) this.moveTo({ [axis]: stops[next] });
  }

  // Row paddles: by a screenful
  protected moveBy(delta:{ left?:number, top?:number }) {
    this.mover.moveBy(this.host, delta);
    this.afterMove();
  }

  protected moveTo(target:{ left?:number, top?:number }, instant = false) {
    this.mover.moveTo(this.host, target, { instant });
    this.afterMove();
  }

  // A translated track fires no scroll events: do their work here
  private afterMove() {
    if (this.mover.kind == 'transform') this.onScroll();
  }

  // Back to the first entry (remembered) and the start, without focusing it
  home() {
    let first = this.navigableEntries()[0];
    if (first) this.remember(first, 0);
    let target:{ left?:number, top?:number } = {};
    this.scrollAxes().forEach(axis => target[axis] = 0);
    this.moveTo(target);
  }

  // Focus the remembered entry (or the first one on screen); false when empty
  focusRemembered(cause:FocusCause = 'restore'):boolean {
    let target = this.enterFrom(null);
    return target ? this.engine.focus(target, cause) : false;
  }

  protected beforeReveal() { }

  // ── scrolling ─────────────────────────────────────────────────────────────

  private onScroll = () => {
    this.updateEdges();
    this.checkScrollEnd();
    clearTimeout(this.saveTimer);
    // the history entry it scrolled in (the navigator may move on meanwhile)
    let scope = this.positions.scope;
    this.saveTimer = setTimeout(() => this.saveScroll(scope), SAVE_DELAY);
  }

  private saveScroll(scope:string) {
    let key = this.storeKey;
    if (!key || !this.host.isConnected || !this.host.clientWidth) return;
    let patch = {};
    this.scrollAxes().forEach(axis => patch[axis == 'left' ? 'scrollLeft' : 'scrollTop'] = this.mover.offset(this.host, axis));
    this.positions.save(key, patch, scope);
  }

  protected contentChanged() {
    this.afterContent();
    if (!this.restored && this.entries().length) {
      this.restored = true;
      let saved = this.storeKey && this.positions.get(this.storeKey);
      if (saved) this.mover.moveTo(this.host, { left: saved.scrollLeft, top: saved.scrollTop }, { instant: true });
    }
    this.updateEdges();
  }

  protected afterContent() { }

  // `atStart` / `atEnd` from the real position (the rowArrows chevrons follow `edges`)
  protected updateEdges() {
    let view = this.mover.viewport(this.host, this.scrollAxes()[0]);
    let start = view.scroll <= 1;
    let end = view.scroll >= maxScroll(view) - 1;
    this.host.classList.toggle('atStart', start);
    this.host.classList.toggle('atEnd', end);
    let now = this.edges.value;
    if (now.start != start || now.end != end) this.edges.next({ start, end });
  }

  private checkScrollEnd() {
    if (this.loadAhead <= 0 && this.loadAheadPx === null) return;
    let view = this.mover.viewport(this.host, this.scrollAxes()[0]);
    let remaining = maxScroll(view) - view.scroll;
    if (remaining <= (this.loadAheadPx ?? view.size)) this.emitNearEnd();
  }

  private emitNearEnd() {
    let now = performance.now();
    if (now - this.lastNearEnd < NEAR_END_THROTTLE) return;
    this.lastNearEnd = now;
    this.zone.run(() => this.nearEnd.emit());
  }
}
