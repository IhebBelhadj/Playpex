import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { MediaType } from '../catalog';
import { CatalogFilters, Genre, LANGUAGES, NO_FILTERS, PERIODS, RATINGS } from '../catalog-filters';

// Full-screen filter panel of the movies / TV list page: genre, release
// period, minimum TMDB score and original language, one choice per group,
// applied together ("Show movies") or reset. On the <px-panel> frame with
// <px-chip>s (ui/overlay), like the 18+ filter panel: while open it owns its
// keys (the trapping section `catalogFilters`; groups are pxGrids of a
// pxStack, src/app/movement) and is a layer of the nav system (src/app/nav):
// Enter picks a chip, back cancels, the host gets no select / back meanwhile.
@Component({
  selector: 'catalog-filter-panel',
  templateUrl: './catalog-filter-panel.component.html',
  styleUrls: ['./catalog-filter-panel.component.scss']
})
export class CatalogFilterPanelComponent implements OnInit {

  @Input() media:MediaType = 'movie';
  @Input() filters:CatalogFilters = NO_FILTERS;
  @Input() genres:Genre[] = [];
  @Output() applied = new EventEmitter<CatalogFilters>();
  @Output() cancelled = new EventEmitter<void>();

  draft:CatalogFilters = { ...NO_FILTERS };
  periods = PERIODS;
  ratings = RATINGS;
  languages = LANGUAGES;

  get noun():string {
    return this.media == 'tv' ? 'TV shows' : 'movies';
  }

  // opens on the chosen genre (or "All genres"), where a change usually starts
  ngOnInit(): void {
    this.draft = { ...this.filters };
  }

  apply() {
    this.applied.emit({ ...this.draft });
  }

  reset() {
    this.draft = { ...NO_FILTERS };
  }
}
