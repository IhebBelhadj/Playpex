import { Component, NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { PxItemDirective } from '../../movement/px-item.directive';
import { InputDispatcher } from '../../nav/input-dispatcher.service';
import { PxSelectDirective } from '../../nav/px-select.directive';
import { PxSliderComponent } from '../controls/px-slider.component';
import { PxTabsComponent, TabModel } from '../controls/px-tabs.component';
import { ActionModel, MetaItem } from '../models';
import { PxChipComponent } from '../overlay/px-chip.component';
import { Toasts } from '../toast/toasts.service';
import { dur } from '../units';
import { PxActionBarComponent } from './px-action-bar.component';
import { PxActionComponent } from './px-action.component';
import { PxButtonComponent } from './px-button.component';
import { PxEmptyComponent } from './px-empty.component';
import { PxMetaComponent } from './px-meta.component';
import { PxProgressComponent } from './px-progress.component';
import { PxScoreComponent } from './px-score.component';
import { PxSearchFieldComponent } from './px-search-field.component';
import { PxSkeletonComponent } from './px-skeleton.component';
import { PxSpinnerComponent } from './px-spinner.component';
import { PxSwitchComponent } from './px-switch.component';

// The step 3 atoms (docs/ui-system-plan.md §5.2): what they render in each
// state, their ARIA, their outputs. Movement containers (pxGrid) are out of
// the picture here (NO_ERRORS_SCHEMA): the movement specs cover them.

@Component({
  template: `
    <px-action-bar [actions]="models" (picked)="picked = $event">
      <px-action key="play" icon="play" label="Play" busyLabel="Finding torrents…" [busy]="busy" [progress]="progress"></px-action>
      <px-action key="list" icon="bookmark" onIcon="tick" label="Watch list" [on]="on"></px-action>
    </px-action-bar>
    <px-button key="b" [variant]="variant" label="Save" [caps]="true" [active]="on"></px-button>
    <px-search-field key="s" [query]="query" placeholder="Search movies"></px-search-field>
    <px-switch key="sw" label="Kids" hint="Family titles" [on]="on"></px-switch>
    <px-score source="tmdb" [value]="7.94"></px-score>
    <px-score class="imdb" source="imdb" [value]="8" votes="712K"></px-score>
    <px-meta [items]="meta"></px-meta>
    <px-progress [value]="1.4"></px-progress>
    <px-empty title="Nothing" text="Here" action="Retry" actionKey="retry" (act)="acted = acted + 1"></px-empty>
    <px-skeleton variant="poster"></px-skeleton>
    <px-tabs gridId="t" [tabs]="tabs" [active]="tab" (activeChange)="tab = $event"></px-tabs>
  `,
})
class HostComponent {
  busy = false;
  progress:number | null = 0.4;
  on = false;
  variant:any = 'outline';
  query = '';
  acted = 0;
  picked:ActionModel | null = null;
  models:ActionModel[] = [{ key: 'party', label: 'Watch party', icon: 'tv' }, { key: 'off', label: 'Off', icon: 'tv', disabled: true }];
  meta:MetaItem[] = [{ kind: 'text', text: '1995' }, { kind: 'chip', text: '1080p' }, { kind: 'score', source: 'imdb', value: 8.3 }, { kind: 'seal', text: '18+' }];
  tabs:TabModel[] = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  tab = 'a';
}

describe('ui atoms', () => {

  let fixture:ComponentFixture<HostComponent>;
  let host:HostComponent;
  let el:HTMLElement;
  let selects:Map<Element, PxSelectDirective>;

  const $ = (selector:string) => el.querySelector(selector) as HTMLElement;
  // what Enter on an element does: the nearest pxSelect around it
  function select(target:HTMLElement) {
    for (let node:Element | null = target; node; node = node.parentElement) {
      let directive = selects.get(node);
      if (directive) return directive.fire(target);
    }
  }

  beforeEach(() => {
    selects = new Map();
    TestBed.configureTestingModule({
      declarations: [
        HostComponent, PxActionComponent, PxActionBarComponent, PxButtonComponent, PxSearchFieldComponent, PxSwitchComponent,
        PxScoreComponent, PxMetaComponent, PxProgressComponent, PxEmptyComponent, PxSpinnerComponent, PxSkeletonComponent,
        PxTabsComponent, PxSliderComponent, PxChipComponent, PxItemDirective, PxSelectDirective,
      ],
      providers: [{
        provide: InputDispatcher,
        useValue: { registerSelect: (e:Element, d:PxSelectDirective) => selects.set(e, d), unregisterSelect: (e:Element) => selects.delete(e) },
      }],
      schemas: [NO_ERRORS_SCHEMA],
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  describe('px-action', () => {
    it('is one focusable item keyed for position memory, with its label and icon', () => {
      let play = $('[data-px-key="play"]');
      expect(play.tagName).toBe('BUTTON');
      expect(play.hasAttribute('data-px-item')).toBeTrue();
      expect(play.textContent).toContain('Play');
      expect((play.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('assets/icons/play.svg');
    });

    it('shows the resume progress, and the busy label instead of it', () => {
      expect(($('[data-px-key="play"] .progress span')).style.width).toBe('40%');
      host.busy = true;
      fixture.detectChanges();
      expect($('[data-px-key="play"]').textContent).toContain('Finding torrents…');
      expect($('[data-px-key="play"] .progress')).toBeNull();
      expect($('[data-px-key="play"]').getAttribute('aria-busy')).toBe('true');
    });

    it('swaps to its "on" icon and marks itself pressed', () => {
      let list = $('[data-px-key="list"]');
      expect(list.getAttribute('aria-pressed')).toBe('false');
      host.on = true;
      fixture.detectChanges();
      expect(list.classList).toContain('on');
      expect(list.getAttribute('aria-pressed')).toBe('true');
      expect(list.querySelector('img')!.getAttribute('src')).toBe('assets/icons/tick.svg');
    });

    it('renders models after the projected tiles and emits (picked), not for disabled ones', () => {
      let keys = Array.from(el.querySelectorAll('.px-action')).map(b => (b as HTMLElement).dataset['pxKey']);
      expect(keys).toEqual(['play', 'list', 'party', 'off']);
      select($('[data-px-key="party"]'));
      expect(host.picked?.key).toBe('party');
      host.picked = null;
      select($('[data-px-key="off"]'));
      expect(host.picked).toBeNull();
    });
  });

  describe('px-button and px-search-field', () => {
    it('takes its variant and options as classes', () => {
      let b = $('[data-px-key="b"]');
      expect(b.classList).toContain('v-outline');
      expect(b.classList).toContain('caps');
      host.variant = 'danger';
      host.on = true;
      fixture.detectChanges();
      expect(b.classList).toContain('v-danger');
      expect(b.classList).toContain('active');
    });

    it('shows the placeholder dimmed until there is a query', () => {
      let s = $('[data-px-key="s"]');
      expect(s.textContent).toContain('Search movies');
      expect(s.classList).toContain('dim');
      host.query = 'heat';
      fixture.detectChanges();
      expect(s.textContent).toContain('heat');
      expect(s.classList).not.toContain('dim');
    });
  });

  it('px-switch is a switch for assistive tech', () => {
    let sw = $('[data-px-key="sw"]');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.textContent).toContain('Family titles');
    host.on = true;
    fixture.detectChanges();
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('px-score formats its value; IMDb shows the logo and the votes', () => {
    expect(el.querySelector('px-score')!.textContent).toContain('TMDB');
    expect(el.querySelector('px-score')!.textContent).toContain('7.9');
    let imdb = $('px-score.imdb');
    expect(imdb.querySelector('img')).not.toBeNull();
    expect(imdb.textContent).toContain('8.0');
    expect(imdb.textContent).toContain('712K');
  });

  it('px-meta renders each item in order', () => {
    let meta = el.querySelector('px-meta')!;
    expect(Array.from(meta.children).map(c => c.className.split(' ')[0])).toEqual(['text', 'chip', 'score', 'seal']);
  });

  it('px-progress clamps to 0–1 and says so', () => {
    let p = el.querySelector('px-progress') as HTMLElement;
    expect(p.getAttribute('role')).toBe('progressbar');
    expect((p.querySelector('.fill') as HTMLElement).style.width).toBe('100%');
  });

  it('px-empty emits (act) from its button', () => {
    select($('[data-px-key="retry"]'));
    expect(host.acted).toBe(1);
  });

  it('px-skeleton only shows after its delay', fakeAsync(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ declarations: [PxSkeletonComponent] });
    let f = TestBed.createComponent(PxSkeletonComponent);
    f.componentInstance.delay = 300;
    f.detectChanges();
    expect(f.nativeElement.classList).not.toContain('shown');
    tick(300);
    f.detectChanges();
    expect(f.nativeElement.classList).toContain('shown');
    expect(f.nativeElement.getAttribute('aria-hidden')).toBe('true');
  }));

  it('px-tabs shows the tab focus moves onto (sn:focused), no Enter needed', () => {
    let b = $('[data-tab="b"]');
    expect($('[data-tab="a"]').getAttribute('aria-selected')).toBe('true');
    b.dispatchEvent(new CustomEvent('sn:focused', { bubbles: true }));
    fixture.detectChanges();
    expect(host.tab).toBe('b');
    expect(b.classList).toContain('active');
    expect(b.dataset['pxKey']).toBe('tab:b');
  });
});

describe('px-slider', () => {
  it('steps its value with Left / Right while focused', () => {
    TestBed.configureTestingModule({ declarations: [PxSliderComponent, PxItemDirective], schemas: [NO_ERRORS_SCHEMA] });
    let f = TestBed.createComponent(PxSliderComponent);
    let slider = f.componentInstance;
    Object.assign(slider, { min: 0, max: 100, step: 5, value: 50 });
    let values:number[] = [];
    slider.valueChange.subscribe(v => values.push(v));
    document.body.append(f.nativeElement);
    f.detectChanges();
    slider.ngOnInit();
    let button = f.nativeElement.querySelector('.px-slider') as HTMLElement;
    button.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    f.detectChanges();
    expect(values).toEqual([55, 60, 55]);
    expect(button.getAttribute('aria-valuenow')).toBe('55');
    slider.ngOnDestroy();
    f.nativeElement.remove();
  });
});

describe('Toasts', () => {

  let toasts:Toasts;

  beforeEach(() => {
    toasts = new Toasts({ run: (fn:() => void) => fn() } as any);
  });

  it('shows one at a time, then the next', fakeAsync(() => {
    toasts.show({ text: 'one' });
    toasts.show({ text: 'two' });
    expect(toasts.current$.value?.text).toBe('one');
    tick(4000);
    expect(toasts.current$.value?.text).toBe('two');
    tick(4000);
    expect(toasts.current$.value).toBeNull();
  }));

  it('errors stay longer', fakeAsync(() => {
    toasts.show({ text: 'oops', tone: 'error' });
    tick(4000);
    expect(toasts.current$.value?.text).toBe('oops');
    tick(2000);
    expect(toasts.current$.value).toBeNull();
  }));

  it('the same key replaces the shown one and restarts its time', fakeAsync(() => {
    toasts.show({ text: 'Added', key: 'list' });
    tick(3000);
    toasts.show({ text: 'Removed', key: 'list' });
    expect(toasts.current$.value?.text).toBe('Removed');
    expect(toasts.waiting.length).toBe(0);
    tick(3000);
    expect(toasts.current$.value?.text).toBe('Removed');
    tick(1000);
    expect(toasts.current$.value).toBeNull();
  }));

  it('keeps at most 3 waiting (the oldest go), and dismiss() moves on', fakeAsync(() => {
    let first = toasts.show({ text: '0' });
    ['1', '2', '3', '4'].forEach(text => toasts.show({ text }));
    expect(toasts.waiting.map(t => t.text)).toEqual(['2', '3', '4']);
    first.dismiss();
    expect(toasts.current$.value?.text).toBe('2');
    tick(20000);
  }));
});

describe('dur()', () => {
  it('reads the duration tokens in seconds', () => {
    let root = document.documentElement.style;
    root.setProperty('--px-dur-slow', '300ms');
    root.setProperty('--px-dur', '0.2s');
    expect(dur('slow')).toBeCloseTo(.3);
    expect(dur()).toBeCloseTo(.2);
    expect(dur('slow', 2)).toBeCloseTo(.6);
    root.setProperty('--px-dur-slow', '0ms');
    expect(dur('slow')).toBe(0);
    root.removeProperty('--px-dur-slow');
    root.removeProperty('--px-dur');
  });
});
