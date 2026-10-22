import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// A full-screen page over the shell (docs/ui-system-plan.md §5.4): "Who's
// watching?", the profile editor, /connect, the first start's display size.
// The plain ground to the screen's edge, the brand top left, the content
// inside the screen edges (§13.1), centred unless `center` is false; above
// the shell and its menu (--px-z-root-page), under the splash and connection
// lost. Sections stay the page's (pxSection on what it projects).
//
//   <px-fullscreen-layout><div class="content" pxSection="profiles">…</div></px-fullscreen-layout>
@Component({
  selector: 'px-fullscreen-layout',
  template: `
    <img *ngIf="brand" class="px-brand" src="assets/icons/logo_full.svg" alt="Playpex">
    <div class="px-fullscreen-body" [class.center]="center"><ng-content></ng-content></div>`,
  styleUrls: ['./px-fullscreen-layout.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxFullscreenLayoutComponent {
  @Input() brand = true;
  @Input() center = true;
}
