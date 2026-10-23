import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as spatialNavigation from '../../plugins/spacialNavigation.js';
import { actionForKey } from '../keymap';
import { Direction } from './moves';
import type { PxContainer } from './px-container';

// Why an item got focus:
//   key     arrows (and focus moved by page code): remembered, scrolled with a glide
//   pointer mouse hover: never scrolls, doesn't change a row's remembered item
//   select  Enter / click on it: remembered, no scroll (the page opens something)
//   restore coming back to a page: remembered, scrolled instantly
export type FocusCause = 'key' | 'pointer' | 'select' | 'restore';
export type InputKind = 'keys' | 'pointer';

// A leaveFor target of pxSection / the menu: '@<section id>', a CSS selector,
// or a movement container by id: 'stack:<id>', 'row:<id>', 'grid:<id>'
// (entered at its remembered item). An array is a fallback chain: the first
// one with something focusable wins.
export type LeaveTarget = string | string[];
export type LeaveResolver = ((direction:Direction) => HTMLElement | false) & { targets:string[] };

const MOVE_INTERVAL = 12;      // ms: key repeats closer than a frame are dropped, not queued
const WHEEL_STEP = 40;         // px of wheel / trackpad travel per step of a translated container
const WHEEL_INTERVAL = 140;    // ms between two wheel steps
const WHEEL_RESET = 250;       // ms of quiet that starts a new gesture

// The movement system's core (see docs/movement-system-plan.md). Built on the
// vendored spatial-navigation library through its public hooks: for an arrow
// key it asks the focused item's movement containers (pxRow / pxGrid /
// pxStack, innermost first) for the next item by index and cancels the
// library's `sn:willmove`; when none has one (an edge), the library goes on
// with its geometry / `leaveFor` between sections. Every focus change is
// then handed to the containers to remember and scroll.
@Injectable({
  providedIn: 'root'
})
export class FocusEngine {

  readonly input = new BehaviorSubject<InputKind>('keys');

  private containers = new Map<HTMLElement, PxContainer>();
  private cause:FocusCause | null = null;
  private lastFocused:HTMLElement | null = null;
  private lastMove = 0;
  private handoff = false;
  private ready = false;
  private wheelTravel = { x: 0, y: 0 };
  private lastWheelEvent = 0;
  private lastWheelStep = 0;

  get lastInput():InputKind {
    return this.input.value;
  }

  init() {
    if (this.ready) return;
    this.ready = true;
    // capture: before the library's own keydown listener
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('sn:willmove', this.onWillMove, true);
    window.addEventListener('sn:focused', this.onFocused, true);
  }

  // ── containers ────────────────────────────────────────────────────────────

  register(container:PxContainer) {
    this.containers.set(container.host, container);
  }

  unregister(container:PxContainer) {
    if (this.containers.get(container.host) === container) this.containers.delete(container.host);
  }

  containerOf(el:Element | null):PxContainer | undefined {
    return el ? this.containers.get(el as HTMLElement) : undefined;
  }

  // The nearest container around `el` (not `el` itself)
  parentContainer(el:Element):PxContainer | undefined {
    let host = el.parentElement?.closest('[data-px-container]');
    return host ? this.containers.get(host as HTMLElement) : undefined;
  }

  // 'stack:watchlist' → that container
  find(ref:string):PxContainer | undefined {
    let match = /^(stack|row|grid):(.+)$/.exec(ref);
    if (!match) return undefined;
    for (let container of Array.from(this.containers.values())) {
      if (container.kind == match[1] && container.id == match[2] && document.contains(container.host)) return container;
    }
    return undefined;
  }

  // ── focus ─────────────────────────────────────────────────────────────────

  focus(el:HTMLElement, cause:FocusCause = 'key'):boolean {
    let previous = this.cause;
    this.cause = cause;
    try {
      return spatialNavigation.focus(el);
    } finally {
      this.cause = previous;
    }
  }

  // Back on a page: focus a container's remembered item, instantly in place
  restore(ref:string):boolean {
    return !!this.find(ref)?.focusRemembered('restore');
  }

  // A select (Enter, or a click: the pointer sends Enter) on an item that
  // only has the hover: remember it (no scroll, the page reacts)
  selected(el:HTMLElement) {
    this.chain(el, (container, entry) => container.focused(entry, 'select', this.lastFocused));
  }

