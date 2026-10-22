import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { dp } from '../units';

// A toolbar search field: the query, or a placeholder in a faint colour.
// Selecting it is the host's (it opens <text-keyboard>): (pxSelect) on the host.
//
//   <px-search-field key="search" [query]="catalog.query" placeholder="Search movies" (pxSelect)="typing = true"></px-search-field>
@Component({
  selector: 'px-search-field',
  template: `<px-button variant="toolbar" icon="search" [key]="key" [label]="query || placeholder" [dim]="!query"
    align="start" [size]="size" [width]="width || defaultWidth"></px-button>`,
  styles: [':host { display: contents; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxSearchFieldComponent {
  @Input() key:string | number | null = 'search';
  @Input() query:string | null = '';
  @Input() placeholder = 'Search';
  // CSS length; default dp(320)
  @Input() width:string | null = null;

  @Input() size:'m' | 'l' = 'm';

  readonly defaultWidth = dp(320);
}
