import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy, OnInit } from '@angular/core';

export type SkeletonVariant = 'poster' | 'still' | 'portrait' | 'compact' | 'line' | 'block';

// The shape of content that hasn't arrived (docs/ui-system-plan.md §13.4): a
// dim block with a slow shimmer (still with reduced motion). Never focusable:
// a row of skeletons can't be entered. Shown only after `delay` ms, so fast
// answers don't flash. Sizes: the card variants' own; `line` / `block` take
// `width` / `height` (CSS lengths).
@Component({
  selector: 'px-skeleton',
  template: '',
  styleUrls: ['./px-skeleton.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class]': "'v-' + variant",
    '[class.shown]': 'shown',
    '[style.width]': 'width',
    '[style.height]': 'height',
  },
})
export class PxSkeletonComponent implements OnInit, OnDestroy {
  @Input() variant:SkeletonVariant = 'line';
  @Input() width:string | null = null;
  @Input() height:string | null = null;
  @Input() delay = 300;

  shown = false;
  private timer:any;

  constructor(private cdr:ChangeDetectorRef) { }

  ngOnInit(): void {
    if (this.delay <= 0) this.shown = true;
    // OnPush: the timer isn't an input change
    else this.timer = setTimeout(() => { this.shown = true; this.cdr.markForCheck(); }, this.delay);
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }
}
