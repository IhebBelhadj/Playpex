import { BehaviorSubject } from 'rxjs';
import { PositionStore, rememberedIndex } from './position-store.service';

describe('movement PositionStore', () => {

  it('rememberedIndex prefers the key, falls back to the (clamped) index', () => {
    let keys = ['a', 'b', 'c'];
    expect(rememberedIndex({ key: 'c', index: 0 }, keys)).toBe(2);
    expect(rememberedIndex({ key: 'gone', index: 1 }, keys)).toBe(1);
    expect(rememberedIndex({ key: 'gone', index: 9 }, keys)).toBe(2);
    expect(rememberedIndex({ key: 'gone' }, keys)).toBe(-1);
    expect(rememberedIndex(undefined, keys)).toBe(-1);
    expect(rememberedIndex({ index: 0 }, [])).toBe(-1);
  });

  it('merges saves, clears a container with its nested ones, and on profile change', () => {
    let current = new BehaviorSubject<any>({ id: 1 });
    let store = new PositionStore({ current } as any);
    store.save('stack', { key: 'row1' });
    store.save('stack', { scrollTop: 40 });
    store.save('stack/row1', { index: 3 });
    store.save('stacker', { index: 1 });
    expect(store.get('stack')).toEqual({ key: 'row1', scrollTop: 40 });

    store.clear('stack');
    expect(store.get('stack')).toBeUndefined();
    expect(store.get('stack/row1')).toBeUndefined();
    expect(store.get('stacker')).toEqual({ index: 1 });

    current.next({ id: 1 });           // same profile (preferences update): kept
    expect(store.get('stacker')).toEqual({ index: 1 });
    current.next({ id: 2 });
    expect(store.get('stacker')).toBeUndefined();
  });

  it('scopes keys (the navigator sets the scope) and clears one scope', () => {
    let store = new PositionStore({ current: new BehaviorSubject<any>(null) } as any);
    store.save('catalog', { index: 1 });
    store.setScope('e4:');
    store.save('cast', { index: 2 });
    expect(store.get('catalog')).toBeUndefined();
    expect(store.get('catalog', '')).toEqual({ index: 1 });
    store.save('cast', { scrollLeft: 30 }, 'e5:');
    store.setScope('e5:');
    expect(store.get('cast')).toEqual({ scrollLeft: 30 });
    store.clearScope('e4:');
    expect(store.get('cast', 'e4:')).toBeUndefined();
    expect(store.get('cast')).toEqual({ scrollLeft: 30 });
    store.clearScope('');
    expect(store.get('catalog', '')).toEqual({ index: 1 });
  });
});
