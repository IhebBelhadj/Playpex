import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { actionForKey } from '../../keymap';

// A value on a scale (volume, a delay, a speed): one focusable item. With the
// focus on it, Left / Right step the value (held: repeats) and the focus stays;
// the mouse clicks or drags along the track. Up / Down move the focus as usual.
//
//   <px-slider key="volume" label="Volume" [min]="0" [max]="100" [step]="10"
//     [value]="volume" [format]="percent" (valueChange)="setVolume($event)"></px-slider>
//
// `origin`: where the fill starts (a delay: 0, in the middle of −5…+5);
// `stops`: names shown under the track for a few fixed values (sizes).
@Component({
  selector: 'px-slider',
  templateUrl: './px-slider.component.html',
  styleUrls: ['./px-slider.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxSliderComponent implements OnInit, OnDestroy {

  @Input() key:string | number | null = null;
  @Input() label = '';
  @Input() min = 0;
  @Input() max = 100;
  @Input() step = 1;
  @Input() value = 0;
  @Input() origin:number | null = null;
  @Input() format:(value:number) => string = v => String(v);
  @Input() stops:{ value:number, label:string }[] | null = null;
  @Input() disabled = false;
  @Output() valueChange = new EventEmitter<number>();

  private dragging = false;
  private keyDown = (e:KeyboardEvent) => this.onKeyDown(e);
  private move = (e:MouseEvent) => { if (this.dragging) this.zone.run(() => this.setFrom(e)); };
  private up = () => { this.dragging = false; };

  constructor(private host:ElementRef<HTMLElement>, private zone:NgZone, private cdr:ChangeDetectorRef) { }

  ngOnInit(): void {
    // capture: before the spatial-navigation library moves the focus
    window.addEventListener('keydown', this.keyDown, true);
    document.addEventListener('mousemove', this.move);
    document.addEventListener('mouseup', this.up);
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.keyDown, true);
    document.removeEventListener('mousemove', this.move);
    document.removeEventListener('mouseup', this.up);
  }

  // 0–1 along the track
  at(value:number):number {
    return this.max > this.min ? (value - this.min) / (this.max - this.min) : 0;
  }

  get fillStart():number {
    return this.at(Math.min(this.origin ?? this.min, this.value));
  }

  get fillEnd():number {
    return this.at(Math.max(this.origin ?? this.min, this.value));
  }

  onDown(e:MouseEvent) {
    if (this.disabled || e.button != 0) return;
    this.dragging = true;
    this.setFrom(e);
  }

  private onKeyDown(e:KeyboardEvent) {
    let button = this.host.nativeElement.querySelector('.px-slider');
    if (this.disabled || document.activeElement !== button) return;
    let action = actionForKey(e);
    if (action != 'left' && action != 'right') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.zone.run(() => this.set(this.value + (action == 'right' ? this.step : -this.step)));
  }

  private setFrom(e:MouseEvent) {
    let track = this.host.nativeElement.querySelector('.track') as HTMLElement;
    let rect = track.getBoundingClientRect();
    let fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    this.set(this.min + fraction * (this.max - this.min));
  }

  private set(value:number) {
    let steps = Math.round((value - this.min) / this.step);
    let next = Math.min(this.max, Math.max(this.min, this.min + steps * this.step));
    next = Math.round(next * 1000) / 1000;
    if (next == this.value) return;
    this.value = next;
    this.valueChange.emit(next);
    // OnPush: the keys and the drag come from window / document listeners
    this.cdr.markForCheck();
  }
}
