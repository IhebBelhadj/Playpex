import { Directive, Input } from '@angular/core';
import { AXIS_OF, Direction, stepIndex, STEP_OF } from './moves';
import { PxContainer } from './px-container';
import { Align, Axis } from './scroller';

export type StackAlign = 'row-top' | Align;

// A vertical sequence of focus targets (pxRow / pxGrid containers or single
// items) that scrolls natively (overflow-y, hidden scrollbar). Up / down go
// to the neighbour entry's remembered item (empty rows skipped); at the first
// / last entry the library takes over (`leaveFor`, e.g. up to a toolbar).
// `align`: 'row-top' puts the focused entry's block (its pxStackItem, e.g.
// the row's section with its title) at the top; 'nearest' scrolls just enough.
// `snap` (default: on for 'row-top'): mouse / trackpad scrolling settles with
// an entry's block at the top (CSS scroll snapping; the Scroller pauses it
// while it glides).
//
//   <div class="rows" pxStack="watchlist" align="row-top">
//     <section *ngFor="let row of rows" pxStackItem>
//       <h3>…</h3>
//       <div [pxRow]="row.key">…</div>
//     </section>
//   </div>
@Directive({
  selector: '[pxStack]',
  exportAs: 'pxStack',
})
export class PxStackDirective extends PxContainer {

  override readonly kind = 'stack';
  @Input('pxStack') override id = '';
  @Input() override align:StackAlign = 'nearest';
  @Input() snap:boolean | null = null;

  private endSpace:HTMLElement | null = null;

  protected override scrollAxes():Axis[] {
    return ['top'];
  }

  protected override crossAxis():'y' {
    return 'y';
  }

  protected override alignFor(axis:Axis):Align {
    return this.align == 'row-top' ? 'start' : this.align;
  }

  protected override blockOf(entry:HTMLElement):HTMLElement {
    let block = entry.closest('[data-px-stack-item]') as HTMLElement | null;
    return block && block !== this.host && this.host.contains(block) ? block : entry;
  }

  override move(from:HTMLElement, direction:Direction, origin:HTMLElement):HTMLElement | null {
    if (AXIS_OF[direction] != 'y') return null;
    let entries = this.navigableEntries();
    let next = stepIndex(entries.length, entries.indexOf(from), STEP_OF[direction], this.wrap);
    return next < 0 ? null : this.resolve(entries[next], origin);
  }

  // The first entry brings the stack back to its very start: whatever is
  // above it (a page's description, a search field) shows again
  override reveal(entry:HTMLElement, instant = false) {
    if (entry === this.navigableEntries()[0]) {
      this.beforeReveal();
      this.moveTo({ top: 0 }, instant);
      return;
    }
    super.reveal(entry, instant);
  }

  protected override afterContent() {
    this.fitEndSpace();
    this.markSnapPoints();
  }

  private markSnapPoints() {
    // a translated stack steps by rows already (FocusEngine.wheel)
    let snap = this.motionKind == 'scroll' && (this.snap ?? this.align == 'row-top');
    this.host.classList.toggle('px-snap-y', snap);
    if (snap) this.entries().forEach(entry => this.blockOf(entry).classList.add('px-snap-point'));
  }

  protected override beforeReveal() {
    this.fitEndSpace();
  }

  // 'row-top' must be able to bring the last row to the top too: room after it
  private fitEndSpace() {
    if (this.align != 'row-top') return;
    let entries = this.entries();
    if (!this.endSpace) {
      this.endSpace = document.createElement('div');
      this.endSpace.className = 'px-stack-end';
      this.endSpace.setAttribute('aria-hidden', 'true');
    }
    let track = this.mover.trackOf(this.host);
    if (this.endSpace.parentElement !== track || track.lastElementChild !== this.endSpace) track.appendChild(this.endSpace);
    let last = entries.length ? this.blockOf(entries[entries.length - 1]) : null;
    let room = last ? Math.max(0, this.host.clientHeight - last.offsetHeight) : 0;
    if (track !== this.host) room = Math.max(0, room - parseFloat(getComputedStyle(track).paddingBottom || '0'));
    this.endSpace.style.height = `${room}px`;
  }
}
