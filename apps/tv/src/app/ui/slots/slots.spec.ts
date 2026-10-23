import { NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';
import { Navigator } from '../../nav/public-api';
import { ContributionRegistry } from './contribution-registry';
import { CONTRIBUTION_REGISTRY, PxSlotComponent } from './px-slot.component';
import { MovieContext } from './slots';
import { PxActionComponent } from '../atoms/px-action.component';
import { PxMetaComponent } from '../atoms/px-meta.component';
import { PxProgressComponent } from '../atoms/px-progress.component';
import { PxSpinnerComponent } from '../atoms/px-spinner.component';
import { PxSkeletonComponent } from '../atoms/px-skeleton.component';
import { PxCardComponent } from '../cards/px-card.component';
import { PxCardRowComponent } from '../cards/px-card-row.component';

// Slots and contributions (docs/ui-system-plan.md §5.6, step 6)

const movie = (kids = false, title = 'Heat'):MovieContext => ({
  movie: { tmdbId: 949, imdbId: 'tt0113277', title, year: '1995' },
  profile: { id: 'p1', name: 'Ann', kids },
});

describe('ContributionRegistry', () => {

  let registry:ContributionRegistry;

  beforeEach(() => registry = new ContributionRegistry());

  it('orders a slot\'s contributions by order, ties by id', () => {
    registry.define({ id: 'plugin.b.one', slot: 'core.movie.actions', order: 20, actions: () => [] });
    registry.define({ id: 'plugin.a.two', slot: 'core.movie.actions', order: 20, actions: () => [] });
    registry.define({ id: 'core.first', slot: 'core.movie.actions', order: 10, actions: () => [] });
    expect(registry.for('core.movie.actions', movie()).map(c => c.id)).toEqual(['core.first', 'plugin.a.two', 'plugin.b.one']);
  });

  it('refuses bad ids, the wrong kind, duplicates and too many per plugin', () => {
    expect(() => registry.define({ id: 'hello', slot: 'core.movie.actions', actions: () => [] })).toThrowError(/plugin\.<pluginId>/);
    expect(() => registry.define({ id: 'plugin.x.rows', slot: 'core.movie.actions', rows: () => [] } as any)).toThrowError(/takes actions/);
    registry.define({ id: 'plugin.x.a', slot: 'core.movie.actions', actions: () => [] });
    expect(() => registry.define({ id: 'plugin.x.a', slot: 'core.movie.actions', actions: () => [] })).toThrowError(/already defined/);
    registry.define({ id: 'plugin.x.b', slot: 'core.movie.actions', actions: () => [] });
    registry.define({ id: 'plugin.x.c', slot: 'core.movie.actions', actions: () => [] });
    expect(() => registry.define({ id: 'plugin.x.d', slot: 'core.movie.actions', actions: () => [] })).toThrowError(/at most 3/);
  });

  it('takes search filter chips on core.search.filters', () => {
    let def = registry.define({
      id: 'plugin.x.chip', slot: 'core.search.filters',
      searchFilter: ctx => [{ key: 'x:chip', label: 'X', rows: [] }],
    });
    let seen:any[] = [];
    registry.models(def, { query: 'abc', profile: { id: 'p', name: 'P', kids: false } }).subscribe(items => seen.push(items));
    expect(seen[0][0].label).toBe('X');
    expect(() => registry.define({ id: 'plugin.x.rows2', slot: 'core.search.filters', rows: () => [] } as any)).toThrowError(/takes searchFilter/);
  });

  it('never gives a kids profile an adults plugin\'s contributions', () => {
    registry.define({ id: 'plugin.x.grownup', slot: 'core.movie.actions', adults: true, actions: () => [] });
    registry.define({ id: 'plugin.x.family', slot: 'core.movie.actions', actions: () => [] });
    expect(registry.for('core.movie.actions', movie(true)).map(c => c.id)).toEqual(['plugin.x.family']);
    expect(registry.for('core.movie.actions', movie(false)).length).toBe(2);
  });

  it('a throwing contribution shows nothing', () => {
    spyOn(console, 'error');
    let def = registry.define({ id: 'plugin.x.boom', slot: 'core.movie.actions', actions: () => { throw new Error('boom'); } });
    let seen:any[] = [];
    registry.models(def, movie()).subscribe(items => seen.push(items));
    expect(seen).toEqual([[]]);
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses a plugin\'s keys that don\'t start with its id', () => {
    spyOn(console, 'error');
    let def = registry.define({ id: 'plugin.x.keys', slot: 'core.movie.actions', actions: () => [{ key: 'party', label: 'P', icon: 'tv' }] });
    let good = registry.define({ id: 'plugin.x.good', slot: 'core.movie.actions', actions: () => [{ key: 'x:party', label: 'P', icon: 'tv' }] });
    let seen:any[] = [];
    registry.models(def, movie()).subscribe(items => seen.push(items.length));
    registry.models(good, movie()).subscribe(items => seen.push(items.length));
    expect(seen).toEqual([0, 1]);
  });
});

describe('<px-slot>', () => {

  let registry:ContributionRegistry;
  let navigator:jasmine.SpyObj<Navigator>;

  function create(name:any, context:any) {
    TestBed.configureTestingModule({
      declarations: [PxSlotComponent, PxActionComponent, PxMetaComponent, PxCardRowComponent, PxCardComponent, PxProgressComponent, PxSpinnerComponent, PxSkeletonComponent],
      providers: [
        { provide: CONTRIBUTION_REGISTRY, useValue: registry },
        { provide: Navigator, useValue: navigator },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    let fixture = TestBed.createComponent(PxSlotComponent);
    fixture.componentInstance.name = name;
    fixture.componentInstance.context = context;
    fixture.componentInstance.ngOnChanges();
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    registry = new ContributionRegistry();
    navigator = jasmine.createSpyObj('Navigator', ['open']);
  });

  it('renders the contributions\' actions in order, again when the context changes', () => {
    registry.define({ id: 'plugin.b.one', slot: 'core.movie.actions', order: 20,
      actions: ctx => [{ key: 'b:about', label: 'About ' + ctx.movie.title, icon: 'tv' }] });
    registry.define({ id: 'plugin.a.one', slot: 'core.movie.actions', order: 10,
      actions: () => [{ key: 'a:party', label: 'Party', icon: 'tv' }] });
    let fixture = create('core.movie.actions', movie());
    expect(fixture.componentInstance.actions.map(a => a.key)).toEqual(['a:party', 'b:about']);
    fixture.componentInstance.context = movie(false, 'Ronin');
    fixture.componentInstance.ngOnChanges();
    expect(fixture.componentInstance.actions[1].label).toBe('About Ronin');
  });

  it('follows an Observable contribution, and lets it go when the context changes', () => {
    let state = new BehaviorSubject<any[]>([{ key: 'x:follow', label: 'Follow', icon: 'tv' }]);
    registry.define({ id: 'plugin.x.toggle', slot: 'core.movie.actions', actions: () => state });
    let fixture = create('core.movie.actions', movie());
    expect(fixture.componentInstance.actions[0].on).toBeFalsy();
    state.next([{ key: 'x:follow', label: 'Following', icon: 'tv', on: true }]);
    expect(fixture.componentInstance.actions[0].on).toBeTrue();
    expect(state.observed).toBeTrue();
    fixture.componentInstance.context = movie(false, 'Ronin');
    fixture.componentInstance.ngOnChanges();
    fixture.componentInstance.ngOnDestroy();
    expect(state.observed).toBeFalse();
  });

  it('runs an action, or opens its intent', () => {
    let ran = 0;
    registry.define({ id: 'plugin.x.acts', slot: 'core.movie.actions', actions: () => [
      { key: 'x:run', label: 'Run', icon: 'tv', run: () => { ran++; } },
      { key: 'x:open', label: 'Open', icon: 'tv', intent: { screen: 'plugin.x.page' } },
    ] });
    let fixture = create('core.movie.actions', movie());
    let [run, open] = fixture.componentInstance.actions;
    fixture.componentInstance.run(run);
    fixture.componentInstance.run(open);
    expect(ran).toBe(1);
    expect(navigator.open).toHaveBeenCalledWith({ screen: 'plugin.x.page' });
  });

  it('pages a paged row on nearEnd', () => {
    let pages:number[] = [];
    registry.define({ id: 'plugin.x.row', slot: 'core.movie.rows', rows: () => [{
      key: 'x:picks', title: 'Picks', source: { page: n => {
        pages.push(n);
        return of({ items: [{ key: 'x:' + n, title: 'Item ' + n }], last: n >= 2 });
      } },
    }] });
    let fixture = create('core.movie.rows', movie());
    let row = fixture.componentInstance.rows[0];
    fixture.componentInstance.more(row);
    fixture.componentInstance.more(row);
    fixture.componentInstance.more(row);
    expect(pages).toEqual([1, 2]);
    expect(row.items.map(i => i.key)).toEqual(['x:1', 'x:2']);
    expect(row.last).toBeTrue();
  });
});
