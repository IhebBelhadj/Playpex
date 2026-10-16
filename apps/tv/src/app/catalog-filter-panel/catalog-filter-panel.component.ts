import { AfterViewInit, Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { Subscription } from 'rxjs';
import { NavigationService } from '../navigation.service';
import { MediaType } from '../catalog';
import { CatalogFilters, Genre, LANGUAGES, NO_FILTERS, PERIODS, RATINGS } from '../catalog-filters';

// Full-screen filter panel of the movies / TV list page: genre, release
// period, minimum TMDB score and original language, one choice per group,
// applied together ("Show movies") or reset. Like <text-keyboard> it owns its
// keys while open (a trapping pxSection `catalogFilters`; groups are pxGrids
// of a pxStack, src/app/movement): Enter picks a chip, back cancels. Hosts
// ignore click / back meanwhile (`Catalog.filtering`).
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

  private navSub:Subscription;

  constructor(private navigation:NavigationService) { }

  get noun():string {
    return this.media == 'tv' ? 'TV shows' : 'movies';
  }

  ngOnInit(): void {
    this.draft = { ...this.filters };
  }

  ngAfterViewInit(): void {
    // the chosen genre (or "All genres"), where a change usually starts
    setTimeout(() => (document.querySelector('.catalogFilters .genreGrid .chip.selected') as HTMLElement)?.focus({ preventScroll: true }), 0);

    this.navSub = this.navigation.executeCommand().subscribe(instruction => {
      if (instruction == 'back' || instruction == 'leave') {
        this.cancelled.emit();
        return;
      }
      if (instruction != 'click') return;
      let data = (document.activeElement as HTMLElement).dataset;
      if (data['genre'] !== undefined) this.draft.genre = data['genre'] ? Number(data['genre']) : null;
      else if (data['period'] !== undefined) this.draft.period = data['period'];
      else if (data['rating'] !== undefined) this.draft.rating = Number(data['rating']);
      else if (data['language'] !== undefined) this.draft.language = data['language'];
      else if (data['action'] == 'apply') this.applied.emit({ ...this.draft });
      else if (data['action'] == 'reset') this.draft = { ...NO_FILTERS };
    });
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
  }
}
