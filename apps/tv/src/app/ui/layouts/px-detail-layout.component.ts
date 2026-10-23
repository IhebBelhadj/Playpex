import { ChangeDetectionStrategy, Component } from '@angular/core';

// A title page beside the menu (docs/ui-system-plan.md §5.4): the movie,
// show and episode pages (inside movies-page) and plugins' title pages. The title
// info on top, the action tiles at the bottom of the first screen, the rows
// below: a column that scrolls, the screen's height (inside its edges), at the
// page gutter. Put the page's pxStack (scroll motion) on it: revealing the
// first entry scrolls back to the top, so the title info shows again.
//
//   <px-detail-layout class="pluginTitle" pxSection="pluginTitle" pxStack>…</px-detail-layout>
@Component({
  selector: 'px-detail-layout',
  template: '<ng-content></ng-content>',
  styleUrls: ['./px-detail-layout.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxDetailLayoutComponent { }
