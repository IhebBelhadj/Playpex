import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// How far in, in amber (the app's progress colour): `bar` = a 3 dp line on a
// track (cards, tiles, the title info's resume line), `line` = the bare amber
// line without its track. Not focusable.
//
//   <px-progress [value]="0.42"></px-progress>
@Component({
  selector: 'px-progress',
  template: `<span class="fill" [style.width.%]="clamped * 100"></span>`,
  styleUrls: ['./px-progress.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'progressbar', '[attr.aria-valuenow]': 'clamped', 'aria-valuemin': '0', 'aria-valuemax': '1', '[class.line]': "variant == 'line'" },
})
export class PxProgressComponent {
  // 0–1
  @Input() value:number | null = 0;
  @Input() variant:'bar' | 'line' = 'bar';

  get clamped():number {
    return Math.min(1, Math.max(0, this.value || 0));
  }
}
