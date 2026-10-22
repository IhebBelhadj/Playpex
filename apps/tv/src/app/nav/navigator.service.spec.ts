import { Component, Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CanActivate, Router, RouteReuseStrategy, UrlTree } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject } from 'rxjs';
import { PositionStore } from '../movement/position-store.service';
import { ProfilesService } from '../profiles.service';
import { Navigator } from './navigator.service';
import { NavReuseStrategy } from './reuse-strategy';
import { Entry, LeaveContext } from './screen';
import { SCREEN_REGISTRY, ScreenRegistry } from './screen-registry';
import { ScreenRef } from './screen-ref';
import { useFrame, useScreen } from './use-screen';

// The navigator against the real Angular router, on a small screen table

let allowed = true;

@Injectable({ providedIn: 'root' })
class TestGuard implements CanActivate {
  constructor(private router:Router) { }
  canActivate():boolean | UrlTree {
    return allowed || this.router.parseUrl('/profiles');
  }
}

@Component({ template: '<router-outlet></router-outlet>' })
class RootComponent { }

@Component({ template: '<router-outlet></router-outlet>' })
class FrameComponent {
  frame = useFrame();
}

let pages:PageComponent[] = [];

@Component({ template: '<div class="page"></div>' })
class PageComponent {
  screen:ScreenRef = useScreen();
  constructor() {
    pages.push(this);
  }
}

function makeRegistry():ScreenRegistry {
  let registry = new ScreenRegistry();
  let frame = { path: 'movies', component: FrameComponent };
  registry.define({ id: 'core.profiles', path: 'profiles', component: PageComponent, kind: 'root' });
  registry.define({ id: 'core.movies', path: 'movies/list', component: PageComponent, frame, kind: 'section', requires: ['profile'] });
  registry.define({ id: 'core.movie', path: 'movies/movie/:id', component: PageComponent, frame, kind: 'detail', requires: ['profile'] });
  registry.define({ id: 'core.episode', path: 'episode/:n', component: PageComponent, kind: 'detail', reuse: true });
  registry.define({ id: 'core.editor', path: 'editor', component: PageComponent, kind: 'detail', back: { open: { screen: 'core.profiles' } } });
  registry.define({ id: 'core.player', path: 'player', component: PageComponent, kind: 'fullscreen' });
  registry.define({ id: 'core.power', path: 'power', component: PageComponent, kind: 'system' });
  return registry;
}

