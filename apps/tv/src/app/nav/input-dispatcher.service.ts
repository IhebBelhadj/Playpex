import { Injectable } from '@angular/core';
import { LayerRef, LayerStack } from './layer-stack.service';
import { Navigator } from './navigator.service';

// select (Enter, a click), back (Escape, right click, the mouse's back
// button) and leave (the shell's Back button: out of the screen at once)
export type NavAction = 'select' | 'back' | 'leave';
export type InputSource = 'key' | 'pointer' | 'button' | 'remote';

export interface Selectable {
  fire(el:HTMLElement):void;
}

// The one entry point of select / back / leave (docs/navigation-system-plan.md
// §5.4, §5.6). An action goes to exactly one owner: the top layer, else the
// shown entry's screen (then its frame), else the navigator. Arrows aren't
// dispatched: they stay with spatial navigation and the movement system.
//
//   select  the nearest (pxSelect) around the focused element inside the
//           owner, else the owner's onSelect handlers
//   back    top layer → layer.back(); else the screen's onBack steps (last
//           registered first), then navigator.back() (pop, or the root's policy)
//   leave   top layer → layer.back(); else onLeave handlers, then navigator.back()
@Injectable({
  providedIn: 'root'
})
export class InputDispatcher {

  private selectables = new WeakMap<Element, Selectable>();

  constructor(private navigator:Navigator, private layers:LayerStack) { }

  registerSelect(el:Element, target:Selectable) {
    this.selectables.set(el, target);
  }

  unregisterSelect(el:Element, target:Selectable) {
    if (this.selectables.get(el) === target) this.selectables.delete(el);
  }

  dispatch(action:NavAction, source:InputSource = 'key'):boolean {
    // the screen is changing: what's shown now isn't what the key was meant for
    if (this.navigator.busy) return true;

    let layer = this.layers.top;
    if (layer) return this.toLayer(layer, action);

    let owners = this.navigator.owners();

    if (action == 'select') {
      let active = document.activeElement as HTMLElement;
      if (this.fireSelect(active, null)) return true;
      return !!active && owners.some(ref => ref.handleSelect(active));
    }

    let consumed = action == 'back'
      ? owners.some(ref => ref.handleBack())
      : owners.some(ref => ref.handleLeave());
    if (!consumed) this.navigator.back();
    return true;
  }

  private toLayer(layer:LayerRef, action:NavAction):boolean {
    if (action != 'select') {
      layer.back();
      return true;
    }
    let active = document.activeElement as HTMLElement;
    if (this.fireSelect(active, layer)) return true;
    if (active && layer.handleSelect(active)) return true;
    return true;
  }

  // The nearest (pxSelect) around `el`; inside the layer when one is open
  private fireSelect(el:HTMLElement | null, layer:LayerRef | null):boolean {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (layer && !layer.contains(node)) return false;
      let target = this.selectables.get(node);
      if (target) {
        target.fire(el);
        return true;
      }
    }
    return false;
  }
}
