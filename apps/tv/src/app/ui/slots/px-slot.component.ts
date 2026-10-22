import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject, InjectionToken, Input, OnChanges, OnDestroy,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { Intent, Navigator } from '../../nav/public-api';
import { ActionModel, CardModel, MetaItem, RowModel } from '../models';
import { ContributionDef, ContributionRegistry, CONTRIBUTIONS } from './contribution-registry';
import { SLOTS, SlotKind, SlotName } from './slots';

export const CONTRIBUTION_REGISTRY = new InjectionToken<ContributionRegistry>('CONTRIBUTION_REGISTRY', {
  providedIn: 'root',
  factory: () => CONTRIBUTIONS,
});

interface RowState {
  model:RowModel;
  items:CardModel[];
  page:number;
  last:boolean;
  loading:boolean;
  sub?:Subscription;
}

// Where a core screen shows a slot's contributions (docs/ui-system-plan.md
// §5.6), rendered with the core's own primitives so they look native:
//
//   actions → <px-action>s (put the slot inside a <px-action-bar>)
//   rows    → <px-card-row>s (inside the page's pxStack; paged sources page on nearEnd)
//   meta    → a <px-meta> line
//
//   <px-slot name="core.movie.actions" [context]="slotContext"></px-slot>
//
// Re-evaluated when `context` changes (a new object: the page builds it when
// its title changes); Observables are unsubscribed then. A contribution that
// throws shows nothing. Selecting an action runs it, or opens its intent; a
// card opens its intent.
@Component({
  selector: 'px-slot',
  templateUrl: './px-slot.component.html',
  styleUrls: ['./px-slot.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PxSlotComponent implements OnChanges, OnDestroy {
  @Input() name:SlotName;
  @Input() context:any = null;

  kind:SlotKind = 'actions';
  actions:ActionModel[] = [];
  rows:RowState[] = [];
  meta:MetaItem[] = [];

  private subs:Subscription[] = [];
  private results = new Map<string, any[]>();
  private contributions:ContributionDef[] = [];

  constructor(
    @Inject(CONTRIBUTION_REGISTRY) private registry:ContributionRegistry,
    private navigator:Navigator,
    private cdr:ChangeDetectorRef,
  ) { }

  ngOnChanges(): void {
    this.clear();
    if (!this.name || !this.context) return;
    this.kind = SLOTS[this.name].kind;
    this.contributions = this.registry.for(this.name, this.context);
    for (let def of this.contributions) {
      this.subs.push(this.registry.models(def, this.context).subscribe(items => {
        this.results.set(def.id, items);
        this.render();
      }));
    }
  }

  ngOnDestroy(): void {
    this.clear();
  }

  run(action:ActionModel) {
    if (action.disabled || action.busy) return;
    if (action.run) {
      try {
        let result = action.run();
        if (result && typeof (result as Promise<void>).catch == 'function') {
          (result as Promise<void>).catch(e => console.error(`Action ${action.key} failed`, e));
        }
      } catch (e) {
        console.error(`Action ${action.key} failed`, e);
      }
    } else if (action.intent) {
      this.open(action.intent);
    }
  }

  pick(card:CardModel) {
    if (card.intent) this.open(card.intent);
  }

  more(row:RowState) {
    let source = row.model.source;
    if (!('page' in source) || row.last || row.loading) return;
    row.loading = true;
    row.sub = source.page(row.page + 1).subscribe({
      next: page => {
        row.page++;
        row.items = [...row.items, ...page.items];
        row.last = page.last;
        row.loading = false;
        this.cdr.markForCheck();
      },
      error: e => {
        console.error(`Row ${row.model.key}: a page failed`, e);
        row.loading = false;
        row.last = true;
      },
    });
  }

  byKey(i:number, item:{ key:any } | RowState) {
    return 'model' in item ? item.model.key : item.key;
  }

  private open(intent:Intent) {
    this.navigator.open(intent);
  }

  private render() {
    let all = this.contributions.flatMap(c => this.results.get(c.id) || []);
    if (this.kind == 'actions') this.actions = all;
    else if (this.kind == 'meta') this.meta = all;
    else {
      let previous = new Map(this.rows.map(r => [r.model.key, r]));
      this.rows = (all as RowModel[]).map(model => {
        let kept = previous.get(model.key);
        if (kept && kept.model.source === model.source) return kept;
        kept?.sub?.unsubscribe();
        let state:RowState = { model, items: [], page: 0, last: false, loading: false };
        if ('items' in model.source) {
          state.items = model.source.items;
          state.last = true;
        } else {
          setTimeout(() => this.more(state));
        }
        return state;
      });
    }
    this.cdr.markForCheck();
  }

  private clear() {
    this.subs.forEach(s => s.unsubscribe());
    this.subs = [];
    this.rows.forEach(r => r.sub?.unsubscribe());
    this.results.clear();
    this.actions = [];
    this.rows = [];
    this.meta = [];
  }
}
