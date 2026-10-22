import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ActionModel } from '../models';

// The line of action tiles of a title page: a pxGrid of <px-action>s, projected
// (the core's own) and / or from `actions` (view models: slots, plugins). A
// model's tile emits (picked) with its model; the host runs it.
//
//   <px-action-bar>
//     <px-action key="play" icon="play" label="Play" (pxSelect)="play()"></px-action>
//   </px-action-bar>
@Component({
  selector: 'px-action-bar',
  template: `
    <div class="px-action-bar" pxGrid role="toolbar">
      <ng-content></ng-content>
      <px-action *ngFor="let a of actions; trackBy: byKey" [key]="a.key" [icon]="a.icon" [label]="a.label"
        [on]="!!a.on" [progress]="a.progress ?? null" [busy]="!!a.busy" [disabled]="!!a.disabled"
        (pxSelect)="a.disabled || picked.emit(a)"></px-action>
    </div>`,
  styleUrls: ['./px-action-bar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxActionBarComponent {
  @Input() actions:ActionModel[] | null = null;
  @Output() picked = new EventEmitter<ActionModel>();

  byKey(i:number, a:ActionModel) { return a.key; }
}
