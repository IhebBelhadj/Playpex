import { AfterViewInit, Directive, ElementRef, EventEmitter, HostBinding, Input, OnDestroy, Output } from '@angular/core';
import { LayerRef, LayerStack, LAYER_PRIORITY } from '../../nav/public-api';

// ms after opening: the focus is taken back if something outside got it
const REGRAB_DELAY = 400;

// How high an overlay sits: its layer priority (who gets the input) and its
// z-index (--px-z-<level>: what is drawn on top). Same order for both, except
// panels, which are drawn over modals: they are their screen's own full-screen
// steps and never open over another layer's modal.
export type OverlayLevel = 'panel' | 'modal' | 'alert' | 'system';

export const LEVEL_PRIORITY:Record<OverlayLevel, number> = {
  panel: LAYER_PRIORITY.panel,
  modal: LAYER_PRIORITY.modal,
  alert: LAYER_PRIORITY.alert,
  system: LAYER_PRIORITY.system,
};

// What <px-dialog> and <px-panel> share: open while they exist (put *ngIf on
// them), a layer of the nav system meanwhile (src/app/nav: select and back
// are theirs, the screen behind gets neither), a trapping pxSection named
// `id`, the focus on their first item when they open and back where it was
// when they go.
//
//   (back)    listened to: Back is the host's, the overlay stays open
//             (a panel that cancels, a step that can't be left while saving)
//   (closed)  otherwise Back closes it, and so does leaving its screen: the
//             host drops its state (the *ngIf), nothing else to clean up
//
// Select: (pxSelect) on the items, or on a wrapper ($event = the focused item).
// The focus stays inside: a page behind that takes it (its own reaction to
// what opened the overlay, the screen restored after a navigation) loses it
// again shortly after opening, and select brings it back first.
@Directive()
export abstract class PxOverlay implements AfterViewInit, OnDestroy {

  @Input() id = '';
  @Input() level:OverlayLevel = 'modal';
  // survives navigation (connection lost, error notifications)
  @Input() global = false;
  // CSS selector of what to focus on open (default: the first item)
  @Input() focus = '';
  @Input() restoreFocus = true;
  @Output() back = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  // a static title="…" (the input of both) would also stay on the host as
  // an attribute: a browser tooltip over the whole screen
  @HostBinding('attr.title') readonly tooltip = null;

  layer:LayerRef | null = null;
  private quiet = false;
  private regrab:any;

  constructor(protected host:ElementRef<HTMLElement>, private layers:LayerStack) { }

  ngAfterViewInit(): void {
    let layer = this.layer = this.layers.open({
      id: this.id,
      priority: LEVEL_PRIORITY[this.level],
      global: this.global,
      element: this.host.nativeElement,
      restoreFocus: this.restoreFocus,
    });
    if (this.back.observed) layer.onBack(() => {
      this.back.emit();
      return true;
    });
    layer.onSelect(el => {
      if (layer.contains(el)) return false;
      this.focusItem();
      return true;
    });
    layer.result$.subscribe({ complete: () => {
      this.layer = null;
      clearTimeout(this.regrab);
      if (!this.quiet) this.closed.emit();
    } });
    this.focusItem();
    this.regrab = setTimeout(() => {
      if (this.layer === layer && !layer.contains(document.activeElement)) this.focusItem();
    }, REGRAB_DELAY);
  }

  ngOnDestroy(): void {
    this.finish();
  }

  // Done, closed by the host before it acts on the choice: the focus goes back
  // first (what the choice opens next remembers that one), no (closed)
  finish() {
    this.quiet = true;
    this.layer?.close();
  }

  // `selector` (default: the `focus` input), else the first item
  focusItem(selector = this.focus) {
    setTimeout(() => {
      let root = this.host.nativeElement;
      let el = (selector && root.querySelector(selector)) || root.querySelector('[data-px-item], .focusable');
      // through the focus engine: `.focused` even when the window isn't focused
      if (el) this.layers.focus(el as HTMLElement);
    }, 0);
  }
}
