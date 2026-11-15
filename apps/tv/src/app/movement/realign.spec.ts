import { Component, ViewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import * as spatialNavigation from '../../plugins/spacialNavigation.js';
import { ProfilesService } from '../profiles.service';
import { PositionStore } from './position-store.service';
import { PxItemDirective } from './px-item.directive';
import { PxRowDirective } from './px-row.directive';

// A row whose items are sized in rem, like every dp() length: changing the
// root font size is what a resized window does to it (styles.scss)
@Component({
  template: `
    <div class="realignTest" style="position:absolute;left:0;top:0;width:300px;overflow:hidden">
      <div pxRow="realign" motion="transform" align="start" style="display:flex;gap:0">
        <button *ngFor="let i of items" pxItem [pxItemKey]="i" class="focusable"
          style="flex:none;width:5rem;height:2rem;padding:0;border:0">{{ i }}</button>
      </div>
    </div>`,
})
class RealignHostComponent {
  items = Array.from({ length: 20 }, (_, i) => i);
  @ViewChild(PxRowDirective) row:PxRowDirective;
}

describe('movement realign after a resize', () => {
  let fixture:ComponentFixture<RealignHostComponent>;
  let row:PxRowDirective;
  let rootSize:string;

  const item = (i:number) => fixture.nativeElement.querySelector(`[data-px-key="${i}"]`) as HTMLElement;
  const offset = () => (row as any).mover.offset(row.host, 'left');

  beforeEach(() => {
    rootSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '16px';
    spatialNavigation.init();
    spatialNavigation.add({ id: 'realignTest', selector: '.realignTest .focusable' });
    TestBed.configureTestingModule({
      declarations: [RealignHostComponent, PxRowDirective, PxItemDirective],
      providers: [{ provide: ProfilesService, useValue: { current: of(null) } }],
    });
    fixture = TestBed.createComponent(RealignHostComponent);
    fixture.detectChanges();
    row = fixture.componentInstance.row;
  });

  afterEach(() => {
    spatialNavigation.remove('realignTest');
    document.documentElement.style.fontSize = rootSize;
    fixture.destroy();
  });

  it('keeps the focused item at its alignment when the items change size', () => {
    let target = item(8);
    target.focus();
    row.reveal(target, true);
    expect(offset()).toBe(8 * 80);
    document.documentElement.style.fontSize = '20px';
    row.realign();
    expect(offset()).toBe(8 * 100);
    document.documentElement.style.fontSize = '12px';
    row.realign();
    expect(offset()).toBe(8 * 60);
  });

  it('realigns on the remembered item when the focus is elsewhere', () => {
    TestBed.inject(PositionStore).save('realign', { key: '6', index: 6 });
    row.reveal(item(6), true);
    (document.activeElement as HTMLElement)?.blur?.();
    document.documentElement.style.fontSize = '24px';
    row.realign();
    expect(offset()).toBe(6 * 120);
  });

  it('a row at its start stays there', () => {
    document.documentElement.style.fontSize = '24px';
    row.realign();
    expect(offset()).toBe(0);
  });

  it('clamps an offset past the new end', () => {
    // no remembered item, no focus: moved by the paddles
    (row as any).mover.moveTo(row.host, { left: 1000 }, { instant: true });
    document.documentElement.style.fontSize = '8px';   // the content is now 20 × 40 = 800 wide
    row.realign();
    expect(offset()).toBe(800 - 300);
  });
});
