import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { FocusEngine } from '../movement/movement';
import { display, previewUiScale, saveUiScale, UI_SCALES } from '../ui/public-api';
import { SettingsService } from '../settings.service';

// The display size choice (ui/display.ts): one chip per size in a pxGrid. The
// focused size is applied at once (the whole screen is the preview), Enter
// stores it (client.json, and the device's setting display.uiScale on the
// server), and leaving without Enter puts the stored one back. Used by the
// first start (core.display) and Settings; the host owns the section.
//
//   <display-size [autofocus]="true" (chosen)="next()"></display-size>
@Component({
  selector: 'display-size',
  templateUrl: './display-size.component.html',
  styleUrls: ['./display-size.component.scss'],
})
export class DisplaySizeComponent implements AfterViewInit, OnDestroy {

  // focus the stored size on init (a page opened for this choice)
  @Input() autofocus = false;
  @Output() chosen = new EventEmitter<number>();

  scales = UI_SCALES;
  stored = display.scale;

  private focusListener = (e:Event) => this.onFocus(e.target as HTMLElement);

  constructor(private host:ElementRef<HTMLElement>, private engine:FocusEngine, private settings:SettingsService) { }

  ngAfterViewInit(): void {
    // the movement system's focus event (fires in a window without OS focus too)
    window.addEventListener('sn:focused', this.focusListener);
    if (this.autofocus) {
      let current = this.host.nativeElement.querySelector('.px-chip.selected') as HTMLElement;
      if (current) this.engine.focus(current, 'restore');
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('sn:focused', this.focusListener);
    previewUiScale(display.scale);
  }

  percent(value:number):string {
    return Math.round(value * 100) + ' %';
  }

  pick(value:number) {
    this.stored = value;
    // client.json: the boot cache; the server: the source (when there is one yet)
    saveUiScale(value).catch(err => console.error('UI scale: ', err));
    this.settings.set('display.uiScale', value as any);
    this.chosen.emit(value);
  }

  // Keys only: under the mouse the whole screen would resize, put another size
  // under the cursor and preview that one (the mouse clicks a size instead)
  private onFocus(el:HTMLElement) {
    let chip = this.host.nativeElement.contains(el) ? el.closest('[data-scale]') as HTMLElement : null;
    let preview = chip && this.engine.lastInput == 'keys';
    previewUiScale(preview ? Number(chip.dataset['scale']) : display.scale);
  }
}
