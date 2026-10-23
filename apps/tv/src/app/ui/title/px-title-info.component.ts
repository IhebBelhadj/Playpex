import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TitleInfoModel } from '../models';
import { dp } from '../units';

// The title block (docs/ui-system-plan.md §5.3): one component for what five
// pages drew themselves. Regions, top to bottom: eyebrow (the show above an
// episode), title, meta line (<px-meta>: year, chips, scores, a seal),
// genres, notes (performers, "Directed by …"), the profile's status with its
// amber line (the watch list), overview (clamped), credits (label / names).
//
//   <px-title-info [info]="titleInfo" layout="detail"></px-title-info>
//
// layout: 'detail' (a title page under the shell's description area: room
// above the overview), 'section' (a list page's header over its rows: one
// line title, three lines of overview), 'episode' (the episode page: eyebrow,
// tighter). `loading`: skeleton lines in place of an info not there yet.
@Component({
  selector: 'px-title-info',
  templateUrl: './px-title-info.component.html',
  styleUrls: ['./px-title-info.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': "'layout-' + layout" },
})
export class PxTitleInfoComponent {
  @Input() info:TitleInfoModel | null = null;
  @Input() layout:'detail' | 'section' | 'episode' = 'detail';
  @Input() loading = false;
  // lines of overview (default: 4 detail, 3 otherwise)
  @Input() overviewLines:number | null = null;

  // the skeleton's sizes (title, meta line, overview lines)
  readonly sk = { title: [dp(520), dp(48)], meta: [dp(320), dp(28)], line: dp(700), short: dp(460) };

  get lines():number {
    return this.overviewLines ?? (this.layout == 'detail' ? 4 : 3);
  }
}
