import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild,
} from '@angular/core';
import { Badge, CardVariant, ScoreSource } from '../models';

// A focusable card of a row (docs/ui-system-plan.md §5.2): its artwork and,
// for some variants, a caption under it.
//
//   poster    180 × 270 artwork, no caption (the section rows, the watch list);
//             dimmed and desaturated until focused, then zoomed
//   compact   150 × 230 artwork + title and a line (similar titles, search results)
//   portrait  a 130 round photo + the name (cast, guests); initials without a photo
//   still     a 270 × 152 episode still + number, title and a meta line
//
// The artwork: a shimmer while it loads, faded in once decoded, the title in
// its place when there is none or it fails. `progress` = the amber line
// (how far in), `badges` = small marks on the artwork ('tv', 'watched',
// 'upcoming' or a text), `busy` = a spinner over it ("Finding torrents…"),
// `dim` = not available yet (an upcoming episode). `data` = data-* attributes
// on the focusable element (what the page's listeners read).
//
//   <px-card variant="poster" [key]="m.tmdbId" [image]="posterBase + m.posterPath" [title]="m.title" (pxSelect)="open(m)"></px-card>
@Component({
  selector: 'px-card',
  templateUrl: './px-card.component.html',
  styleUrls: ['./px-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxCardComponent implements OnChanges, AfterViewInit {
  @Input() key:string | number | null = null;
  @Input() variant:CardVariant = 'poster';
  @Input() image:string | null | undefined = null;
  @Input() title = '';
  @Input() subtitle = '';
  // the episode number before the title (still)
  @Input() number:number | string | null = null;
  @Input() rating:{ source:ScoreSource, value:number } | null = null;
  // more short facts after the subtitle (an episode's runtime, its air date)
  @Input() meta:string[] | null = null;
  @Input() badges:Badge[] | null = null;
  @Input() progress:number | null = null;
  @Input() busy = false;
  @Input() busyLabel = '';
  @Input() dim = false;
  @Input() data:{ [name:string]:string | number | null | undefined } | null = null;

  @ViewChild('button') button:ElementRef<HTMLElement>;

  loaded = false;
  failed = false;

  constructor(private cdr:ChangeDetectorRef) { }

  get caption():boolean {
    return this.variant != 'poster';
  }

  get showImage():boolean {
    return !!this.image && !this.failed;
  }

  get initials():string {
    return (this.title || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }

  ngOnChanges(changes:SimpleChanges): void {
    if (changes['image'] && !changes['image'].firstChange) {
      this.loaded = false;
      this.failed = false;
    }
    if (changes['data'] && this.button) this.applyData();
  }

  ngAfterViewInit(): void {
    this.applyData();
  }

  // decoded before it shows: no half-drawn poster
  onLoad(img:HTMLImageElement) {
    let done = () => { this.loaded = true; this.cdr.markForCheck(); };
    (img.decode ? img.decode() : Promise.resolve()).then(done, done);
  }

  onError() {
    this.failed = true;
    this.cdr.markForCheck();
  }

  badgeText(b:Badge):string {
    if (typeof b != 'string') return b.text;
    return { tv: 'TV', watched: 'Watched', upcoming: 'Upcoming', current: 'On this page', server: 'On this server' }[b];
  }

  badgeKind(b:Badge):string {
    return typeof b == 'string' ? b : 'text';
  }

  private applyData() {
    let el = this.button?.nativeElement;
    if (!el) return;
    Object.entries(this.data || {}).forEach(([name, value]) => {
      if (value === null || value === undefined) delete el.dataset[name];
      else el.dataset[name] = String(value);
    });
  }
}
