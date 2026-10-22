import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// An on / off setting: one focusable row, the label (+ a hint line) and a
// switch at its end. Selecting it is the host's (flip the value): (pxSelect).
// The "on" colour is --px-switch-on (default: positive green). A page can
// restyle the row through --px-switch-bg / -color / -text / -radius / -padding /
// -min-height / -off (the profile editor's fields).
//
//   <px-switch key="kid" label="This profile is for a kid" [on]="isKid" (pxSelect)="isKid = !isKid"></px-switch>
@Component({
  selector: 'px-switch',
  templateUrl: './px-switch.component.html',
  styleUrls: ['./px-switch.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxSwitchComponent {
  @Input() key:string | number | null = null;
  @Input() label = '';
  @Input() hint = '';
  @Input() on = false;
  @Input() disabled = false;
}
