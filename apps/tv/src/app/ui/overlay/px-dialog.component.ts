import { Component, ElementRef, Input } from '@angular/core';
import { LayerStack } from '../../nav/public-api';
import { dp } from '../units';
import { PxOverlay } from './px-overlay';

// A modal: blurred scrim, a centred panel with a title, a subtitle and a
// one-column list of <px-option>s (or anything with pxItem) that scrolls
// natively when long. Open while it exists (see PxOverlay):
//
//   <px-dialog *ngIf="request" id="torrentPicker" title="Choose a torrent" [subtitle]="…"
//              [width]="560" (closed)="cancel()">
//     <px-option *ngFor="let o of options" [key]="o.id" [label]="o.label" (pxSelect)="pick(o)"></px-option>
//   </px-dialog>
//
// `level` modal (default) / alert / system (stronger scrim); `focus` a CSS
// selector, e.g. '[data-px-key="retry"]'. For a plain choice from code
// (a plugin, a confirmation) use the Dialogs service instead.
@Component({
  selector: 'px-dialog',
  templateUrl: './px-dialog.component.html',
  styleUrls: ['./px-dialog.component.scss'],
})
export class PxDialogComponent extends PxOverlay {

  @Input() title = '';
  @Input() subtitle = '';
  @Input() subtitleTone:'' | 'caution' = '';
  // of the content, in design pixels (dp)
  @Input() width = 480;

  readonly dp = dp;

  constructor(host:ElementRef<HTMLElement>, layers:LayerStack) {
    super(host, layers);
  }

  // New content in an open dialog: back to the top, first item focused
  reset() {
    let body = this.host.nativeElement.querySelector('.px-dialog-body');
    if (body) body.scrollTop = 0;
    this.focusItem();
  }
}
