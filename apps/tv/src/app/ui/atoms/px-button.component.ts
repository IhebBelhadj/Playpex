import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { iconUrl } from '../models';

export type ButtonVariant = 'outline' | 'primary' | 'filled' | 'danger' | 'toolbar' | 'plate' | 'icon';

// A button with a text label (an action tile is <px-action>, a pill choice
// <px-chip>). One focusable item; select with (pxSelect) on the host.
//
//   outline   thin grey frame, muted label (empty states, panel footers)
//   primary   the same frame in white: the main choice of a panel ("Show titles")
//   filled    a soft white fill (Save, Done, Connect)
//   danger    outline, red when focused (Delete)
//   toolbar   a dark rounded control with an icon (the sections' toolbars);
//             `active`: a ring (filters in use); `quiet`: no fill until focused
//   plate     a wide dark plate, light label (the power menu)
//   icon      a round icon; focused, it grows into a white pill with its label
//             (the player's controls); `size="l"`: the main one (Play);
//             `active`: the icon turns amber
//
// All of them turn white when focused. `caps`: upper case, spaced (the profile
// screens); `size="l"`: a larger label (full-screen pages); `round`: rounded
// corners (/connect).
//
//   <px-button key="retry" label="Try again" (pxSelect)="reload()"></px-button>
//   <px-button variant="toolbar" icon="opts" [label]="filterLabel" [active]="filtered"></px-button>
@Component({
  selector: 'px-button',
  templateUrl: './px-button.component.html',
  styleUrls: ['./px-button.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxButtonComponent {
  @Input() key:string | number | null = null;
  @Input() label = '';
  @Input() variant:ButtonVariant = 'outline';
  @Input() icon:string | null = null;
  @Input() active = false;
  @Input() quiet = false;
  @Input() caps = false;
  @Input() size:'m' | 'l' = 'm';
  @Input() round = false;
  @Input() disabled = false;
  // a placeholder look for the label (an empty field)
  @Input() dim = false;
  // a fixed width (CSS length, e.g. dp(320)); the label is cut with an ellipsis
  @Input() width:string | null = null;
  @Input() align:'center' | 'start' = 'center';

  get src():string | null {
    return this.icon ? iconUrl(this.icon) : null;
  }
}
