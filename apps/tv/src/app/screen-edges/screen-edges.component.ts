import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { applySafeArea } from '../ui/public-api';

// Screen edges calibration (docs/ui-system-plan.md §13.1): many TVs crop the
// picture's edges and nothing can detect it. A full-screen panel with a frame
// and four corner marks at the current inset; ←/→ on the slider move them in
// or out (the whole UI follows at once: the screen is the preview), Enter
// keeps it, Back puts the previous one back. Stored by the host (the device
// setting display.safeArea).
//
//   <screen-edges *ngIf="adjusting" [value]="settings.value('display.safeArea')" (done)="…" (cancelled)="…"></screen-edges>
@Component({
  selector: 'screen-edges',
  templateUrl: './screen-edges.component.html',
  styleUrls: ['./screen-edges.component.scss'],
})
export class ScreenEdgesComponent implements OnInit, OnDestroy {

  // 0–0.06 of each dimension
  @Input() value = 0;
  @Output() done = new EventEmitter<number>();
  @Output() cancelled = new EventEmitter<void>();

  percent = 0;
  private kept = false;
  readonly format = (v:number) => v == 0 ? 'None' : v.toLocaleString('en', { maximumFractionDigits: 1 }) + ' %';

  ngOnInit(): void {
    this.percent = Math.round((this.value || 0) * 1000) / 10;
  }

  ngOnDestroy(): void {
    // left without Enter: the stored value again
    if (!this.kept) applySafeArea(this.value);
  }

  preview(percent:number) {
    this.percent = percent;
    applySafeArea(percent / 100);
  }

  keep() {
    this.kept = true;
    this.done.emit(Math.round(this.percent * 10) / 1000);
  }

  cancel() {
    applySafeArea(this.value);
    this.cancelled.emit();
  }
}
