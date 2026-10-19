import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { LayerRef, LayerStack } from '../nav/public-api';
import { MediaType } from '../catalog';
import { CatalogFilters, Genre, LANGUAGES, NO_FILTERS, PERIODS, RATINGS } from '../catalog-filters';

// Full-screen filter panel of the movies / TV list page: genre, release
// period, minimum TMDB score and original language, one choice per group,
// applied together ("Show movies") or reset. Like <text-keyboard> it owns its
// keys while open (a trapping pxSection `catalogFilters`; groups are pxGrids
// of a pxStack, src/app/movement): Enter picks a chip, back cancels. A layer
// of the nav system (src/app/nav): the host gets no select / back meanwhile.
@Component({
  selector: 'catalog-filter-panel',
  templateUrl: './catalog-filter-panel.component.html',
  styleUrls: ['./catalog-filter-panel.component.scss']
})
export class CatalogFilterPanelComponent implements OnInit, AfterViewInit, OnDestroy {

  @Input() media:MediaType = 'movie';
  @Input() filters:CatalogFilters = NO_FILTERS;
  @Input() genres:Genre[] = [];
  @Output() applied = new EventEmitter<CatalogFilters>();
  @Output() cancelled = new EventEmitter<void>();

  draft:CatalogFilters = { ...NO_FILTERS };
  periods = PERIODS;
  ratings = RATINGS;
  languages = LANGUAGES;

  private layer:LayerRef;

  constructor(private layers:LayerStack, private host:ElementRef<HTMLElement>) { }

  get noun():string {
    return this.media == 'tv' ? 'TV shows' : 'movies';
  }

  ngOnInit(): void {
    this.draft = { ...this.filters };
  }

  ngAfterViewInit(): void {
    // the chosen genre (or "All genres"), where a change usually starts
    setTimeout(() => (document.querySelector('.catalogFilters .genreGrid .chip.selected') as HTMLElement)?.focus({ preventScroll: true }), 0);

    // a layer of the nav system: select / back are its own while it's open
    this.layer = this.layers.open({ id: 'catalogFilters', element: this.host.nativeElement });
    this.layer.onBack(() => {
      this.cancelled.emit();
      return true;
    });
    this.layer.onSelect(el => {
      let data = el.dataset;
      if (data['genre'] !== undefined) this.draft.genre = data['genre'] ? Number(data['genre']) : null;
      else if (data['period'] !== undefined) this.draft.period = data['period'];
      else if (data['rating'] !== undefined) this.draft.rating = Number(data['rating']);
      else if (data['language'] !== undefined) this.draft.language = data['language'];
      else if (data['action'] == 'apply') this.applied.emit({ ...this.draft });
      else if (data['action'] == 'reset') this.draft = { ...NO_FILTERS };
    });
  }

  ngOnDestroy(): void {
    this.layer?.close();
  }
}
