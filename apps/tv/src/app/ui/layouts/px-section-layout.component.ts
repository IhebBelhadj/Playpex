import { ChangeDetectionStrategy, Component } from '@angular/core';

// A section page beside the menu (docs/ui-system-plan.md §5.4): the movies /
// TV lists, the watch list, a plugin's catalog. A column the screen's height
// (inside its edges), at the page gutter from the menu: the toolbar and the
// title info on top, the rows at the bottom (the page puts margin-top: auto,
// or flex: 1 on what's above them). Rows next to the menu clip their own
// sides (the movement guide's "rows next to the menu").
//
//   <px-section-layout class="libraryPage" pxSection="library" [leaveFor]="…">…</px-section-layout>
@Component({
  selector: 'px-section-layout',
  template: '<ng-content></ng-content>',
  styleUrls: ['./px-section-layout.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxSectionLayoutComponent { }
