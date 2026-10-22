import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

// Something is being worked on (an action, a list loading its next page). A
// ring turning in the current text colour; still with reduced motion. For
// content that has a shape (cards, a title block), use <px-skeleton>.
@Component({
  selector: 'px-spinner',
  template: `<span class="ring"></span><span class="label" *ngIf="label">{{ label }}</span>`,
  styleUrls: ['./px-spinner.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', '[attr.aria-label]': 'label || "Loading"' },
})
export class PxSpinnerComponent {
  @Input() label = '';
}
