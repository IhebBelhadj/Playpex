import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { applyFrame, MAX_EDGE, NO_FRAME, normalFrame, SCREEN_SHAPES, ScreenFrame, ScreenShape } from '../ui/public-api';

// The screen area's calibration (docs/web-client-plan.md §3.2, first built as
// "Screen edges", docs/ui-system-plan.md §13.1): many TVs crop the picture's
// edges and nothing can detect it, and a window or a screen may be any shape.
// A full-screen panel with a frame and four corner marks at the area's edges:
// two sliders move the left / right and the top / bottom edges in or out, the
// shape chips narrow the area to 16:9, 21:9 or 4:3 (the rest shows the
// backdrop). The whole UI follows at once (the screen is the preview); OK on a
// slider or Done keeps it, Back puts the previous one back. Stored by the host
// (the device settings display.safeArea / safeAreaY / shape).
//
//   <screen-edges *ngIf="adjusting" [value]="frame" (done)="…" (cancelled)="…"></screen-edges>
@Component({
  selector: 'screen-edges',
  templateUrl: './screen-edges.component.html',
  styleUrls: ['./screen-edges.component.scss'],
})
export class ScreenEdgesComponent implements OnInit, OnDestroy {

  @Input() value:ScreenFrame = NO_FRAME;
  @Output() done = new EventEmitter<ScreenFrame>();
  @Output() cancelled = new EventEmitter<void>();

  readonly shapes = SCREEN_SHAPES;
  readonly maxPercent = MAX_EDGE * 100;
  // percents, as the sliders show them
  x = 0;
  y = 0;
  shape:ScreenShape = 'auto';
  private kept = false;
  readonly format = (v:number) => v == 0 ? 'None' : v.toLocaleString('en', { maximumFractionDigits: 1 }) + ' %';

  ngOnInit(): void {
    let frame = normalFrame(this.value);
    this.x = Math.round(frame.x * 1000) / 10;
    this.y = Math.round((frame.y === null ? frame.x : frame.y) * 1000) / 10;
    this.shape = frame.shape;
  }

  ngOnDestroy(): void {
    // left without Done: the stored area again
    if (!this.kept) applyFrame(this.value);
  }

  get frame():ScreenFrame {
    let x = Math.round(this.x * 10) / 1000;
    let y = Math.round(this.y * 10) / 1000;
    return { x, y: y == x ? null : y, shape: this.shape };
  }

  setX(percent:number) {
    this.x = percent;
    applyFrame(this.frame);
  }

  setY(percent:number) {
    this.y = percent;
    applyFrame(this.frame);
  }

  setShape(shape:ScreenShape) {
    this.shape = shape;
    applyFrame(this.frame);
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.shape = 'auto';
    applyFrame(this.frame);
  }

  keep() {
    this.kept = true;
    this.done.emit(this.frame);
  }

  cancel() {
    applyFrame(this.value);
    this.cancelled.emit();
  }
}
