import { Directive, Input } from '@angular/core';
import { columnLines, Direction, gridLines, gridStep } from './moves';
import { PxContainer } from './px-container';
import { Align, Axis } from './scroller';

// A 2D (or one-column) list: chip grids, on-screen keyboards, the 18+ release
// list. Sideways moves stay on the visual line; up / down go to the nearest
// entry of the neighbour line (`columns="auto"` reads the lines from the
// layout, a number chunks the items). Scrolls natively on whichever axis
// overflows, with `align` ('nearest' by default, 'third' for long lists).
@Directive({
  selector: '[pxGrid]',
  exportAs: 'pxGrid',
})
export class PxGridDirective extends PxContainer {

  override readonly kind = 'grid';
  @Input('pxGrid') override id = '';
  @Input() override align:Align = 'nearest';
  @Input() columns:'auto' | number = 'auto';

  // the page's CSS decides whether a grid scrolls (keyboards don't)
  protected override styledAxes():Axis[] {
    return [];
  }

  protected override scrollAxes():Axis[] {
    let host = this.host;
    let axes:Axis[] = [];
    if (host.scrollHeight > host.clientHeight + 1 || getComputedStyle(host).overflowY != 'visible') axes.push('top');
    if (host.scrollWidth > host.clientWidth + 1) axes.push('left');
    return axes.length ? axes : ['top'];
  }

  override move(from:HTMLElement, direction:Direction, origin:HTMLElement):HTMLElement | null {
    let entries = this.navigableEntries();
    let slots = entries.map(e => this.slotOf(e));
    let lines = this.columns == 'auto' ? gridLines(slots) : columnLines(entries.length, Number(this.columns));
    let next = gridStep(slots, lines, entries.indexOf(from), direction, this.wrap);
    return next < 0 ? null : this.resolve(entries[next], origin);
  }
}
