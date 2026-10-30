import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Found } from '../search-sources.service';
import { CODECS, NO_REFINE, QUALITIES, Refine, SIZES, SORTS, WHATS, facets, refine, toggle } from '../search-refine';

interface Option {
  value:string;
  label:string;
}

interface Group {
  key:'qualities' | 'what' | 'sizes' | 'codecs' | 'sources';
  title:string;
  options:Option[];
}

// The search page's panel for its videos or torrents: the order, then filters
// by quality, what it is, size, video codec, where it came from and names
// holding every word. Everything is already here, so a change shows at once
// (`change`); each option says how many results it leaves (the other filters
// on), and only options some result has are offered. Laid out like the list
// page's filter panel (<px-panel>, a pxStack of pxGrids entered `nearest`).
@Component({
  selector: 'search-refine-panel',
  templateUrl: './search-refine-panel.component.html',
  styleUrls: ['./search-refine-panel.component.scss'],
})
export class SearchRefinePanelComponent {

  /** 'torrents' or 'videos' */
  @Input() noun = 'torrents';
  @Input() items:Found[] = [];
  @Input() value:Refine = NO_REFINE;
  /** provider id → name */
  @Input() sources = new Map<string, string>();
  @Output() change = new EventEmitter<Refine>();
  @Output() closed = new EventEmitter<void>();

  get sorts() {
    return SORTS.filter(s => this.noun != 'videos' || s.value != 'seeds');
  }

  get left():number {
    return refine(this.items, this.value).length;
  }

  get exactCount():number {
    return facets(this.items, this.value).exact;
  }

  /** The groups with at least two options to choose from (or one on), each option with its count */
  get groups():(Group & { counts:Map<string, number> })[] {
    let f = facets(this.items, this.value);
    let all:(Group & { counts:Map<string, number> })[] = [
      { key: 'qualities', title: 'Quality', options: QUALITIES, counts: f.qualities as Map<string, number> },
      { key: 'what', title: 'What it is', options: WHATS, counts: f.what as Map<string, number> },
      { key: 'sizes', title: 'Size', options: SIZES, counts: f.sizes as Map<string, number> },
      { key: 'codecs', title: 'Video', options: CODECS, counts: f.codecs as Map<string, number> },
      { key: 'sources', title: 'From', options: [...this.sources].map(([value, label]) => ({ value, label })), counts: f.sources },
    ];
    return all.map(g => ({
      ...g,
      options: g.options.filter(o => (g.counts.get(o.value) || 0) > 0 || (this.value[g.key] as string[]).includes(o.value)),
    })).filter(g => g.options.length > 1 || (this.value[g.key] as string[]).length > 0);
  }

  isOn(group:Group['key'], value:string):boolean {
    return (this.value[group] as string[]).includes(value);
  }

  setSort(sort:Refine['sort']) {
    this.change.emit({ ...this.value, sort });
  }

  flip(group:Group['key'], value:string) {
    this.change.emit({ ...this.value, [group]: toggle(this.value[group] as string[], value) });
  }

  flipExact() {
    this.change.emit({ ...this.value, exact: !this.value.exact });
  }

  clear() {
    this.change.emit({ ...NO_REFINE, sort: this.value.sort });
  }

  trackGroup(i:number, g:Group) { return g.key; }
  trackOption(i:number, o:Option) { return o.value; }
}
