import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { iconUrl, MetaItem } from '../models';

// The meta line under a title: plain text (the year), small chips (qualities,
// "Movie", "2 seasons"), scores (<px-score>) and seals (a plugin's: "NEW"), in order.
//
//   <px-meta [items]="[{kind:'text', text:'1995'}, {kind:'chip', text:'1080p'}, {kind:'score', source:'imdb', value:8.3}]"></px-meta>
@Component({
  selector: 'px-meta',
  templateUrl: './px-meta.component.html',
  styleUrls: ['./px-meta.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxMetaComponent {
  @Input() items:MetaItem[] | null = null;

  byIndex(i:number) { return i; }

  icon(name:string) { return iconUrl(name); }
}
