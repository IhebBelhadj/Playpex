import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { iconUrl } from '../models';

// An action tile of a title page (Play / Resume, Trailer, Find releases, Watch
// list, Watched): an icon in a dark tile with the label under it, dimmed until
// focused (then a white tile). `on`: the icon turns amber (in the watch list,
// watched); `progress`: the amber resume line along the tile's bottom; `busy`:
// "Finding torrents…" without moving the focus. Goes in a <px-action-bar>:
//
//   <px-action key="play" icon="play" [label]="resumeLabel || 'Play'" [progress]="resumeRatio" (pxSelect)="play()"></px-action>
//
// `onIcon` replaces the icon while on (bookmark → tick).
@Component({
  selector: 'px-action',
  templateUrl: './px-action.component.html',
  styleUrls: ['./px-action.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxActionComponent {
  @Input() key:string | number | null = null;
  @Input() icon = '';
  @Input() onIcon:string | null = null;
  @Input() label = '';
  @Input() busyLabel = '';
  @Input() on = false;
  // 0–1
  @Input() progress:number | null = null;
  @Input() busy = false;
  @Input() disabled = false;

  get src():string {
    return iconUrl(this.on && this.onIcon ? this.onIcon : this.icon);
  }
}