  // The mouse moved / scrolled / clicked
  pointerActive() {
    if (this.input.value != 'pointer') this.input.next('pointer');
  }

  // The wheel over a 'transform' container (motion.ts), which the browser
  // can't scroll: vertical → its stack one row on, sideways (trackpad, tilt
  // wheel, shift + wheel) → its row one poster on. Focus doesn't move. True
  // when it's ours (the caller cancels the native scroll)
  wheel(e:WheelEvent):boolean {
    let start = (e.target as Element)?.closest?.('[data-px-motion="transform"]');
    if (!start) return false;

    let scale = e.deltaMode == WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode == WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
    let dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    let sideways = Math.abs(dx) > Math.abs(dy);

    let now = performance.now();
    if (now - this.lastWheelEvent > WHEEL_RESET) this.wheelTravel = { x: 0, y: 0 };
    this.lastWheelEvent = now;
    if (sideways) this.wheelTravel.x += dx;
    else this.wheelTravel.y += dy;

    let travel = sideways ? this.wheelTravel.x : this.wheelTravel.y;
    if (now - this.lastWheelStep < WHEEL_INTERVAL || Math.abs(travel) < WHEEL_STEP) return true;

    let kind = sideways ? 'row' : 'stack';
    let container = this.containerOf(start.closest('[data-px-container]'));
    while (container && !(container.kind == kind && container.motionKind == 'transform')) container = this.parentContainer(container.host);
    if (!container) return true;

    this.lastWheelStep = now;
    this.wheelTravel = { x: 0, y: 0 };
    container.wheelStep(travel > 0 ? 1 : -1);
    return true;
  }

  // ── leaveFor targets ──────────────────────────────────────────────────────

  // A library `leaveFor` value for `target` (resolved when leaving)
  target(target:LeaveTarget):LeaveTarget | LeaveResolver {
    let targets = Array.isArray(target) ? target : [target];
    if (targets.length == 1 && !/^(stack|row|grid):/.test(targets[0])) return targets[0];
    let resolver = ((direction:Direction) => this.resolveTarget(targets)) as LeaveResolver;
    resolver.targets = targets;
    return resolver;
  }

  resolveTarget(targets:string[]):HTMLElement | false {
    let origin = document.activeElement as HTMLElement;
    for (let target of targets) {
      let el:HTMLElement | null | undefined = null;
      if (target.charAt(0) == '@') el = spatialNavigation.navigableElements(target.slice(1))[0] && this.sectionEntry(target.slice(1));
      else if (/^(stack|row|grid):/.test(target)) el = this.find(target)?.enterFrom(origin);
      else el = (Array.from(document.querySelectorAll(target)) as HTMLElement[]).find(e => spatialNavigation.sectionOf(e));
      if (el) return el;
    }
    return false;
  }

  // Can a `leaveFor` value lead to `el` (in section `to`)? For the pointer,
  // which respects restricted sections the way the arrow keys do
  leads(dest:any, el:HTMLElement, to:string):boolean {
    let targets:string[] = typeof dest == 'string' ? [dest] : dest?.targets || [];
    return targets.some(target => {
      if (target.charAt(0) == '@') return target == '@' + to;
      if (/^(stack|row|grid):/.test(target)) return !!this.find(target)?.host.contains(el);
      return el.matches(target);
    });
  }

  // Can the keys get from section `from` to `el` (in section `to`), in as many
  // steps as it takes (settings → its rail → the menu)? Only through
  // restricted sections' `leaveFor`; an unrestricted one reaches anything
  reaches(from:string, el:HTMLElement, to:string):boolean {
    let seen = new Set<string>([from]);
    let queue = [from];
    while (queue.length) {
      let config = spatialNavigation.sectionConfig(queue.shift());
      if (!config || config.restrict != 'self-only') return true;
      let dests = Object.values(config.leaveFor || {});
      if (dests.some(dest => this.leads(dest, el, to))) return true;
      dests.forEach(dest => this.sectionsOf(dest).forEach(id => {
        if (!seen.has(id)) { seen.add(id); queue.push(id); }
      }));
    }
    return false;
  }

