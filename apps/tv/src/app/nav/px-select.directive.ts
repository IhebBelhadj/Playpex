import { Directive, ElementRef, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { InputDispatcher, Selectable } from './input-dispatcher.service';

// What select (Enter, a click) does on an element or on anything inside it:
//
//   <button class="play focusable" (pxSelect)="play()">Play</button>
//   <div class="row" (pxSelect)="open($event)">…posters…</div>   ($event = the focused element)
//
// The InputDispatcher fires the nearest one around the focused element, only
// inside the owner of the input (the top layer, else the shown screen).
@Directive({
  selector: '[pxSelect]'
})
export class PxSelectDirective implements OnInit, OnDestroy, Selectable {

  @Output() pxSelect = new EventEmitter<HTMLElement>();

  constructor(private el:ElementRef<HTMLElement>, private dispatcher:InputDispatcher) { }

  ngOnInit(): void {
    this.dispatcher.registerSelect(this.el.nativeElement, this);
  }

  ngOnDestroy(): void {
    this.dispatcher.unregisterSelect(this.el.nativeElement, this);
  }

  fire(el:HTMLElement) {
    this.pxSelect.emit(el);
  }
}
