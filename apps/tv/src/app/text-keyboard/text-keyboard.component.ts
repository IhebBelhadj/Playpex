import { AfterViewInit, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { RemoteControl, RemoteTextField } from '../remote/remote-control.service';

// Full-screen on-screen keyboard (A–Z, 0–9, space / delete / clear / done) for
// the remote; typing on a physical keyboard works too (taken as is). Emits
// `done` with the text or `cancelled` on back. On the <px-panel> frame
// (ui/overlay): while open it owns the `textKeyboard` section (keys and mouse
// stay in it; arrows move by key grid lines, src/app/movement) and is a layer
// of the nav system (src/app/nav): the host gets no select / back meanwhile.
//
// While it's open it is the device's text field for remote control
// (`RemoteControl.openField`): a controller (the dashboard's remote on a phone)
// is told, shows its own keyboard and sends the whole text back, which
// replaces this one's (`remoteValue`); its Enter is Done here.
@Component({
  selector: 'text-keyboard',
  templateUrl: './text-keyboard.component.html',
  styleUrls: ['./text-keyboard.component.scss']
})
export class TextKeyboardComponent implements AfterViewInit, OnDestroy, RemoteTextField {

  @Input() title = '';
  @Input() placeholder = '';
  @Input() set value(v:string) {
    this.text = v || '';
    this.remote.fieldChanged(this);
  }
  get value() { return this.text; }
  @Input() maxLength = 30;
  // on-screen keys are capitals: capitalize word starts (names) or type lower case (searches)
  @Input() capitalizeWords = true;
  @Input() doneLabel = 'Done';
  // extra keys after the digits, e.g. ['.', ':'] for an address
  @Input() symbols:string[] = [];
  @Output() done = new EventEmitter<string>();
  @Output() cancelled = new EventEmitter<void>();

  letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  digits = '1234567890'.split('');

  private keyListener;
  private text = '';

  constructor(public remote:RemoteControl) { }

  // what the field is for (the remote controller's keyboard: a search key, a URL keyboard); unset: a
  // search when it types lower case, else text
  @Input() fieldKind:'text' | 'search' | 'address' | null = null;

  get kind():'text' | 'search' | 'address' {
    return this.fieldKind || (this.capitalizeWords ? 'text' : 'search');
  }

  /** the controller's text (the whole field), then Done when it pressed Enter */
  remoteValue(value:string, submit:boolean) {
    this.text = value.slice(0, this.maxLength);
    if (submit) this.press('done');
  }

  // the panel focuses the first key (A) when it opens
  ngAfterViewInit(): void {
    this.remote.openField(this);
    this.keyListener = (e:KeyboardEvent) => {
      if (e.key == 'Backspace') this.press('del');
      else if (e.key.length == 1 && (/[\p{L}\p{N} '\-&.]/u.test(e.key) || this.symbols.includes(e.key))) {
        // typed, not pressed on screen: space would also "click" the
        // focused key button
        e.preventDefault();
        this.append(e.key);
      }
    };
    document.addEventListener('keydown', this.keyListener);
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.keyListener);
    this.remote.closeField(this);
  }

  select(el:HTMLElement) {
    if (el.classList.contains('key')) this.press(el.dataset['key']);
  }

  press(key:string) {
    switch (key) {
      case 'del': this.value = this.value.slice(0, -1); break;
      case 'space': this.append(' '); break;
      case 'clear': this.value = ''; break;
      case 'done': this.done.emit(this.value.trim().replace(/\s+/g, ' ')); break;
      default:
        let wordStart = !this.value || this.value.endsWith(' ');
        this.append(this.capitalizeWords && wordStart ? key : key.toLowerCase());
    }
  }

  private append(text:string) {
    if (this.value.length >= this.maxLength) return;
    if (text == ' ' && (!this.value || this.value.endsWith(' '))) return;
    this.value += text;
  }
}
