import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { FocusEngine } from '../movement/movement';
import { display, previewUiScale, saveUiScale, UI_SCALES } from '../ui/public-api';

// The display size choice (ui/display.ts): one chip per size in a pxGrid. The
// focused size is applied at once (the whole screen is the preview), Enter
// stores it, and leaving without Enter puts the stored one back. Used by the
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

  constructor(private host:ElementRef<HTMLElement>, private engine:FocusEngine) { }

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
    saveUiScale(value).catch(err => console.error('UI scale: ', err));
    this.chosen.emit(value);
  }

  private onFocus(el:HTMLElement) {
    let chip = this.host.nativeElement.contains(el) ? el.closest('[data-scale]') as HTMLElement : null;
    previewUiScale(chip ? Number(chip.dataset['scale']) : display.scale);
  }
}
