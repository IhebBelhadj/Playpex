import { Component, Input } from '@angular/core';

// A pill: dim fill, white ring when selected, white fill (and a small zoom)
// when focused. One per choice of a filter group, in a pxGrid:
//
//   <div pxGrid enter="nearest">
//     <px-chip *ngFor="let g of genres" [key]="g.id" [label]="g.name" [selected]="g.id == genre" (pxSelect)="genre = g.id"></px-chip>
//   </div>
@Component({
  selector: 'px-chip',
  templateUrl: './px-chip.component.html',
  styleUrls: ['./px-chip.component.scss'],
})
export class PxChipComponent {
  @Input() key:string | number | null = null;
  @Input() label = '';
  @Input() selected = false;
}
