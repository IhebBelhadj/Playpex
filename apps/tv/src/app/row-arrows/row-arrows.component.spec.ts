import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MOVEMENT_DIRECTIVES, PositionStore } from '../movement/movement';
import { RowArrowsComponent } from './row-arrows.component';

// A 250px row of 100px items
@Component({
  template: `
    <div rowArrows style="width: 250px">
      <div pxRow="" style="display: flex; width: 250px">
        <button *ngFor="let i of items" pxItem [pxItemKey]="i" style="flex: none; width: 100px; height: 60px">{{ i }}</button>
      </div>
    </div>`,
})
class HostComponent {
  items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
}

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

async function until(check:() => boolean, ms = 1000) {
  let end = performance.now() + ms;
  while (!check() && performance.now() < end) await frame();
}

describe('RowArrowsComponent', () => {
  let fixture:ComponentFixture<HostComponent>;
  let host:HTMLElement;
  let row:HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [HostComponent, RowArrowsComponent, ...MOVEMENT_DIRECTIVES],
      providers: [{ provide: PositionStore, useValue: { scope: '', get: () => null, save: () => { } } }],
    });
    fixture = TestBed.createComponent(HostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    host = fixture.nativeElement.querySelector('.rowArrows');
    row = fixture.nativeElement.querySelector('[data-px-container]');
  });

  afterEach(() => fixture.nativeElement.remove());

  it('shows only the forward chevron at the start of a row that is cut off', () => {
    expect(host.classList).toContain('canForward');
    expect(host.classList).not.toContain('canBack');
  });

  it('shows none when every item fits', async () => {
    fixture.componentInstance.items = [0, 1];
    fixture.detectChanges();
    await frame();
    expect(host.classList).not.toContain('canForward');
    expect(host.classList).not.toContain('canBack');
  });

  it('pages the row from the forward chevron, then shows the back one', async () => {
    (host.querySelector('.rowArrow.forward') as HTMLElement).click();
    await until(() => host.classList.contains('canBack'));
    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(host.classList).toContain('canBack');
  });

  it('marks the chevron the focused item is under', async () => {
    (row.querySelector('button') as HTMLElement).focus();
    await frame();
    await frame();
    expect(host.querySelector('.rowArrow.back').classList).toContain('covers');
    expect(host.querySelector('.rowArrow.forward').classList).not.toContain('covers');
  });
});
