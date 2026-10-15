import { Directive, ElementRef, Input, OnChanges, OnInit } from '@angular/core';

// A focusable item of a movement container (pxRow / pxGrid / pxStack). Its
// index is its DOM order among the container's items; `pxItemKey` is the
// stable id PositionStore remembers it by (indexes shift when data changes).
// The element must still match a spatial-navigation section (pxSection or a
// page's own) so hover and click keep working. `.focused` stays AppComponent's.
@Directive({
  selector: '[pxItem]'
})
export class PxItemDirective implements OnInit, OnChanges {

  @Input() pxItemKey:string | number | null = null;

  constructor(private el:ElementRef<HTMLElement>) { }

  ngOnInit(): void {
    this.el.nativeElement.setAttribute('data-px-item', '');
  }

  ngOnChanges(): void {
    let host = this.el.nativeElement;
    if (this.pxItemKey === null || this.pxItemKey === undefined) host.removeAttribute('data-px-key');
    else host.setAttribute('data-px-key', String(this.pxItemKey));
  }
}

// The block a pxStack aligns for one of its entries: a row's section with its
// title, rather than the bare row of posters
@Directive({
  selector: '[pxStackItem]'
})
export class PxStackItemDirective implements OnInit {

  constructor(private el:ElementRef<HTMLElement>) { }

  ngOnInit(): void {
    this.el.nativeElement.setAttribute('data-px-stack-item', '');
  }
}

// The part of a 'transform' container that moves (motion.ts): a stack's
// wrapper of rows, when the container also holds things that must stay put
@Directive({
  selector: '[pxTrack]'
})
export class PxTrackDirective implements OnInit {

  constructor(private el:ElementRef<HTMLElement>) { }

  ngOnInit(): void {
    this.el.nativeElement.setAttribute('pxTrack', '');
  }
}
