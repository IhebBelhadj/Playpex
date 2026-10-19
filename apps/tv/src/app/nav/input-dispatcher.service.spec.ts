import { Subject } from 'rxjs';
import { InputDispatcher } from './input-dispatcher.service';
import { LayerStack, LAYER_PRIORITY } from './layer-stack.service';
import { Entry } from './screen';
import { ScreenRef } from './screen-ref';

// The dispatcher and the layer stack against a stand-in navigator: who gets
// select / back, in which order

function entry(id:number):Entry {
  return { id, screen: { id: 'test.' + id, path: 'p' + id, component: null, kind: 'detail' }, params: {}, payload: null, state: {}, left: false };
}

describe('nav InputDispatcher and LayerStack', () => {

  let navigator:any;
  let engine:any;
  let layers:LayerStack;
  let dispatcher:InputDispatcher;
  let screen:ScreenRef;
  let frame:ScreenRef;
  let host:HTMLElement;
  let buttons:HTMLElement[];

  beforeEach(() => {
    host = document.createElement('div');
    host.innerHTML = '<button class="a">a</button><div class="row"><button class="b">b</button></div><div class="panel"><button class="c">c</button></div>';
    document.body.appendChild(host);
    buttons = ['a', 'b', 'c'].map(c => host.querySelector('.' + c) as HTMLElement);

    let current = entry(1);
    screen = new ScreenRef(null, null, host, 'screen');
    frame = new ScreenRef(null, null, host, 'frame');
    screen.bind(current);
    frame.bind(current);
    navigator = {
      busy: false,
      current,
      activating: null,
      events$: new Subject(),
      owners: () => [screen, frame],
      back: jasmine.createSpy('back'),
      restoreFocus: () => false,
    };
    engine = { focus: (el:HTMLElement) => { el.focus(); return true; } };
    layers = new LayerStack(navigator, engine);
    dispatcher = new InputDispatcher(navigator, layers);
  });

  afterEach(() => host.remove());

  it('select fires the nearest (pxSelect) around the focused element', () => {
    let fired:string[] = [];
    dispatcher.registerSelect(buttons[0], { fire: () => fired.push('a') });
    dispatcher.registerSelect(host.querySelector('.row'), { fire: el => fired.push('row:' + el.className) });
    buttons[0].focus();
    dispatcher.dispatch('select');
    buttons[1].focus();
    dispatcher.dispatch('select');
    expect(fired).toEqual(['a', 'row:b']);
  });

  it('select without a (pxSelect) goes to the screen, then the frame', () => {
    let seen:string[] = [];
    frame.onSelect(() => { seen.push('frame'); });
    screen.onSelect(el => { seen.push('screen:' + el.className); return false; });
    buttons[2].focus();
    dispatcher.dispatch('select');
    expect(seen).toEqual(['screen:c', 'frame']);
  });

  it('back: in-page steps first, then the navigator', () => {
    let step = true;
    screen.onBack(() => step);
    dispatcher.dispatch('back');
    expect(navigator.back).not.toHaveBeenCalled();
    step = false;
    dispatcher.dispatch('back');
    expect(navigator.back).toHaveBeenCalledTimes(1);
  });

  it('leave skips the in-page steps', () => {
    screen.onBack(() => true);
    dispatcher.dispatch('leave');
    expect(navigator.back).toHaveBeenCalledTimes(1);
    screen.onLeave(() => true);
    dispatcher.dispatch('leave');
    expect(navigator.back).toHaveBeenCalledTimes(1);
  });

  it('ignores input while the navigator is changing screens', () => {
    navigator.busy = true;
    dispatcher.dispatch('back');
    expect(navigator.back).not.toHaveBeenCalled();
  });

  it('a layer takes all input; the screen gets none, Back closes it and focus goes back', () => {
    let screenSaw = 0;
    screen.onSelect(() => { screenSaw++; });
    screen.onBack(() => { screenSaw++; return true; });
    buttons[0].focus();

    let layer = layers.open<string>({ id: 'panel', element: host.querySelector('.panel') as HTMLElement });
    let picked:string[] = [];
    let done = false;
    layer.result$.subscribe({ next: r => picked.push(r), complete: () => done = true });
    dispatcher.registerSelect(buttons[2], { fire: () => layer.close('c') });
    buttons[0].focus();          // focus outside the layer: its (pxSelect) doesn't count
    dispatcher.registerSelect(buttons[0], { fire: () => picked.push('outside') });
    dispatcher.dispatch('select');
    expect(picked).toEqual([]);

    buttons[2].focus();
    dispatcher.dispatch('select');
    expect(picked).toEqual(['c']);
    expect(done).toBeTrue();
    expect(layers.top).toBeNull();
    expect(screenSaw).toBe(0);
    expect(document.activeElement).toBe(buttons[0]);

    let second = layers.open({ id: 'second', element: host.querySelector('.panel') as HTMLElement });
    buttons[2].focus();
    dispatcher.dispatch('back');
    expect(second.closed).toBeTrue();
    expect(navigator.back).not.toHaveBeenCalled();
    expect(screenSaw).toBe(0);
  });

  it("a layer's own back steps run before it closes", () => {
    let layer = layers.open({ id: 'panel' });
    let inner = true;
    layer.onBack(() => inner);
    dispatcher.dispatch('back');
    expect(layer.closed).toBeFalse();
    inner = false;
    dispatcher.dispatch('leave');
    expect(layer.closed).toBeTrue();
  });

  it('orders layers by priority, then by opening', () => {
    let picker = layers.open({ id: 'picker', priority: LAYER_PRIORITY.modal });
    let lost = layers.open({ id: 'lost', priority: LAYER_PRIORITY.system, global: true });
    let panel = layers.open({ id: 'panel' });
    expect(layers.layers.map(l => l.def.id)).toEqual(['panel', 'picker', 'lost']);
    expect(layers.top).toBe(lost);
    lost.close();
    expect(layers.top).toBe(picker);
    picker.close();
    expect(layers.top).toBe(panel);
  });

  it("closes a screen's layers when another screen is shown, not the global ones", () => {
    let picker = layers.open({ id: 'picker', priority: LAYER_PRIORITY.modal });
    let lost = layers.open({ id: 'lost', priority: LAYER_PRIORITY.system, global: true });
    expect(picker.owner).toBe(navigator.current);
    expect(lost.owner).toBeNull();
    navigator.current = entry(2);
    navigator.events$.next({ type: 'navigated', entry: navigator.current, stack: [navigator.current] });
    expect(picker.closed).toBeTrue();
    expect(lost.closed).toBeFalse();
  });
});
