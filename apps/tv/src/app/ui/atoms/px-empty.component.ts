import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

// Nothing to show (yet): a title, a line of text and optionally one button
// (Try again, Clear filters), which is focusable (key `actionKey`; (act) when
// selected). `busy`: a spinner with the text instead (loading).
//
//   <px-empty title="Nothing here yet" text="Titles you add show up here." action="Browse movies" (act)="…"></px-empty>
@Component({
  selector: 'px-empty',
  templateUrl: './px-empty.component.html',
  styleUrls: ['./px-empty.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.hero]': "size == 'hero'" },
})
export class PxEmptyComponent {
  @Input() title = '';
  @Input() text = '';
  @Input() action = '';
  @Input() actionKey = 'empty';
  @Input() actionVariant:'outline' | 'primary' = 'outline';
  @Input() busy = false;
  // 'hero': where a page's title block would be (watch list, 18+ posters)
  @Input() size:'m' | 'hero' = 'm';
  @Output() act = new EventEmitter<void>();
}
