import { ElementRef } from '@angular/core';
import { fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { InputDispatcher, LayerStack, LAYER_PRIORITY } from '../../nav/public-api';
import { Dialogs } from './dialogs.service';
import { PxOverlay } from './px-overlay';

// The overlays' layer wiring (PxOverlay, what <px-dialog> and <px-panel>
// share) against a stand-in navigator, and the Dialogs service

class TestOverlay extends PxOverlay { }

describe('ui overlays', () => {

  let navigator:any;
  let layers:LayerStack;
  let dispatcher:InputDispatcher;
  let page:HTMLElement;
  let host:HTMLElement;

  function overlay(level:PxOverlay['level'] = 'modal'):TestOverlay {
    let o = new TestOverlay(new ElementRef(host), layers);
    o.id = 'test';
    o.level = level;
    return o;
  }

  beforeEach(() => {
    page = document.createElement('div');
    page.innerHTML = '<button class="page">page</button>';
    host = document.createElement('div');
    host.innerHTML = '<button data-px-item class="one">one</button><button data-px-item class="two">two</button>';
    document.body.append(page, host);
    let current = { id: 1 };
    navigator = {
      busy: false,
      current,
      activating: null,
      events$: new Subject(),
      owners: () => [],
      back: jasmine.createSpy('back'),
      restoreFocus: () => false,
    };
    layers = new LayerStack(navigator, { focus: (el:HTMLElement) => { el.focus(); return true; } } as any);
    dispatcher = new InputDispatcher(navigator, layers);
    (page.firstElementChild as HTMLElement).focus();
  });

  afterEach(() => {
    page.remove();
    host.remove();
  });

  it('opens a layer of its level and focuses its first item', fakeAsync(() => {
    let o = overlay('system');
    o.ngAfterViewInit();
    expect(layers.top).toBe(o.layer);
    expect(o.layer.priority).toBe(LAYER_PRIORITY.system);
    tick(0);
    expect(document.activeElement).toBe(host.querySelector('.one'));
    o.ngOnDestroy();
    tick(500);
  }));

  it('focuses the `focus` selector when given', fakeAsync(() => {
    let o = overlay();
    o.focus = '.two';
    o.ngAfterViewInit();
    tick(0);
    expect(document.activeElement).toBe(host.querySelector('.two'));
    o.ngOnDestroy();
    tick(500);
  }));

  it('Back closes it and emits (closed); the focus goes back', fakeAsync(() => {
    let o = overlay();
    let closed = 0;
    o.closed.subscribe(() => closed++);
    o.ngAfterViewInit();
    tick(0);
    dispatcher.dispatch('back');
    expect(layers.top).toBeNull();
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(page.firstElementChild);
    tick(500);
  }));

  it('with (back) listened to, Back is the host\'s and it stays open', fakeAsync(() => {
    let o = overlay('panel');
    let backs = 0;
    o.back.subscribe(() => backs++);
    o.ngAfterViewInit();
    dispatcher.dispatch('back');
    expect(backs).toBe(1);
    expect(layers.top).toBe(o.layer);
    o.ngOnDestroy();
    expect(layers.top).toBeNull();
    tick(500);
  }));

  it('destroyed or finished by the host: closed quietly, focus back', fakeAsync(() => {
    let o = overlay();
    let closed = 0;
    o.closed.subscribe(() => closed++);
    o.ngAfterViewInit();
    tick(0);
    o.finish();
    o.ngOnDestroy();
    expect(layers.top).toBeNull();
    expect(closed).toBe(0);
    expect(document.activeElement).toBe(page.firstElementChild);
    tick(500);
  }));

  it('takes the focus back when something outside grabbed it', fakeAsync(() => {
    let o = overlay();
    o.ngAfterViewInit();
    tick(0);
    (page.firstElementChild as HTMLElement).focus();
    tick(400);
    expect(document.activeElement).toBe(host.querySelector('.one'));
    // and select with the focus outside brings it back first
    (page.firstElementChild as HTMLElement).focus();
    dispatcher.dispatch('select');
    tick(0);
    expect(document.activeElement).toBe(host.querySelector('.one'));
    o.ngOnDestroy();
  }));

  it('a global one survives navigation, a screen\'s own closes with it', fakeAsync(() => {
    let own = overlay();
    let global = overlay('alert');
    global.global = true;
    let closed:string[] = [];
    own.closed.subscribe(() => closed.push('own'));
    global.closed.subscribe(() => closed.push('global'));
    own.ngAfterViewInit();
    global.ngAfterViewInit();
    navigator.current = { id: 2 };
    navigator.events$.next({ type: 'navigated' });
    expect(closed).toEqual(['own']);
    expect(layers.layers.length).toBe(1);
    global.ngOnDestroy();
    tick(500);
  }));

  describe('Dialogs', () => {

    let dialogs:Dialogs;

    beforeEach(() => dialogs = new Dialogs());

    it('choose: open while subscribed, emits the picked value once', () => {
      let values:number[] = [];
      let done = false;
      let sub = dialogs.choose({ title: 'Pick', choices: [{ key: 'a', label: 'A', value: 1 }, { key: 'b', label: 'B', value: 2 }] })
        .subscribe({ next: v => values.push(v), complete: () => done = true });
      let request = dialogs.open$.value[0];
      expect(request.id).toMatch(/^dialog-/);
      expect(request.level).toBe('modal');
      request.pick(request.choices[1]);
      expect(values).toEqual([2]);
      expect(done).toBeTrue();
      expect(dialogs.open$.value.length).toBe(0);
      sub.unsubscribe();
    });

    it('choose: Back completes empty; unsubscribing closes it', () => {
      let values:number[] = [];
      dialogs.choose({ choices: [{ key: 'a', label: 'A', value: 1 }] }).subscribe(v => values.push(v));
      dialogs.open$.value[0].cancel();
      expect(values).toEqual([]);
      expect(dialogs.open$.value.length).toBe(0);

      let sub = dialogs.choose({ choices: [{ key: 'a', label: 'A', value: 1 }] }).subscribe();
      expect(dialogs.open$.value.length).toBe(1);
      sub.unsubscribe();
      expect(dialogs.open$.value.length).toBe(0);
    });

    it('confirm answers false on Back, alert emits once dismissed', () => {
      let answers:boolean[] = [];
      dialogs.confirm({ title: 'Sure?' }).subscribe(a => answers.push(a));
      dialogs.open$.value[0].cancel();
      dialogs.confirm({ title: 'Sure?', confirm: 'Yes' }).subscribe(a => answers.push(a));
      let request = dialogs.open$.value[0];
      expect(request.choices.map(c => c.label)).toEqual(['Yes', 'Cancel']);
      request.pick(request.choices[0]);
      expect(answers).toEqual([false, true]);

      let dismissed = 0;
      dialogs.alert({ text: 'Oops' }).subscribe(() => dismissed++);
      expect(dialogs.open$.value[0].subtitle).toBe('Oops');
      dialogs.open$.value[0].cancel();
      expect(dismissed).toBe(1);
    });
  });
});
