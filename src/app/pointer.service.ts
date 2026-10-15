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
// The wheel scrolls natively, like a website (movement system,
// src/app/movement): a page's stack vertically, rows sideways (trackpad,
// shift + wheel); over translated containers (`motion="transform"`) the
// FocusEngine steps them a row / a poster at a time. Focus only follows the
// next real mouse movement; hovering never scrolls anything.
//
// The cursor is hidden on any key press and comes back when the mouse moves
// (the first nudge only reveals it, so it doesn't steal focus from the keys).

// Elements (or containers) marked like this get the hover/focus but handle the
// click themselves, e.g. the player's progress bar seeks where it's clicked
export const OWN_CLICK_SELECTOR = '[data-pointer="own"]';

const WHEEL_SETTLE = 350;     // ms without hover focus after a wheel step (content slides)
const SCROLL_SETTLE = 150;    // ms without hover focus after content scrolled under the cursor
const HIDDEN_CLASS = 'pointer-hidden';
const PRESSED_CLASS = 'pointer-pressed';

@Injectable({
  providedIn: 'root'
})
export class PointerService {

  visible = false;
  // false while a page handles the wheel itself (the player)
  wheelNavigation = true;
  // real mouse movement with the cursor visible
  moved = new Subject<MouseEvent>();

  private synthetic = new WeakSet<Event>();
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
    if (el && el !== document.activeElement && this.canReach(el)) this.focus(el);
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

  // The browser scrolls the nearest scrollable container; translated rows /
  // stacks (motion="transform") are stepped by the engine instead
  private onWheel = (e:WheelEvent) => {
    if (!this.wheelNavigation || e.ctrlKey) return;
    this.show();
    this.engine.pointerActive();
    if (this.engine.wheel(e)) {
      e.preventDefault();
      this.hoverPausedUntil = performance.now() + WHEEL_SETTLE;
    } else {
      this.hoverPausedUntil = Math.max(this.hoverPausedUntil, performance.now() + SCROLL_SETTLE);
    }
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

  // Hover focus: never scrolls, doesn't change what rows remember
  private focus(el:HTMLElement){
    this.engine.focus(el, 'pointer');
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
