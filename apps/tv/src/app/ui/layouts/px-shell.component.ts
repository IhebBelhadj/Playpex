import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// The app's frame (docs/ui-system-plan.md §5.4), in app.component.html: the
// shell row (menu rail + the page, the overlays' hosts, the back button and
// the clock), inside the screen edges (§13.1), themed by the shown screen's
// accent (data-px-accent); behind it the backdrop: its gradient, the title's
// picture (projected: `pxShellBackdrop`, crossfaded by AppComponent) and the
// overlay that darkens it towards the menu.
//
//   <px-shell [accent]="accent">
//     <menu pxShellMenu></menu> …overlay hosts… <router-outlet></router-outlet> <clock></clock>
//     <img pxShellBackdrop class="background_img newBackground">
//   </px-shell>
//
// `.masterContainer` keeps its name: pages animate it (GSAP, a title opening).
@Component({
  selector: 'px-shell',
  template: `
    <div class="masterContainer" [attr.data-px-accent]="accent">
      <ng-content select="[pxShellMenu]"></ng-content>
      <ng-content></ng-content>
    </div>
    <div class="overlay"></div>
    <ng-content select="[pxShellBackdrop]"></ng-content>
    <div class="background"></div>`,
  styleUrls: ['./px-shell.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxShellComponent {
  @Input() accent:string | null = null;
}
