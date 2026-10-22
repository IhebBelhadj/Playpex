import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { ScoreSource } from '../models';

// A rating chip: the IMDb logo + the rating (and votes), "TMDB 7.4", or a
// provider's own score. Not focusable.
//
//   <px-score source="imdb" [value]="8.3" votes="712K"></px-score>
@Component({
  selector: 'px-score',
  template: `
    <img *ngIf="source == 'imdb'" src="assets/icons/imdbsvg.svg" alt="IMDb">
    <span *ngIf="source == 'tmdb' || label">{{ label || 'TMDB' }}&nbsp;</span>{{ text }}
    <span class="votes" *ngIf="votes">{{ votes }}</span>`,
  styleUrls: ['./px-score.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxScoreComponent {
  @Input() source:ScoreSource = 'imdb';
  @Input() value:number | string | null = null;
  @Input() votes:number | string | null = null;
  // shown before the value instead of a logo (a provider's name)
  @Input() label:string | null = null;
  // digits after the point; null = as given
  @Input() digits:number | null = 1;

  get text():string {
    if (this.value == null || this.value === '') return '';
    let n = Number(this.value);
    return this.digits == null || isNaN(n) ? String(this.value) : n.toFixed(this.digits);
  }
}