  // The sections a `leaveFor` value can lead into
  private sectionsOf(dest:any):string[] {
    let targets:string[] = typeof dest == 'string' ? [dest] : dest?.targets || [];
    let ids:string[] = [];
    targets.forEach(target => {
      if (target.charAt(0) == '@') { ids.push(target.slice(1)); return; }
      let els = /^(stack|row|grid):/.test(target)
        ? Array.from(this.find(target)?.host.querySelectorAll('[data-px-item], .focusable') || [])
        : Array.from(document.querySelectorAll(target));
      els.forEach(e => { let id = spatialNavigation.sectionOf(e); if (id) ids.push(id); });
    });
    return ids;
  }

  // Entering a section as the library would (last focused, default, first)
  private sectionEntry(sectionId:string):HTMLElement | null {
    let config = spatialNavigation.sectionConfig(sectionId);
    let list = spatialNavigation.navigableElements(sectionId) as HTMLElement[];
    let last = config?.lastFocusedElement as HTMLElement | undefined;
    if (config?.enterTo == 'last-focused' && last && list.includes(last)) return last;
    return list[0] || null;
  }

  // ── events ────────────────────────────────────────────────────────────────

  private onKeyDown = (e:KeyboardEvent) => {
    let action = actionForKey(e);
    if (action == 'select' && document.activeElement) this.selected(document.activeElement as HTMLElement);
    if (!e.isTrusted) return;           // the pointer's synthetic keys
    if (action == 'up' || action == 'down' || action == 'left' || action == 'right') {
      this.handoff = this.handoff || this.input.value == 'pointer';
    }
    if (this.input.value != 'keys') this.input.next('keys');
  }

  private onWillMove = (e:CustomEvent) => {
    let from = e.target as HTMLElement;
    let direction = e.detail?.direction as Direction;
    if (!direction || !this.parentContainer(from)) {
      this.handoff = false;
      return;
    }

    let now = performance.now();
    if (now - this.lastMove < MOVE_INTERVAL) {
      e.preventDefault();
      return;
    }
    this.lastMove = now;

    // first key after the mouse scrolled the view: carry on from what's on
    // screen instead of jumping back to where the focus was left
    let start = from;
    if (this.handoff) {
      this.handoff = false;
      let replacement = this.onScreen(from) ? null : this.alignedOnScreen(from);
      if (replacement && replacement !== from && this.focus(replacement, 'key')) start = replacement;
    }

    let next = this.next(start, direction);
    if (next && this.focus(next, 'key')) {
      e.preventDefault();
    } else if (start !== from) {
      // landed on the on-screen item; the library would move from the old one
      e.preventDefault();
    }
  }

  private onFocused = (e:Event) => {
    let el = e.target as HTMLElement;
    let cause = this.cause || 'key';
    let previous = this.lastFocused;
    this.lastFocused = el;
    this.chain(el, (container, entry) => container.focused(entry, cause, previous));
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  // `fn(container, entry)` for every container around `el`, innermost first
  private chain(el:HTMLElement, fn:(container:PxContainer, entry:HTMLElement) => void) {
    let entry = el;
    for (let container = this.parentContainer(el); container; container = this.parentContainer(container.host)) {
      fn(container, entry);
      entry = container.host;
    }
  }

  // Next item from `from`: the innermost container that has one wins
  private next(from:HTMLElement, direction:Direction):HTMLElement | null {
    let entry = from;
    for (let container = this.parentContainer(from); container; container = this.parentContainer(container.host)) {
      let next = container.move(entry, direction, from);
      if (next) return next;
      entry = container.host;
    }
    return null;
  }

  // The item is on screen: whole inside rows / grids, at least a third
  // inside stacks (a row peeking in under the current one still counts)
  private onScreen(el:HTMLElement):boolean {
    let ok = true;
    this.chain(el, (container, entry) => {
      if (!ok) return;
      let slot = container.slotOf(entry);
      ok = container.visible(slot, container.kind == 'stack' ? .33 : .98);
    });
    return ok;
  }

  // From the outermost container down: the on-screen entry nearest to each
  // container's alignment point
  private alignedOnScreen(el:HTMLElement):HTMLElement | null {
    let outer:PxContainer | undefined;
    for (let c = this.parentContainer(el); c; c = this.parentContainer(c.host)) outer = c;
    let container = outer;
    while (container) {
      let entry = container.alignedVisibleEntry();
      if (!entry) return null;
      let nested = this.containerOf(entry);
      if (!nested) return entry;
      container = nested;
    }
    return null;
  }
}
