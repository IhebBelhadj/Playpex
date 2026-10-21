import { Component, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { DialogChoice, DialogRequest, Dialogs } from './dialogs.service';
import { PxDialogComponent } from './px-dialog.component';

// The Dialogs service's dialogs, in the shell (app.component.html)
@Component({
  selector: 'px-dialog-host',
  template: `
    <px-dialog *ngFor="let d of requests; trackBy: byId" #dialog
      [id]="d.id" [level]="d.level" [global]="!!d.global" [title]="d.title || ''" [subtitle]="d.subtitle || ''"
      [width]="d.width || 480" [focus]="focusOf(d)"
      (closed)="d.cancel()">
      <px-option *ngFor="let c of d.choices" [key]="c.key" [label]="c.label" [detail]="c.detail || ''"
        [progress]="c.progress ?? null" (pxSelect)="pick(dialog, d, c)"></px-option>
    </px-dialog>
  `,
})
export class PxDialogHostComponent implements OnDestroy {

  requests:readonly DialogRequest[] = [];
  private subscription:Subscription;

  constructor(dialogs:Dialogs) {
    this.subscription = dialogs.open$.subscribe(requests => this.requests = requests);
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  byId(_:number, request:DialogRequest) {
    return request.id;
  }

  focusOf(request:DialogRequest):string {
    return request.focus ? `[data-px-key="${request.focus}"]` : '';
  }

  pick(dialog:PxDialogComponent, request:DialogRequest, choice:DialogChoice) {
    dialog.finish();
    request.pick(choice);
  }
}
