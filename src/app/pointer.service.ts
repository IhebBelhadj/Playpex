import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import * as spatialNavigation from '../plugins/spacialNavigation.js';
import { InputAction, KEY_BINDINGS } from './keymap';
import { FocusEngine } from './movement/focus-engine.service';

// Mouse support on top of the keyboard model. The pointer never gets its own
// code paths in the pages: hovering a navigable element focuses it through the
// spatial-navigation library, a click on it sends the `select` key, right click
// / the mouse "back" button send `back`. So every page keeps reacting to the
// same focus events and actions it already handles.
//
// The wheel: on pages migrated to the movement system (a `data-px-native-wheel`
// element is on screen) it scrolls natively, like a website: the stack
// vertically, rows sideways (trackpad, shift + wheel); over translated
// containers (`motion="transform"`) the FocusEngine steps them a row / a
// poster at a time. Focus only follows the next real mouse movement. On the
// other pages it still sends arrow keys.
//
// The cursor is hidden on any key press and comes back when the mouse moves
// (the first nudge only reveals it, so it doesn't steal focus from the keys).
//
// Pages that scroll rows on focus check `isPointerFocus()` and leave the row
// where it is: the row would otherwise slide away under the cursor.

let pointerFocusing = false;
export function isPointerFocus() { return pointerFocusing; }

// Elements (or containers) marked like this get the hover/focus but handle the
// click themselves, e.g. the player's progress bar seeks where it's clicked
export const OWN_CLICK_SELECTOR = '[data-pointer="own"]';

// Containers marked like this (rows peeking in below the current one) don't
// take focus on hover; a click brings them in as the arrow keys would, without
// selecting anything
export const NO_HOVER_SELECTOR = '[data-pointer-hover="off"]';

// Pages whose content scrolls natively (src/app/movement) carry this on their root
export const NATIVE_WHEEL_SELECTOR = '[data-px-native-wheel]';

// Row paddles of unmigrated pages: index of the item a screenful away from the first one shown in
// a row scrolled with `transform` (keeps one item of overlap for context)
export function pagedIndex(row:HTMLElement, items:HTMLElement[], viewportWidth:number, direction:number):number {
  if (items.length < 2) return -1;
  let step = items[1].offsetLeft - items[0].offsetLeft;
  let shownFrom = Math.round(-new DOMMatrix(getComputedStyle(row).transform).m41 / step);
  let perPage = Math.max(1, Math.floor(viewportWidth / step) - 1);
  let target = Math.min(items.length - 1, Math.max(0, shownFrom + direction * perPage));
  return target == shownFrom ? -1 : target;
}

const WHEEL_STEP = 40;        // px of wheel travel per arrow key
const WHEEL_INTERVAL = 140;   // ms between two wheel steps
const WHEEL_SETTLE = 350;     // ms without hover focus after a step (rows are sliding)
const SCROLL_SETTLE = 150;    // ms without hover focus after content scrolled under the cursor
const HIDDEN_CLASS = 'pointer-hidden';
const PRESSED_CLASS = 'pointer-pressed';

@Injectable({
  providedIn: 'root'
})
export class PointerService {

  visible = false;
  // false while a page uses the wheel natively (the player)
  wheelNavigation = true;
  // real mouse movement with the cursor visible
  moved = new Subject<MouseEvent>();

  private synthetic = new WeakSet<Event>();
  private wheelY = 0;
  private lastWheelStep = 0;
  private lastWheelEvent = 0;
  private hoverPausedUntil = 0;
  private lastX:number;
  private lastY:number;

  constructor(private zone:NgZone, private engine:FocusEngine) { }

  init(){
    document.body.classList.add(HIDDEN_CLASS);

    // mousemove/wheel fire constantly: keep them out of change detection; the
    // keys they send are handled by listeners registered inside the zone
    this.zone.runOutsideAngular(() => {
      window.addEventListener('keydown', this.onKey, true);
      document.addEventListener('mousemove', this.onMove);
      document.addEventListener('mousedown', this.onDown);
      document.addEventListener('mouseup', this.onUp);
      document.addEventListener('click', this.onClick);
      document.addEventListener('contextmenu', this.onContextMenu);
      document.addEventListener('dragstart', this.onDragStart);
      document.addEventListener('wheel', this.onWheel, { passive : false });
      document.addEventListener('scroll', this.onScroll, { passive : true, capture : true });
    });
  }

  show(){
    if (this.visible) return;
    this.visible = true;
    document.body.classList.remove(HIDDEN_CLASS);
  }

  hide(){
    if (!this.visible) return;
    this.visible = false;
    document.body.classList.add(HIDDEN_CLASS);
    document.body.classList.remove(PRESSED_CLASS);
  }

  // ── events ────────────────────────────────────────────────────────────────

  private onKey = (e:KeyboardEvent) => {
    if (!this.synthetic.has(e)) this.hide();
  }

