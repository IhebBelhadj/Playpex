import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CardModel, CardVariant } from '../models';

// A titled row of cards (docs/ui-system-plan.md §5.3): the 12-row boilerplate
// in one element. Its title, the `rowArrows` chevrons, a `pxRow` (keyed for
// position memory: same `rowKey`s as before), one item per entry, the row
// gutters (room for the focus zoom) and `min-width: 0`. Put `pxStackItem` on it
// inside a pxStack: the stack decides the motion (transform for the section
// rows, scroll for detail pages).
//
//   <px-card-row pxStackItem rowKey="similar" title="Similar titles to watch" align="third"
//     [items]="cards" (picked)="open($event)"></px-card-row>          view models → <px-card>s
//
//   <px-card-row pxStackItem rowKey="cast" title="Cast" align="third">
//     <px-card *ngFor="let c of casts; trackBy: byId" variant="portrait" [key]="c.id" …></px-card>
//   </px-card-row>                                                    the core's own items, projected
//
// Projected items are declared in the page (any pxItem: a px-card, a season
// chip): unlike an ng-template stamped here, Angular doesn't re-check them
// with every change of the row (a title page's ~70 cards cost a long task).
//
// `tone`: 'section' (the list pages' row titles) or 'detail' (title pages).
// Gutters: --px-row-gutter-block / --px-row-gutter-inline (default 16 / 10, posters).
@Component({
  selector: 'px-card-row',
  templateUrl: './px-card-row.component.html',
  styleUrls: ['./px-card-row.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxCardRowComponent {
  @Input() rowKey = '';
  @Input() title = '';
  @Input() items:readonly any[] | null = null;
  @Input() variant:CardVariant = 'poster';
  @Input() align:'start' | 'third' | 'nearest' | 'center' = 'start';
  @Input() loadAhead = 0;
  @Input() tone:'section' | 'detail' = 'section';
  // view models (slots, plugins); the core projects its own cards instead
  @Input() trackBy:(index:number, item:any) => any = (i, item) => item?.key ?? i;
  // its first page hasn't come yet: skeleton cards (not focusable, §13.4)
  @Input() loading = false;
  readonly skeletons = [0, 1, 2, 3, 4, 5, 6, 7];
  @Output() nearEnd = new EventEmitter<void>();
  // a view model's card was selected (rows of CardModels)
  @Output() picked = new EventEmitter<CardModel>();
}
