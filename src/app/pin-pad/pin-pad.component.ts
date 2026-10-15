import { AfterViewInit, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { PIN_LENGTH, ProfilesService } from '../profiles.service';

// Full-screen PIN entry with an on-screen keypad (remote) that also accepts
// the number keys. Emits `completed` once PIN_LENGTH digits are in and waits:
// the host either closes it or calls fail(message) to try again.
// While open it owns the `pinPad` navigation section; hosts must ignore
// click/back commands meanwhile.
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

  private navSub:Subscription;
  private keyListener;

  constructor(private navigation:NavigationService) { }

  ngAfterViewInit(): void {
    this.navigation.updateNavigation('add', {
      id: 'pinPad',
      selector: '.pinPad .pinKey',
      restrict: 'self-only',
    });
    setTimeout(() => (document.querySelector('.pinPad .pinKey') as HTMLElement)?.focus({ preventScroll: true }), 0);

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (instruction == 'back') {
        this.cancelled.emit();
        return;
      }
      let active = document.activeElement as HTMLElement;
      if (instruction == 'click' && active.classList.contains('pinKey')) {
        this.press(active.dataset['key']);
      }
    });

    // Text entry, not navigation: digits and Backspace straight from the keyboard / remote
    this.keyListener = (e:KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) this.press(e.key);
      else if (e.key == 'Backspace') this.press('del');
    };
    document.addEventListener('keydown', this.keyListener);
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
    document.removeEventListener('keydown', this.keyListener);
    this.navigation.updateNavigation('remove', { sectionId: 'pinPad' });
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
