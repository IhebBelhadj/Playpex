import { Directive, Input } from '@angular/core';
import { AXIS_OF, Direction, stepIndex, STEP_OF } from './moves';
import { PxContainer } from './px-container';
import { Align, Axis } from './scroller';

// A horizontal row that scrolls natively (overflow-x, hidden scrollbar):
// left / right move by index and the row glides to keep the focused item at
// `align` ('start': posters; 'third': cast, episodes; 'nearest': chips).
// Up / down are left to the parent pxStack. The chevrons of a `rowArrows`
// wrapper (row-arrows/) show where it's cut off (`edges`) and call `page(±1)`.
//
//   <div class="slider" rowArrows>
//     <div class="sliderSection" pxRow="popular" align="start" [loadAhead]="6" (nearEnd)="loadMore(row)">
//       <button *ngFor="…" pxItem [pxItemKey]="item.id">…</button>
//     </div>
//   </div>
@Directive({
  selector: '[pxRow]',
  exportAs: 'pxRow',
})
export class PxRowDirective extends PxContainer {

  override readonly kind = 'row';
  @Input('pxRow') override id = '';
  @Input() override align:Align = 'start';

  protected override scrollAxes():Axis[] {
    return ['left'];
  }

  protected override crossAxis():'x' {
    return 'x';
  }

  override move(from:HTMLElement, direction:Direction, origin:HTMLElement):HTMLElement | null {
    if (AXIS_OF[direction] != 'x') return null;
    let entries = this.navigableEntries();
    let next = stepIndex(entries.length, entries.indexOf(from), STEP_OF[direction], this.wrap);
    return next < 0 ? null : this.resolve(entries[next], origin);
  }

  // Row paddles (mouse): a screenful minus one item, keeping it for context.
  // Focus stays with the pointer
  page(direction:number) {
    let entries = this.entries();
    if (!entries.length) return;
    let step = entries.length > 1 ? entries[1].offsetLeft - entries[0].offsetLeft : entries[0].offsetWidth;
    this.moveBy({ left: direction * Math.max(step, this.host.clientWidth - step) });
  }
}