  private onMove = (e:MouseEvent) => {
    // Chromium also sends mousemove when content moves under a still cursor
    if (e.clientX == this.lastX && e.clientY == this.lastY) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (!this.visible) {
      this.show();
      return;
    }
    this.moved.next(e);
    this.engine.pointerActive();
    if (performance.now() < this.hoverPausedUntil) return;

    let el = this.navigableFrom(e.target);
    if (el && el !== document.activeElement && !el.closest(NO_HOVER_SELECTOR) && this.canReach(el)) this.focus(el);
  }

  private onDown = (e:MouseEvent) => {
    this.show();
    this.engine.pointerActive();
    // no native focus (focus goes through the library) and no text selection
    if (!(e.target as Element).closest?.('input, textarea, select')) e.preventDefault();
    if (e.button == 0) document.body.classList.add(PRESSED_CLASS);
  }

  private onUp = (e:MouseEvent) => {
    document.body.classList.remove(PRESSED_CLASS);
    // side "back" button
    if (e.button == 3) {
      e.preventDefault();
      this.send('back');
    }
  }

  private onClick = (e:MouseEvent) => {
    if (e.button != 0) return;
    let el = this.navigableFrom(e.target);
    if (!el || !this.canReach(el)) return;

    // a peeking row comes in at its remembered item (.lastSelected), so it
    // doesn't also slide sideways
    let inert = el.closest(NO_HOVER_SELECTOR);
    if (inert) {
      spatialNavigation.focus(inert.querySelector('.lastSelected') || el);
      return;
    }

    if (el !== document.activeElement) this.focus(el);
    if (el !== document.activeElement) return;   // refused (willfocus cancelled)
    if (el.closest(OWN_CLICK_SELECTOR)) return;

    this.send('select', el);
  }

  private onContextMenu = (e:MouseEvent) => {
    e.preventDefault();
    this.show();
    this.send('back');
  }

  private onDragStart = (e:DragEvent) => {
    e.preventDefault();
  }

  // Wheel → up/down arrow keys, one step per notch (trackpads: per WHEEL_STEP
  // px). Vertical only: rows go sideways with the paddles or by hovering, and
  // the sideways part of a diagonal trackpad swipe made rows jump back and forth
  private onWheel = (e:WheelEvent) => {
    if (!this.wheelNavigation || e.ctrlKey) return;
    // translated rows / stacks (movement system): the engine steps them
    if (this.engine.wheel(e)) {
      e.preventDefault();
      this.show();
      this.engine.pointerActive();
      this.hoverPausedUntil = performance.now() + WHEEL_SETTLE;
      return;
    }
    if (document.querySelector(NATIVE_WHEEL_SELECTOR)) {
      // the browser scrolls the nearest scrollable container
      this.show();
      this.engine.pointerActive();
      this.hoverPausedUntil = performance.now() + SCROLL_SETTLE;
      return;
    }
    e.preventDefault();
    this.show();

    let scale = e.deltaMode == WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode == WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
    let dy = e.shiftKey ? 0 : e.deltaY * scale;

    let now = performance.now();
    if (now - this.lastWheelEvent > 250) this.wheelY = 0;
    this.lastWheelEvent = now;
    this.wheelY += dy;

    if (now - this.lastWheelStep < WHEEL_INTERVAL || Math.abs(this.wheelY) < WHEEL_STEP) return;

    this.lastWheelStep = now;
    this.hoverPausedUntil = now + WHEEL_SETTLE;
    let down = this.wheelY > 0;
    this.wheelY = 0;
    this.send(down ? 'down' : 'up');
  }

  // Content scrolling under a still cursor must not steal the focus: hover
  // waits until it settles and the mouse really moves again
  private onScroll = () => {
    this.hoverPausedUntil = Math.max(this.hoverPausedUntil, performance.now() + SCROLL_SETTLE);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  // The element (target or ancestor) the spatial navigation can focus
  private navigableFrom(node:EventTarget):HTMLElement {
    for (let el = node as HTMLElement; el && el !== document.body; el = el.parentElement) {
      if (spatialNavigation.sectionOf(el)) return el;
    }
    return undefined;
  }

  // A restricted section (modal, panel, keyboard overlay) can only be left
  // the ways its `leaveFor` allows, as with the arrow keys
  private canReach(el:HTMLElement):boolean {
    let current = document.activeElement as HTMLElement;
    let from = current && current !== document.body ? spatialNavigation.sectionOf(current) : undefined;
    let to = spatialNavigation.sectionOf(el);
    if (!from || from == to) return true;

    let config = spatialNavigation.sectionConfig(from);
    if (!config || config.restrict != 'self-only') return true;

    return Object.values(config.leaveFor || {}).some(dest => this.engine.leads(dest, el, to));
  }

  private focus(el:HTMLElement){
    pointerFocusing = true;
    try {
      this.engine.focus(el, 'pointer');
    } finally {
      pointerFocusing = false;
    }
  }

  // Same path as a key press: every handler sees an ordinary keydown/keyup
  private send(action:InputAction, target?:Element){
    let el = target || document.activeElement || document.body;
    let key = KEY_BINDINGS[action][0];
    ['keydown', 'keyup'].forEach(type => {
      let event = new KeyboardEvent(type, { key, bubbles : true, cancelable : true });
      this.synthetic.add(event);
      el.dispatchEvent(event);
    });
  }
}
