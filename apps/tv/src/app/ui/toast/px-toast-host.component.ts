import { ChangeDetectionStrategy, Component } from '@angular/core';
import { iconUrl } from '../models';
import { Toasts } from './toasts.service';

// The Toasts service's messages, in the shell (app.component.html): bottom
// start, inside the screen edges, above the player's controls. Not focusable,
// `role="status"` (read politely by screen readers).
@Component({
  selector: 'px-toast-host',
  template: `
    <div class="px-toast" *ngIf="toasts.current$ | async as t" [attr.data-tone]="t.tone" role="status" aria-live="polite">
      <img *ngIf="t.icon" [src]="icon(t.icon)" alt="">
      <span class="dot" *ngIf="!t.icon"></span>
      <span class="body">
        <span class="text">{{ t.text }}</span>
        <span class="detail" *ngIf="t.detail">{{ t.detail }}</span>
      </span>
    </div>`,
  styleUrls: ['./px-toast-host.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxToastHostComponent {
  constructor(public toasts:Toasts) { }

  icon(name:string) {
    return iconUrl(name);
  }
}
