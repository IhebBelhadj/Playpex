import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { LayerRef, LayerStack } from '../nav/public-api';
import { PIN_LENGTH, ProfilesService } from '../profiles.service';

// Full-screen PIN entry with an on-screen keypad (remote) that also accepts
// the number keys. Emits `completed` once PIN_LENGTH digits are in and waits:
// the host either closes it or calls fail(message) to try again.
// While open it owns the `pinPad` navigation section and is a layer of the
// nav system (src/app/nav): the host gets no select / back meanwhile.
@Component({
  selector: 'pin-pad',
  templateUrl: './pin-pad.component.html',
  styleUrls: ['./pin-pad.component.scss']
})
export class PinPadComponent implements AfterViewInit, OnDestroy {

  @Input() title = 'Enter your PIN';
  @Input() subtitle = '';
  @Input() avatar:string | null = null;
  @Output() completed = new EventEmitter<string>();
  @Output() cancelled = new EventEmitter<void>();

  slots = Array.from({ length: PIN_LENGTH }, (_, i) => i);
  keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'cancel', '0', 'del'];
  digits = '';
  error = '';
  waiting = false;
  shake = false;

  private layer:LayerRef;
  private keyListener;

  constructor(private layers:LayerStack, private host:ElementRef<HTMLElement>) { }

  ngAfterViewInit(): void {
    // section `pinPad`: a trapping pxSection in the template, keys a pxGrid
    setTimeout(() => (document.querySelector('.pinPad .pinKey') as HTMLElement)?.focus({ preventScroll: true }), 0);

    // a layer of the nav system: select / back are its own while it's open
    this.layer = this.layers.open({ id: 'pinPad', element: this.host.nativeElement });
    this.layer.onSelect(el => {
      if (el.classList.contains('pinKey')) this.press(el.dataset['key']);
    });
    this.layer.onBack(() => {
      this.cancelled.emit();
      return true;
    });

    // Text entry, not navigation: digits and Backspace straight from the keyboard / remote
    this.keyListener = (e:KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) this.press(e.key);
      else if (e.key == 'Backspace') this.press('del');
    };
    document.addEventListener('keydown', this.keyListener);
  }

  ngOnDestroy(): void {
    this.layer?.close();
    document.removeEventListener('keydown', this.keyListener);
  }

  press(key:string) {
    if (key == 'cancel') {
      this.cancelled.emit();
      return;
    }
    if (this.waiting) return;
    if (key == 'del') {
      this.digits = this.digits.slice(0, -1);
      return;
    }
    if (this.digits.length >= PIN_LENGTH) return;
    this.error = '';
    this.digits += key;
    if (this.digits.length == PIN_LENGTH) {
      this.waiting = true;
      this.completed.emit(this.digits);
    }
  }

  // Wrong PIN (or any refusal): clear the boxes and show why
  fail(message:string) {
    this.error = message;
    this.digits = '';
    this.waiting = false;
    this.shake = true;
    setTimeout(() => this.shake = false, 400);
  }

  avatarUrl(avatar:string | null) {
    return ProfilesService.avatarUrl(avatar);
  }
}
