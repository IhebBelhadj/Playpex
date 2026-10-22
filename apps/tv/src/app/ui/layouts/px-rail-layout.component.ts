import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { dp } from '../units';

// A page of two regions side by side (docs/ui-system-plan.md §5.4): a rail of
// fixed width (filters, a list of groups) and the main region, each filling
// the height and scrolling on its own. Structure and sizes only: the page puts
// its pxSection (and leaveFor between them) on what it projects.
//
//   <px-rail-layout [railWidth]="300">
//     <div pxRail pxSection="settingsRail" [leaveFor]="{ right: '@settings' }">…</div>
//     <div pxMain pxSection="settings" [leaveFor]="{ left: '@settingsRail' }">…</div>
//   </px-rail-layout>
@Component({
  selector: 'px-rail-layout',
  template: `
    <div class="px-rail" [style.width]="width"><ng-content select="[pxRail]"></ng-content></div>
    <div class="px-main"><ng-content select="[pxMain]"></ng-content></div>`,
  styleUrls: ['./px-rail-layout.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxRailLayoutComponent {
  // dp
  @Input() railWidth = 320;

  get width():string {
    return dp(this.railWidth);
  }
}
