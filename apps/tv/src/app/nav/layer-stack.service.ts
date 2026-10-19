import { Injectable } from '@angular/core';
import { BehaviorSubject, filter, Observable, Subject } from 'rxjs';
import * as spatialNavigation from '../../plugins/spacialNavigation.js';
import { FocusEngine } from '../movement/focus-engine.service';
import { Navigator } from './navigator.service';
import { Entry } from './screen';

// Something drawn above the current screen that takes input while open
// (docs/navigation-system-plan.md §5.5): modals (connection lost, torrent
// picker, play choice, error notification) and panels (text keyboard, PIN
// pad, filter panels, editor panels, pairing). While a layer is open, the
// screen behind gets no select / back at all: no "a panel is open" flags.
//
// Priorities: a higher one stays on top whatever the opening order
// (connection lost above an open torrent picker).
export const LAYER_PRIORITY = {
  panel: 0,         // a screen's own panels
  modal: 10,        // pickers, choices
  alert: 20,        // the error notification
  system: 30,       // connection lost
};

export interface LayerDef {
  id: string;
  priority?: number;
  // where its (pxSelect) items are; a function when it renders after opening
  element?: HTMLElement | (() => HTMLElement | null);
  // global: survives navigation (connection lost, notifications); otherwise
  // owned by the shown entry and closed when another screen covers it
  global?: boolean;
  // focus back where it was on close (default true)
  restoreFocus?: boolean;
}

export class LayerRef<R = unknown> {

  closed = false;
  readonly owner:Entry | null;
  readonly order:number;
  private result = new Subject<R>();
  private selectHandlers:((el:HTMLElement) => boolean | void)[] = [];
  private backHandlers:(() => boolean)[] = [];
  private previousFocus:Element | null;

  constructor(readonly def:LayerDef, private stack:LayerStack, owner:Entry | null, order:number) {
    this.owner = owner;
    this.order = order;
    this.previousFocus = document.activeElement;
  }

  // emits the result once, or completes empty when cancelled
  get result$():Observable<R> {
    return this.result.asObservable();
  }

  get priority():number {
    return this.def.priority ?? LAYER_PRIORITY.panel;
  }

  get element():HTMLElement | null {
    let el = this.def.element;
    return typeof el == 'function' ? el() : el || null;
  }

  onSelect(fn:(el:HTMLElement) => boolean | void) {
    this.selectHandlers.push(fn);
  }

  // true = consumed; when none consumes, back closes the layer
  onBack(fn:() => boolean) {
    this.backHandlers.push(fn);
  }

  close(result?:R, restoreFocus = true) {
    if (this.closed) return;
    this.closed = true;
    let wasTop = this.stack.top === this;
    this.stack.remove(this);
    if (restoreFocus && wasTop && this.def.restoreFocus !== false) this.restore();
    if (result !== undefined) this.result.next(result);
    this.result.complete();
  }

  back() {
    for (let i = this.backHandlers.length - 1; i >= 0; i--) if (this.backHandlers[i]()) return;
    this.close();
  }

  handleSelect(el:HTMLElement):boolean {
    return this.selectHandlers.some(fn => fn(el) !== false);
  }

  contains(el:Element | null):boolean {
    let host = this.element;
    return !!host && !!el && host.contains(el);
  }

  private restore() {
    let el = this.previousFocus as HTMLElement;
    let active = document.activeElement;
    // something else took the focus meanwhile (the host moved it): keep that
    if (active && active !== document.body && !this.contains(active)) return;
    if (el && el.isConnected && el !== document.body) this.stack.focus(el);
    // it went with a screen meanwhile (an error popup after the player left)
    else this.stack.focusScreen();
  }
}

@Injectable({
  providedIn: 'root'
})
export class LayerStack {

  readonly layers$ = new BehaviorSubject<readonly LayerRef[]>([]);
  private order = 0;

  constructor(private navigator:Navigator, private engine:FocusEngine) {
    // a screen covered or left: its layers close (no focus restore, the
    // next screen focuses its own)
    navigator.events$.pipe(filter(e => e.type == 'navigated')).subscribe(() => {
      let top = navigator.current;
      this.layers$.value.filter(layer => layer.owner && layer.owner !== top).forEach(layer => layer.close(undefined, false));
    });
  }

  get top():LayerRef | null {
    let layers = this.layers$.value;
    return layers[layers.length - 1] || null;
  }

  get layers():readonly LayerRef[] {
    return this.layers$.value;
  }

  open<R = unknown>(def:LayerDef):LayerRef<R> {
    let owner = def.global ? null : (this.navigator.activating || this.navigator.current);
    let ref = new LayerRef<R>(def, this, owner, this.order++);
    let layers = [...this.layers$.value, ref as LayerRef]
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
    this.layers$.next(layers);
    return ref;
  }

  // LayerRef.close()
  remove(ref:LayerRef) {
    this.layers$.next(this.layers$.value.filter(layer => layer !== ref));
  }

  focus(el:HTMLElement) {
    this.engine.focus(el, 'restore');
  }

  // What the shown screen had focused when it was covered, else the first
  // navigable element
  focusScreen() {
    let entry = this.navigator.current;
    if (entry && this.navigator.restoreFocus(entry)) return;
    spatialNavigation.focus();
  }
}
