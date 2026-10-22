import { Component, ElementRef, Input } from '@angular/core';
import { LayerStack } from '../../nav/public-api';
import { dp } from '../units';
import { OverlayLevel, PxOverlay } from './px-overlay';

// A full-screen panel: dark blurred scrim over the whole screen, the content
// centred in a column, an optional title. Keyboards, the PIN pad, filter
// panels, the profile editor's panels, pairing. Open while it exists (see
// PxOverlay); its content brings its own movement containers:
//
//   <px-panel *ngIf="panel == 'avatars'" id="avatarChooser" title="Choose a profile icon"
//             focus=".current" (back)="closePanel()">
//     <div class="avatarGrid" pxGrid enter="nearest" (pxSelect)="choose($event)">…</div>
//   </px-panel>
//
// `width` (dp) + `align="start"`: a wide panel (filters), title and content
// left-aligned; the content scrolls when it needs to (min-height: 0 on it).
// `edge="end"`: docked to the right edge at full height, over a side gradient
// instead of the blurred scrim, so what's behind stays visible (the player's
// subtitles panel); `width` sets its width.
@Component({
  selector: 'px-panel',
  templateUrl: './px-panel.component.html',
  styleUrls: ['./px-panel.component.scss'],
})
export class PxPanelComponent extends PxOverlay {

  @Input() override level:OverlayLevel = 'panel';
  @Input() title = '';
  @Input() align:'center' | 'start' = 'center';
  @Input() width:number | null = null;
  @Input() edge:'none' | 'end' = 'none';

  readonly dp = dp;

  constructor(host:ElementRef<HTMLElement>, layers:LayerStack) {
    super(host, layers);
  }
}
