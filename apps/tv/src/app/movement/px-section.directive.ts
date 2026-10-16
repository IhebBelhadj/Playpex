import { Directive, ElementRef, Input, OnChanges, OnDestroy, OnInit } from '@angular/core';
import { NavigationService } from '../navigation.service';
import { FocusEngine, LeaveTarget } from './focus-engine.service';
import { Direction } from './moves';

// A spatial-navigation section declared in the template: added on init,
// removed on destroy (no more "forgot to remove the section" bugs), updated
// when `leaveFor` changes. Its items are the `.focusable` and `pxItem`
// elements inside the host, minus those of a nested pxSection.
//
//   <div class="toolbar" pxSection="adultToolbar"
//        [leaveFor]="{ left: '@menu', down: ['stack:adult-browse', '@adultPosters'] }">
//
// `leaveFor` values: '@<section>', a CSS selector, 'stack:<id>' / 'row:<id>' /
// 'grid:<id>' (entered at the remembered item), or an array tried in order.
// `trap` makes a modal: keys and mouse can't leave it.
@Directive({
  selector: '[pxSection]'
})
export class PxSectionDirective implements OnInit, OnChanges, OnDestroy {

  @Input('pxSection') id = '';
  @Input() leaveFor:Partial<Record<Direction, LeaveTarget>> | null = null;
  @Input() restrict:'self-only' | 'self-first' | 'none' = 'self-only';
  @Input() trap = false;
  @Input() enterTo:'' | 'last-focused' | 'default-element' = 'last-focused';
  @Input() defaultElement = '';
  @Input() straightOnly = true;
  // items inside the host (default: `.focusable` and `pxItem` elements)
  @Input() pxSelector = '';

  private added = false;

  constructor(
    private el:ElementRef<HTMLElement>,
    private navigation:NavigationService,
    private engine:FocusEngine,
  ) { }

  ngOnInit(): void {
    this.el.nativeElement.setAttribute('data-px-section', this.id);
    this.add();
  }

  ngOnChanges(): void {
    if (!this.added) return;
    this.navigation.updateNavigation('remove', { sectionId: this.id });
    this.add();
  }

  ngOnDestroy(): void {
    if (this.added) this.navigation.updateNavigation('remove', { sectionId: this.id });
    this.added = false;
  }

  private add() {
    let scope = `[data-px-section="${this.id}"]`;
    let items = (this.pxSelector || '.focusable, [data-px-item]').split(',').map(s => s.trim()).filter(Boolean);
    // a nested section's items are its own
    let selector = items.map(item => `${scope} ${item}:not(${scope} [data-px-section] *)`).join(', ');

    let leaveFor = null;
    if (!this.trap && this.leaveFor) {
      leaveFor = {};
      Object.keys(this.leaveFor).forEach(direction => leaveFor[direction] = this.engine.target(this.leaveFor[direction]));
    }

    this.navigation.updateNavigation('add', {
      id: this.id,
      selector,
      restrict: this.trap ? 'self-only' : this.restrict,
      leaveFor,
      enterTo: this.enterTo,
      defaultElement: this.defaultElement ? `${scope} ${this.defaultElement}` : '',
      straightOnly: this.straightOnly,
    });
    this.added = true;
  }
}