describe('nav Navigator', () => {

  let nav:Navigator;
  let router:Router;
  let positions:PositionStore;

  const ids = () => nav.stack.map(e => e.screen.id);
  const top = () => pages[pages.length - 1];

  beforeEach(() => {
    allowed = true;
    pages = [];
    let registry = makeRegistry();
    TestBed.configureTestingModule({
      imports: [RouterTestingModule.withRoutes(registry.buildRoutes({ display: TestGuard, server: TestGuard, profile: TestGuard, adult: TestGuard }))],
      declarations: [RootComponent, FrameComponent, PageComponent],
      providers: [
        { provide: SCREEN_REGISTRY, useValue: registry },
        { provide: RouteReuseStrategy, useClass: NavReuseStrategy },
        { provide: ProfilesService, useValue: { current: new BehaviorSubject(null) } },
      ],
    });
    TestBed.createComponent(RootComponent).detectChanges();
    nav = TestBed.inject(Navigator);
    router = TestBed.inject(Router);
    positions = TestBed.inject(PositionStore);
  });

  it('pushes, pops and drives the router, without growing the browser history', async () => {
    expect(await nav.reset({ screen: 'core.movies' })).toBeTrue();
    await nav.open({ screen: 'core.movie', params: { id: 603 }, payload: { title: 'The Matrix' } });
    await nav.open({ screen: 'core.movie', params: { id: 604 } });
    expect(ids()).toEqual(['core.movies', 'core.movie', 'core.movie']);
    expect(router.url).toBe('/movies/movie/604');
    expect(nav.current.params).toEqual({ id: '604' });

    await nav.back();
    expect(router.url).toBe('/movies/movie/603');
    expect(nav.current.payload).toEqual({ title: 'The Matrix' });
    expect(nav.canGoBack()).toBeTrue();
    await nav.back();
    expect(ids()).toEqual(['core.movies']);
    expect(router.url).toBe('/movies/list');
  });

  it('gives each visit its own component, bound to its entry', async () => {
    await nav.reset({ screen: 'core.movies' });
    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    let first = top();
    expect(first.screen.entry).toBe(nav.current);
    expect(first.screen.params).toEqual({ id: '1' });

    await nav.open({ screen: 'core.movie', params: { id: 2 } });
    let second = top();
    expect(second).not.toBe(first);
    expect(second.screen.active).toBeTrue();
    expect(first.screen.entry).toBeNull();        // its route is gone

    await nav.back();
    let again = top();
    expect(again).not.toBe(second);
    expect(again.screen.params).toEqual({ id: '1' });
    expect(again.screen.returning).toBeTrue();
  });

  it('keeps a frame across its screens, bound to the shown one', async () => {
    await nav.reset({ screen: 'core.movies' });
    let frameEntries:(Entry | null)[] = [];
    let frame = TestBed.inject(Navigator).owners().find(ref => ref.kind == 'frame');
    frame.entry$.subscribe(entry => frameEntries.push(entry));
    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    expect(nav.owners().map(ref => ref.kind)).toEqual(['screen', 'frame']);
    expect(nav.owners()[1]).toBe(frame);
    expect(frameEntries.map(e => e?.screen.id)).toEqual(['core.movies', 'core.movie']);
  });

  it('replaces the top entry; a `reuse` screen keeps its component and emits the new entry', async () => {
    await nav.reset({ screen: 'core.movies' });
    await nav.open({ screen: 'core.episode', params: { n: 1 } });
    let page = top();
    let seen:string[] = [];
    page.screen.params$.subscribe(p => seen.push(p['n']));
    await nav.replace({ screen: 'core.episode', params: { n: 2 } });
    expect(ids()).toEqual(['core.movies', 'core.episode']);
    expect(top()).toBe(page);
    expect(seen).toEqual(['1', '2']);
    await nav.back();
    expect(ids()).toEqual(['core.movies']);
  });

  it('applies the root back policy: sections and roots open the power menu', async () => {
    await nav.reset({ screen: 'core.movies' });
    expect(await nav.back()).toBeTrue();
    expect(ids()).toEqual(['core.movies', 'core.power']);
    await nav.back();
    expect(ids()).toEqual(['core.movies']);

    await nav.reset({ screen: 'core.editor' });
    await nav.back();
    expect(ids()).toEqual(['core.editor', 'core.profiles']);

    await nav.reset({ screen: 'core.player' });
    expect(await nav.back()).toBeFalse();
    expect(ids()).toEqual(['core.player']);
  });

  it('pops back to a screen, and resets the stack', async () => {
    await nav.reset({ screen: 'core.profiles' });
    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    await nav.open({ screen: 'core.movie', params: { id: 2 } });
    await nav.open({ screen: 'core.player' });
    await nav.backTo('core.profiles');
    expect(ids()).toEqual(['core.profiles']);
    expect(await nav.backTo('core.movie')).toBeFalse();
  });

  it('switching to the shown section keeps its root entry', async () => {
    await nav.reset({ screen: 'core.movies' });
    let root = nav.root;
    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    await nav.switchSection('core.movies');
    expect(nav.stack).toEqual([root]);
  });

  it('runs one navigation at a time, in order', async () => {
    await nav.reset({ screen: 'core.movies' });
    let a = nav.open({ screen: 'core.movie', params: { id: 1 } });
    let b = nav.open({ screen: 'core.movie', params: { id: 2 } });
    let c = nav.back();
    await Promise.all([a, b, c]);
    expect(nav.stack.map(e => e.params['id'] || e.screen.id)).toEqual(['core.movies', '1']);
    expect(router.url).toBe('/movies/movie/1');
  });

  it('commits what a guard redirected to (a root: reset)', async () => {
    // (guards run when a route activates: the frame's, from outside it)
    await nav.reset({ screen: 'core.player' });
    allowed = false;
    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    expect(ids()).toEqual(['core.profiles']);
    expect(router.url).toBe('/profiles');
  });

  it('adopts navigations it did not start', async () => {
    await nav.reset({ screen: 'core.movies' });
    await router.navigateByUrl('/movies/movie/7');
    expect(ids()).toEqual(['core.movies', 'core.movie']);
    expect(nav.current.params).toEqual({ id: '7' });
    await router.navigateByUrl('/episode/3', { replaceUrl: true });
    expect(ids()).toEqual(['core.movies', 'core.episode']);
    await router.navigateByUrl('/profiles');
    expect(ids()).toEqual(['core.profiles']);
  });

  it('caps the stack, keeping the root', async () => {
    await nav.reset({ screen: 'core.movies' });
    let root = nav.root;
    for (let i = 1; i <= 55; i++) await nav.open({ screen: 'core.episode', params: { n: i } });
    expect(nav.stack.length).toBe(50);
    expect(nav.root).toBe(root);
    expect(nav.current.params).toEqual({ n: '55' });
    expect(nav.stack[1].params).toEqual({ n: '7' });
  });

  it('runs beforeLeave on every way out, saying whether the entry is gone', async () => {
    await nav.reset({ screen: 'core.movies' });
    await nav.open({ screen: 'core.player' });
    let calls:LeaveContext[] = [];
    top().screen.beforeLeave(ctx => { calls.push(ctx); });
    await nav.open({ screen: 'core.power' });
    expect(calls.map(c => [c.reason, c.removed])).toEqual([['open', false]]);
    await nav.back();
    top().screen.beforeLeave(ctx => { calls.push(ctx); });
    await nav.reset({ screen: 'core.profiles' });
    expect(calls.map(c => [c.reason, c.removed])).toEqual([['open', false], ['reset', true]]);
  });

  it('waits for an async beforeLeave', async () => {
    await nav.reset({ screen: 'core.movies' });
    await nav.open({ screen: 'core.player' });
    let released = false;
    top().screen.beforeLeave(() => new Promise<void>(resolve => setTimeout(() => { released = true; resolve(); }, 20)));
    await nav.back();
    expect(released).toBeTrue();
    expect(ids()).toEqual(['core.movies']);
  });

  it('scopes positions by entry, except for sections, and drops them with the entry', async () => {
    await nav.reset({ screen: 'core.movies' });
    expect(positions.scope).toBe('');
    positions.save('catalog:movie', { index: 3 });

    await nav.open({ screen: 'core.movie', params: { id: 1 } });
    let movie = nav.current;
    expect(positions.scope).toBe(`e${movie.id}:`);
    positions.save('cast', { index: 2 });

    await nav.open({ screen: 'core.movie', params: { id: 2 } });
    expect(positions.get('cast')).toBeUndefined();
    await nav.back();
    expect(positions.get('cast')).toEqual({ index: 2 });

    await nav.back();
    expect(positions.get('catalog:movie')).toEqual({ index: 3 });
    expect(positions.get('cast', `e${movie.id}:`)).toBeUndefined();
  });

  it('marks an entry as left once covered, and in-page back steps run last registered first', async () => {
    await nav.reset({ screen: 'core.movies' });
    let order:string[] = [];
    top().screen.onBack(() => { order.push('first'); return false; });
    top().screen.onBack(() => { order.push('second'); return true; });
    expect(nav.owners()[0].handleBack()).toBeTrue();
    expect(order).toEqual(['second']);

    let entry = nav.current;
    await nav.open({ screen: 'core.player' });
    expect(entry.left).toBeTrue();
  });
});
