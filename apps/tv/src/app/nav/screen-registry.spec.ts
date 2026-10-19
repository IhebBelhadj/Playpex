import { Component } from '@angular/core';
import { FRAME_KEY, SCREEN_KEY, ScreenRegistry } from './screen-registry';

@Component({ template: '' })
class PageComponent { }

@Component({ template: '' })
class FrameComponent { }

class ServerGuard { }
class ProfileGuard { }
class AdultGuard { }
const GUARDS = { server: ServerGuard, profile: ProfileGuard, adult: AdultGuard };

describe('nav ScreenRegistry', () => {

  let registry:ScreenRegistry;
  const frame = { path: 'movies', component: FrameComponent, data: { media: 'movie' } };

  beforeEach(() => {
    registry = new ScreenRegistry();
    registry.define({ id: 'core.profiles', path: 'profiles', component: PageComponent, kind: 'root', requires: ['server'] });
    registry.define({ id: 'core.movies', path: 'movies/list', component: PageComponent, frame, kind: 'section', requires: ['profile'], menu: { label: 'Movies', icon: 'film', order: 20 } });
    registry.define({ id: 'core.movie', path: 'movies/movie/:id', component: PageComponent, frame, kind: 'detail', requires: ['profile'] });
    registry.define({ id: 'core.search', path: 'search', component: PageComponent, kind: 'section', menu: { label: 'Search', icon: 'search', order: 10 } });
  });

  it('matches URLs back to screens, with decoded params', () => {
    expect(registry.match('/movies/movie/603')).toEqual({ screen: registry.get('core.movie'), params: { id: '603' } });
    expect(registry.match('/movies/movie/a%2Fb?x=1#y')?.params).toEqual({ id: 'a/b' });
    expect(registry.match('/movies/list')?.screen.id).toBe('core.movies');
    expect(registry.match('/movies/movie')).toBeNull();
    expect(registry.match('/nowhere')).toBeNull();
  });

  it('builds URLs from params (encoded) and refuses missing ones', () => {
    expect(registry.urlFor({ screen: 'core.movie', params: { id: 603 } })).toBe('/movies/movie/603');
    expect(registry.urlFor({ screen: 'core.movie', params: { id: 'a/b' } })).toBe('/movies/movie/a%2Fb');
    expect(registry.urlFor({ screen: 'core.profiles' })).toBe('/profiles');
    expect(() => registry.urlFor({ screen: 'core.movie' })).toThrowError(/missing param id/);
    expect(() => registry.urlFor({ screen: 'core.nope' })).toThrowError(/Unknown screen/);
  });

  it('generates the routes: one parent per frame, guards from requires, screen ids in data', () => {
    let routes = registry.buildRoutes(GUARDS, [{ path: '', redirectTo: '/profiles', pathMatch: 'full' }]);
    expect(routes.map(r => r.path)).toEqual(['', 'profiles', 'movies', 'search']);

    let profiles = routes[1];
    expect(profiles.component).toBe(PageComponent);
    expect(profiles.canActivate).toEqual([ServerGuard]);
    expect(profiles.data[SCREEN_KEY]).toBe('core.profiles');

    let movies = routes[2];
    expect(movies.component).toBe(FrameComponent);
    expect(movies.canActivate).toEqual([ProfileGuard]);
    expect(movies.data).toEqual({ media: 'movie', [FRAME_KEY]: 'movies' });
    expect(movies.children.map(c => c.path)).toEqual(['list', 'movie/:id']);
    expect(movies.children[1].data[SCREEN_KEY]).toBe('core.movie');

    expect(routes[3].canActivate).toBeUndefined();
  });

  it('lists the menu sections in order', () => {
    expect(registry.sections().map(s => s.id)).toEqual(['core.search', 'core.movies']);
  });

  it('refuses duplicate ids and paths, and paths outside their frame', () => {
    expect(() => registry.define({ id: 'core.movie', path: 'other', component: PageComponent, kind: 'detail' })).toThrowError(/already defined/);
    expect(() => registry.define({ id: 'core.other', path: '/search/', component: PageComponent, kind: 'detail' })).toThrowError(/same path/);
    expect(() => registry.define({ id: 'core.x', path: 'shows/x', component: PageComponent, frame, kind: 'detail' })).toThrowError(/isn't under its frame/);
  });

  it('holds plugins to their namespace (decision G)', () => {
    expect(() => registry.define({ id: 'hello.main', path: 'p/hello/main', component: PageComponent, kind: 'section' })).not.toThrow();
    expect(() => registry.define({ id: 'plugin.hello', path: 'p/hello/a', component: PageComponent, kind: 'section' })).toThrowError(/plugin.<pluginId>.<name>/);
    expect(() => registry.define({ id: 'plugin.hello.a', path: 'hello/a', component: PageComponent, kind: 'section' })).toThrowError(/p\/hello\//);
    expect(() => registry.define({ id: 'plugin.hello.b', path: 'p/hello/b', component: PageComponent, kind: 'root' })).toThrowError(/core's/);
    expect(() => registry.define({ id: 'plugin.hello.c', path: 'p/hello/c', component: PageComponent, kind: 'detail' })).not.toThrow();
  });
});
