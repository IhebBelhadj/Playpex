import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// A row of a <px-dialog>: label, detail line, optional amber progress (how
// far in), dimmed until focused (then a white fill). Extra content is
// projected under the detail; it can follow the focus through
// --px-option-fill (a tag's background) and --px-option-caution (a warning).
//
//   <px-option key="resume" label="Resume" detail="From 42:13" [progress]="0.4" (pxSelect)="…"></px-option>
@Component({
  selector: 'px-option',
  templateUrl: './px-option.component.html',
  styleUrls: ['./px-option.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxOptionComponent {
  @Input() key:string | number | null = null;
  @Input() label = '';
  @Input() detail = '';
  // 0–1
  @Input() progress:number | null = null;
}
